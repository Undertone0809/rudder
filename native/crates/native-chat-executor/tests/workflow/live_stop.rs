use crate::fixture::*;
use rudder_d1_persistence::native_chat::{
    control::{StopOutcome, StopRequest, request_stop},
    execution,
};
use rudder_native_chat_executor::{
    ExecutionRequest, ProcessDisposition, run_observed_on_blocking_thread, run_on_blocking_thread,
};
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

async fn execution_snapshot(pool: &sqlx::PgPool, run: &str) -> Value {
    sqlx::query_scalar::<_, Value>(
        "SELECT jsonb_build_object('run',to_jsonb(r),'generation',to_jsonb(g),
           'attempt',to_jsonb(a),'action',to_jsonb(c),'span',to_jsonb(s),
           'assistantMessages',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id)
             FROM chat_messages m WHERE m.run_id=r.id AND m.role='assistant'),'[]'::jsonb),
           'events',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.generation_seq)
             FROM chat_generation_events e WHERE e.run_id=r.id),'[]'::jsonb))
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         JOIN chat_control_actions c ON c.org_id=r.org_id AND c.expected_generation_id=g.id
         JOIN run_runtime_spans s ON s.org_id=r.org_id AND s.run_id=r.id
           AND s.attempt_id=a.id AND s.relation='primary'
         WHERE r.id=$1::uuid",
    )
    .bind(run)
    .fetch_one(pool)
    .await
    .unwrap()
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
        "live-stop-output-after-stop",
    ] {
        let (database, host, actor, run, attempt) = database_and_admission(mode).await;
        let release = host.probe_path("release-turn-start");
        let pending = host.probe_path("turn-start-pending");
        let release_output = host.probe_path("release-output");
        let pending_output = host.probe_path("output-pending");
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
            for _ in 0..500 {
                if pending_output.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(
                pending_output.exists(),
                "provider must pause after its prefix"
            );
            let mut observed = None;
            for _ in 0..500 {
                observed = sqlx::query_as::<_, (i32, String)>(
                    "SELECT e.generation_seq,e.payload->>'bodyHash'
                     FROM chat_generation_events e
                     JOIN chat_messages m ON m.org_id=e.org_id AND m.id=e.assistant_message_id
                     WHERE e.org_id=$1::uuid AND e.run_id=$2::uuid
                       AND e.event_kind='assistant_delta' AND m.body='prefix'
                     ORDER BY e.generation_seq DESC LIMIT 1",
                )
                .bind(ORG)
                .bind(&run)
                .fetch_optional(&database.pool)
                .await
                .unwrap();
                if observed.is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let (seq, hash) = observed.expect("typed output receipt must be persisted before Stop");
            request.requested_render_seq = seq;
            request.requested_body_hash = hash;
        }
        let initial = request_stop(&database.pool, &actor, &request)
            .await
            .unwrap();
        assert_eq!(initial.outcome, StopOutcome::StopIntentRecorded);
        if mode == "live-stop-late-turn" {
            std::fs::write(release, "release").unwrap();
        } else if mode == "live-stop-cutoff" {
            std::fs::write(release_output, "release").unwrap();
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
            assert_eq!(body, "prefix");
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
        if mode == "live-stop-output-after-stop" {
            let visible_rows: i64 = sqlx::query_scalar(
                "SELECT
                   (SELECT count(*) FROM chat_messages
                    WHERE org_id=$1::uuid AND run_id=$2::uuid AND role='assistant')
                 + (SELECT count(*) FROM chat_generation_events
                    WHERE org_id=$1::uuid AND run_id=$2::uuid
                      AND event_kind IN ('assistant_delta','runtime_output'))",
            )
            .bind(ORG)
            .bind(&run)
            .fetch_one(&database.pool)
            .await
            .unwrap();
            assert_eq!(
                visible_rows, 0,
                "provider output delivered after Stop must not cross the frozen prefix"
            );
        }
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
        let result = run_observed_on_blocking_thread(
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
    let failure = match result {
        Ok(_) => panic!("missing provider terminal should retain an execution failure"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.process_disposition(),
        ProcessDisposition::CleanupProven
    );
    let fence = failure.fence().expect("post-launch fence retained");
    let cleanup = failure.cleanup_receipt().expect("actual cleanup retained");
    let stop = execution::observe_stop(&database.pool, &actor, fence)
        .await
        .unwrap()
        .expect("Stop intent remains active");
    let before: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('run',to_jsonb(r),'generation',to_jsonb(g),
           'attempt',to_jsonb(a),'action',to_jsonb(c), 'span',to_jsonb(s))
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         JOIN chat_control_actions c ON c.org_id=r.org_id AND c.expected_generation_id=g.id
         JOIN run_runtime_spans s ON s.org_id=r.org_id AND s.run_id=r.id AND s.attempt_id=a.id
           AND s.relation='primary' WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert!(matches!(
        execution::finalize_stopped_before_submission(
            &database.pool,
            &actor,
            fence,
            cleanup,
            &stop,
        )
        .await,
        Err(rudder_d1_persistence::native_chat::Error::Http(409, _))
    ));
    let after: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('run',to_jsonb(r),'generation',to_jsonb(g),
           'attempt',to_jsonb(a),'action',to_jsonb(c), 'span',to_jsonb(s))
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         JOIN chat_control_actions c ON c.org_id=r.org_id AND c.expected_generation_id=g.id
         JOIN run_runtime_spans s ON s.org_id=r.org_id AND s.run_id=r.id AND s.attempt_id=a.id
           AND s.relation='primary' WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        before, after,
        "TurnKnown must not be terminalized as not submitted"
    );
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
async fn ambiguous_start_and_input_effects_are_never_finalized_as_not_submitted() {
    assert_ignored_external_dependencies();
    for (mode, probe, expected_phase) in [
        (
            "live-stop-thread-unknown",
            "thread-start-pending",
            "thread_start_indeterminate",
        ),
        (
            "live-stop-input-unknown",
            "turn-start-pending",
            "input_indeterminate",
        ),
    ] {
        let (database, host, actor, run, attempt) = database_and_admission(mode).await;
        let pending = host.probe_path(probe);
        let pool = database.pool.clone();
        let a = actor.clone();
        let r = run.clone();
        let at = attempt.clone();
        let handle = tokio::runtime::Handle::current();
        let worker = tokio::task::spawn_blocking(move || {
            let cancelled = AtomicBool::new(false);
            let result = run_observed_on_blocking_thread(
                &handle,
                &pool,
                &a,
                host.context(),
                &host.paths(),
                ExecutionRequest {
                    organization_id: ORG,
                    run_id: &r,
                    attempt_id: &at,
                    timeout: Duration::from_secs(5),
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
        let (result, host) = worker.await.unwrap();
        let failure = match result {
            Ok(_) => panic!("ambiguous provider effects cannot produce a terminal receipt"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.process_disposition(),
            ProcessDisposition::CleanupProven
        );
        let fence = failure.fence().expect("post-launch fence retained");
        let cleanup = failure.cleanup_receipt().expect("owned cleanup retained");
        assert!(host.probe_path("provider-stopped").exists());
        let stop = execution::observe_stop(&database.pool, &actor, fence)
            .await
            .unwrap()
            .expect("Stop intent remains active");
        let before: Value = sqlx::query_scalar(
            "SELECT jsonb_build_object('run',to_jsonb(r),'generation',to_jsonb(g),
               'attempt',to_jsonb(a),'action',to_jsonb(c), 'span',to_jsonb(s))
             FROM heartbeat_runs r
             JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
             JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
             JOIN chat_control_actions c ON c.org_id=r.org_id AND c.expected_generation_id=g.id
             JOIN run_runtime_spans s ON s.org_id=r.org_id AND s.run_id=r.id AND s.attempt_id=a.id
               AND s.relation='primary' WHERE r.id=$1::uuid",
        )
        .bind(&run)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert!(matches!(
            execution::finalize_stopped_before_submission(
                &database.pool,
                &actor,
                fence,
                cleanup,
                &stop,
            )
            .await,
            Err(rudder_d1_persistence::native_chat::Error::Http(409, _))
        ));
        let after: Value = sqlx::query_scalar(
            "SELECT jsonb_build_object('run',to_jsonb(r),'generation',to_jsonb(g),
               'attempt',to_jsonb(a),'action',to_jsonb(c), 'span',to_jsonb(s))
             FROM heartbeat_runs r
             JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
             JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
             JOIN chat_control_actions c ON c.org_id=r.org_id AND c.expected_generation_id=g.id
             JOIN run_runtime_spans s ON s.org_id=r.org_id AND s.run_id=r.id AND s.attempt_id=a.id
               AND s.relation='primary' WHERE r.id=$1::uuid",
        )
        .bind(&run)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert_eq!(
            before, after,
            "{expected_phase} must remain held and unchanged"
        );
        let phase: String = sqlx::query_scalar(
            "SELECT protocol_phase FROM heartbeat_run_attempts WHERE id=$1::uuid",
        )
        .bind(&attempt)
        .fetch_one(&database.pool)
        .await
        .unwrap();
        assert_eq!(phase, expected_phase);
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and synthetic provider"]
async fn stop_before_thread_start_finalizes_from_no_thread_request() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run, attempt) =
        database_and_admission("live-stop-config-pending").await;
    let pending = host.probe_path("config-read-pending");
    let release = host.probe_path("release-config-read");
    let pool = database.pool.clone();
    let a = actor.clone();
    let r = run.clone();
    let at = attempt.clone();
    let handle = tokio::runtime::Handle::current();
    let worker = tokio::task::spawn_blocking(move || {
        let cancelled = AtomicBool::new(false);
        let result = run_observed_on_blocking_thread(
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
    let failure = match result {
        Ok(_) => panic!("pre-thread Stop cannot produce a Turn receipt"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.process_disposition(),
        ProcessDisposition::CleanupProven
    );
    let fence = failure.fence().expect("post-launch fence retained");
    let cleanup = failure.cleanup_receipt().expect("owned cleanup retained");
    let stop = execution::observe_stop(&database.pool, &actor, fence)
        .await
        .unwrap()
        .expect("durable Stop remains observable");
    let phase: String =
        sqlx::query_scalar("SELECT protocol_phase FROM heartbeat_run_attempts WHERE id=$1::uuid")
            .bind(&attempt)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(phase, "no_thread_request");
    assert_eq!(
        host.events()
            .iter()
            .filter(|event| matches!(
                event["received"]["method"].as_str(),
                Some("thread/start" | "turn/start" | "turn/interrupt")
            ))
            .count(),
        0
    );
    let before_unbound = execution_snapshot(&database.pool, &run).await;
    assert!(matches!(
        execution::finalize_stopped_before_submission(
            &database.pool,
            &actor,
            fence,
            cleanup,
            &stop,
        )
        .await,
        Err(rudder_d1_persistence::native_chat::Error::Http(409, _))
    ));
    assert_eq!(
        before_unbound,
        execution_snapshot(&database.pool, &run).await,
        "no-input cleanup cannot finalize before exact connection registration"
    );
    let connection = cleanup.connection_receipt();
    execution::bind_stopping_connection(&database.pool, &actor, fence, &stop, &connection)
        .await
        .unwrap();
    let result = execution::finalize_stopped_before_submission(
        &database.pool,
        &actor,
        fence,
        cleanup,
        &stop,
    )
    .await
    .unwrap();
    assert_eq!(result["inputDisposition"], "not_submitted");
    assert_eq!(result["assistantMessageId"], Value::Null);
    let segment: (String, Option<String>) = sqlx::query_as(
        "SELECT s.state,s.native_session_id FROM heartbeat_runs r
         JOIN native_segments s ON s.org_id=r.org_id
           AND s.id=(r.context_snapshot->>'nativeSegmentId')::uuid
         WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(segment, ("pending".into(), None));
    let span: (String, String) = sqlx::query_as(
        "SELECT state,completeness FROM run_runtime_spans
         WHERE run_id=$1::uuid AND attempt_id=$2::uuid AND relation='primary'",
    )
    .bind(&run)
    .bind(&attempt)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(span, ("sealed".into(), "partial".into()));
}

async fn assert_pre_submission_projection_is_rejected(nonempty_cutoff: bool) {
    assert_ignored_external_dependencies();
    let (database, host, actor, run, attempt) =
        database_and_admission("live-stop-config-pending").await;
    let pending = host.probe_path("config-read-pending");
    let release = host.probe_path("release-config-read");
    let mut stop_request = request(&database.pool, &run).await;
    let pool = database.pool.clone();
    let worker_actor = actor.clone();
    let worker_run = run.clone();
    let worker_attempt = attempt.clone();
    let handle = tokio::runtime::Handle::current();
    let worker = tokio::task::spawn_blocking(move || {
        let cancelled = AtomicBool::new(false);
        let result = run_observed_on_blocking_thread(
            &handle,
            &pool,
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
    let mut config_read_pending = false;
    for _ in 0..500 {
        if pending.exists() {
            config_read_pending = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    if !config_read_pending {
        let _ = std::fs::write(&release, "release");
        let _ = worker.await;
        panic!("provider did not reach the config-read gate");
    }

    let cutoff_setup: std::result::Result<(), sqlx::Error> = if nonempty_cutoff {
        async {
            let mut tx = database.pool.begin().await?;
            sqlx::query(
                "SELECT set_config('rudder.native_chat_write','native_chat:test_no_turn_cutoff',true)",
            )
            .execute(&mut *tx)
            .await?;
            let hash = "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb";
            // Build a valid visible projection so Stop can durably freeze the
            // non-empty prefix; the no-Thread finalizer must then reject it.
            let assistant_message_id: String = sqlx::query_scalar(
                "INSERT INTO chat_messages(org_id,conversation_id,role,kind,status,body,run_id,
                   replying_agent_id,chat_turn_id,turn_variant)
                 SELECT $1::uuid,$2::uuid,'assistant','message','streaming','a',$3::uuid,$5::uuid,
                   source_message.chat_turn_id,source_message.turn_variant
                 FROM chat_generations g JOIN chat_messages source_message
                   ON source_message.org_id=g.org_id AND source_message.id=g.source_message_id
                 WHERE g.org_id=$1::uuid AND g.id=$4::uuid AND g.conversation_id=$2::uuid
                 RETURNING id::text",
            )
            .bind(ORG)
            .bind(CHAT)
            .bind(&run)
            .bind(&stop_request.generation_id)
            .bind(CEO)
            .fetch_one(&mut *tx)
            .await?;
            sqlx::query("INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,assistant_message_id,run_id) VALUES($1::uuid,$2::uuid,2,1,'assistant_delta',$3,$4::uuid,$5::uuid)")
                .bind(ORG)
                .bind(&stop_request.generation_id)
                .bind(serde_json::json!({"delta":"a","bodyHash":hash}))
                .bind(&assistant_message_id)
                .bind(&run)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            stop_request.requested_render_seq = 2;
            stop_request.requested_body_hash = hash.into();
            Ok(())
        }
        .await
    } else {
        Ok(())
    };
    let stop_result = if cutoff_setup.is_ok() {
        Some(request_stop(&database.pool, &actor, &stop_request).await)
    } else {
        None
    };
    let release_result = std::fs::write(&release, "release");
    let (result, _host) = worker.await.unwrap();
    release_result.expect("release worker config-read gate");
    cutoff_setup.expect("persist the valid frozen prefix fixture");
    let stop_receipt = stop_result
        .expect("Stop should run after fixture setup")
        .expect("valid durable visible prefix should be accepted by Stop");
    assert_eq!(stop_receipt.outcome, StopOutcome::StopIntentRecorded);
    let Err(failure) = result else {
        panic!("Stop before Thread start has no provider terminal");
    };
    assert_eq!(
        failure.process_disposition(),
        ProcessDisposition::CleanupProven
    );
    let fence = failure.fence().expect("claimed fence retained");
    let cleanup = failure.cleanup_receipt().expect("actual cleanup retained");
    let stop = execution::observe_stop(&database.pool, &actor, fence)
        .await
        .unwrap()
        .expect("Stop intent remains active");

    if !nonempty_cutoff {
        let mut tx = database.pool.begin().await.unwrap();
        sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_no_turn_projection',true)")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO chat_messages(org_id,conversation_id,role,kind,status,body,run_id) VALUES($1::uuid,$2::uuid,'assistant','message','streaming','unexpected',$3::uuid)")
            .bind(ORG)
            .bind(CHAT)
            .bind(&run)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }

    let before = execution_snapshot(&database.pool, &run).await;
    assert!(matches!(
        execution::finalize_stopped_before_submission(
            &database.pool,
            &actor,
            fence,
            cleanup,
            &stop,
        )
        .await,
        Err(rudder_d1_persistence::native_chat::Error::Http(409, _))
    ));
    assert_eq!(
        before,
        execution_snapshot(&database.pool, &run).await,
        "rejected prefix checks must be read-only"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and synthetic provider"]
async fn no_thread_stop_refuses_nonzero_frozen_render_cutoff_without_side_effects() {
    assert_pre_submission_projection_is_rejected(true).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and synthetic provider"]
async fn no_thread_stop_refuses_assistant_projection_even_with_empty_cutoff() {
    assert_pre_submission_projection_is_rejected(false).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and synthetic provider"]
async fn late_thread_response_after_stop_finalizes_without_a_turn() {
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
        let result = run_observed_on_blocking_thread(
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
    let failure = match result {
        Ok(_) => panic!("Stop before input should not produce a provider Turn receipt"),
        Err(failure) => failure,
    };
    assert_eq!(
        failure.process_disposition(),
        rudder_native_chat_executor::ProcessDisposition::CleanupProven
    );
    let fence = failure
        .fence()
        .expect("post-launch failure retains its fence");
    let cleanup = failure
        .cleanup_receipt()
        .expect("owned process cleanup receipt is retained");
    let stop = execution::observe_stop(&database.pool, &actor, fence)
        .await
        .unwrap()
        .expect("durable Stop remains observable");
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
    let phase: (String, Option<String>) = sqlx::query_as(
        "SELECT protocol_phase,provider_turn_id FROM heartbeat_run_attempts WHERE id=$1::uuid",
    )
    .bind(&attempt)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(phase, ("thread_known".into(), None));

    let result = execution::finalize_stopped_before_submission(
        &database.pool,
        &actor,
        fence,
        cleanup,
        &stop,
    )
    .await
    .unwrap();
    assert_eq!(result["status"], "cancelled");
    assert_eq!(result["generationStatus"], "stopped");
    assert_eq!(result["inputDisposition"], "not_submitted");
    assert_eq!(result["assistantMessageId"], Value::Null);
    assert_eq!(result["cost"]["status"], "unknown");
    assert_eq!(result["usage"]["status"], "unavailable");
    assert_eq!(result["usage"]["reason"], "input_not_submitted");
    assert!(result["usage"]["inputTokens"].is_null());
    let persisted: (
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT r.status,g.status,a.protocol_phase,a.provider_turn_id,
                    s.native_session_id,s.state,rs.native_execution_ref
             FROM heartbeat_runs r
             JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
             JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
             JOIN native_segments s ON s.org_id=r.org_id
               AND s.id=(r.context_snapshot->>'nativeSegmentId')::uuid
             JOIN run_runtime_spans rs ON rs.org_id=r.org_id AND rs.run_id=r.id
               AND rs.attempt_id=a.id AND rs.relation='primary'
             WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        persisted,
        (
            "cancelled".into(),
            "stopped".into(),
            "execution_terminal_committed".into(),
            None,
            THREAD.into(),
            "open".into(),
            None,
        )
    );
    let span: (String, String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT state,completeness,native_execution_ref,input_correlation_ref
         FROM run_runtime_spans WHERE run_id=$1::uuid AND attempt_id=$2::uuid AND relation='primary'",
    )
    .bind(&run)
    .bind(&attempt)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(span, ("sealed".into(), "partial".into(), None, None));
    let counts: (i64, i64, Option<i64>, bool, bool) = sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM chat_messages WHERE run_id=$1::uuid AND role='assistant'),
           (SELECT count(*) FROM chat_generation_events WHERE run_id=$1::uuid AND event_kind IN ('runtime_terminal','terminal_projected')),
           a.cost_cents,r.native_admission_hold,g.native_admission_hold
         FROM heartbeat_runs r JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(counts, (0, 2, None, false, false));
    let retry = execution::finalize_stopped_before_submission(
        &database.pool,
        &actor,
        fence,
        cleanup,
        &stop,
    )
    .await
    .unwrap();
    assert_eq!(retry, result);
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
