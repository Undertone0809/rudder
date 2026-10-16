use super::*;

#[tokio::test(flavor = "multi_thread")]
async fn first_claim_is_org_scoped_distinct_and_never_adopts_an_existing_owner() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run_id, attempt_id) = prepare(&database, &host).await;
    let claimed = claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    .expect("claim first owner");
    assert_eq!(claimed.config.identity.agent_id, CEO);
    assert_eq!(claimed.config.identity.host_id, host.context().host_id());
    assert_eq!(claimed.config.identity.runtime_type, "codex_local");
    assert_eq!(claimed.config.model.as_deref(), Some("gpt-5.6-luna"));
    assert_eq!(claimed.config.cwd, host.cwd);
    assert_eq!(claimed.config.executable, host.executable);
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    assert_eq!(
        claimed.config.instruction_content.as_deref(),
        Some("isolated test instructions")
    );
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    assert!(claimed.config.instruction_content.is_none());
    assert!(
        claimed
            .config
            .identity
            .instructions_revision
            .starts_with("sha256:")
    );
    let fence = claimed.fence;
    let identity = fence.identity();
    assert_eq!(identity.run_id, run_id);
    assert_eq!(identity.attempt_id, attempt_id);
    assert_eq!(identity.generation_attempt_epoch, 1);
    assert_eq!(identity.run_attempt_epoch, 1);
    assert_eq!(identity.connection_epoch, 1);
    assert_ne!(
        fence.generation_control_owner_token(),
        fence.run_execution_owner_token()
    );
    let debug = format!("{fence:?}");
    assert!(!debug.contains(fence.generation_control_owner_token()));
    assert!(!debug.contains(fence.run_execution_owner_token()));

    let holds: (bool, bool, String, Option<String>) = sqlx::query_as(
        "SELECT g.native_admission_hold, r.native_admission_hold, g.control_state, g.control_owner_token
         FROM chat_generations g JOIN heartbeat_runs r
           ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read first claim");
    assert_eq!(
        (holds.0, holds.1, holds.2.as_str()),
        (true, true, "unregistered")
    );
    assert_eq!(
        holds.3.as_deref(),
        Some(fence.generation_control_owner_token())
    );

    assert_conflict(
        claim(
            &database.pool,
            &actor,
            ORG,
            &run_id,
            &attempt_id,
            host.context(),
        )
        .await,
    );
    let foreign_actor = verified_actor(OTHER, USER, "foreign");
    assert!(matches!(
        claim(
            &database.pool,
            &foreign_actor,
            ORG,
            &run_id,
            &attempt_id,
            host.context(),
        )
        .await,
        Err(Error::Http(403, _))
    ));

    let before: (i64, i64) = sqlx::query_as(
        "SELECT floor(extract(epoch FROM g.control_lease_expires_at) * 1000)::bigint,
                floor(extract(epoch FROM r.execution_lease_expires_at) * 1000)::bigint
         FROM chat_generations g JOIN heartbeat_runs r
           ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read claim leases");
    let renewed = renew_lease(&database.pool, &actor, &fence)
        .await
        .expect("renew both live leases");
    assert!(renewed.generation_expires_at_unix_ms() > before.0);
    assert!(renewed.run_expires_at_unix_ms() > before.1);
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid
         AND action='runtime.native_chat.execution_claimed' AND entity_id=$2",
    )
    .bind(ORG)
    .bind(identity.generation_id)
    .fetch_one(&database.pool)
    .await
    .expect("read claim activity audit");
    assert_eq!(audit_count, 1, "duplicate claim must not duplicate audit");
}

#[tokio::test(flavor = "multi_thread")]
async fn unsupported_config_changed_after_admission_leaves_claim_unmodified() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run_id, attempt_id) = prepare(&database, &host).await;

    let secret = "changed-config-test-secret";
    sqlx::query(
        "UPDATE agents SET agent_runtime_config=$1::jsonb
         WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(json!({"env":{"TOKEN":secret},"search":false}).to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("change persisted runtime config after Run admission");

    match claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    {
        Err(Error::Http(409, message)) => assert!(!message.contains(secret)),
        Err(Error::Http(status, _)) => panic!("expected config conflict, got HTTP {status}"),
        Err(Error::Database(error)) => {
            panic!("expected config conflict, got database error: {error}")
        }
        Ok(_) => panic!("unsupported changed runtime config was claimed"),
    }

    let state: (bool, bool, Option<String>, bool) = sqlx::query_as(
        "SELECT g.native_admission_hold, r.native_admission_hold,
                g.control_owner_token, g.control_lease_expires_at IS NOT NULL
         FROM chat_generations g JOIN heartbeat_runs r
           ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read claim state after rejected config");
    assert_eq!(state, (false, false, None, false));

    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log
         WHERE org_id=$1::uuid AND action='runtime.native_chat.execution_claimed'
           AND entity_id=(SELECT chat_generation_id::text FROM heartbeat_runs
                          WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read audit after rejected config");
    assert_eq!(
        audit_count, 0,
        "rejected config must not create claim audit"
    );
}
