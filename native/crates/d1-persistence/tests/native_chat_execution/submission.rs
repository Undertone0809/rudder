use super::*;
use rudder_d1_persistence::native_chat::execution::{ExecutionFence, load_submission};

async fn prepare_input(database: &Database, actor: &VerifiedActor, fence: &ExecutionFence) {
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

#[tokio::test(flavor = "multi_thread")]
async fn submission_reads_only_admitted_input_before_first_effect() {
    let database = Database::start().await;
    let (actor, run_id, attempt_id, fence) = seed_execution(&database).await;
    assert_conflict(load_submission(&database.pool, &actor, &fence).await);
    prepare_input(&database, &actor, &fence).await;
    // Unrelated history must never be assembled into the provider input.
    sqlx::query(
        "INSERT INTO chat_messages (org_id, conversation_id, role, kind, status, body)
        VALUES ($1::uuid,$2::uuid,'assistant','message','completed','old private history')",
    )
    .bind(ORG)
    .bind(CHAT)
    .execute(&database.pool)
    .await
    .expect("seed old history");
    let input = load_submission(&database.pool, &actor, &fence)
        .await
        .expect("read original input");
    assert_eq!(input.body(), "begin a durable native execution");
    assert_eq!(input.run_id(), run_id);
    assert_eq!(input.attempt_id(), attempt_id);
    assert_eq!(input.checkpoint_revision(), 3);
    let expected: String = sqlx::query_scalar(
        "SELECT source_message_id::text FROM chat_generations
        WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(fence.identity().generation_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(input.message_id(), expected);
    let foreign = verified_actor(OTHER, USER, "foreign-submission");
    assert!(matches!(
        load_submission(&database.pool, &foreign, &fence).await,
        Err(Error::Http(403, _))
    ));
    let mut receipt = advance_checkpoint(
        &database.pool,
        &actor,
        &fence,
        Phase::InputPreSubmission,
        3,
        CheckpointTransition::MarkInputIndeterminate,
    )
    .await
    .expect("commit once-only input permit");
    let permit = receipt.take_effect_permit().unwrap();
    assert_eq!(permit.run_id(), input.run_id());
    assert_eq!(permit.attempt_id(), input.attempt_id());
    assert_eq!(permit.committed_revision(), input.checkpoint_revision() + 1);
    assert_conflict(load_submission(&database.pool, &actor, &fence).await);
    let state = current_checkpoint(&database.pool, &actor, &fence)
        .await
        .unwrap();
    assert_eq!(state.phase, Phase::InputIndeterminate);
    assert_eq!(state.revision, 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn submission_rejects_mutated_input_and_message_lock_without_losing_ownership() {
    let database = Database::start().await;
    let (actor, run_id, _, fence) = seed_execution(&database).await;
    prepare_input(&database, &actor, &fence).await;
    let mut edit = database.pool.begin().await.unwrap();
    sqlx::query(
        "SELECT id FROM chat_messages WHERE org_id=$1::uuid AND run_id=$2::uuid FOR UPDATE",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&mut *edit)
    .await
    .unwrap();
    assert_conflict(
        tokio::time::timeout(
            Duration::from_secs(3),
            load_submission(&database.pool, &actor, &fence),
        )
        .await
        .expect("reader must not deadlock behind editor"),
    );
    edit.rollback().await.unwrap();
    let input = load_submission(&database.pool, &actor, &fence)
        .await
        .unwrap();
    let message_id = input.message_id().to_owned();
    let mut edit = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:test', true)")
        .execute(&mut *edit)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE chat_messages SET body='changed input',
        client_mutation_fingerprint=$3 WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&message_id)
    // Even editing the message fingerprint cannot alter the admitted Run snapshot.
    .bind("native-chat-v1:22689eedfa0d5a07b6e6d7e0b198ea13cf6614daeb6481a31b9a39e45854ae5a")
    .execute(&mut *edit)
    .await
    .unwrap();
    edit.commit().await.unwrap();
    assert_conflict(load_submission(&database.pool, &actor, &fence).await);
    let state = current_checkpoint(&database.pool, &actor, &fence)
        .await
        .unwrap();
    assert_eq!(state.phase, Phase::InputPreSubmission);
    assert_eq!(state.revision, 3);
    let held: (bool, bool) = sqlx::query_as("SELECT r.native_admission_hold, g.native_admission_hold
        FROM heartbeat_runs r JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
        WHERE r.org_id=$1::uuid AND r.id=$2::uuid")
        .bind(ORG).bind(&run_id).fetch_one(&database.pool).await.unwrap();
    assert_eq!(held, (true, true));
}
