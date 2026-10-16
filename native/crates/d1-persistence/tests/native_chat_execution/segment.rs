use super::*;

const OTHER_CHAT: &str = "21000000-0000-4000-8000-000000000202";

type ProtocolState = (
    Value,
    String,
    Option<String>,
    bool,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
);

async fn admitted_binding(pool: &PgPool, run_id: &str) -> (String, String) {
    let snapshot: Value = sqlx::query_scalar(
        "SELECT context_snapshot FROM heartbeat_runs
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(run_id)
    .fetch_one(pool)
    .await
    .expect("read admitted execution context");
    (
        snapshot["runtimeBindingId"]
            .as_str()
            .expect("runtime binding id")
            .to_owned(),
        snapshot["nativeSegmentId"]
            .as_str()
            .expect("native segment id")
            .to_owned(),
    )
}

async fn protocol_state(
    pool: &PgPool,
    run_id: &str,
    attempt_id: &str,
    binding_id: &str,
    segment_id: &str,
) -> ProtocolState {
    sqlx::query_as(
        "SELECT a.checkpoint_json, s.state, s.native_session_id,
                s.sealed_at IS NOT NULL,
                b.current_segment_id::text, g.provider_thread_id, r.session_id_after,
                (SELECT count(*) FROM activity_log l
                 WHERE l.org_id=r.org_id AND l.run_id=r.id
                   AND l.action='runtime.native_chat.checkpoint_advanced')
         FROM heartbeat_runs r
         JOIN heartbeat_run_attempts a
           ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$3::uuid
         JOIN chat_generations g
           ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN runtime_bindings b ON b.org_id=r.org_id AND b.id=$4::uuid
         JOIN native_segments s
           ON s.org_id=b.org_id AND s.binding_id=b.id AND s.id=$5::uuid
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(run_id)
    .bind(attempt_id)
    .bind(binding_id)
    .bind(segment_id)
    .fetch_one(pool)
    .await
    .expect("read checkpoint and current Segment state")
}

#[tokio::test(flavor = "multi_thread")]
async fn record_thread_atomically_opens_the_exact_admitted_segment() {
    let database = Database::start().await;
    let (actor, run_id, attempt_id, fence) = seed_execution(&database).await;
    let (binding_id, segment_id) = admitted_binding(&database.pool, &run_id).await;

    let pending = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &binding_id,
        &segment_id,
    )
    .await;
    assert_eq!(pending.1, "pending");
    assert_eq!(pending.2, None);
    assert!(!pending.3);
    assert_eq!(pending.4.as_deref(), Some(segment_id.as_str()));

    advance_checkpoint(
        &database.pool,
        &actor,
        &fence,
        Phase::NoThreadRequest,
        0,
        CheckpointTransition::PrepareThreadStart,
    )
    .await
    .expect("persist indeterminate thread-start phase");
    let thread = advance_checkpoint(
        &database.pool,
        &actor,
        &fence,
        Phase::ThreadStartIndeterminate,
        1,
        CheckpointTransition::RecordThread {
            thread_id: OPAQUE_THREAD.to_owned(),
        },
    )
    .await
    .expect("bind exact opaque Thread to the pending Segment");
    assert_eq!(thread.snapshot().thread_id.as_deref(), Some(OPAQUE_THREAD));

    let opened = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &binding_id,
        &segment_id,
    )
    .await;
    assert_eq!(opened.1, "open");
    assert_eq!(opened.2.as_deref(), Some(OPAQUE_THREAD));
    assert!(!opened.3);
    assert_eq!(opened.4.as_deref(), Some(segment_id.as_str()));
    assert_eq!(opened.5.as_deref(), Some(OPAQUE_THREAD));
    assert!(opened.6.is_none());
    assert_eq!(opened.0["phase"], "thread_known");
    assert_eq!(opened.0["threadId"], OPAQUE_THREAD);
    assert_eq!(opened.7, 2, "both checkpoint transitions were audited");

    let restored = current_checkpoint(&database.pool, &actor, &fence)
        .await
        .expect("validate and restore the exact open Segment association");
    assert_eq!(restored.phase, Phase::ThreadKnown);
    assert_eq!(restored.thread_id.as_deref(), Some(OPAQUE_THREAD));

    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin mismatched Thread fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)")
        .execute(&mut *tx)
        .await
        .expect("mark mismatched Thread fixture");
    sqlx::query(
        "UPDATE native_segments SET native_session_id='different-thread',
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND binding_id=$2::uuid AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(&binding_id)
    .bind(&segment_id)
    .execute(&mut *tx)
    .await
    .expect("change exact Thread locator fixture");
    tx.commit().await.expect("commit mismatched Thread fixture");
    let before = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &binding_id,
        &segment_id,
    )
    .await;
    assert_conflict(current_checkpoint(&database.pool, &actor, &fence).await);
    assert_conflict(
        advance_checkpoint(
            &database.pool,
            &actor,
            &fence,
            Phase::NoThreadRequest,
            0,
            CheckpointTransition::PrepareThreadStart,
        )
        .await,
    );
    let after = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &binding_id,
        &segment_id,
    )
    .await;
    assert_eq!(after, before, "mismatched Thread rejection has no effects");
}

