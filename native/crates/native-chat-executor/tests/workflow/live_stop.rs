use crate::fixture::*;
use rudder_d1_persistence::native_chat::{
    control::{StopOutcome, StopRequest, request_stop},
    execution,
};
use rudder_native_chat_executor::{ExecutionRequest, run_on_blocking_thread};
use serde_json::Value;
use std::{sync::atomic::AtomicBool, time::Duration};

async fn request(pool: &sqlx::PgPool, run: &str) -> StopRequest {
    let (generation,version):(String,i32)=sqlx::query_as("SELECT g.id::text,g.control_version FROM chat_generations g JOIN heartbeat_runs r ON r.chat_generation_id=g.id WHERE r.id=$1::uuid")
        .bind(run).fetch_one(pool).await.unwrap();
    StopRequest {
        conversation_id: CHAT.into(),
        generation_id: generation,
        control_action_id: "72000000-0000-4000-8000-000000000001".into(),
        expected_attempt_epoch: 1,
        expected_control_version: version,
        requested_render_seq: 0,
        requested_body_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            .into(),
    }
}
async fn wait_phase(pool: &sqlx::PgPool, attempt: &str, phase: &str) {
    for _ in 0..500 {
        let actual: Option<String> = sqlx::query_scalar(
            "SELECT protocol_phase FROM heartbeat_run_attempts WHERE id=$1::uuid",
        )
        .bind(attempt)
        .fetch_one(pool)
        .await
        .unwrap();
        if actual.as_deref() == Some(phase) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("executor never reached expected phase {phase}");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and synthetic provider"]
async fn live_stop_interrupts_once_and_preserves_actual_terminal_without_tail_projection() {
    assert_ignored_external_dependencies();
    for mode in [
        "live-stop",
        "live-stop-completed",
        "live-stop-late-turn",
        "live-stop-stale-terminal",
        "live-stop-cutoff",
    ] {
        let (database, host, actor, run, attempt) = database_and_admission(mode).await;
        let release = host.probe_path("release-turn-start");
        let pending = host.probe_path("turn-start-pending");
        let worker_pool = database.pool.clone();
        let worker_actor = actor.clone();
        let worker_run = run.clone();
        let worker_attempt = attempt.clone();
        let handle = tokio::runtime::Handle::current();
        let worker = tokio::task::spawn_blocking(move || {
            let cancelled = AtomicBool::new(false);
            let result = run_on_blocking_thread(
                &handle,
                &worker_pool,
                &worker_actor,
                host.context(),
                &host.paths(),
                ExecutionRequest {
                    organization_id: ORG,
                    run_id: &worker_run,
                    attempt_id: &worker_attempt,
                    timeout: Duration::from_secs(15),
                    cancelled: &cancelled,
                },
            );
            (result, host)
        });
        if mode == "live-stop-late-turn" {
            for _ in 0..500 {
                if pending.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(pending.exists());
        } else {
            wait_phase(&database.pool, &attempt, "turn_known").await;
        }
        let mut request = request(&database.pool, &run).await;
        if mode == "live-stop-cutoff" {
            let mut tx = database.pool.begin().await.unwrap();
            sqlx::query(
                "SELECT set_config('rudder.native_chat_write','native_chat:test_live_cutoff',true)",
            )
            .execute(&mut *tx)
            .await
            .unwrap();
            let hash = "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";
            sqlx::query("INSERT INTO chat_messages(org_id,conversation_id,role,kind,status,body,run_id) VALUES($1::uuid,$2::uuid,'assistant','message','streaming','a',$3::uuid)").bind(ORG).bind(CHAT).bind(&run).execute(&mut *tx).await.unwrap();
            sqlx::query("INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,run_id) VALUES($1::uuid,$2::uuid,2,1,'assistant_delta',$3,$4::uuid)").bind(ORG).bind(&request.generation_id).bind(serde_json::json!({"delta":"a","bodyHash":hash})).bind(&run).execute(&mut *tx).await.unwrap();
            tx.commit().await.unwrap();
            request.requested_render_seq = 2;
            request.requested_body_hash = hash.into();
        }
        let initial = request_stop(&database.pool, &actor, &request)
            .await
            .unwrap();
        assert_eq!(initial.outcome, StopOutcome::StopIntentRecorded);
        if mode == "live-stop-late-turn" {
            std::fs::write(release, "release").unwrap();
        }
        let (observed, host) = worker.await.unwrap();
        let observed = observed.expect("matching Stop terminal observed");
        let stop = observed.stop.as_ref().expect("durable stop latched");
        assert_eq!(
            host.events()
                .iter()
                .filter(|e| e["received"]["method"] == "turn/start")
                .count(),
            1
        );
        assert_eq!(
            host.events()
                .iter()
                .filter(|e| e["received"]["method"] == "turn/interrupt")
                .count(),
            1
        );
        assert!(
            execution::finalize(
                &database.pool,
                &actor,
                &observed.fence,
                &observed.turn_receipt,
                observed.cleanup_receipt.as_ref().unwrap()
            )
            .await
            .is_err()
        );
        let result = execution::finalize_stopped(
            &database.pool,
            &actor,
            &observed.fence,
            &observed.turn_receipt,
            observed.cleanup_receipt.as_ref().unwrap(),
            stop,
        )
        .await
        .unwrap();
        assert_eq!(result["status"], "cancelled");
        assert_eq!(result["generationStatus"], "stopped");
        assert_eq!(result["nativeAdmissionHold"], false);
        if mode == "live-stop-cutoff" {
            assert!(result["assistantMessageId"].is_string());
            let body: String =
                sqlx::query_scalar("SELECT body FROM chat_messages WHERE id=$1::uuid")
                    .bind(result["assistantMessageId"].as_str())
                    .fetch_one(&database.pool)
                    .await
                    .unwrap();
            assert_eq!(body, "a");
        } else {
            assert_eq!(result["assistantMessageId"], Value::Null);
        }
        assert_eq!(
            execution::finalize_stopped(
                &database.pool,
                &actor,
                &observed.fence,
                &observed.turn_receipt,
                observed.cleanup_receipt.as_ref().unwrap(),
                stop
            )
            .await
            .unwrap(),
            result
        );
        let state:(String,String,i64,i64,String)=sqlx::query_as("SELECT r.status,g.status,(SELECT count(*) FROM chat_messages m WHERE m.run_id=r.id AND m.role='assistant'),(SELECT count(*) FROM chat_generation_events e WHERE e.generation_id=g.id AND e.event_kind IN ('runtime_terminal','terminal_projected')),a.provider_evidence->'stopResolution'->>'actualProviderStatus' FROM heartbeat_runs r JOIN chat_generations g ON g.id=r.chat_generation_id JOIN chat_control_actions a ON a.expected_generation_id=g.id WHERE r.id=$1::uuid")
            .bind(&run).fetch_one(&database.pool).await.unwrap();
        assert_eq!(
            state,
            (
                "cancelled".into(),
                "stopped".into(),
                if mode == "live-stop-cutoff" { 1 } else { 0 },
                2,
                if mode == "live-stop-completed" {
                    "Completed"
                } else {
                    "Interrupted"
                }
                .into()
            )
        );
        let retry = request_stop(&database.pool, &actor, &request)
            .await
            .unwrap();
        assert!(retry.idempotent);
        assert_eq!(retry.outcome, initial.outcome);
        let next:AdmissionRequest=serde_json::from_value(serde_json::json!({"operation":"submit_native_chat_turn","conversationId":CHAT,"clientMutationId":"after-live-stop","body":"new input"})).unwrap();
        let next = admit(&database.pool, &actor, ORG, &next, host.context())
            .await
            .unwrap();
        assert_ne!(next["runId"].as_str(), Some(run.as_str()));
        let before: Value =
            sqlx::query_scalar("SELECT to_jsonb(r) FROM heartbeat_runs r WHERE id=$1::uuid")
                .bind(next["runId"].as_str())
                .fetch_one(&database.pool)
                .await
                .unwrap();
        assert_eq!(
            execution::finalize_stopped(
                &database.pool,
                &actor,
                &observed.fence,
                &observed.turn_receipt,
                observed.cleanup_receipt.as_ref().unwrap(),
                stop
            )
            .await
            .unwrap(),
            result
        );
        let after: Value =
            sqlx::query_scalar("SELECT to_jsonb(r) FROM heartbeat_runs r WHERE id=$1::uuid")
                .bind(next["runId"].as_str())
                .fetch_one(&database.pool)
                .await
                .unwrap();
        assert_eq!(before, after);
        sqlx::query("UPDATE organization_memberships SET status='inactive' WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2").bind(ORG).bind(&actor.actor().id).execute(&database.pool).await.unwrap();
        assert!(matches!(
            execution::finalize_stopped(
                &database.pool,
                &actor,
                &observed.fence,
                &observed.turn_receipt,
                observed.cleanup_receipt.as_ref().unwrap(),
                stop
            )
            .await,
            Err(rudder_d1_persistence::native_chat::Error::Http(403, _))
        ));
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and synthetic provider"]
async fn interrupt_ack_without_terminal_retains_holds_and_never_resends() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run, attempt) = database_and_admission("live-stop-ack-only").await;
    let pool = database.pool.clone();
    let a = actor.clone();
    let r = run.clone();
    let at = attempt.clone();
    let handle = tokio::runtime::Handle::current();
    let worker = tokio::task::spawn_blocking(move || {
        let cancelled = AtomicBool::new(false);
        let result = run_on_blocking_thread(
            &handle,
            &pool,
            &a,
            host.context(),
            &host.paths(),
            ExecutionRequest {
                organization_id: ORG,
                run_id: &r,
                attempt_id: &at,
                timeout: Duration::from_secs(4),
                cancelled: &cancelled,
            },
        );
        (result, host)
    });
    wait_phase(&database.pool, &attempt, "turn_known").await;
    request_stop(&database.pool, &actor, &request(&database.pool, &run).await)
        .await
        .unwrap();
    let (result, host) = worker.await.unwrap();
    assert!(matches!(result, Err(ExecutorError::Deadline)));
    assert_eq!(
        host.events()
            .iter()
            .filter(|e| e["received"]["method"] == "turn/interrupt")
            .count(),
        1
    );
    let(state,hold,disposition):(String,bool,String)=sqlx::query_as("SELECT r.status,r.native_admission_hold,a.provider_disposition FROM heartbeat_runs r JOIN chat_control_actions a ON a.expected_generation_id=r.chat_generation_id WHERE r.id=$1::uuid").bind(&run).fetch_one(&database.pool).await.unwrap();
    assert_eq!(
        (state, hold, disposition),
        ("running".into(), true, "unverified".into())
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and synthetic provider"]
async fn late_thread_response_after_stop_never_submits_input_or_fabricates_terminal() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run, attempt) =
        database_and_admission("live-stop-late-thread").await;
    let pending = host.probe_path("thread-start-pending");
    let release = host.probe_path("release-thread-start");
    let pool = database.pool.clone();
    let a = actor.clone();
    let r = run.clone();
    let at = attempt.clone();
    let handle = tokio::runtime::Handle::current();
    let worker = tokio::task::spawn_blocking(move || {
        let cancelled = AtomicBool::new(false);
        let result = run_on_blocking_thread(
            &handle,
            &pool,
            &a,
            host.context(),
            &host.paths(),
            ExecutionRequest {
                organization_id: ORG,
                run_id: &r,
                attempt_id: &at,
                timeout: Duration::from_secs(15),
                cancelled: &cancelled,
            },
        );
        (result, host)
    });
    for _ in 0..500 {
        if pending.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(pending.exists());
    request_stop(&database.pool, &actor, &request(&database.pool, &run).await)
        .await
        .unwrap();
    std::fs::write(release, "release").unwrap();
    let (result, host) = worker.await.unwrap();
    assert!(result.is_err());
    assert_eq!(
        host.events()
            .iter()
            .filter(|e| matches!(
                e["received"]["method"].as_str(),
                Some("turn/start" | "turn/interrupt")
            ))
            .count(),
        0
    );
    let(state,hold,phase):(String,bool,String)=sqlx::query_as("SELECT r.status,r.native_admission_hold,a.protocol_phase FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.run_id=r.id WHERE r.id=$1::uuid").bind(run).fetch_one(&database.pool).await.unwrap();
    assert_eq!(
        (state, hold, phase),
        ("running".into(), true, "thread_known".into())
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and synthetic provider"]
async fn stopped_finalization_audit_failure_rolls_back_action_rows_events_and_span() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run, attempt) = database_and_admission("complete").await;
    let (result, _host) =
        execute_on_worker(&database, host, actor.clone(), run.clone(), attempt).await;
    let observed = result.unwrap();
    request_stop(&database.pool, &actor, &request(&database.pool, &run).await)
        .await
        .unwrap();
    let stop = execution::observe_stop(&database.pool, &actor, &observed.fence)
        .await
        .unwrap()
        .unwrap();
    async fn snapshot(pool: &sqlx::PgPool, run: &str) -> Value {
        sqlx::query_scalar("SELECT jsonb_build_object('run',to_jsonb(r),'generation',(SELECT to_jsonb(g) FROM chat_generations g WHERE g.id=r.chat_generation_id),'attempt',(SELECT to_jsonb(a) FROM heartbeat_run_attempts a WHERE a.run_id=r.id),'action',(SELECT to_jsonb(a) FROM chat_control_actions a WHERE a.expected_generation_id=r.chat_generation_id),'span',(SELECT to_jsonb(s) FROM run_runtime_spans s WHERE s.run_id=r.id),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.generation_seq) FROM chat_generation_events e WHERE e.generation_id=r.chat_generation_id),'runEvents',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.seq) FROM heartbeat_run_events e WHERE e.run_id=r.id)) FROM heartbeat_runs r WHERE r.id=$1::uuid").bind(run).fetch_one(pool).await.unwrap()
    }
    let before = snapshot(&database.pool, &run).await;
    sqlx::raw_sql("CREATE FUNCTION test_live_stop_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='runtime.native_chat.finalized' THEN RAISE EXCEPTION 'synthetic Stop audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_live_stop_audit_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION test_live_stop_audit_failure();").execute(&database.pool).await.unwrap();
    assert!(
        execution::finalize_stopped(
            &database.pool,
            &actor,
            &observed.fence,
            &observed.turn_receipt,
            observed.cleanup_receipt.as_ref().unwrap(),
            &stop
        )
        .await
        .is_err()
    );
    assert_eq!(snapshot(&database.pool, &run).await, before);
    sqlx::query("DROP TRIGGER test_live_stop_audit_failure ON activity_log")
        .execute(&database.pool)
        .await
        .unwrap();
    let result = execution::finalize_stopped(
        &database.pool,
        &actor,
        &observed.fence,
        &observed.turn_receipt,
        observed.cleanup_receipt.as_ref().unwrap(),
        &stop,
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "cancelled");
}
