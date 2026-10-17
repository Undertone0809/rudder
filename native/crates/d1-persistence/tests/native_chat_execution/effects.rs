use super::*;
use rudder_d1_persistence::native_chat::execution::{
    EffectPermit, SubmissionInput, authorize_effect,
};

const OTHER_CHAT: &str = "21000000-0000-4000-8000-000000000202";
const THIRD_CHAT: &str = "21000000-0000-4000-8000-000000000203";
const FOURTH_CHAT: &str = "21000000-0000-4000-8000-000000000204";
const FIFTH_CHAT: &str = "21000000-0000-4000-8000-000000000205";

pub(super) async fn additional_execution(
    database: &Database,
    host: &ExecutionHost,
    actor: &VerifiedActor,
    conversation_id: &str,
    key: &str,
) -> (
    String,
    String,
    rudder_d1_persistence::native_chat::execution::ExecutionFence,
) {
    sqlx::query(
        "INSERT INTO chat_conversations
           (id, org_id, title, conversation_kind, created_by_user_id, status, preferred_agent_id)
         VALUES ($1::uuid, $2::uuid, 'Native effect fixture', 'chat', $3, 'active', $4::uuid)",
    )
    .bind(conversation_id)
    .bind(ORG)
    .bind(USER)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed additional ordinary Chat");

    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation": "submit_native_chat_turn",
        "conversationId": conversation_id,
        "clientMutationId": format!("native-effect-{key}"),
        "body": format!("admitted native input {key}"),
    }))
    .expect("valid additional admission request");
    let receipt = execute(&database.pool, actor, ORG, &request, host.context())
        .await
        .expect("admit additional Native Chat execution");
    let run_id = receipt["runId"].as_str().unwrap().to_owned();
    let attempt_id = receipt["attemptId"].as_str().unwrap().to_owned();
    let claimed = claim(
        &database.pool,
        actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    .expect("claim additional Native Chat execution");
    (run_id, attempt_id, claimed.fence)
}

async fn start_permit(
    database: &Database,
    actor: &VerifiedActor,
    fence: &rudder_d1_persistence::native_chat::execution::ExecutionFence,
) -> EffectPermit {
    advance_checkpoint(
        &database.pool,
        actor,
        fence,
        Phase::NoThreadRequest,
        0,
        CheckpointTransition::PrepareThreadStart,
    )
    .await
    .expect("commit Thread-start indeterminate phase")
    .take_effect_permit()
    .expect("fresh Thread-start permit")
}

pub(super) async fn submit_permit(
    database: &Database,
    actor: &VerifiedActor,
    fence: &rudder_d1_persistence::native_chat::execution::ExecutionFence,
) -> (EffectPermit, SubmissionInput) {
    advance_checkpoint(
        &database.pool,
        actor,
        fence,
        Phase::NoThreadRequest,
        0,
        CheckpointTransition::PrepareThreadStart,
    )
    .await
    .expect("prepare Thread start");
    advance_checkpoint(
        &database.pool,
        actor,
        fence,
        Phase::ThreadStartIndeterminate,
        1,
        CheckpointTransition::RecordThread {
            thread_id: OPAQUE_THREAD.to_owned(),
        },
    )
    .await
    .expect("record exact provider Thread");
    advance_checkpoint(
        &database.pool,
        actor,
        fence,
        Phase::ThreadKnown,
        2,
        CheckpointTransition::PrepareInput,
    )
    .await
    .expect("prepare first input");
    let input = load_submission(&database.pool, actor, fence)
        .await
        .expect("load exact admitted input before submit transition");
    let permit = advance_checkpoint(
        &database.pool,
        actor,
        fence,
        Phase::InputPreSubmission,
        3,
        CheckpointTransition::MarkInputIndeterminate,
    )
    .await
    .expect("commit non-replayable Submit phase")
    .take_effect_permit()
    .expect("fresh SubmitInput permit");
    (permit, input)
}

async fn mark_native_write(pool: &PgPool) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = pool.begin().await.expect("begin fixture transaction");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)")
        .execute(&mut *tx)
        .await
        .expect("mark fixture transaction");
    tx
}