#[tokio::test(flavor = "multi_thread")]
async fn sealed_or_rotated_segment_is_rejected_without_checkpoint_effects() {
    let database = Database::start().await;
    let (actor, run_id, attempt_id, fence) = seed_execution(&database).await;
    let (binding_id, segment_id) = admitted_binding(&database.pool, &run_id).await;

    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin sealed Segment fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)")
        .execute(&mut *tx)
        .await
        .expect("mark sealed Segment fixture");
    sqlx::query(
        "UPDATE native_segments SET state='sealed', sealed_at=clock_timestamp(),
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND binding_id=$2::uuid AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(&binding_id)
    .bind(&segment_id)
    .execute(&mut *tx)
    .await
    .expect("seal current Segment fixture");
    tx.commit().await.expect("commit sealed Segment fixture");

    let before = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &binding_id,
        &segment_id,
    )
    .await;
    assert_conflict(
        advance_checkpoint(
            &database.pool,
            &actor,
            &fence,
            Phase::NoThreadRequest,
            0,
            CheckpointTransition::PrepareThreadStart,
        )
        .await,
    );
    let after = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &binding_id,
        &segment_id,
    )
    .await;
    assert_eq!(after, before, "sealed Segment rejection has no effects");

    let mut tx = database.pool.begin().await.expect("begin Segment restore");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)")
        .execute(&mut *tx)
        .await
        .expect("mark Segment restore");
    sqlx::query(
        "UPDATE native_segments SET state='pending', sealed_at=NULL,
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND binding_id=$2::uuid AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(&binding_id)
    .bind(&segment_id)
    .execute(&mut *tx)
    .await
    .expect("restore pending Segment fixture");

    let rotated_id: String = sqlx::query_scalar(
        "INSERT INTO native_segments (org_id, binding_id, runtime_type, segment_ordinal, state)
         VALUES ($1::uuid, $2::uuid, 'codex_local', 91, 'pending')
         RETURNING id::text",
    )
    .bind(ORG)
    .bind(&binding_id)
    .fetch_one(&mut *tx)
    .await
    .expect("insert rotated current Segment fixture");
    sqlx::query(
        "UPDATE runtime_bindings SET current_segment_id=$3::uuid,
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&binding_id)
    .bind(&rotated_id)
    .execute(&mut *tx)
    .await
    .expect("rotate binding to a different Segment");
    tx.commit().await.expect("commit Segment rotation fixture");

    let before = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &binding_id,
        &segment_id,
    )
    .await;
    assert_conflict(current_checkpoint(&database.pool, &actor, &fence).await);
    let after = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &binding_id,
        &segment_id,
    )
    .await;
    assert_eq!(after, before, "rotated Segment rejection has no effects");
}

