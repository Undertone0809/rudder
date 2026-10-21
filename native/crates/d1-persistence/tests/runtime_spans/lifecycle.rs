use super::*;
use rudder_auth_core::VerifiedActor;

async fn opened() -> (Database, VerifiedActor, String) {
    let database = Database::start().await;
    seed_access(&database.pool).await;
    seed_chat(&database.pool, CHAT, "chat", USER).await;
    let owner = actor(USER, ORG, "lifecycle-regression");
    let (binding, segment) = ensure_binding(&database.pool, &owner, CHAT).await;
    seed_run_attempt(&database.pool, CHAT).await;
    let result = execute(
        &database.pool,
        &owner,
        ORG,
        &open_request(&binding, &segment),
    )
    .await
    .expect("open owned span");
    let span = result["span"]["id"].as_str().expect("span id").to_owned();
    (database, owner, span)
}

fn request_value(operation: &str, span: &str) -> Value {
    let mut value = json!({
        "operation": operation, "spanId": span, "runId": RUN,
        "attemptId": ATTEMPT, "attemptEpoch": 7, "ownerToken": "attempt-owner-token"
    });
    if operation == "close" {
        value["completeness"] = json!("complete");
    }
    value
}

fn request(operation: &str, span: &str) -> Request {
    serde_json::from_value(request_value(operation, span)).expect("typed lifecycle request")
}

async fn snapshot(database: &Database, span: &str) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'span', to_jsonb(s), 'segment', to_jsonb(n),
           'activityCount', (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid),
           'outboxCount', (SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid)
         ) FROM run_runtime_spans s
         JOIN native_segments n ON n.org_id=s.org_id AND n.id=s.segment_id
         WHERE s.org_id=$1::uuid AND s.id=$2::uuid",
    )
    .bind(ORG)
    .bind(span)
    .fetch_one(&database.pool)
    .await
    .expect("snapshot span, segment and effects")
}

