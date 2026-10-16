use super::*;

async fn clone_binding_with_continuity(
    pool: &PgPool,
    source_binding_id: &str,
    conversation_id: &str,
    continuity: &str,
) -> (String, String) {
    let binding_id: String = sqlx::query_scalar(
        "INSERT INTO runtime_bindings
           (org_id, conversation_id, target_type, target_id, principal_scope_ref,
            agent_id, runtime_type, host_id, profile_id, workspace_binding_id,
            instructions_revision, capability_revision, continuity, binding_epoch, status)
         SELECT org_id, $2::uuid, 'chat_conversation', $2, principal_scope_ref,
                agent_id, runtime_type, host_id, profile_id, workspace_binding_id,
                instructions_revision, capability_revision, $3, binding_epoch, status
         FROM runtime_bindings WHERE org_id=$1::uuid AND id=$4::uuid
         RETURNING id::text",
    )
    .bind(ORG)
    .bind(conversation_id)
    .bind(continuity)
    .bind(source_binding_id)
    .fetch_one(pool)
    .await
    .expect("clone the exact resolved binding identity");
    let segment_id: String = sqlx::query_scalar(
        "INSERT INTO native_segments (org_id, binding_id, runtime_type, segment_ordinal, state)
         SELECT org_id, id, runtime_type, 0, 'pending'
         FROM runtime_bindings WHERE org_id=$1::uuid AND id=$2::uuid
         RETURNING id::text",
    )
    .bind(ORG)
    .bind(&binding_id)
    .fetch_one(pool)
    .await
    .expect("create pending segment for cloned binding");
    sqlx::query(
        "UPDATE runtime_bindings SET current_segment_id=$1::uuid
         WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(&segment_id)
    .bind(ORG)
    .bind(&binding_id)
    .execute(pool)
    .await
    .expect("set cloned current segment");
    (binding_id, segment_id)
}

#[tokio::test(flavor = "multi_thread")]
async fn admission_rejects_non_native_binding_continuity_without_mutation() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "native-admit-continuity");
    let source = execute(
        &database.pool,
        &actor,
        ORG,
        &request(CHAT, "continuity-source", "seed resolved identity"),
    )
    .await
    .expect("admit source Chat to obtain a valid resolved identity");
    let source_snapshot: Value = sqlx::query_scalar(
        "SELECT context_snapshot FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(source["runId"].as_str().expect("source Run id"))
    .fetch_one(&database.pool)
    .await
    .expect("read source binding association");
    let source_binding_id = source_snapshot["runtimeBindingId"]
        .as_str()
        .expect("source RuntimeBinding id");

    for (conversation_id, continuity) in [
        (CHAT_LEGACY_CONTINUITY, "legacy"),
        (CHAT_HANDOFF_CONTINUITY, "context_handoff"),
    ] {
        let (binding_id, segment_id) = clone_binding_with_continuity(
            &database.pool,
            source_binding_id,
            conversation_id,
            continuity,
        )
        .await;
        let before: (String, String, String, i32, Option<String>) = sqlx::query_as(
            "SELECT b.id::text, b.current_segment_id::text, b.continuity,
                    b.binding_epoch, s.native_session_id
             FROM runtime_bindings b JOIN native_segments s
               ON s.org_id=b.org_id AND s.binding_id=b.id AND s.id=b.current_segment_id
             WHERE b.org_id=$1::uuid AND b.id=$2::uuid",
        )
        .bind(ORG)
        .bind(&binding_id)
        .fetch_one(&database.pool)
        .await
        .expect("snapshot non-native binding before admission");

        assert!(matches!(
            execute(
                &database.pool,
                &actor,
                ORG,
                &request(
                    conversation_id,
                    &format!("reject-{continuity}"),
                    "must not attach"
                ),
            )
            .await,
            Err(Error::Http(409, _))
        ));

        assert_eq!(
            row_counts(&database.pool, conversation_id).await,
            (0, 0, 0, 0, 0)
        );
        let after: (String, String, String, i32, Option<String>) = sqlx::query_as(
            "SELECT b.id::text, b.current_segment_id::text, b.continuity,
                    b.binding_epoch, s.native_session_id
             FROM runtime_bindings b JOIN native_segments s
               ON s.org_id=b.org_id AND s.binding_id=b.id AND s.id=b.current_segment_id
             WHERE b.org_id=$1::uuid AND b.id=$2::uuid",
        )
        .bind(ORG)
        .bind(&binding_id)
        .fetch_one(&database.pool)
        .await
        .expect("read non-native binding after rejection");
        assert_eq!(
            after, before,
            "rejected admission must not mutate the binding"
        );
        assert_eq!(after.0, binding_id);
        assert_eq!(after.1, segment_id);
        let binding_audit_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid
             AND action='runtime.binding.created' AND entity_id=$2",
        )
        .bind(ORG)
        .bind(&binding_id)
        .fetch_one(&database.pool)
        .await
        .expect("count binding audit after rejected admission");
        assert_eq!(binding_audit_count, 0);
    }
}

async fn wait_for_locked_replay(pool: &PgPool) {
    for _ in 0..300 {
        let waiting: bool = sqlx::query_scalar(
            "SELECT EXISTS(
               SELECT 1 FROM pg_stat_activity
               WHERE datname=current_database() AND wait_event_type='Lock'
                 AND query ILIKE '%FROM chat_conversations%' AND query ILIKE '%FOR UPDATE%'
             )",
        )
        .fetch_one(pool)
        .await
        .expect("inspect Native Chat replay lock wait");
        if waiting {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for replay to lock the reassigned Chat");
}

#[tokio::test(flavor = "multi_thread")]
async fn reassigned_agent_cannot_replay_receipt_after_waiting_for_chat_lock() {
    let database = Database::start().await;
    prepare(&database).await;
    let old_agent = verified_actor_kind("agent", CEO, "native-admit-replay-old-agent");
    let replay = request(CHAT, "replay-assignment-race", "stable receipt content");
    execute(&database.pool, &old_agent, ORG, &replay)
        .await
        .expect("admit the original Agent's Chat turn");

    // The uncommitted update keeps the old assignment visible to the
    // replay's initial read. Its final locked authorization must observe the
    // new assignment before it returns the already-persisted receipt.
    let mut reassignment = database
        .pool
        .begin()
        .await
        .expect("begin concurrent Chat reassignment");
    sqlx::query(
        "UPDATE chat_conversations SET preferred_agent_id=$1::uuid
         WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(WRONG_AGENT)
    .bind(ORG)
    .bind(CHAT)
    .execute(&mut *reassignment)
    .await
    .expect("hold the reassigned Chat row");

    let replay_pool = database.pool.clone();
    let replay_actor = old_agent.clone();
    let replay_request = replay.clone();
    let replay_task =
        tokio::spawn(
            async move { execute(&replay_pool, &replay_actor, ORG, &replay_request).await },
        );
    wait_for_locked_replay(&database.pool).await;
    reassignment
        .commit()
        .await
        .expect("commit the new Chat Agent assignment");

    let replay_result = tokio::time::timeout(std::time::Duration::from_secs(5), replay_task)
        .await
        .expect("receipt reauthorization must finish after reassignment")
        .expect("join exact replay task");
    assert!(
        matches!(replay_result, Err(Error::Http(403, _))),
        "old Agent must lose read access to the existing receipt"
    );
    assert_eq!(row_counts(&database.pool, CHAT).await, (1, 1, 1, 1, 1));
}