#[tokio::test(flavor = "multi_thread")]
async fn another_chat_binding_cannot_be_substituted_into_run_context() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run_id, attempt_id) = prepare(&database, &host).await;
    let original = admitted_binding(&database.pool, &run_id).await;

    sqlx::query(
        "INSERT INTO chat_conversations
           (id, org_id, title, conversation_kind, created_by_user_id, status, preferred_agent_id)
         VALUES ($1::uuid, $2::uuid, 'Other Native execution fixture', 'chat', $3, 'active', $4::uuid)",
    )
    .bind(OTHER_CHAT)
    .bind(ORG)
    .bind(USER)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed a second authorized Chat target");
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation": "submit_native_chat_turn",
        "conversationId": OTHER_CHAT,
        "clientMutationId": "native-execution-other-chat",
        "body": "second binding fixture",
    }))
    .expect("build second Chat request");
    let other_receipt = execute(&database.pool, &actor, ORG, &request, host.context())
        .await
        .expect("admit the other Chat");
    let other_run_id = other_receipt["runId"].as_str().expect("other Run id");
    let other = admitted_binding(&database.pool, other_run_id).await;
    let claimed = claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    .expect("claim the original execution before association tampering");

    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin foreign binding fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)")
        .execute(&mut *tx)
        .await
        .expect("mark foreign binding fixture");
    sqlx::query(
        "UPDATE heartbeat_runs
         SET context_snapshot=jsonb_set(
               jsonb_set(context_snapshot, '{runtimeBindingId}', to_jsonb($3::text), true),
               '{nativeSegmentId}', to_jsonb($4::text), true)
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&other.0)
    .bind(&other.1)
    .execute(&mut *tx)
    .await
    .expect("substitute other Chat binding into Run context fixture");
    tx.commit().await.expect("commit foreign binding fixture");

    let before = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &original.0,
        &original.1,
    )
    .await;
    assert_conflict(current_checkpoint(&database.pool, &actor, &claimed.fence).await);
    let after = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &original.0,
        &original.1,
    )
    .await;
    assert_eq!(after, before, "foreign binding rejection has no effects");
}

#[tokio::test(flavor = "multi_thread")]
async fn execution_fence_rejects_same_chat_binding_replacement_and_snapshot_rewrite() {
    let database = Database::start().await;
    let (actor, run_id, attempt_id, fence) = seed_execution(&database).await;
    let (old_binding_id, old_segment_id) = admitted_binding(&database.pool, &run_id).await;

    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin coordinated same-Chat replacement fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)")
        .execute(&mut *tx)
        .await
        .expect("mark same-Chat replacement fixture");
    sqlx::query(
        "UPDATE runtime_bindings SET status='superseded', updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&old_binding_id)
    .execute(&mut *tx)
    .await
    .expect("make the admitted binding inactive");
    let new_binding_id: String = sqlx::query_scalar(
        "INSERT INTO runtime_bindings
           (org_id, conversation_id, principal_scope_ref, agent_id, runtime_type,
            host_id, profile_id, workspace_binding_id, instructions_revision,
            capability_revision, continuity, binding_epoch, status, target_type, target_id)
         SELECT org_id, conversation_id, principal_scope_ref, agent_id, runtime_type,
                host_id, profile_id, workspace_binding_id, instructions_revision,
                capability_revision, continuity, binding_epoch + 1, 'active', target_type, target_id
         FROM runtime_bindings WHERE org_id=$1::uuid AND id=$2::uuid
         RETURNING id::text",
    )
    .bind(ORG)
    .bind(&old_binding_id)
    .fetch_one(&mut *tx)
    .await
    .expect("insert replacement with the same Agent and binding identity");
    let new_segment_id: String = sqlx::query_scalar(
        "INSERT INTO native_segments (org_id, binding_id, runtime_type, segment_ordinal, state)
         SELECT org_id, id, runtime_type, 0, 'pending'
         FROM runtime_bindings WHERE org_id=$1::uuid AND id=$2::uuid
         RETURNING id::text",
    )
    .bind(ORG)
    .bind(&new_binding_id)
    .fetch_one(&mut *tx)
    .await
    .expect("insert replacement pending Segment");
    sqlx::query(
        "UPDATE runtime_bindings SET current_segment_id=$3::uuid,
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&new_binding_id)
    .bind(&new_segment_id)
    .execute(&mut *tx)
    .await
    .expect("make replacement Segment current");
    sqlx::query(
        "UPDATE heartbeat_runs
         SET context_snapshot=jsonb_set(
               jsonb_set(context_snapshot, '{runtimeBindingId}', to_jsonb($3::text), true),
               '{nativeSegmentId}', to_jsonb($4::text), true)
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&new_binding_id)
    .bind(&new_segment_id)
    .execute(&mut *tx)
    .await
    .expect("rewrite the Run snapshot to the replacement");
    tx.commit()
        .await
        .expect("commit coordinated binding replacement fixture");

    let replacement: (
        String,
        String,
        String,
        Option<String>,
        String,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT b.status, b.agent_id::text, b.principal_scope_ref,
                    b.current_segment_id::text, s.state, s.native_session_id
             FROM runtime_bindings b
             JOIN native_segments s
               ON s.org_id=b.org_id AND s.binding_id=b.id AND s.id=b.current_segment_id
             WHERE b.org_id=$1::uuid AND b.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&new_binding_id)
    .fetch_one(&database.pool)
    .await
    .expect("read active same-identity replacement");
    assert_eq!(replacement.0, "active");
    assert_eq!(replacement.1, CEO);
    assert_eq!(replacement.2, format!("org:{ORG}"));
    assert_eq!(replacement.3.as_deref(), Some(new_segment_id.as_str()));
    assert_eq!(replacement.4, "pending");
    assert_eq!(replacement.5, None);

    let before = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &old_binding_id,
        &old_segment_id,
    )
    .await;
    let replacement_before = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &new_binding_id,
        &new_segment_id,
    )
    .await;
    assert_conflict(current_checkpoint(&database.pool, &actor, &fence).await);
    assert_conflict(
        advance_checkpoint(
            &database.pool,
            &actor,
            &fence,
            Phase::NoThreadRequest,
            0,
            CheckpointTransition::PrepareThreadStart,
        )
        .await,
    );
    let after = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &old_binding_id,
        &old_segment_id,
    )
    .await;
    assert_eq!(after, before, "pinned binding rejection has no effects");
    let replacement_after = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &new_binding_id,
        &new_segment_id,
    )
    .await;
    assert_eq!(
        replacement_after, replacement_before,
        "rejected old fence does not touch the replacement binding"
    );

    let snapshot: Value = sqlx::query_scalar(
        "SELECT context_snapshot FROM heartbeat_runs
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("confirm coordinated snapshot replacement remains only fixture state");
    assert_eq!(snapshot["runtimeBindingId"], new_binding_id);
    assert_eq!(snapshot["nativeSegmentId"], new_segment_id);
}

