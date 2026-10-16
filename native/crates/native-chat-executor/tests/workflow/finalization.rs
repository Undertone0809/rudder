use crate::fixture::*;
use rudder_d1_persistence::native_chat::execution::finalize;

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