#[tokio::test(flavor = "multi_thread")]
async fn queued_run_cannot_replay_closed_span_as_a_terminal_retry() {
    let (database, owner, span) = opened().await;
    let close = request("close", &span);
    execute(&database.pool, &owner, ORG, &close)
        .await
        .expect("close owned span");
    sqlx::query("UPDATE heartbeat_runs SET status='queued' WHERE id=$1::uuid")
        .bind(RUN)
        .execute(&database.pool)
        .await
        .expect("set nonterminal run status");
    let before = snapshot(&database, &span).await;
    assert!(matches!(
        execute(&database.pool, &owner, ORG, &close).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(snapshot(&database, &span).await, before);
}

#[tokio::test(flavor = "multi_thread")]
async fn expired_lease_rolls_back_every_lifecycle_mutation_and_activity() {
    for operation in ["close", "seal_segment", "reconcile_segment"] {
        let (database, owner, span) = opened().await;
        if operation == "reconcile_segment" {
            execute(&database.pool, &owner, ORG, &request("close", &span))
                .await
                .expect("close before reconciliation");
        }
        sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid")
            .bind(RUN).execute(&database.pool).await.expect("expire owned lease");
        let before = snapshot(&database, &span).await;
        assert!(
            matches!(
                execute(&database.pool, &owner, ORG, &request(operation, &span)).await,
                Err(Error::Http(409, _))
            ),
            "{operation}"
        );
        assert_eq!(
            snapshot(&database, &span).await,
            before,
            "{operation} must roll back effects"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn lifecycle_rejects_foreign_actors_and_changed_fences_without_effects() {
    let (database, owner, span) = opened().await;
    for operation in ["close", "seal_segment", "reconcile_segment"] {
        let before = snapshot(&database, &span).await;
        let outsider = actor("not-a-member", ORG, "lifecycle-outsider");
        assert!(matches!(
            execute(&database.pool, &outsider, ORG, &request(operation, &span)).await,
            Err(Error::Http(403, _))
        ));
        let foreign = actor(USER, OTHER, "lifecycle-foreign-org");
        assert!(matches!(
            execute(&database.pool, &foreign, ORG, &request(operation, &span)).await,
            Err(Error::Http(403, _))
        ));
        for (field, value, status) in [
            ("runId", json!("64000000-0000-4000-8000-000000000999"), 409),
            ("attemptId", json!(ATTEMPT_TWO), 404),
            ("attemptEpoch", json!(8), 409),
            ("ownerToken", json!("changed-owner-token"), 409),
        ] {
            let mut changed = request_value(operation, &span);
            changed[field] = value;
            let changed: Request = serde_json::from_value(changed).expect("changed fence request");
            let result = execute(&database.pool, &owner, ORG, &changed).await;
            assert!(
                matches!(result, Err(Error::Http(code, _)) if code == status),
                "{operation}/{field}: {result:?}"
            );
        }
        assert_eq!(snapshot(&database, &span).await, before);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn lifecycle_retries_do_not_duplicate_activity_and_conflicts_are_rejected() {
    let (database, owner, span) = opened().await;
    let seal = request("seal_segment", &span);
    let first = execute(&database.pool, &owner, ORG, &seal)
        .await
        .expect("seal segment");
    let before = snapshot(&database, &span).await;
    assert_eq!(
        execute(&database.pool, &owner, ORG, &seal)
            .await
            .expect("repeat seal"),
        first
    );
    assert_eq!(snapshot(&database, &span).await, before);

    let close = request("close", &span);
    let closed = execute(&database.pool, &owner, ORG, &close)
        .await
        .expect("close span");
    let before = snapshot(&database, &span).await;
    assert_eq!(
        execute(&database.pool, &owner, ORG, &close)
            .await
            .expect("repeat close"),
        closed
    );
    let sealed_after_close = execute(&database.pool, &owner, ORG, &seal)
        .await
        .expect("repeat seal after close is read-only");
    assert_eq!(sealed_after_close["span"]["state"], "sealed");
    assert_eq!(snapshot(&database, &span).await, before);
    let mut conflict = request_value("close", &span);
    conflict["completeness"] = json!("unknown");
    let conflict = serde_json::from_value(conflict).expect("conflicting close");
    assert!(matches!(
        execute(&database.pool, &owner, ORG, &conflict).await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(snapshot(&database, &span).await, before);

    let reconcile = request("reconcile_segment", &span);
    execute(&database.pool, &owner, ORG, &reconcile)
        .await
        .expect("reconcile sealed segment");
    assert_eq!(snapshot(&database, &span).await, before);
    sqlx::query("UPDATE heartbeat_runs SET status='failed', execution_lease_expires_at=NULL WHERE id=$1::uuid")
        .bind(RUN).execute(&database.pool).await.expect("terminal run retains exact owner fence");
    let before = snapshot(&database, &span).await;
    assert_eq!(
        execute(&database.pool, &owner, ORG, &close)
            .await
            .expect("terminal same-owner close retry"),
        closed
    );
    execute(&database.pool, &owner, ORG, &reconcile)
        .await
        .expect("terminal same-owner reconcile retry");
    assert_eq!(
        snapshot(&database, &span).await,
        before,
        "terminal retries are read-only"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn unknown_close_is_unresolved_and_reconcile_requires_a_closed_span() {
    let (database, owner, span) = opened().await;
    let before = snapshot(&database, &span).await;
    assert!(matches!(
        execute(
            &database.pool,
            &owner,
            ORG,
            &request("reconcile_segment", &span)
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(snapshot(&database, &span).await, before);
    let mut unknown = request_value("close", &span);
    unknown["completeness"] = json!("unknown");
    let unknown = serde_json::from_value(unknown).expect("unknown completeness request");
    let result = execute(&database.pool, &owner, ORG, &unknown)
        .await
        .expect("close unresolved span");
    assert_eq!(result["span"]["state"], "unresolved");
    assert_eq!(result["span"]["completeness"], "unknown");
    execute(
        &database.pool,
        &owner,
        ORG,
        &request("reconcile_segment", &span),
    )
    .await
    .expect("reconcile unresolved closed span");
}

#[tokio::test(flavor = "multi_thread")]
async fn lifecycle_rejects_superseded_segments_and_newer_attempts_without_effects() {
    let (database, owner, span) = opened().await;
    let before = snapshot(&database, &span).await;
    let invalid = sqlx::query(
        "UPDATE native_segments SET state='sealed', sealed_at=NULL
         WHERE id=(SELECT segment_id FROM run_runtime_spans WHERE id=$1::uuid)",
    )
    .bind(&span)
    .execute(&database.pool)
    .await;
    assert!(matches!(invalid, Err(sqlx::Error::Database(ref error))
        if error.constraint() == Some("native_segments_sealed_lifecycle_check")));
    assert_eq!(snapshot(&database, &span).await, before);

    sqlx::query(
        "UPDATE native_segments SET state='superseded', sealed_at=clock_timestamp()
         WHERE id=(SELECT segment_id FROM run_runtime_spans WHERE id=$1::uuid)",
    )
    .bind(&span)
    .execute(&database.pool)
    .await
    .expect("supersede segment");
    let before = snapshot(&database, &span).await;
    for operation in ["close", "seal_segment", "reconcile_segment"] {
        assert!(
            matches!(
                execute(&database.pool, &owner, ORG, &request(operation, &span)).await,
                Err(Error::Http(409, _))
            ),
            "{operation}"
        );
        assert_eq!(snapshot(&database, &span).await, before);
    }

    let (database, owner, span) = opened().await;
    sqlx::query(
        "INSERT INTO heartbeat_run_attempts
           (id, org_id, run_id, agent_id, attempt_index, runtime_type, status)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,'codex_local','started')",
    )
    .bind(ATTEMPT_TWO)
    .bind(ORG)
    .bind(RUN)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("insert superseding attempt");
    let before = snapshot(&database, &span).await;
    for operation in ["close", "seal_segment", "reconcile_segment"] {
        assert!(
            matches!(
                execute(&database.pool, &owner, ORG, &request(operation, &span)).await,
                Err(Error::Http(409, _))
            ),
            "{operation}"
        );
        assert_eq!(snapshot(&database, &span).await, before);
    }
}