#[tokio::test(flavor = "multi_thread")]
async fn checkpoint_rejects_a_chat_reassigned_away_from_the_fenced_agent() {
    let database = Database::start().await;
    let (actor, run_id, attempt_id, fence) = seed_execution(&database).await;
    let (binding_id, segment_id) = admitted_binding(&database.pool, &run_id).await;

    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin Chat reassignment fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)")
        .execute(&mut *tx)
        .await
        .expect("mark Chat reassignment fixture");
    sqlx::query(
        "UPDATE chat_conversations SET preferred_agent_id=NULL, routed_agent_id=NULL,
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(CHAT)
    .execute(&mut *tx)
    .await
    .expect("remove selected Agent from Chat fixture");
    tx.commit().await.expect("commit Chat reassignment fixture");

    let before = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &binding_id,
        &segment_id,
    )
    .await;
    assert_conflict(current_checkpoint(&database.pool, &actor, &fence).await);
    let after = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &binding_id,
        &segment_id,
    )
    .await;
    assert_eq!(
        after, before,
        "stale Agent selection rejection has no effects"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn thread_locator_rolls_back_when_later_checkpoint_cas_fails() {
    let database = Database::start().await;
    let (actor, run_id, attempt_id, fence) = seed_execution(&database).await;
    let (binding_id, segment_id) = admitted_binding(&database.pool, &run_id).await;
    advance_checkpoint(
        &database.pool,
        &actor,
        &fence,
        Phase::NoThreadRequest,
        0,
        CheckpointTransition::PrepareThreadStart,
    )
    .await
    .expect("persist thread-start phase before rollback regression");
    let before = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &binding_id,
        &segment_id,
    )
    .await;

    sqlx::query(
        "ALTER TABLE heartbeat_run_attempts
         ADD CONSTRAINT native_chat_test_reject_thread_known
         CHECK (protocol_phase <> 'thread_known') NOT VALID",
    )
    .execute(&database.pool)
    .await
    .expect("install transaction-local regression constraint");
    let result = advance_checkpoint(
        &database.pool,
        &actor,
        &fence,
        Phase::ThreadStartIndeterminate,
        1,
        CheckpointTransition::RecordThread {
            thread_id: OPAQUE_THREAD.to_owned(),
        },
    )
    .await;
    assert!(result.is_err(), "later checkpoint CAS must fail");
    sqlx::query(
        "ALTER TABLE heartbeat_run_attempts
         DROP CONSTRAINT native_chat_test_reject_thread_known",
    )
    .execute(&database.pool)
    .await
    .expect("remove regression constraint");

    let after = protocol_state(
        &database.pool,
        &run_id,
        &attempt_id,
        &binding_id,
        &segment_id,
    )
    .await;
    assert_eq!(after, before, "failed CAS must roll back locator and audit");
    assert_eq!(after.1, "pending");
    assert_eq!(after.2, None);
}
