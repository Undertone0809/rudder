//! Direct D1 finalization coverage. The fixture yields an ambiguous approval
//! error with real owned cleanup; the worker must NOT classify that error as an
//! output-limit failure. Calling this trusted primitive here tests its guards,
//! not a public ordinal-overflow workflow.
use crate::fixture::*;
use rudder_d1_persistence::native_chat::{
    control::{StopOutcome, StopRequest, request_stop},
    execution::{finalize_failed, finalize_output_limit_failure, observe_stop},
};
use rudder_native_chat_executor::{
    ExecutionFailure, ExecutionRequest, ProcessDisposition, run_observed_on_blocking_thread,
};
use serde_json::Value;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

async fn prepared() -> (Database, FixtureHost, ExecutionFailure, String, String) {
    let (database, host, actor, run, attempt) =
        database_and_admission("approval-after-prefix").await;
    let pool = database.pool.clone();
    let worker_run = run.clone();
    let worker_attempt = attempt.clone();
    let handle = tokio::runtime::Handle::current();
    let release = host.probe_path("release-after-prefix-approval");
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let worker = tokio::task::spawn_blocking(move || {
        let result = run_observed_on_blocking_thread(
            &handle,
            &pool,
            &actor,
            host.context(),
            &host.paths(),
            ExecutionRequest {
                organization_id: ORG,
                run_id: &worker_run,
                attempt_id: &worker_attempt,
                timeout: Duration::from_secs(15),
                cancelled: &worker_cancelled,
            },
        );
        (
            result.err().expect("fixture requires an operator decision"),
            host,
        )
    });
    // Provider frames can precede host FrameWritten/turn correlation. Do not
    // send the approval until this test's actual durable prefix exists.
    let visible = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let committed: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM chat_messages WHERE org_id=$1::uuid
                 AND run_id=$2::uuid AND role='assistant' AND status='streaming' AND body=$3)",
            )
            .bind(ORG)
            .bind(&run)
            .bind("x".repeat(1024))
            .fetch_one(&database.pool)
            .await
            .unwrap();
            if committed {
                break;
            }
            assert!(
                !worker.is_finished(),
                "fixture exited before committing its prefix"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    if visible.is_err() {
        cancelled.store(true, Ordering::Release);
        let _ = worker.await;
        panic!("fixture did not commit its prefix before its approval barrier");
    }
    std::fs::write(release, "release").unwrap();
    let (failure, host) = worker.await.unwrap();
    assert_eq!(
        failure.process_disposition(),
        ProcessDisposition::CleanupProven
    );
    assert_eq!(failure.diagnostic_code(), "approval_required");
    assert!(!failure.is_definitive_failure());
    assert!(!failure.can_finalize_output_limit_failure());
    assert!(failure.cleanup_receipt().is_some());
    (database, host, failure, run, attempt)
}

