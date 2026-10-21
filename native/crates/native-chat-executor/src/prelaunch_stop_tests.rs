use super::*;
use rudder_d1_persistence::native_chat::control::{StopOutcome, StopRequest, request_stop};
use std::{sync::atomic::AtomicBool, time::Duration};

#[derive(Clone, Copy)]
enum Provider {
    Codex,
    Hermes,
}

async fn stop_request(pool: &PgPool, run_id: &str) -> StopRequest {
    let (generation_id, control_version): (String, i32) = sqlx::query_as(
        "SELECT g.id::text,g.control_version FROM chat_generations g
         JOIN heartbeat_runs r ON r.chat_generation_id=g.id WHERE r.id=$1::uuid",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .expect("read current generation control version");
    StopRequest {
        conversation_id: cleanup_claim_fixture::CHAT.into(),
        generation_id,
        control_action_id: "72000000-0000-4000-8000-000000000001".into(),
        expected_attempt_epoch: 1,
        expected_control_version: control_version,
        requested_render_seq: 0,
        requested_body_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            .into(),
    }
}

async fn exercise_stop_after_claim(provider: Provider) {
    use cleanup_claim_fixture as fixture;

    let (database, host, actor, run_id, attempt_id) = match provider {
        Provider::Codex => fixture::database_and_admission("complete").await,
        Provider::Hermes => fixture::database_and_hermes_admission("complete").await,
    };
    let claimed = fixture::claim(
        &database.pool,
        &actor,
        fixture::ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    .expect("claim admitted execution before Stop");
    let (execution_principal, fence, config, launch_permit) = claimed.into_execution_parts();

    let stop = request_stop(
        &database.pool,
        &actor,
        &stop_request(&database.pool, &run_id).await,
    )
    .await
    .expect("Stop after durable claim");
    assert_eq!(stop.outcome, StopOutcome::StopIntentRecorded);

    // This calls the same private claimed-execution path as the public worker,
    // with Stop committed before either normal prelaunch read can run.
    let pool = database.pool.clone();
    let handle = Handle::current();
    let worker = tokio::task::spawn_blocking(move || {
        let paths = host.paths();
        let cancelled = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(15);
        let result = match provider {
            Provider::Codex => run_codex_claimed(
                &handle,
                &pool,
                execution_principal,
                fence,
                config,
                launch_permit,
                &cancelled,
                deadline,
                &paths,
            ),
            Provider::Hermes => hermes::run_claimed(
                &handle,
                &pool,
                execution_principal,
                fence,
                config,
                launch_permit,
                &cancelled,
                deadline,
                &paths,
            )
            .map(NativeExecutionObservation::Hermes),
        };
        (result, host)
    });
    let (result, host) = worker.await.expect("claimed worker joins");
    let failure = match result {
        Err(failure) => failure,
        Ok(_) => panic!("Stop before launch cannot produce a provider turn"),
    };
    assert!(
        failure.is_cancelled(),
        "Stop should cancel before provider work"
    );
    assert_eq!(
        failure.process_disposition(),
        ProcessDisposition::CleanupProven,
        "the exact owned host must provide cleanup evidence"
    );
    assert!(failure.process_quiescent());
    assert!(match provider {
        Provider::Codex => failure.cleanup_receipt().is_some(),
        Provider::Hermes => failure.hermes_cleanup_receipt().is_some(),
    });

    let events = host.events();
    assert!(
        events.is_empty(),
        "Stop is polled after spawn and before provider initialization"
    );
    assert!(
        !host.probe_path("session-new-count").exists(),
        "Hermes must not create a session"
    );
    assert!(
        !events.iter().any(|event| {
            matches!(
                event["received"]["method"].as_str(),
                Some("thread/start" | "turn/start" | "session/new" | "session/prompt")
            )
        }),
        "Stop must not start a Thread/session or submit the admitted input"
    );

    let execution_actor = failure
        .execution_principal()
        .expect("claimed execution principal retained");
    let fence = failure.fence().expect("claim fence retained").clone();
    let stop = execution::observe_stop(&database.pool, execution_actor, &fence)
        .await
        .expect("read active Stop")
        .expect("durable Stop remains active");
    let result = match provider {
        Provider::Codex => {
            let cleanup = failure
                .cleanup_receipt()
                .expect("Codex cleanup receipt retained");
            execution::bind_stopping_connection(
                &database.pool,
                execution_actor,
                &fence,
                &stop,
                &cleanup.connection_receipt(),
            )
            .await
            .expect("bind exact Codex owner connection");
            execution::finalize_stopped_before_submission(
                &database.pool,
                execution_actor,
                &fence,
                cleanup,
                &stop,
            )
            .await
            .expect("finalize unsubmitted Codex Stop")
        }
        Provider::Hermes => {
            let cleanup = failure
                .hermes_cleanup_receipt()
                .expect("Hermes cleanup receipt retained");
            execution::bind_stopping_connection(
                &database.pool,
                execution_actor,
                &fence,
                &stop,
                &cleanup.connection_receipt(),
            )
            .await
            .expect("bind exact Hermes owner connection");
            execution::finalize_hermes_stopped_before_submission(
                &database.pool,
                execution_actor,
                &fence,
                cleanup,
                &stop,
            )
            .await
            .expect("finalize unsubmitted Hermes Stop")
        }
    };
    assert_eq!(result["status"], "cancelled");
    assert_eq!(result["generationStatus"], "stopped");
    assert_eq!(result["nativeAdmissionHold"], false);
    assert_eq!(result["inputDisposition"], "not_submitted");
    let (run_status, run_hold, generation_status, generation_hold): (String, bool, String, bool) =
        sqlx::query_as(
            "SELECT r.status,r.native_admission_hold,g.status,g.native_admission_hold
             FROM heartbeat_runs r JOIN chat_generations g
               ON g.org_id=r.org_id AND g.id=r.chat_generation_id WHERE r.id=$1::uuid",
        )
        .bind(&run_id)
        .fetch_one(&database.pool)
        .await
        .expect("read finalized hold state");
    assert_eq!(
        (run_status, run_hold, generation_status, generation_hold),
        ("cancelled".into(), false, "stopped".into(), false)
    );

    let assistant_messages: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_messages WHERE run_id=$1::uuid AND role='assistant'",
    )
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("count assistant output after Stop");
    assert_eq!(assistant_messages, 0, "Stop cannot project provider output");
    assert!(
        fixture::claim(
            &database.pool,
            &actor,
            fixture::ORG,
            &run_id,
            &attempt_id,
            host.context(),
        )
        .await
        .is_err(),
        "a finalized stopped attempt cannot be replayed"
    );
}

async fn exercise_hermes_existing_session_stop() {
    use cleanup_claim_fixture as fixture;

    let (database, host, actor, first_run_id, first_attempt_id) =
        fixture::database_and_hermes_admission("complete").await;
    let (first_result, host) = fixture::execute_native_on_worker(
        &database,
        host,
        actor.clone(),
        first_run_id.clone(),
        first_attempt_id,
    )
    .await;
    let first = match first_result {
        Ok(NativeExecutionObservation::Hermes(observation)) => observation,
        Ok(_) => panic!("the Hermes fixture must return a Hermes observation"),
        Err(error) => panic!("seed a real persisted Hermes session: {error:?}"),
    };
    let cleanup = first
        .cleanup_receipt
        .as_ref()
        .expect("first Hermes turn has exact owned cleanup");
    execution::finalize_hermes(
        &database.pool,
        &actor,
        &first.fence,
        &first.turn_receipt,
        cleanup,
    )
    .await
    .expect("finalize the first synthetic Hermes turn to persist its session");
    let events_before_stop = host.events();
    assert!(
        events_before_stop
            .iter()
            .any(|event| { event["received"]["method"].as_str() == Some("session/new") })
    );
    assert!(
        events_before_stop
            .iter()
            .any(|event| { event["received"]["method"].as_str() == Some("session/prompt") })
    );

    let stored_session: Option<String> = sqlx::query_scalar(
        "SELECT s.native_session_id FROM heartbeat_runs r
         JOIN native_segments s
           ON s.org_id=r.org_id AND s.id=(r.context_snapshot->>'nativeSegmentId')::uuid
         WHERE r.id=$1::uuid",
    )
    .bind(&first_run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read session created by the completed Hermes turn");
    assert_eq!(
        stored_session.as_deref(),
        Some("550e8400-e29b-41d4-a716-446655440000"),
        "the second attempt must resume the persisted native session"
    );

    let (actor, run_id, attempt_id) = fixture::admitted_hermes_with_input(
        &database,
        &host,
        "native-chat-executor-hermes-resume-2",
        "Do not submit this second admitted input.",
    )
    .await;
    let claimed = fixture::claim(
        &database.pool,
        &actor,
        fixture::ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    .expect("claim an attempt that resumes the persisted Hermes session");
    let (principal, fence, config, launch_permit) = claimed.into_execution_parts();
    let stop_request = stop_request(&database.pool, &run_id).await;
    let stop = request_stop(&database.pool, &actor, &stop_request)
        .await
        .expect("Stop after existing-session claim");
    assert_eq!(stop.outcome, StopOutcome::StopIntentRecorded);

    let pool = database.pool.clone();
    let handle = Handle::current();
    let worker = tokio::task::spawn_blocking(move || {
        let paths = host.paths();
        let cancelled = AtomicBool::new(false);
        let result = hermes::run_claimed(
            &handle,
            &pool,
            principal,
            fence,
            config,
            launch_permit,
            &cancelled,
            Instant::now() + Duration::from_secs(15),
            &paths,
        )
        .map(NativeExecutionObservation::Hermes);
        (result, host)
    });
    let (result, host) = worker.await.expect("resumed Hermes worker joins");
    let failure = match result {
        Err(failure) => failure,
        Ok(_) => panic!("pre-prompt Stop must cancel the resumed session"),
    };
    assert!(failure.is_cancelled());
    assert_eq!(
        failure.process_disposition(),
        ProcessDisposition::CleanupProven
    );
    let cleanup = failure
        .hermes_cleanup_receipt()
        .expect("same-owner Hermes cleanup receipt");
    assert!(failure.process_quiescent());
    assert_eq!(
        host.events(),
        events_before_stop,
        "resumed Stop must happen before initialize, session load, or prompt"
    );

    let execution_actor = failure
        .execution_principal()
        .expect("claimed execution principal retained");
    let fence = failure.fence().expect("claim fence retained").clone();
    let stop = execution::observe_stop(&database.pool, execution_actor, &fence)
        .await
        .expect("read active Stop")
        .expect("durable Stop remains active");
    execution::bind_stopping_connection(
        &database.pool,
        execution_actor,
        &fence,
        &stop,
        &cleanup.connection_receipt(),
    )
    .await
    .expect("bind exact Hermes owner connection");
    let result = execution::finalize_hermes_stopped_before_submission(
        &database.pool,
        execution_actor,
        &fence,
        cleanup,
        &stop,
    )
    .await
    .expect("finalize resumed Hermes Stop before prompt submission");
    assert_eq!(result["status"], "cancelled");
    assert_eq!(result["generationStatus"], "stopped");
    assert_eq!(result["nativeAdmissionHold"], false);
    assert_eq!(result["inputDisposition"], "not_submitted");

    let (run_status, run_hold, generation_status, generation_hold): (String, bool, String, bool) =
        sqlx::query_as(
            "SELECT r.status,r.native_admission_hold,g.status,g.native_admission_hold
             FROM heartbeat_runs r JOIN chat_generations g
               ON g.org_id=r.org_id AND g.id=r.chat_generation_id WHERE r.id=$1::uuid",
        )
        .bind(&run_id)
        .fetch_one(&database.pool)
        .await
        .expect("read finalized Hermes resume holds");
    assert_eq!(
        (run_status, run_hold, generation_status, generation_hold),
        ("cancelled".into(), false, "stopped".into(), false)
    );
    let assistant_messages: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_messages WHERE run_id=$1::uuid AND role='assistant'",
    )
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("count assistant output after resumed Hermes Stop");
    assert_eq!(assistant_messages, 0);
    assert!(
        fixture::claim(
            &database.pool,
            &actor,
            fixture::ORG,
            &run_id,
            &attempt_id,
            host.context(),
        )
        .await
        .is_err(),
        "a finalized resumed Hermes attempt cannot be replayed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and synthetic providers"]
async fn stop_after_claim_before_prelaunch_reads_cleans_codex_and_hermes_without_submission() {
    cleanup_claim_fixture::assert_ignored_external_dependencies();
    exercise_stop_after_claim(Provider::Codex).await;
    exercise_stop_after_claim(Provider::Hermes).await;
    exercise_hermes_existing_session_stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL"]
async fn unrelated_prelaunch_409_without_stop_does_not_use_stopping_snapshot() {
    use cleanup_claim_fixture as fixture;

    let (database, host, actor, run_id, attempt_id) =
        fixture::database_and_admission("complete").await;
    let claimed = fixture::claim(
        &database.pool,
        &actor,
        fixture::ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    .expect("claim admitted execution");
    let (principal, fence, _config, _permit) = claimed.into_execution_parts();
    let mut tx = database.pool.begin().await.expect("begin fixture mutation");
    sqlx::query("SELECT set_config('rudder.native_chat_write', $1, true)")
        .bind("native_chat:execution")
        .execute(&mut *tx)
        .await
        .expect("mark the scoped Rust-owned fixture mutation");
    sqlx::query(
        "UPDATE chat_messages SET body='changed after admission'
         WHERE id=(SELECT source_message_id FROM chat_generations WHERE id=$1::uuid)",
    )
    .bind(fence.identity().generation_id)
    .execute(&mut *tx)
    .await
    .expect("change the admitted source in the disposable fixture");
    tx.commit().await.expect("commit fixture source change");

    assert!(
        execution::observe_stop(&database.pool, &principal, &fence)
            .await
            .expect("absence of active Stop is readable")
            .is_none()
    );
    let pool = database.pool.clone();
    let handle = Handle::current();
    let result = tokio::task::spawn_blocking(move || {
        prelaunch_checkpoint(
            &handle,
            &pool,
            &principal,
            &fence,
            Instant::now() + Duration::from_secs(5),
        )
    })
    .await
    .expect("prelaunch checker joins");
    assert!(matches!(
        result,
        Err(Error::Persistence(runtime_bindings::Error::Http(409, _)))
    ));
    assert!(
        !host.provider_started(),
        "an unrelated source conflict must not launch the owned provider"
    );
}
