use super::*;
use rudder_d1_persistence::native_chat::control::recover_expired_claimed_stop;

async fn set_expiry(
    pool: &PgPool,
    generation: &str,
    run: &str,
    generation_expired: bool,
    run_expired: bool,
) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE chat_generations SET control_lease_expires_at=clock_timestamp()+($2::int * interval '1 second') WHERE id=$1::uuid")
        .bind(generation)
        .bind(if generation_expired { -1 } else { 30 })
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp()+($2::int * interval '1 second') WHERE id=$1::uuid")
        .bind(run)
        .bind(if run_expired { -1 } else { 30 })
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn expired_claimed_stop_becomes_idempotent_control_lost_without_cleanup_claim() {
    let database = Database::start().await;
    let (actor, run, attempt, fence) = seed_execution(&database).await;
    let request = stop_request(&database.pool, &run).await;
    assert_eq!(
        request_stop(&database.pool, &actor, &request)
            .await
            .unwrap()
            .outcome,
        StopOutcome::StopIntentRecorded
    );
    set_expiry(&database.pool, &request.generation_id, &run, true, true).await;

    let (first, concurrent) = tokio::join!(
        recover_expired_claimed_stop(&database.pool, &actor, &request),
        recover_expired_claimed_stop(&database.pool, &actor, &request),
    );
    let first = first
        .unwrap()
        .expect("first operator recovery records owner loss");
    let concurrent = concurrent
        .unwrap()
        .expect("concurrent operator replay sees owner loss");
    assert_eq!(first.outcome, StopOutcome::ControlLost);
    assert_eq!(concurrent.outcome, StopOutcome::ControlLost);
    assert_ne!(first.idempotent, concurrent.idempotent);

    let original_replay = request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();
    assert!(original_replay.idempotent);
    assert_eq!(original_replay.outcome, StopOutcome::ControlLost);

    let mut second_action = request.clone();
    second_action.control_action_id = "71000000-0000-4000-8000-000000000099".into();
    second_action.expected_control_version = 1;
    let second = request_stop(&database.pool, &actor, &second_action)
        .await
        .unwrap();
    assert!(!second.idempotent);
    assert_eq!(second.outcome, StopOutcome::ControlLost);
    let second_replay = request_stop(&database.pool, &actor, &second_action)
        .await
        .unwrap();
    assert!(second_replay.idempotent);
    assert_eq!(second_replay.outcome, StopOutcome::ControlLost);

    let state: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'generationStatus',g.status,'controlState',g.control_state,
           'generationHold',g.native_admission_hold,'generationOwner',g.control_owner_token IS NOT NULL,
           'runtimeTerminal',g.runtime_terminal_at IS NOT NULL,'runStatus',r.status,
           'runHold',r.native_admission_hold,'runOwner',r.execution_owner_token IS NOT NULL,
           'processExited',r.process_exited_at IS NOT NULL,'runFinished',r.finished_at IS NOT NULL,
           'attemptStatus',a.status,'attemptFinished',a.finished_at IS NOT NULL,
           'generationIncidents',(SELECT count(*) FROM chat_generation_events e WHERE e.generation_id=g.id AND e.event_kind='control_lost'),
           'runIncidents',(SELECT count(*) FROM heartbeat_run_events e WHERE e.run_id=r.id AND e.idempotency_key='native-chat-control-lost:' || a.id::text),
           'ownerLossAudits',(SELECT count(*) FROM activity_log l WHERE l.run_id=r.id AND l.action='runtime.native_chat.owner_lost'),
           'replayAudits',(SELECT count(*) FROM activity_log l WHERE l.run_id=r.id AND l.action='runtime.native_chat.control_lost_stop_replayed'),
           'stopActions',(SELECT count(*) FROM chat_control_actions c WHERE c.expected_generation_id=g.id AND c.local_disposition='control_lost'))
         FROM chat_generations g JOIN heartbeat_runs r ON r.chat_generation_id=g.id
         JOIN heartbeat_run_attempts a ON a.run_id=r.id AND a.id=$2::uuid
         WHERE g.id=$1::uuid",
    )
    .bind(&request.generation_id)
    .bind(&attempt)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        state,
        json!({
            "generationStatus":"interrupted_unverified","controlState":"control_lost",
            "generationHold":true,"generationOwner":true,"runtimeTerminal":false,
            "runStatus":"failed","runHold":true,"runOwner":true,"processExited":false,
            "runFinished":true,"attemptStatus":"failed","attemptFinished":true,
            "generationIncidents":1,"runIncidents":1,"ownerLossAudits":1,
            "replayAudits":1,"stopActions":2
        })
    );
    assert!(renew_lease(&database.pool, &actor, &fence).await.is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn owner_loss_requires_both_expired_leases_exact_attempt_and_operator_actor() {
    let database = Database::start().await;
    let (actor, run, attempt, _) = seed_execution(&database).await;
    let request = stop_request(&database.pool, &run).await;
    request_stop(&database.pool, &actor, &request)
        .await
        .unwrap();

    set_expiry(&database.pool, &request.generation_id, &run, true, false).await;
    assert!(
        recover_expired_claimed_stop(&database.pool, &actor, &request)
            .await
            .unwrap()
            .is_none()
    );
    let other_org = verified_actor(OTHER, "foreign-user", "owner-loss-foreign-org");
    assert!(
        recover_expired_claimed_stop(&database.pool, &other_org, &request)
            .await
            .is_err()
    );

    set_expiry(&database.pool, &request.generation_id, &run, true, true).await;
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE heartbeat_run_attempts SET generation_attempt_epoch=2 WHERE id=$1::uuid")
        .bind(&attempt)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(
        recover_expired_claimed_stop(&database.pool, &actor, &request)
            .await
            .unwrap()
            .is_none()
    );
    let generation_status: String =
        sqlx::query_scalar("SELECT status FROM chat_generations WHERE id=$1::uuid")
            .bind(&request.generation_id)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(generation_status, "stop_requested");
}

#[tokio::test(flavor = "multi_thread")]
async fn agent_stop_keeps_the_normal_live_owner_receipt_without_operator_recovery() {
    let database = Database::start().await;
    let (_user, run, _, _) = seed_execution(&database).await;
    let request = stop_request(&database.pool, &run).await;
    let agent = verified_actor_kind(ORG, "agent", CEO, "owner-loss-agent-stop");

    let stop = request_stop(&database.pool, &agent, &request)
        .await
        .unwrap();
    assert_eq!(stop.outcome, StopOutcome::StopIntentRecorded);
    assert!(
        recover_expired_claimed_stop(&database.pool, &agent, &request)
            .await
            .unwrap()
            .is_none()
    );
    let (generation_status, run_status): (String, String) = sqlx::query_as(
        "SELECT g.status,r.status FROM chat_generations g JOIN heartbeat_runs r ON r.chat_generation_id=g.id WHERE g.id=$1::uuid",
    )
    .bind(&request.generation_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(generation_status, "stop_requested");
    assert_eq!(run_status, "running");
}