async fn state(database: &Database, run: &str, attempt: &str) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_build_object(
          'run',r.status,'generation',g.status,'attempt',a.status,'phase',a.protocol_phase,
          'runHold',r.native_admission_hold,'generationHold',g.native_admission_hold,
          'processExited',r.process_exited_at IS NOT NULL,'runtimeTerminal',g.runtime_terminal_at IS NOT NULL,
          'messageId',m.id,'messageStatus',m.status,'body',m.body,
          'spanState',s.state,'spanCompleteness',s.completeness,'selector',s.selector_json,
          'outputCount',(SELECT count(*) FROM chat_generation_events e WHERE e.run_id=r.id
             AND e.org_id=r.org_id AND e.event_kind IN ('assistant_delta','runtime_output')),
          'terminalEvents',(SELECT count(*) FROM chat_generation_events e WHERE e.run_id=r.id
             AND e.org_id=r.org_id AND e.event_kind IN ('runtime_terminal','terminal_projected')),
          'linkedTerminalEvents',(SELECT count(*) FROM chat_generation_events e WHERE e.run_id=r.id
             AND e.org_id=r.org_id AND e.event_kind IN ('runtime_terminal','terminal_projected')
             AND e.assistant_message_id=m.id AND e.payload->>'assistantMessageId'=m.id::text),
          'activities',(SELECT count(*) FROM activity_log l WHERE l.org_id=r.org_id
             AND l.entity_type='heartbeat_run' AND l.entity_id=r.id::text
             AND l.action='runtime.native_chat.finalized'))
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$3::uuid
         JOIN run_runtime_spans s ON s.org_id=r.org_id AND s.run_id=r.id AND s.attempt_id=a.id
             AND s.relation='primary'
         JOIN chat_messages m ON m.org_id=r.org_id AND m.run_id=r.id AND m.role='assistant'
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    ).bind(ORG).bind(run).bind(attempt).fetch_one(&database.pool).await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST and disposable PostgreSQL"]
async fn owned_cleanup_failure_preserves_and_seals_the_exact_prefix_once() {
    assert_ignored_external_dependencies();
    let (database, host, failure, run, attempt) = prepared().await;
    let before = state(&database, &run, &attempt).await;
    assert_eq!(before["messageStatus"], "streaming");
    assert_eq!(before["body"], "x".repeat(1024));
    let result = finalize_failed(
        &database.pool,
        failure.execution_principal().unwrap(),
        failure.fence().unwrap(),
        failure.cleanup_receipt().unwrap(),
    )
    .await
    .expect("trusted failure finalizer authenticates the committed prefix");
    assert_eq!(result["status"], "failed");
    assert_eq!(result["assistantMessageId"], before["messageId"]);
    assert_eq!(
        result["projectionDisposition"],
        "failed_without_terminal_receipt"
    );
    assert_eq!(result["cost"]["status"], "unknown");
    assert_eq!(result["usage"]["status"], "unavailable");
    let after = state(&database, &run, &attempt).await;
    for field in ["run", "generation", "attempt", "messageStatus"] {
        assert_eq!(after[field], "failed");
    }
    assert_eq!(after["phase"], "execution_terminal_committed");
    assert_eq!(after["body"], before["body"]);
    assert_eq!(after["messageId"], before["messageId"]);
    assert_eq!(after["outputCount"], before["outputCount"]);
    assert_eq!(after["terminalEvents"], 2);
    assert_eq!(after["linkedTerminalEvents"], 2);
    assert_eq!(after["activities"], 1);
    assert_eq!(after["runHold"], false);
    assert_eq!(after["generationHold"], false);
    assert_eq!(after["processExited"], true);
    assert_eq!(after["runtimeTerminal"], true);
    assert_eq!(after["spanState"], "sealed");
    assert_eq!(after["spanCompleteness"], "partial");
    assert_eq!(after["selector"]["inputDisposition"], "unknown");
    let retry = finalize_failed(
        &database.pool,
        failure.execution_principal().unwrap(),
        failure.fence().unwrap(),
        failure.cleanup_receipt().unwrap(),
    )
    .await
    .expect("same evidence reads back the committed failed result");
    assert_eq!(retry, result);
    assert_eq!(state(&database, &run, &attempt).await, after);
    assert_eq!(
        host.events()
            .iter()
            .filter(|event| event.get("turnStart").is_some())
            .count(),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST and disposable PostgreSQL"]
async fn stale_cleanup_or_changed_prefix_cannot_finalize_or_release_the_execution() {
    assert_ignored_external_dependencies();
    for corruption in ["wrong-cleanup", "expired-lease", "changed-prefix"] {
        let (database, _host, failure, run, attempt) = prepared().await;
        // A receipt from another real owned connection is deliberately passed
        // only in this negative guard case. No receipt internals are forged.
        let other = if corruption == "wrong-cleanup" {
            Some(prepared().await)
        } else {
            None
        };
        if corruption != "wrong-cleanup" {
            let mut tx = database.pool.begin().await.unwrap();
            sqlx::query(
                "SELECT set_config('rudder.native_chat_write','native_chat:execution',true)",
            )
            .execute(&mut *tx)
            .await
            .unwrap();
            if corruption == "expired-lease" {
                sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=clock_timestamp()-interval '1 second' WHERE org_id=$1::uuid AND id=$2::uuid")
                    .bind(ORG).bind(&run).execute(&mut *tx).await.unwrap();
            } else {
                sqlx::query("UPDATE chat_messages SET body='changed prefix' WHERE org_id=$1::uuid AND run_id=$2::uuid AND role='assistant'")
                    .bind(ORG).bind(&run).execute(&mut *tx).await.unwrap();
            }
            tx.commit().await.unwrap();
        }
        let before = state(&database, &run, &attempt).await;
        let cleanup = other
            .as_ref()
            .map(|(_, _, failure, _, _)| failure.cleanup_receipt().unwrap())
            .unwrap_or_else(|| failure.cleanup_receipt().unwrap());
        assert!(
            finalize_failed(
                &database.pool,
                failure.execution_principal().unwrap(),
                failure.fence().unwrap(),
                cleanup,
            )
            .await
            .is_err()
        );
        assert_eq!(state(&database, &run, &attempt).await, before);
        assert_eq!(before["runHold"], true);
        assert_eq!(before["generationHold"], true);
        assert_eq!(before["messageStatus"], "streaming");
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST and disposable PostgreSQL"]
async fn output_limit_finalizer_atomically_honors_stop_and_never_relabels_submitted_input() {
    assert_ignored_external_dependencies();
    for mode in ["no-stop", "stop-prefix", "stop-empty"] {
        let (database, _host, failure, run, attempt) = prepared().await;
        let actor = failure.execution_principal().unwrap();
        let fence = failure.fence().unwrap();
        let cleanup = failure.cleanup_receipt().unwrap();
        assert!(
            observe_stop(&database.pool, actor, fence)
                .await
                .unwrap()
                .is_none()
        );
        let (generation, version, sequence, hash): (String, i32, i32, String) = sqlx::query_as(
            "SELECT g.id::text,g.control_version,e.generation_seq,e.payload->>'bodyHash'
             FROM heartbeat_runs r JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
             JOIN chat_generation_events e ON e.org_id=r.org_id AND e.run_id=r.id
             WHERE r.org_id=$1::uuid AND r.id=$2::uuid
               AND e.event_kind IN ('assistant_delta','runtime_output')
             ORDER BY e.generation_seq DESC LIMIT 1",
        ).bind(ORG).bind(&run).fetch_one(&database.pool).await.unwrap();
        let request = StopRequest {
            conversation_id: CHAT.into(),
            generation_id: generation,
            control_action_id: "72000000-0000-4000-8000-000000000099".into(),
            expected_attempt_epoch: 1,
            expected_control_version: version,
            requested_render_seq: if mode == "stop-empty" { 0 } else { sequence },
            requested_body_hash: if mode == "stop-empty" {
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".into()
            } else {
                hash
            },
        };
        // Precisely the interleaving at risk: the worker observed no Stop,
        // then the public action commits before D1 terminalization acquires
        // its serialization lock. No provider receipt or SQL state is forged.
        if mode != "no-stop" {
            assert_eq!(
                request_stop(&database.pool, &verified_actor(), &request)
                    .await
                    .unwrap()
                    .outcome,
                StopOutcome::StopIntentRecorded
            );
        }
        let before = state(&database, &run, &attempt).await;
        let result = finalize_output_limit_failure(&database.pool, actor, fence, cleanup)
            .await
            .unwrap();
        assert_eq!(result["inputDisposition"], "unknown");
        assert_eq!(result["cost"]["status"], "unknown");
        assert_eq!(result["assistantMessageId"], before["messageId"]);
        let after = state(&database, &run, &attempt).await;
        assert_eq!(after["body"], before["body"]);
        assert_eq!(after["outputCount"], before["outputCount"]);
        assert_eq!(after["terminalEvents"], 2);
        assert_eq!(after["linkedTerminalEvents"], 2);
        assert_eq!(after["spanCompleteness"], "partial");
        assert_eq!(after["selector"]["inputDisposition"], "unknown");
        if mode == "no-stop" {
            assert_eq!(result["status"], "failed");
            assert_eq!(after["messageStatus"], "failed");
            assert_eq!(
                request_stop(&database.pool, &verified_actor(), &request)
                    .await
                    .unwrap()
                    .outcome,
                StopOutcome::AlreadyTerminal
            );
        } else {
            assert_eq!(result["status"], "cancelled");
            assert_eq!(after["messageStatus"], "stopped");
            assert_eq!(
                request_stop(&database.pool, &verified_actor(), &request)
                    .await
                    .unwrap()
                    .outcome,
                StopOutcome::Stopped
            );
            let evidence: Value = sqlx::query_scalar(
                "SELECT provider_evidence->'stopResolution' FROM chat_control_actions WHERE id=$1::uuid",
            ).bind(&request.control_action_id).fetch_one(&database.pool).await.unwrap();
            assert_eq!(evidence["inputDisposition"], "unknown");
            assert_eq!(evidence["cleanupProven"], true);
            assert!(evidence.get("actualProviderStatus").is_none());
        }
        assert_eq!(
            finalize_output_limit_failure(&database.pool, actor, fence, cleanup)
                .await
                .unwrap(),
            result
        );
        assert_eq!(state(&database, &run, &attempt).await, after);
    }
}
