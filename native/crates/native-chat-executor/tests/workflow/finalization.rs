use crate::fixture::*;
use rudder_auth_core::VerifiedActor;
use rudder_d1_persistence::native_chat::execution::finalize;
use rudder_native_chat_executor::{
    ExecutionFailure, ExecutionObservation, ExecutionRequest, ProcessDisposition,
    run_observed_on_blocking_thread,
};
use serde_json::Value;
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{runtime::Handle, task::JoinHandle};

type ObservedWorker = JoinHandle<(
    std::result::Result<ExecutionObservation, ExecutionFailure>,
    FixtureHost,
)>;

fn spawn_observed_worker(
    database: &Database,
    host: FixtureHost,
    actor: VerifiedActor,
    run_id: String,
    attempt_id: String,
    timeout: Duration,
) -> (ObservedWorker, Arc<AtomicBool>) {
    let pool = database.pool.clone();
    let handle = Handle::current();
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let worker = tokio::task::spawn_blocking(move || {
        let paths = host.paths();
        let result = run_observed_on_blocking_thread(
            &handle,
            &pool,
            &actor,
            host.context(),
            &paths,
            ExecutionRequest {
                organization_id: ORG,
                run_id: &run_id,
                attempt_id: &attempt_id,
                timeout,
                cancelled: worker_cancelled.as_ref(),
            },
        );
        (result, host)
    });
    (worker, cancelled)
}

async fn panic_for_early_worker_exit(worker: &mut ObservedWorker, context: &str) -> ! {
    match (&mut *worker).await {
        Ok((Ok(_), _)) => panic!("{context}: executor completed before the fixture gate"),
        Ok((Err(error), _)) => panic!("{context}: executor failed early: {error:?}"),
        Err(error) => panic!("{context}: executor worker join failed: {error}"),
    }
}

async fn cancel_worker_after_fixture_timeout(
    worker: &mut ObservedWorker,
    cancelled: &AtomicBool,
    context: &str,
) -> ! {
    cancelled.store(true, Ordering::Release);
    match tokio::time::timeout(Duration::from_secs(15), &mut *worker).await {
        Ok(Ok((Ok(_), _))) => panic!("{context}: worker completed after fixture timeout"),
        Ok(Ok((Err(error), _))) => panic!("{context}: worker failed after timeout: {error:?}"),
        Ok(Err(error)) => panic!("{context}: executor worker join failed: {error}"),
        Err(_) => panic!("{context}: executor did not stop after fixture cancellation"),
    }
}