#[tokio::test(flavor = "multi_thread")]
async fn start_effect_dispatch_is_synchronous_and_stale_revision_cannot_dispatch() {
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
    .expect("claim Thread-start execution");
    let permit = start_permit(&database, &actor, &claimed.fence).await;
    let authorized = authorize_effect(&database.pool, &actor, permit, None)
        .await
        .expect("authorize freshly committed Thread start");
    let mut dispatch_count = 0;
    let receipt = authorized
        .dispatch(|effect| {
            dispatch_count += 1;
            assert!(matches!(effect, EffectDispatch::StartThread));
            "queued"
        })
        .expect("dispatch within the owner lease window");
    assert_eq!(receipt, "queued");
    assert_eq!(dispatch_count, 1);

    let (_other_run, _other_attempt, other_fence) =
        additional_execution(&database, &host, &actor, OTHER_CHAT, "revision").await;
    let stale_permit = start_permit(&database, &actor, &other_fence).await;
    advance_checkpoint(
        &database.pool,
        &actor,
        &other_fence,
        Phase::ThreadStartIndeterminate,
        1,
        CheckpointTransition::RecordThread {
            thread_id: OPAQUE_THREAD.to_owned(),
        },
    )
    .await
    .expect("move checkpoint past the one-use permit revision");
    let mut stale_dispatch_count = 0;
    assert_conflict(
        authorize_effect(&database.pool, &actor, stale_permit, None)
            .await
            .and_then(|authorized| {
                authorized.dispatch(|_| {
                    stale_dispatch_count += 1;
                })
            }),
    );
    assert_eq!(stale_dispatch_count, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn submit_effect_dispatch_contains_exact_thread_message_and_admitted_body() {
    let database = Database::start().await;
    let (actor, _run_id, _attempt_id, fence) = seed_execution(&database).await;
    let (permit, input) = submit_permit(&database, &actor, &fence).await;
    assert_eq!(input.checkpoint_revision() + 1, permit.committed_revision());
    let authorized = authorize_effect(&database.pool, &actor, permit, Some(input))
        .await
        .expect("authorize exact pre-submit input");
    let dispatch = authorized
        .dispatch(|effect| match effect {
            EffectDispatch::SubmitInput {
                thread_id,
                source_message_id,
                body,
            } => (
                thread_id.to_owned(),
                source_message_id.to_owned(),
                body.to_owned(),
            ),
            EffectDispatch::StartThread => panic!("Submit permit produced Thread start"),
            EffectDispatch::StartHermesSession => panic!("Submit permit produced Hermes session start"),
            EffectDispatch::SubmitHermesInput { .. } => panic!("Submit permit produced Hermes input"),
        })
        .expect("dispatch exact Submit request");
    assert_eq!(dispatch.0, OPAQUE_THREAD);
    assert_eq!(dispatch.1, inputless_message_id(&database, &fence).await);
    assert_eq!(dispatch.2, "begin a durable native execution");
}

async fn inputless_message_id(
    database: &Database,
    fence: &rudder_d1_persistence::native_chat::execution::ExecutionFence,
) -> String {
    sqlx::query_scalar(
        "SELECT source_message_id::text FROM chat_generations
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(fence.identity().generation_id)
    .fetch_one(&database.pool)
    .await
    .expect("read admitted source message identity")
}

#[tokio::test(flavor = "multi_thread")]
async fn submit_rejects_wrong_input_and_thread_without_dispatch() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run_id, attempt_id) = prepare(&database, &host).await;
    let first = claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    .expect("claim first execution");
    let (permit, _exact_input) = submit_permit(&database, &actor, &first.fence).await;
    let (_other_run, _other_attempt, other_fence) =
        additional_execution(&database, &host, &actor, OTHER_CHAT, "wrong-input").await;
    let (_other_permit, foreign_input) = submit_permit(&database, &actor, &other_fence).await;
    let mut wrong_input_dispatches = 0;
    assert_conflict(
        authorize_effect(&database.pool, &actor, permit, Some(foreign_input))
            .await
            .and_then(|authorized| {
                authorized.dispatch(|_| {
                    wrong_input_dispatches += 1;
                })
            }),
    );
    assert_eq!(wrong_input_dispatches, 0);

    let (hash_run, _hash_attempt, hash_fence) =
        additional_execution(&database, &host, &actor, FIFTH_CHAT, "changed-hash").await;
    let (hash_permit, hash_input) = submit_permit(&database, &actor, &hash_fence).await;
    let mut fixture = mark_native_write(&database.pool).await;
    sqlx::query(
        "UPDATE chat_messages SET client_mutation_fingerprint='native-chat-v1:changed'
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND role='user' AND kind='message'",
    )
    .bind(ORG)
    .bind(&hash_run)
    .execute(&mut *fixture)
    .await
    .expect("change source fingerprint fixture");
    fixture.commit().await.expect("commit changed input hash");
    let mut wrong_hash_dispatches = 0;
    assert_conflict(
        authorize_effect(&database.pool, &actor, hash_permit, Some(hash_input))
            .await
            .and_then(|authorized| {
                authorized.dispatch(|_| {
                    wrong_hash_dispatches += 1;
                })
            }),
    );
    assert_eq!(wrong_hash_dispatches, 0);

    let (_thread_run, _thread_attempt, thread_fence) =
        additional_execution(&database, &host, &actor, THIRD_CHAT, "wrong-thread").await;
    let (thread_permit, thread_input) = submit_permit(&database, &actor, &thread_fence).await;
    let (binding_id, segment_id): (String, String) = sqlx::query_as(
        "SELECT context_snapshot->>'runtimeBindingId', context_snapshot->>'nativeSegmentId'
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(thread_fence.identity().run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read exact Segment association");
    let mut fixture = mark_native_write(&database.pool).await;
    sqlx::query(
        "UPDATE native_segments SET native_session_id='changed-thread-locator'
         WHERE org_id=$1::uuid AND binding_id=$2::uuid AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(binding_id)
    .bind(segment_id)
    .execute(&mut *fixture)
    .await
    .expect("corrupt Thread locator fixture");
    fixture
        .commit()
        .await
        .expect("commit Thread mismatch fixture");
    let mut wrong_thread_dispatches = 0;
    assert_conflict(
        authorize_effect(&database.pool, &actor, thread_permit, Some(thread_input))
            .await
            .and_then(|authorized| {
                authorized.dispatch(|_| {
                    wrong_thread_dispatches += 1;
                })
            }),
    );
    assert_eq!(wrong_thread_dispatches, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn both_owner_fences_and_each_lease_are_rechecked_before_dispatch() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, run_id, attempt_id) = prepare(&database, &host).await;
    let first = claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    .expect("claim first fence case");
    let cases = [
        ("generation-owner", CHAT, true, false),
        ("run-owner", OTHER_CHAT, false, false),
        ("generation-lease", THIRD_CHAT, false, true),
        ("run-lease", FOURTH_CHAT, false, true),
    ];
    for (index, (case, conversation_id, generation_owner, lease)) in cases.into_iter().enumerate() {
        let fence = if index == 0 {
            first.fence.clone()
        } else {
            additional_execution(&database, &host, &actor, conversation_id, case)
                .await
                .2
        };
        let permit = start_permit(&database, &actor, &fence).await;
        let mut fixture = mark_native_write(&database.pool).await;
        if generation_owner {
            sqlx::query(
                "UPDATE chat_generations SET control_owner_token='changed-generation-owner'
                 WHERE org_id=$1::uuid AND id=$2::uuid",
            )
            .bind(ORG)
            .bind(fence.identity().generation_id)
            .execute(&mut *fixture)
            .await
            .expect("change Generation owner fixture");
        } else if case == "run-owner" {
            sqlx::query(
                "UPDATE heartbeat_runs SET execution_owner_token='changed-run-owner'
                 WHERE org_id=$1::uuid AND id=$2::uuid",
            )
            .bind(ORG)
            .bind(fence.identity().run_id)
            .execute(&mut *fixture)
            .await
            .expect("change Run owner fixture");
        } else if lease && case == "generation-lease" {
            sqlx::query(
                "UPDATE chat_generations SET control_lease_expires_at=clock_timestamp()-interval '1 millisecond'
                 WHERE org_id=$1::uuid AND id=$2::uuid",
            )
            .bind(ORG)
            .bind(fence.identity().generation_id)
            .execute(&mut *fixture)
            .await
            .expect("expire Generation lease fixture");
        } else {
            sqlx::query(
                "UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp()-interval '1 millisecond'
                 WHERE org_id=$1::uuid AND id=$2::uuid",
            )
            .bind(ORG)
            .bind(fence.identity().run_id)
            .execute(&mut *fixture)
            .await
            .expect("expire Run lease fixture");
        }
        fixture.commit().await.expect("commit stale owner fixture");

        let mut dispatches = 0;
        assert_conflict(
            authorize_effect(&database.pool, &actor, permit, None)
                .await
                .and_then(|authorized| {
                    authorized.dispatch(|_| {
                        dispatches += 1;
                    })
                }),
        );
        assert_eq!(dispatches, 0, "stale {case} must not dispatch");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn dispatch_deadline_is_short_and_lease_bounded() {
    let database = Database::start().await;
    let (actor, run_id, _attempt_id, fence) = seed_execution(&database).await;
    let permit = start_permit(&database, &actor, &fence).await;
    let mut fixture = mark_native_write(&database.pool).await;
    sqlx::query(
        "UPDATE chat_generations SET control_lease_expires_at=clock_timestamp()+interval '30 seconds'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(fence.identity().generation_id)
    .execute(&mut *fixture)
    .await
    .expect("set live Generation lease fixture");
    sqlx::query(
        "UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp()+interval '30 seconds'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .execute(&mut *fixture)
    .await
    .expect("set live Run lease fixture");
    fixture.commit().await.expect("commit live lease fixture");

    let authorized = authorize_effect(&database.pool, &actor, permit, None)
        .await
        .expect("authorize within both live leases");
    tokio::time::sleep(Duration::from_millis(2_100)).await;
    let mut dispatches = 0;
    assert_conflict(authorized.dispatch(|_| {
        dispatches += 1;
    }));
    assert_eq!(dispatches, 0, "expired authorization cannot dispatch");
}

#[tokio::test(flavor = "multi_thread")]
async fn database_wait_consumes_the_effect_deadline() {
    let database = Database::start().await;
    let (actor, run_id, attempt_id, fence) = seed_execution(&database).await;
    let permit = start_permit(&database, &actor, &fence).await;

    let mut lease_lock = mark_native_write(&database.pool).await;
    sqlx::query(
        "UPDATE chat_generations SET control_lease_expires_at=clock_timestamp()+interval '5 seconds'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(fence.identity().generation_id)
    .execute(&mut *lease_lock)
    .await
    .expect("set short but live Generation lease");

    let task_pool = database.pool.clone();
    let task_actor = actor.clone();
    let authorization =
        tokio::spawn(async move { authorize_effect(&task_pool, &task_actor, permit, None).await });
    wait_for_lock_wait(&database.pool, "FROM chat_generations").await;
    tokio::time::sleep(Duration::from_millis(3_200)).await;
    lease_lock
        .commit()
        .await
        .expect("release Generation row after consuming most of its lease");

    let authorized = authorization
        .await
        .expect("join delayed authorization")
        .expect("Generation lease remains briefly live after row unlock");
    let mut dispatches = 0;
    assert_conflict(authorized.dispatch(|_| {
        dispatches += 1;
    }));
    assert_eq!(dispatches, 0);
    let current: (String, bool) = sqlx::query_as(
        "SELECT a.protocol_phase, r.native_admission_hold
         FROM heartbeat_run_attempts a
         JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND a.id=$3::uuid",
    )
    .bind(ORG)
    .bind(run_id)
    .bind(attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read durable checkpoint after expired dispatch authorization");
    assert_eq!(current, ("thread_start_indeterminate".to_owned(), true));
}
