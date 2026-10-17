use super::*;

#[tokio::test(flavor = "multi_thread")]
async fn expired_after_lock_wait_and_concurrent_newer_attempt_are_rejected() {
    let database = Database::start().await;
    let (actor, run_id, attempt_id, fence) = seed_execution(&database).await;

    let mut expiry_fixture = database.pool.begin().await.expect("begin expiry fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)")
        .execute(&mut *expiry_fixture)
        .await
        .expect("set write marker for expiry fixture");
    sqlx::query(
        "UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp()+interval '600 milliseconds'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .execute(&mut *expiry_fixture)
    .await
    .expect("set short Run lease for wait regression");
    expiry_fixture
        .commit()
        .await
        .expect("commit expiry fixture");

    let mut conversation_lock = database.pool.begin().await.expect("begin target lock");
    sqlx::query(
        "SELECT id FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    )
    .bind(ORG)
    .bind(CHAT)
    .fetch_one(&mut *conversation_lock)
    .await
    .expect("hold Conversation lock");
    let task_pool = database.pool.clone();
    let task_actor = actor.clone();
    let task_fence = fence.clone();
    let renew_task =
        tokio::spawn(async move { renew_lease(&task_pool, &task_actor, &task_fence).await });
    wait_for_lock_wait(&database.pool, "chat_conversations").await;
    let expired: bool = sqlx::query_scalar(
        "SELECT execution_lease_expires_at <= clock_timestamp()
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("wait for lease expiry while operation is blocked");
    let mut observed_expiry = expired;
    for _ in 0..200 {
        if observed_expiry {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
        observed_expiry = sqlx::query_scalar(
            "SELECT execution_lease_expires_at <= clock_timestamp()
             FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(ORG)
        .bind(&run_id)
        .fetch_one(&database.pool)
        .await
        .expect("poll Run lease expiry");
    }
    assert!(
        observed_expiry,
        "Run lease expires while write waits on Conversation"
    );
    conversation_lock
        .commit()
        .await
        .expect("release Conversation lock");
    assert_conflict(renew_task.await.expect("join lease renewal"));

    let unchanged: (bool, bool) = sqlx::query_as(
        "SELECT g.native_admission_hold, r.native_admission_hold
         FROM chat_generations g JOIN heartbeat_runs r
           ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read holds after stale renewal");
    assert_eq!(unchanged, (true, true));

    // Reset only the test lease so the newer-attempt FK race can exercise its
    // own current-attempt check without changing production lease semantics.
    let mut reset = database
        .pool
        .begin()
        .await
        .expect("begin lease reset fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)")
        .execute(&mut *reset)
        .await
        .expect("mark lease reset fixture");
    sqlx::query(
        "UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp()+interval '30 seconds'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .execute(&mut *reset)
    .await
    .expect("restore test execution lease");
    reset.commit().await.expect("commit test lease reset");

    let mut newer_attempt = database
        .pool
        .begin()
        .await
        .expect("begin newer attempt insert");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)")
        .execute(&mut *newer_attempt)
        .await
        .expect("mark newer attempt fixture");
    sqlx::query(
        "INSERT INTO heartbeat_run_attempts
           (org_id, run_id, agent_id, attempt_index, runtime_type, resume_source,
            status, owner_token, attempt_epoch, generation_attempt_epoch,
            connection_epoch, protocol_phase, checkpoint_json)
         SELECT a.org_id, a.run_id, a.agent_id, 2, a.runtime_type, 'fresh',
                'started', 'synthetic-newer-owner', 2, a.generation_attempt_epoch,
                a.connection_epoch+1, a.protocol_phase, a.checkpoint_json
         FROM heartbeat_run_attempts a WHERE a.org_id=$1::uuid AND a.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&attempt_id)
    .execute(&mut *newer_attempt)
    .await
    .expect("insert a syntactically valid newer attempt");
    let task_pool = database.pool.clone();
    let task_actor = actor.clone();
    let task_fence = fence.clone();
    let advance_task = tokio::spawn(async move {
        advance_checkpoint(
            &task_pool,
            &task_actor,
            &task_fence,
            Phase::NoThreadRequest,
            0,
            CheckpointTransition::PrepareThreadStart,
        )
        .await
    });
    wait_for_lock_wait(&database.pool, "heartbeat_runs").await;
    newer_attempt.commit().await.expect("commit newer attempt");
    assert_conflict(advance_task.await.expect("join current-attempt transition"));

    let checkpoint: Value = sqlx::query_scalar(
        "SELECT checkpoint_json FROM heartbeat_run_attempts
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read original Attempt checkpoint after newer insert");
    assert_eq!(checkpoint["phase"], "no_thread_request");
    assert_eq!(checkpoint["revision"], 0);
}
