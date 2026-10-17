use super::effects::{additional_execution, submit_permit};
use super::*;
use rudder_d1_persistence::native_chat::execution::{
    EffectDispatch, ExecutionFence, SubmissionInput, authorize_effect, validate_submission_source,
};

async fn prepare_for_submission(
    database: &Database,
    actor: &VerifiedActor,
    fence: &ExecutionFence,
) {
    for (phase, revision, transition) in [
        (
            Phase::NoThreadRequest,
            0,
            CheckpointTransition::PrepareThreadStart,
        ),
        (
            Phase::ThreadStartIndeterminate,
            1,
            CheckpointTransition::RecordThread {
                thread_id: OPAQUE_THREAD.to_owned(),
            },
        ),
        (Phase::ThreadKnown, 2, CheckpointTransition::PrepareInput),
    ] {
        advance_checkpoint(&database.pool, actor, fence, phase, revision, transition)
            .await
            .expect("prepare first input through durable checkpoints");
    }
}

async fn assert_no_submit_dispatch(
    database: &Database,
    actor: &VerifiedActor,
    permit: rudder_d1_persistence::native_chat::execution::EffectPermit,
    input: SubmissionInput,
) {
    let mut callbacks = 0;
    assert_conflict(
        authorize_effect(&database.pool, actor, permit, Some(input))
            .await
            .and_then(|authorized| {
                authorized.dispatch(|effect| {
                    callbacks += 1;
                    assert!(matches!(effect, EffectDispatch::SubmitInput { .. }));
                })
            }),
    );
    assert_eq!(callbacks, 0, "unsupported source content must not dispatch");
}

async fn add_attachment(database: &Database, message_id: &str) {
    sqlx::query(
        "INSERT INTO chat_attachments (org_id, conversation_id, message_id, asset_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)",
    )
    .bind(ORG)
    .bind(CHAT)
    .bind(message_id)
    .bind(support::ASSET)
    .execute(&database.pool)
    .await
    .expect("attach an existing organization asset to the admitted source message");
}

async fn set_structured_payload(database: &Database, message_id: &str) {
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin fixture transaction");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:test', true)")
        .execute(&mut *tx)
        .await
        .expect("mark native fixture update");
    sqlx::query(
        r#"UPDATE chat_messages SET structured_payload='{"source":"unsupported"}'::jsonb
           WHERE org_id=$1::uuid AND id=$2::uuid"#,
    )
    .bind(ORG)
    .bind(message_id)
    .execute(&mut *tx)
    .await
    .expect("seed unsupported structured source payload");
    tx.commit().await.expect("commit fixture payload");
}

async fn source_message_id(database: &Database, fence: &ExecutionFence) -> String {
    sqlx::query_scalar(
        "SELECT source_message_id::text FROM chat_generations
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(fence.identity().generation_id)
    .fetch_one(&database.pool)
    .await
    .expect("read admitted source message id")
}

#[tokio::test(flavor = "multi_thread")]
async fn pre_thread_source_validation_is_read_only_and_rejects_unsupported_content() {
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
    .expect("claim admitted Native Chat execution");
    let fence = claimed.fence;
    let before = current_checkpoint(&database.pool, &actor, &fence)
        .await
        .expect("read fresh pre-thread checkpoint");
    validate_submission_source(&database.pool, &actor, &fence)
        .await
        .expect("verify valid exact source without returning its body");
    let message_id = source_message_id(&database, &fence).await;
    add_attachment(&database, &message_id).await;
    assert_conflict(validate_submission_source(&database.pool, &actor, &fence).await);
    let after = current_checkpoint(&database.pool, &actor, &fence)
        .await
        .expect("read checkpoint after unsupported source rejection");
    assert_eq!(
        after, before,
        "pre-thread validation has no checkpoint effects"
    );
    let (phase, native_session_id): (String, Option<String>) = sqlx::query_as(
        "SELECT s.state, s.native_session_id
         FROM heartbeat_runs r
         JOIN runtime_bindings b ON b.org_id=r.org_id
           AND b.id=(r.context_snapshot->>'runtimeBindingId')::uuid
         JOIN native_segments s ON s.org_id=b.org_id AND s.binding_id=b.id
           AND s.id=(r.context_snapshot->>'nativeSegmentId')::uuid
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read still-pending initial Segment");
    assert_eq!(phase, "pending");
    assert_eq!(native_session_id, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn load_submission_rejects_attachments_and_structured_payloads() {
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
    .expect("claim ordinary Chat execution");
    prepare_for_submission(&database, &actor, &claimed.fence).await;
    let message_id = source_message_id(&database, &claimed.fence).await;
    add_attachment(&database, &message_id).await;
    assert_conflict(load_submission(&database.pool, &actor, &claimed.fence).await);

    let (_, _, second_fence) = additional_execution(
        &database,
        &host,
        &actor,
        "21000000-0000-4000-8000-000000000202",
        "structured-payload-load",
    )
    .await;
    prepare_for_submission(&database, &actor, &second_fence).await;
    let message_id = source_message_id(&database, &second_fence).await;
    set_structured_payload(&database, &message_id).await;
    assert_conflict(load_submission(&database.pool, &actor, &second_fence).await);
}

#[tokio::test(flavor = "multi_thread")]
async fn submit_authorization_rejects_attachment_added_after_load_without_dispatch() {
    let database = Database::start().await;
    let (actor, _run_id, _attempt_id, fence) = seed_execution(&database).await;
    let (permit, input) = submit_permit(&database, &actor, &fence).await;
    add_attachment(&database, input.message_id()).await;
    assert_no_submit_dispatch(&database, &actor, permit, input).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn submit_authorization_rejects_structured_payload_added_after_load_without_dispatch() {
    let database = Database::start().await;
    let (actor, _run_id, _attempt_id, fence) = seed_execution(&database).await;
    let (permit, input) = submit_permit(&database, &actor, &fence).await;
    set_structured_payload(&database, input.message_id()).await;
    assert_no_submit_dispatch(&database, &actor, permit, input).await;
}