async fn wait_for_fixture_gate(
    path: &Path,
    worker: &mut ObservedWorker,
    cancelled: &AtomicBool,
    context: &str,
) {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if path.exists() {
            return;
        }
        if worker.is_finished() {
            panic_for_early_worker_exit(worker, context).await;
        }
        if Instant::now() >= deadline {
            cancel_worker_after_fixture_timeout(worker, cancelled, context).await;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_for_output_rows(
    database: &Database,
    run_id: &str,
    expected: i64,
    worker: &mut ObservedWorker,
    cancelled: &AtomicBool,
) {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM chat_generation_events WHERE org_id=$1::uuid AND run_id=$2::uuid
             AND event_kind IN ('assistant_delta','runtime_output')",
        )
        .bind(ORG)
        .bind(run_id)
        .fetch_one(&database.pool)
        .await
        .expect("count persisted output receipts");
        if count == expected {
            return;
        }
        assert!(count < expected, "output writer advanced past gated batch");
        if worker.is_finished() {
            panic_for_early_worker_exit(worker, "output batch persistence").await;
        }
        if Instant::now() >= deadline {
            cancel_worker_after_fixture_timeout(worker, cancelled, "output batch persistence")
                .await;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn release_fixture_gate(home: &Path, stage: &str, batch: usize) {
    std::fs::write(
        home.join(format!("output-flood-{stage}-release-{batch}")),
        "release",
    )
    .expect("release bounded fake-provider event batch");
}

async fn run_gated_many_observations() {
    let (database, host, actor, run_id, attempt_id) =
        database_and_admission("many-observations").await;
    let home = host
        .probe_path("mode.txt")
        .parent()
        .expect("isolated provider home")
        .to_path_buf();
    let (mut worker, cancelled) = spawn_observed_worker(
        &database,
        host,
        actor,
        run_id.clone(),
        attempt_id,
        Duration::from_secs(90),
    );
    // 130 usage updates plus 130 tool starts/completions cross the old
    // notification-count boundary without overflowing the bounded host queue.
    for batch in 0..7 {
        let marker = home.join(format!("output-flood-many-pending-{batch}"));
        wait_for_fixture_gate(
            &marker,
            &mut worker,
            &cancelled,
            "mixed observation prelude",
        )
        .await;
        wait_for_output_rows(
            &database,
            &run_id,
            (batch + 1) as i64,
            &mut worker,
            &cancelled,
        )
        .await;
        release_fixture_gate(&home, "many", batch);
    }
    let (result, host) = worker.await.expect("many-observations worker joins");
    let observation = match result {
        Ok(observation) => observation,
        Err(error) => panic!("mixed provider observations should remain usable: {error:?}"),
    };
    assert_eq!(
        observation.turn_receipt.final_text(),
        Some("synthetic answer")
    );
    assert_eq!(observation.turn_receipt.usage().unwrap().total_tokens(), 12);
    let counts: Value = serde_json::from_slice(
        &std::fs::read(host.probe_path("many-observations-counts.json"))
            .expect("provider emitted mixed observation counts"),
    )
    .expect("mixed observation count JSON");
    assert_eq!(counts["usage"], 130);
    assert_eq!(counts["toolStarted"], 130);
    assert_eq!(counts["toolCompleted"], 130);
}

async fn projection_state(database: &Database, run_id: &str, attempt_id: &str) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'run',jsonb_build_object('status',r.status,'hold',r.native_admission_hold,
             'finishedAt',r.finished_at,'updatedAt',r.updated_at),
           'generation',jsonb_build_object('status',g.status,'hold',g.native_admission_hold,
             'terminalReason',g.terminal_reason,'runtimeTerminalAt',g.runtime_terminal_at,
             'completedAt',g.completed_at,'updatedAt',g.updated_at),
           'attempt',jsonb_build_object('status',a.status,'phase',a.protocol_phase,
             'finishedAt',a.finished_at),
           'span',jsonb_build_object('state',s.state,'closedAt',s.closed_at),
           'assistant',jsonb_build_object('id',m.id,'status',m.status,'body',m.body,
             'updatedAt',m.updated_at),
           'outputLedger',COALESCE((
             SELECT jsonb_agg(jsonb_build_array(e.generation_seq,e.event_kind,
               e.assistant_message_id,e.payload) ORDER BY e.generation_seq)
             FROM chat_generation_events e WHERE e.org_id=r.org_id AND e.run_id=r.id
               AND e.event_kind IN ('assistant_delta','runtime_output')),'[]'::jsonb),
           'runEventCount',(SELECT count(*) FROM heartbeat_run_events re
             WHERE re.org_id=r.org_id AND re.run_id=r.id),
           'finalizedActivityCount',(SELECT count(*) FROM activity_log al WHERE al.org_id=r.org_id
             AND al.entity_type='heartbeat_run' AND al.entity_id=r.id::text
             AND al.action='runtime.native_chat.finalized'))
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$3::uuid
         JOIN run_runtime_spans s ON s.org_id=r.org_id AND s.run_id=r.id AND s.attempt_id=a.id
          AND s.relation='primary'
         JOIN chat_messages m ON m.org_id=r.org_id AND m.run_id=r.id AND m.role='assistant'
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(run_id)
    .bind(attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read Native Chat projection state")
}

async fn assert_rejected_projection_keeps_execution_held(
    database: &Database,
    run_id: &str,
    attempt_id: &str,
    expected_body: &str,
    before: &Value,
) {
    let after = projection_state(database, run_id, attempt_id).await;
    assert_eq!(
        after, *before,
        "rejected finalization must have zero effects"
    );
    assert!(before["run"]["hold"].as_bool().unwrap());
    assert!(before["generation"]["hold"].as_bool().unwrap());
    assert!(!matches!(
        before["run"]["status"].as_str().unwrap(),
        "succeeded" | "failed" | "cancelled" | "stopped" | "completed"
    ));
    assert!(!matches!(
        before["generation"]["status"].as_str().unwrap(),
        "succeeded" | "failed" | "cancelled" | "stopped" | "completed"
    ));
    assert_eq!(before["attempt"]["phase"], "provider_terminal_observed");
    assert_eq!(before["span"]["state"], "open");
    assert_eq!(before["assistant"]["status"], "streaming");
    assert_eq!(before["assistant"]["body"], expected_body);
    assert_eq!(before["finalizedActivityCount"], 0);
}

type FinalizedRunState = (
    String,
    bool,
    String,
    bool,
    String,
    Option<i64>,
    Option<String>,
    Option<String>,
);

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn typed_receipts_finalize_once_with_unknown_cost_and_exact_terminal_projection() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) = database_and_admission("complete").await;
    let (result, host) = execute_on_worker(
        &database,
        host,
        actor.clone(),
        run_id.clone(),
        attempt_id.clone(),
    )
    .await;
    let observation = result.expect("synthetic completed turn should be observed");
    let cleanup = observation
        .cleanup_receipt
        .as_ref()
        .expect("typed cleanup evidence must accompany provider turn evidence");
    assert!(cleanup.proves_quiescence_for(&observation.turn_receipt));
    assert_eq!(
        observation.turn_receipt.final_text(),
        Some("synthetic answer")
    );
    assert_eq!(observation.turn_receipt.usage().unwrap().total_tokens(), 12);

    let selected_model: Option<String> =
        sqlx::query_scalar("SELECT model FROM heartbeat_run_attempts WHERE id=$1::uuid")
            .bind(&attempt_id)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(selected_model.as_deref(), Some(MODEL));
    let events = host.events();
    let dispatched = events
        .iter()
        .find(|event| event["received"]["method"] == "turn/start")
        .unwrap();
    assert_eq!(dispatched["received"]["params"]["model"], MODEL);
    sqlx::query(
        "UPDATE agents SET agent_runtime_config=jsonb_set(agent_runtime_config,'{model}',
         '\"vendor/changed-after-execution\"'::jsonb) WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .unwrap();

    let first = finalize(
        &database.pool,
        &actor,
        &observation.fence,
        &observation.turn_receipt,
        cleanup,
    )
    .await
    .expect("validated turn and cleanup receipts finalize");
    assert_eq!(first["status"], "succeeded");
    assert_eq!(first["nativeAdmissionHold"], false);
    assert_eq!(first["projectionDisposition"], "projected");
    assert_eq!(first["budgetDisposition"], "unbudgeted_unknown_cost");
    assert_eq!(first["cost"]["status"], "unknown");
    assert_eq!(first["usage"]["status"], "unavailable");
    assert_eq!(first["usage"]["reason"], "run_total_not_established");
    let latest = &first["usage"]["latestReportedIncrement"];
    assert_eq!(
        latest["source"],
        "thread/tokenUsage/updated.tokenUsage.last"
    );
    assert_eq!(latest["scope"], "latest_reported_increment");
    assert_eq!(latest["attemptId"], attempt_id);
    assert_eq!(latest["model"], MODEL);
    assert_eq!(latest["modelSource"], "execution_config");
    assert!(latest.get("threadId").is_none());
    assert!(latest.get("turnId").is_none());
    assert_eq!(latest["inputTokens"], 5);
    assert_eq!(latest["cachedInputTokens"], 2);
    assert_eq!(latest["outputTokens"], 7);
    assert_eq!(latest["reasoningOutputTokens"], 3);
    assert_eq!(latest["totalTokens"], 12);

    let retry = finalize(
        &database.pool,
        &actor,
        &observation.fence,
        &observation.turn_receipt,
        cleanup,
    )
    .await
    .expect("exact durable finalization retry returns its committed result");
    assert_eq!(retry, first);

    let (run_status, run_hold, generation_status, generation_hold, attempt_status, cost_cents, session_before, session_after):
        FinalizedRunState = sqlx::query_as(
        "SELECT r.status,r.native_admission_hold,g.status,g.native_admission_hold,a.status,a.cost_cents,
                r.session_id_before,r.session_id_after
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$3::uuid
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read finalized owner state");
    assert_eq!(run_status, "succeeded");
    assert_eq!(generation_status, "completed");
    assert_eq!(attempt_status, "succeeded");
    assert!(!run_hold && !generation_hold);
    assert_eq!(session_before, None);
    assert_eq!(session_after, None);
    assert_eq!(
        cost_cents, None,
        "unknown provider cost is never converted to zero"
    );

    let assistant_messages: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND run_id=$2::uuid AND role='assistant'",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let generation_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_generation_events WHERE org_id=$1::uuid AND run_id=$2::uuid
         AND event_kind IN ('runtime_terminal','terminal_projected')",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let run_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid
         AND idempotency_key=$3",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(format!("native-finalize:{attempt_id}"))
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let activity_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_type='heartbeat_run'
         AND entity_id=$2 AND action='runtime.native_chat.finalized'",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(assistant_messages, 1);
    assert_eq!(generation_events, 2);
    assert_eq!(run_events, 1);
    assert_eq!(activity_events, 1);
    assert!(host.provider_started());

    let (
        result_json,
        usage_json,
        event_payloads,
        generation_payloads,
        activity_details,
        attempt_thread,
        attempt_turn,
        selector_json,
    ): (
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    ) = sqlx::query_as(
        "SELECT r.result_json::text,r.usage_json::text,
                COALESCE((SELECT string_agg(e.payload::text,' ') FROM heartbeat_run_events e
                          WHERE e.org_id=r.org_id AND e.run_id=r.id),''),
                COALESCE((SELECT string_agg(e.payload::text,' ') FROM chat_generation_events e
                          WHERE e.org_id=r.org_id AND e.generation_id=r.chat_generation_id),''),
                COALESCE((SELECT string_agg(a.details::text,' ') FROM activity_log a
                          WHERE a.org_id=r.org_id AND a.entity_type='heartbeat_run' AND a.entity_id=r.id::text),''),
                a.provider_thread_id,a.provider_turn_id,s.selector_json::text
         FROM heartbeat_runs r
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$3::uuid
         JOIN run_runtime_spans s ON s.org_id=r.org_id AND s.run_id=r.id AND s.attempt_id=a.id
          AND s.relation='primary'
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read public and private finalization evidence");
    let public_writes = format!(
        "{result_json} {usage_json} {event_payloads} {generation_payloads} {activity_details}"
    );
    assert!(!public_writes.contains(observation.turn_receipt.thread_id()));
    assert!(!public_writes.contains(observation.turn_receipt.turn_id()));
    assert_eq!(attempt_thread, observation.turn_receipt.thread_id());
    assert_eq!(attempt_turn, observation.turn_receipt.turn_id());
    assert!(selector_json.contains(observation.turn_receipt.thread_id()));
    assert!(selector_json.contains(observation.turn_receipt.turn_id()));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn mismatched_execution_receipts_cannot_finalize_another_run() {
    assert_ignored_external_dependencies();
    let (database_a, host_a, actor_a, run_a, attempt_a) = database_and_admission("complete").await;
    let (result_a, _host_a) = execute_on_worker(
        &database_a,
        host_a,
        actor_a.clone(),
        run_a.clone(),
        attempt_a.clone(),
    )
    .await;
    let observation_a = result_a.expect("first synthetic turn should run");

    let (database_b, host_b, actor_b, run_b, attempt_b) = database_and_admission("complete").await;
    let (result_b, _host_b) =
        execute_on_worker(&database_b, host_b, actor_b, run_b, attempt_b).await;
    let observation_b = result_b.expect("second synthetic turn should run");
    let cleanup_b = observation_b.cleanup_receipt.as_ref().unwrap();
    assert!(!cleanup_b.proves_quiescence_for(&observation_a.turn_receipt));
    assert!(
        finalize(
            &database_a.pool,
            &actor_a,
            &observation_a.fence,
            &observation_b.turn_receipt,
            cleanup_b,
        )
        .await
        .is_err()
    );

    let (status, hold, phase): (String, bool, String) = sqlx::query_as(
        "SELECT r.status,r.native_admission_hold,a.protocol_phase FROM heartbeat_runs r
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$3::uuid
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_a)
    .bind(&attempt_a)
    .fetch_one(&database_a.pool)
    .await
    .unwrap();
    assert_eq!(status, "running");
    assert!(hold);
    assert_eq!(phase, "provider_terminal_observed");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn completed_turn_without_final_answer_stays_held_and_is_not_projected() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) = database_and_admission("empty-answer").await;
    let (result, _host) = execute_on_worker(
        &database,
        host,
        actor.clone(),
        run_id.clone(),
        attempt_id.clone(),
    )
    .await;
    let observation = result.expect("terminal status can be observed without a final answer");
    assert_eq!(observation.turn_receipt.final_text(), None);
    let cleanup = observation.cleanup_receipt.as_ref().unwrap();
    let result = finalize(
        &database.pool,
        &actor,
        &observation.fence,
        &observation.turn_receipt,
        cleanup,
    )
    .await
    .expect("unsupported output is durably represented without inventing an answer");
    assert_eq!(result["projectionDisposition"], "unsupported_final_answer");
    assert_eq!(result["nativeAdmissionHold"], true);
    assert_eq!(result["cost"]["status"], "unknown");
    assert_eq!(result["usage"]["status"], "unavailable");
    assert_eq!(
        result["usage"]["latestReportedIncrement"]["totalTokens"],
        12
    );
    let (run_status, generation_status, terminal_reason, run_hold, generation_hold, assistant_messages): (String, String, String, bool, bool, i64) = sqlx::query_as(
        "SELECT r.status,g.status,g.terminal_reason,
                r.native_admission_hold,g.native_admission_hold,
                (SELECT count(*) FROM chat_messages m WHERE m.org_id=r.org_id AND m.run_id=r.id AND m.role='assistant')
         FROM heartbeat_runs r JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(run_status, "failed");
    assert_eq!(generation_status, "failed");
    assert_eq!(
        terminal_reason,
        "native_provider_completed_without_projectable_answer"
    );
    assert!(run_hold && generation_hold);
    assert_eq!(assistant_messages, 0);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn valid_partial_stream_without_terminal_answer_is_failed_and_remains_held() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) =
        database_and_admission("partial-empty-answer").await;
    let (result, _host) = execute_on_worker(
        &database,
        host,
        actor.clone(),
        run_id.clone(),
        attempt_id.clone(),
    )
    .await;
    let observation = result.expect("completed Turn with partial visible output is observed");
    assert_eq!(observation.turn_receipt.final_text(), None);
    let cleanup = observation.cleanup_receipt.as_ref().unwrap();
    let result = finalize(
        &database.pool,
        &actor,
        &observation.fence,
        &observation.turn_receipt,
        cleanup,
    )
    .await
    .expect("validated partial output is represented as unsupported final answer");
    assert_eq!(result["status"], "failed");
    assert_eq!(result["generationStatus"], "failed");
    assert_eq!(result["nativeAdmissionHold"], true);
    assert_eq!(result["projectionDisposition"], "unsupported_final_answer");

    let (run_status, generation_status, run_hold, generation_hold, message_status, body): (
        String,
        String,
        bool,
        bool,
        String,
        String,
    ) = sqlx::query_as(
        "SELECT r.status,g.status,r.native_admission_hold,g.native_admission_hold,m.status,m.body
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN chat_messages m ON m.org_id=r.org_id AND m.run_id=r.id AND m.role='assistant'
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read failed partial-output projection");
    assert_eq!(run_status, "failed");
    assert_eq!(generation_status, "failed");
    assert!(run_hold && generation_hold);
    assert_eq!(message_status, "failed");
    assert_eq!(body, "same same answer");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn interrupted_turn_persists_stopped_assistant_message_and_retains_admission_holds() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) = database_and_admission("interrupted").await;
    let (result, _host) = execute_on_worker(
        &database,
        host,
        actor.clone(),
        run_id.clone(),
        attempt_id.clone(),
    )
    .await;
    let observation = result.expect("interrupted terminal is valid evidence");
    assert_eq!(
        observation.turn_receipt.final_text(),
        Some("synthetic answer")
    );
    let cleanup = observation.cleanup_receipt.as_ref().unwrap();
    let result = finalize(
        &database.pool,
        &actor,
        &observation.fence,
        &observation.turn_receipt,
        cleanup,
    )
    .await
    .expect("interrupted terminal is durably represented");
    assert_eq!(result["status"], "cancelled");
    assert_eq!(result["generationStatus"], "stopped");
    assert_eq!(result["nativeAdmissionHold"], false);

    let (run_status, generation_status, run_hold, generation_hold, message_status, message_body): (
        String,
        String,
        bool,
        bool,
        String,
        String,
    ) = sqlx::query_as(
        "SELECT r.status,g.status,r.native_admission_hold,g.native_admission_hold,
                m.status,m.body
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN chat_messages m ON m.org_id=r.org_id AND m.run_id=r.id AND m.role='assistant'
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(run_status, "cancelled");
    assert_eq!(generation_status, "stopped");
    assert!(!run_hold && !generation_hold);
    assert_eq!(message_status, "stopped");
    assert_eq!(message_body, "synthetic answer");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn streamed_output_preserves_repeated_deltas_and_finalizes_the_same_message() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) = database_and_admission("stream-output").await;
    let (result, _host) = execute_on_worker(
        &database,
        host,
        actor.clone(),
        run_id.clone(),
        attempt_id.clone(),
    )
    .await;
    let observation = result.expect("streamed synthetic Turn should be observed");
    assert_eq!(
        observation.turn_receipt.final_text(),
        Some("same same answer")
    );

    let (message_id, message_status, message_body): (String, String, String) = sqlx::query_as(
        "SELECT id::text,status,body FROM chat_messages
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND role='assistant'",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("visible streaming reply must be queryable before terminalization");
    assert_eq!(message_status, "streaming");
    assert_eq!(message_body, "same same answer");

    let output_events: Vec<(String, Value)> = sqlx::query_as(
        "SELECT event_kind,payload FROM chat_generation_events
         WHERE org_id=$1::uuid AND run_id=$2::uuid
           AND event_kind IN ('assistant_delta','runtime_output')
         ORDER BY generation_seq",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_all(&database.pool)
    .await
    .expect("read ordered visible output receipts");
    assert_eq!(output_events.len(), 4);
    assert_eq!(output_events[0].0, "assistant_delta");
    assert_eq!(output_events[0].1["delta"], "same ");
    assert_eq!(output_events[1].0, "assistant_delta");
    assert_eq!(output_events[1].1["delta"], "same ");
    assert_eq!(
        output_events[2].1["delta"], "answer",
        "identical chunks remain distinct ordered observations"
    );
    assert_eq!(output_events[3].0, "runtime_output");
    assert_eq!(output_events[3].1["body"], "same same answer");

    let cleanup = observation
        .cleanup_receipt
        .as_ref()
        .expect("owned process cleanup receipt");
    let finalized = finalize(
        &database.pool,
        &actor,
        &observation.fence,
        &observation.turn_receipt,
        cleanup,
    )
    .await
    .expect("terminal receipt should close the existing streaming row");
    assert_eq!(finalized["assistantMessageId"], message_id);

    let (count, final_status, final_body): (i64, String, String) = sqlx::query_as(
        "SELECT count(*) OVER (),status,body FROM chat_messages
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND role='assistant' LIMIT 1",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read terminalized assistant projection");
    assert_eq!(count, 1, "finalization must not insert a duplicate reply");
    assert_eq!(final_status, "completed");
    assert_eq!(final_body, "same same answer");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn finalization_rejects_tampered_output_provenance_without_effects() {
    reject_corrupt_projection(false).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn finalization_rejects_corrupt_snapshot_text_even_when_body_hash_is_unchanged() {
    reject_corrupt_projection(true).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn finalization_rejects_tampered_delta_that_remains_a_body_suffix() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) =
        database_and_admission("partial-empty-answer").await;
    let (result, _host) = execute_on_worker(
        &database,
        host,
        actor.clone(),
        run_id.clone(),
        attempt_id.clone(),
    )
    .await;
    let observation = result.expect("completed Turn with partial visible output is observed");
    assert_eq!(observation.turn_receipt.final_text(), None);
    let cleanup = observation.cleanup_receipt.as_ref().unwrap();
    let latest_delta: (String, String, String) = sqlx::query_as(
        "SELECT event_kind,payload->>'delta',payload->>'bodyHash' FROM chat_generation_events
         WHERE org_id=$1::uuid AND run_id=$2::uuid
           AND event_kind IN ('assistant_delta','runtime_output')
         ORDER BY generation_seq DESC LIMIT 1",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read latest partial output event");
    assert_eq!(latest_delta.0, "assistant_delta");
    assert_eq!(latest_delta.1, "answer");
    assert!("same same answer".ends_with("swer"));

    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE chat_generation_events SET payload=jsonb_set(payload,'{delta}',
           to_jsonb('swer'::text),false)
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND generation_seq=(
           SELECT max(generation_seq) FROM chat_generation_events
           WHERE org_id=$1::uuid AND run_id=$2::uuid AND event_kind='assistant_delta')",
    )
    .bind(ORG)
    .bind(&run_id)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let retained_hash: String = sqlx::query_scalar(
        "SELECT payload->>'bodyHash' FROM chat_generation_events
         WHERE org_id=$1::uuid AND run_id=$2::uuid
           AND event_kind='assistant_delta'
         ORDER BY generation_seq DESC LIMIT 1",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read retained delta body hash");
    assert_eq!(retained_hash, latest_delta.2);
    let before = projection_state(&database, &run_id, &attempt_id).await;

    assert!(
        finalize(
            &database.pool,
            &actor,
            &observation.fence,
            &observation.turn_receipt,
            cleanup,
        )
        .await
        .is_err(),
        "a suffix delta with the original body hash cannot authenticate a partial reply"
    );
    assert_rejected_projection_keeps_execution_held(
        &database,
        &run_id,
        &attempt_id,
        "same same answer",
        &before,
    )
    .await;
}

async fn reject_corrupt_projection(corrupt_body: bool) {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) = database_and_admission("stream-output").await;
    let (result, _host) = execute_on_worker(
        &database,
        host,
        actor.clone(),
        run_id.clone(),
        attempt_id.clone(),
    )
    .await;
    let observation = result.expect("streamed synthetic Turn should be observed");
    let cleanup = observation.cleanup_receipt.as_ref().unwrap();
    let message_id: String = sqlx::query_scalar(
        "SELECT id::text FROM chat_messages WHERE org_id=$1::uuid AND run_id=$2::uuid
          AND role='assistant'",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read streaming reply id");
    let latest_sequence: i32 = sqlx::query_scalar(
        "SELECT max(generation_seq) FROM chat_generation_events WHERE org_id=$1::uuid
          AND run_id=$2::uuid AND event_kind IN ('assistant_delta','runtime_output')",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read latest output ledger sequence");
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE chat_generation_events SET payload=CASE WHEN $4::boolean
           THEN jsonb_set(payload,'{body}',to_jsonb('corrupt terminal body'::text),true)
           ELSE jsonb_set(payload,'{nativeSource,claimDigest}',to_jsonb('tampered-claim'::text),true) END
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND generation_seq=$3",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(latest_sequence)
    .bind(corrupt_body)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let before = projection_state(&database, &run_id, &attempt_id).await;

    assert!(
        finalize(
            &database.pool,
            &actor,
            &observation.fence,
            &observation.turn_receipt,
            cleanup,
        )
        .await
        .is_err(),
        "a terminal receipt cannot authenticate a changed output source"
    );
    assert_rejected_projection_keeps_execution_held(
        &database,
        &run_id,
        &attempt_id,
        "same same answer",
        &before,
    )
    .await;
    let unchanged_id: String = sqlx::query_scalar(
        "SELECT id::text FROM chat_messages WHERE org_id=$1::uuid AND run_id=$2::uuid
          AND role='assistant'",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("rejected finalization preserves the original message");
    assert_eq!(unchanged_id, message_id);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn finalization_rejects_missing_output_ledger_without_effects() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) = database_and_admission("stream-output").await;
    let (result, _host) = execute_on_worker(
        &database,
        host,
        actor.clone(),
        run_id.clone(),
        attempt_id.clone(),
    )
    .await;
    let observation = result.expect("streamed synthetic Turn should be observed");
    let cleanup = observation.cleanup_receipt.as_ref().unwrap();
    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM chat_generation_events WHERE org_id=$1::uuid AND run_id=$2::uuid
          AND event_kind IN ('assistant_delta','runtime_output')",
    )
    .bind(ORG)
    .bind(&run_id)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let before = projection_state(&database, &run_id, &attempt_id).await;

    assert!(
        finalize(
            &database.pool,
            &actor,
            &observation.fence,
            &observation.turn_receipt,
            cleanup,
        )
        .await
        .is_err(),
        "a streaming row without its output ledger cannot be finalized"
    );
    assert_rejected_projection_keeps_execution_held(
        &database,
        &run_id,
        &attempt_id,
        "same same answer",
        &before,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn visible_output_flood_retains_hold_at_durable_projection_ceiling_without_publishing_tail() {
    assert_ignored_external_dependencies();

    // The transport must continue to accept tool and usage observations after
    // the former 128-event total-count boundary, and keep the latest usage.
    run_gated_many_observations().await;

    let (database, host, actor, run_id, attempt_id) = database_and_admission("output-flood").await;
    let home = host
        .probe_path("mode.txt")
        .parent()
        .expect("isolated provider home")
        .to_path_buf();
    let (mut worker, cancelled) = spawn_observed_worker(
        &database,
        host,
        actor,
        run_id.clone(),
        attempt_id.clone(),
        Duration::from_secs(360),
    );

    // Each fixture batch is smaller than the host's bounded event queue. An
    // empty delta after each prelude batch provides a durable drain marker; the
    // test releases the next batch only after that receipt commits.
    for batch in 0..7 {
        let marker = home.join(format!("output-flood-prelude-pending-{batch}"));
        wait_for_fixture_gate(&marker, &mut worker, &cancelled, "output-flood prelude").await;
        wait_for_output_rows(
            &database,
            &run_id,
            (batch + 1) as i64,
            &mut worker,
            &cancelled,
        )
        .await;
        release_fixture_gate(&home, "prelude", batch);
    }
    for batch in 0..64 {
        let marker = home.join(format!("output-flood-output-pending-{batch}"));
        wait_for_fixture_gate(&marker, &mut worker, &cancelled, "visible output flood").await;
        let expected = 7 + (((batch + 1) * 64).min(4089)) as i64;
        wait_for_output_rows(&database, &run_id, expected, &mut worker, &cancelled).await;
        release_fixture_gate(&home, "output", batch);
    }
    let terminal_pending = home.join("output-flood-terminal-pending");
    wait_for_fixture_gate(
        &terminal_pending,
        &mut worker,
        &cancelled,
        "uncommitted tail before terminal snapshot",
    )
    .await;
    // Correct behavior rejects ordinal 4097 and tears down the blocked child.
    // If the regression is present, release the terminal only after giving the
    // worker time to demonstrate that it failed to enforce the output ceiling;
    // subsequent ledger assertions then expose any published tail.
    for _ in 0..300 {
        if worker.is_finished() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !worker.is_finished() {
        std::fs::write(home.join("output-flood-terminal-release"), "release")
            .expect("release terminal to prevent a broken-cap test from hanging");
    }
    let (result, host) = worker
        .await
        .expect("flood worker joins after bounded rejection");
    let failure = match result {
        Err(failure) => failure,
        Ok(_) => panic!("the 4097th visible receipt must not complete the Run"),
    };
    assert_eq!(
        failure.process_disposition(),
        ProcessDisposition::CleanupProven,
        "output rejection must still reap the owned provider process"
    );
    let failure_debug = format!("{failure:?}");
    assert!(
        failure_debug.contains("Native Chat output does not match its execution"),
        "failure must be the durable output ordinal cap, got {failure_debug}"
    );
    assert!(host.provider_started());
    assert!(terminal_pending.exists());
    let counts: Value = serde_json::from_slice(
        &std::fs::read(host.probe_path("output-flood-prelude-counts.json"))
            .expect("provider emitted mixed observation counts"),
    )
    .expect("mixed observation count JSON");
    assert_eq!(counts["usage"], 130);
    assert_eq!(counts["toolStarted"], 130);
    assert_eq!(counts["toolCompleted"], 130);

    let (output_rows, max_ordinal, tail_rows, terminal_rows): (i64, i64, i64, i64) =
        sqlx::query_as(
            "SELECT count(*)::bigint,
                    COALESCE(max((payload->'nativeSource'->>'ordinal')::bigint),0)::bigint,
                    count(*) FILTER (WHERE payload->>'delta'='TAIL'
                      OR COALESCE(payload->>'body','') LIKE '%TAIL%')::bigint,
                    count(*) FILTER (WHERE event_kind IN ('runtime_terminal','terminal_projected'))::bigint
             FROM chat_generation_events WHERE org_id=$1::uuid AND run_id=$2::uuid
               AND event_kind IN ('assistant_delta','runtime_output','runtime_terminal','terminal_projected')",
        )
        .bind(ORG)
        .bind(&run_id)
        .fetch_one(&database.pool)
        .await
        .expect("read output cap and terminal evidence");
    assert_eq!(
        output_rows, 4096,
        "durable output cannot exceed its hard cap"
    );
    assert_eq!(max_ordinal, 4096);
    assert_eq!(
        tail_rows, 0,
        "the rejected sentinel tail is never published"
    );
    assert_eq!(
        terminal_rows, 0,
        "no terminal event is inferred from the flood"
    );

    let boundary: Vec<(i64, String, String, String, String)> = sqlx::query_as(
        "SELECT (payload->'nativeSource'->>'ordinal')::bigint,event_kind,
                payload->'nativeSource'->>'kind',
                payload->'nativeSource'->>'receiptTextDigest',
                payload->'nativeSource'->>'fingerprint'
         FROM chat_generation_events WHERE org_id=$1::uuid AND run_id=$2::uuid
           AND payload->'nativeSource'->>'ordinal' IN ('64','65')
         ORDER BY generation_seq",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_all(&database.pool)
    .await
    .expect("read periodic snapshot and following delta receipts");
    assert_eq!(boundary.len(), 2);
    assert_eq!(boundary[0].0, 64);
    assert_eq!(boundary[0].1, "runtime_output");
    assert_eq!(boundary[0].2, "delta");
    assert_eq!(boundary[1].0, 65);
    assert_eq!(boundary[1].1, "assistant_delta");
    assert_eq!(boundary[1].2, "delta");
    for (_, _, _, receipt_digest, fingerprint) in &boundary {
        assert_eq!(receipt_digest.len(), 64);
        assert_eq!(fingerprint.len(), 64);
        assert!(receipt_digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    let audit_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_type='heartbeat_run'
         AND entity_id=$2 AND action='runtime.native_chat.output_recorded'",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("count output audit rows");
    assert_eq!(
        audit_rows, 4096,
        "every durable output row has one audit row"
    );

    let assistants: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id::text,status,body FROM chat_messages WHERE org_id=$1::uuid AND run_id=$2::uuid
         AND role='assistant' ORDER BY id",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_all(&database.pool)
    .await
    .expect("read streaming assistant projection");
    assert_eq!(assistants.len(), 1);
    assert_eq!(assistants[0].1, "streaming");
    assert_eq!(assistants[0].2, "x".repeat(4089));

    let (run_status, run_hold, generation_status, generation_hold, attempt_status, phase): (
        String,
        bool,
        String,
        bool,
        String,
        String,
    ) = sqlx::query_as(
        "SELECT r.status,r.native_admission_hold,g.status,g.native_admission_hold,
                a.status,a.protocol_phase
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND a.id=$3::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read held execution state");
    assert!(
        run_hold && generation_hold,
        "hard output limit retains both holds"
    );
    assert_eq!(phase, "turn_known");
    assert!(!matches!(
        run_status.as_str(),
        "succeeded" | "failed" | "cancelled" | "stopped" | "completed"
    ));
    assert!(!matches!(
        generation_status.as_str(),
        "succeeded" | "failed" | "cancelled" | "stopped" | "completed"
    ));
    assert!(!matches!(
        attempt_status.as_str(),
        "succeeded" | "failed" | "cancelled"
    ));

    let finalized_activity: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_type='heartbeat_run'
         AND entity_id=$2 AND action='runtime.native_chat.finalized'",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("count finalization activity");
    assert_eq!(finalized_activity, 0);
}
