use crate::fixture::*;
use rudder_d1_persistence::native_chat::control::{
    ReadEvents, StopOutcome, StopRequest, read_events, request_stop,
};
use rudder_d1_persistence::native_chat::execution::{finalize_hermes, finalize_hermes_stopped};
use rudder_d1_persistence::runtime_spans::{
    Request as RuntimeSpanRequest, execute as read_runtime_span,
};
use rudder_native_chat_executor::NativeExecutionObservation;
use serde_json::Value;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn first_hermes_progress_atomically_creates_one_streaming_placeholder_and_is_readable() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) =
        database_and_hermes_admission("hermes-live-progress").await;
    let prompt_ready = host.probe_path("prompt-ready");
    let first_progress_release = host.probe_path("first-progress-release");
    let progress_pending = host.probe_path("progress-pending");
    let progress_release = host.probe_path("progress-release");
    let read_actor = actor.clone();
    let worker = spawn_native_executor_worker(&database, host, actor, run_id.clone(), attempt_id);

    wait_for_path(&prompt_ready).await;
    let streaming_before_progress: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND run_id=$2::uuid
           AND role='assistant' AND status='streaming'",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        streaming_before_progress, 0,
        "admission alone creates no Hermes placeholder"
    );

    std::fs::write(&first_progress_release, "release").unwrap();
    wait_for_path(&progress_pending).await;
    let (generation_id, assistant_message_id) =
        wait_for_first_progress(&database.pool, &run_id).await;
    let assistant: (String, String, String) = sqlx::query_as(
        "SELECT id::text,status,body FROM chat_messages WHERE org_id=$1::uuid
           AND run_id=$2::uuid AND role='assistant' AND status='streaming'",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(assistant.0, assistant_message_id);
    assert_eq!(assistant.1, "streaming");
    assert!(
        assistant.2.is_empty(),
        "progress does not write assistant body text"
    );

    let page = read_events(
        &database.pool,
        &read_actor,
        &ReadEvents {
            conversation_id: CHAT.into(),
            generation_id: generation_id.clone(),
            after_seq: 0,
            limit: 100,
            max_bytes: 128 * 1024,
        },
    )
    .await
    .expect("typed public Hermes progress can be read while streaming");
    let public_entries: Vec<Value> = page
        .events
        .iter()
        .filter(|event| event.event_kind == "transcript")
        .map(|event| event.payload["entry"].clone())
        .collect();
    assert_eq!(public_entries.len(), 1);
    assert_eq!(public_entries[0]["kind"], "thinking");
    assert_eq!(public_entries[0]["text"], "Synthetic process thought.");
    let public_page_json = serde_json::to_string(&page).unwrap();
    assert!(!public_page_json.contains("nativeSource"));
    assert!(!public_page_json.contains("raw input sentinel"));
    assert!(!public_page_json.contains("raw output sentinel"));

    std::fs::write(&progress_release, "release").unwrap();
    let (result, _host) = worker.await.unwrap();
    let NativeExecutionObservation::Hermes(observation) = result.unwrap() else {
        panic!("synthetic Hermes execution must remain provider-native")
    };
    assert_eq!(observation.turn_receipt.final_text(), "synthetic answer");
    let cleanup = observation
        .cleanup_receipt
        .as_ref()
        .expect("owned process cleanup receipt");
    assert!(cleanup.proves_quiescence_for(&observation.turn_receipt));
    finalize_hermes(
        &database.pool,
        &observation.execution_principal,
        &observation.fence,
        &observation.turn_receipt,
        cleanup,
    )
    .await
    .expect("terminal finalization updates the existing Hermes assistant row");

    let finalized: (String, String, String) = sqlx::query_as(
        "SELECT id::text,status,body FROM chat_messages WHERE org_id=$1::uuid
           AND run_id=$2::uuid AND role='assistant' AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&assistant_message_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(finalized.0, assistant_message_id);
    assert_eq!(finalized.1, "completed");
    assert_eq!(finalized.2, "synthetic answer");

    let transcript = read_runtime_span(
        &database.pool,
        &read_actor,
        ORG,
        &RuntimeSpanRequest::ReadMessageTranscript {
            conversation_id: CHAT.into(),
            message_id: assistant_message_id,
            after_seq: 0,
            limit: 100,
        },
    )
    .await
    .expect("Native Reader returns the same typed Hermes progress ledger");
    let entries = transcript["transcript"].as_array().unwrap();
    assert!(entries.iter().any(|entry| entry["kind"] == "thinking"));
    assert!(entries.iter().any(|entry| entry["kind"] == "tool_call"));
    assert!(entries.iter().any(|entry| entry["kind"] == "tool_result"));
    assert!(
        entries
            .iter()
            .any(|entry| { entry["kind"] == "assistant" && entry["text"] == "synthetic answer" })
    );
    let transcript_json = serde_json::to_string(&transcript).unwrap();
    assert!(!transcript_json.contains("raw input sentinel"));
    assert!(!transcript_json.contains("raw output sentinel"));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn stop_freezes_before_persisted_hermes_progress_and_hides_tail_from_readers() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) =
        database_and_hermes_admission("hermes-stop-pending").await;
    let progress_pending = host.probe_path("progress-pending");
    let (generation_id, control_version): (String, i32) = sqlx::query_as(
        "SELECT g.id::text,g.control_version FROM chat_generations g
         JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let worker =
        spawn_native_executor_worker(&database, host, actor.clone(), run_id.clone(), attempt_id);

    wait_for_path(&progress_pending).await;
    let (_generation, assistant_message_id) =
        wait_for_first_progress(&database.pool, &run_id).await;
    let stored_progress_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_generation_events WHERE org_id=$1::uuid
           AND run_id=$2::uuid AND event_kind='transcript'",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        stored_progress_count, 1,
        "the thought is durable before Stop"
    );

    let stop = request_stop(
        &database.pool,
        &actor,
        &StopRequest {
            conversation_id: CHAT.into(),
            generation_id: generation_id.clone(),
            control_action_id: "73000000-0000-4000-8000-000000000001".into(),
            expected_attempt_epoch: 1,
            expected_control_version: control_version,
            requested_render_seq: 0,
            requested_body_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                .into(),
        },
    )
    .await
    .expect("a client-visible empty checkpoint can stop before the durable progress tail");
    assert_eq!(stop.outcome, StopOutcome::StopIntentRecorded);
    assert_eq!(stop.accepted_through_seq, Some(0));

    let (result, _host) = worker.await.unwrap();
    let NativeExecutionObservation::Hermes(observation) = result.unwrap() else {
        panic!("Stop must retain the provider-native Hermes receipt")
    };
    let stop_intent = observation
        .stop
        .as_ref()
        .expect("authorized Stop reached owner");
    assert_eq!(
        observation.turn_receipt.stop_reason(),
        rudder_hermes_acp::HermesStopReason::Cancelled
    );
    let cleanup = observation
        .cleanup_receipt
        .as_ref()
        .expect("owned process cancellation cleanup receipt");
    assert!(cleanup.proves_quiescence_for(&observation.turn_receipt));

    let (progress_seq, original_progress): (i32, Value) = sqlx::query_as(
        "SELECT generation_seq,payload FROM chat_generation_events WHERE org_id=$1::uuid
           AND run_id=$2::uuid AND event_kind='transcript' ORDER BY generation_seq LIMIT 1",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let original_request_id = original_progress["nativeSource"]["requestId"]
        .as_u64()
        .expect("stored Hermes request identity");
    let mut corrupted_progress = original_progress.clone();
    corrupted_progress["nativeSource"]["requestId"] = serde_json::json!(original_request_id + 1);
    rewrite_progress_payload(
        &database.pool,
        &run_id,
        &generation_id,
        progress_seq,
        &corrupted_progress,
    )
    .await;
    let rejected = finalize_hermes_stopped(
        &database.pool,
        &observation.execution_principal,
        &observation.fence,
        &observation.turn_receipt,
        cleanup,
        stop_intent,
    )
    .await;
    assert!(
        matches!(
            rejected,
            Err(rudder_d1_persistence::runtime_spans::Error::Http(409, _))
        ),
        "Stop finalization validates progress receipts even when the row is beyond the visible cutoff"
    );
    let held_after_rejection: (bool, bool) = sqlx::query_as(
        "SELECT r.native_admission_hold,g.native_admission_hold
         FROM heartbeat_runs r JOIN chat_generations g
           ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(held_after_rejection, (true, true));
    rewrite_progress_payload(
        &database.pool,
        &run_id,
        &generation_id,
        progress_seq,
        &original_progress,
    )
    .await;
    finalize_hermes_stopped(
        &database.pool,
        &observation.execution_principal,
        &observation.fence,
        &observation.turn_receipt,
        cleanup,
        stop_intent,
    )
    .await
    .expect("Stop finalization accepts progress after the client-visible cutoff");

    let (run_status, run_hold, generation_status, generation_hold, accepted): (
        String,
        bool,
        String,
        bool,
        i32,
    ) = sqlx::query_as(
        "SELECT r.status,r.native_admission_hold,g.status,g.native_admission_hold,
                g.accepted_through_seq
         FROM heartbeat_runs r JOIN chat_generations g
           ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(run_status, "cancelled");
    assert_eq!(generation_status, "stopped");
    assert!(
        !run_hold && !generation_hold,
        "cleanup closes the owned Stop hold"
    );
    assert_eq!(accepted, 0);
    let stored_after_stop: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_generation_events WHERE org_id=$1::uuid
           AND run_id=$2::uuid AND event_kind='transcript'",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        stored_after_stop, 1,
        "Stop does not erase durable audit history"
    );

    let page = read_events(
        &database.pool,
        &actor,
        &ReadEvents {
            conversation_id: CHAT.into(),
            generation_id,
            after_seq: 0,
            limit: 100,
            max_bytes: 128 * 1024,
        },
    )
    .await
    .expect("public event reads apply the frozen progress cutoff");
    assert!(
        !page
            .events
            .iter()
            .any(|event| event.event_kind == "transcript")
    );

    let transcript = read_runtime_span(
        &database.pool,
        &actor,
        ORG,
        &RuntimeSpanRequest::ReadMessageTranscript {
            conversation_id: CHAT.into(),
            message_id: assistant_message_id.clone(),
            after_seq: 0,
            limit: 100,
        },
    )
    .await
    .expect("Native Reader applies the frozen progress cutoff");
    assert_eq!(transcript["transcript"].as_array().unwrap().len(), 0);

    let history = read_runtime_span(
        &database.pool,
        &actor,
        ORG,
        &RuntimeSpanRequest::ReadConversationMessages {
            conversation_id: CHAT.into(),
            limit: 100,
            // The shared fixture intentionally seeds legacy history. Read the
            // current native reply after its admitted user message.
            cursor: Some(observation.turn_receipt.user_message_id().to_owned()),
            include_transcript: true,
        },
    )
    .await
    .expect("conversation history honors the same typed progress cutoff");
    let message = history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["id"] == assistant_message_id)
        .expect("stopped assistant placeholder remains readable");
    assert_eq!(message["body"], "");
    assert_eq!(message["status"], "stopped");
    assert_eq!(message["transcript"].as_array().unwrap().len(), 0);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn hermes_finalization_rejects_missing_progress_and_placeholder_without_releasing_hold() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) =
        database_and_hermes_admission("hermes-live-progress").await;
    let prompt_ready = host.probe_path("prompt-ready");
    let first_progress_release = host.probe_path("first-progress-release");
    let progress_pending = host.probe_path("progress-pending");
    let progress_release = host.probe_path("progress-release");
    let worker = spawn_native_executor_worker(&database, host, actor, run_id.clone(), attempt_id);

    wait_for_path(&prompt_ready).await;
    std::fs::write(&first_progress_release, "release").unwrap();
    wait_for_path(&progress_pending).await;
    let (generation_id, assistant_message_id) =
        wait_for_first_progress(&database.pool, &run_id).await;
    std::fs::write(&progress_release, "release").unwrap();
    let (result, _host) = worker.await.unwrap();
    let NativeExecutionObservation::Hermes(observation) = result.unwrap() else {
        panic!("synthetic Hermes execution must remain provider-native")
    };
    let cleanup = observation
        .cleanup_receipt
        .as_ref()
        .expect("owned process cleanup receipt");
    assert!(cleanup.proves_quiescence_for(&observation.turn_receipt));

    let mut tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
           AND run_id=$3::uuid AND event_kind='transcript'",
    )
    .bind(ORG)
    .bind(&generation_id)
    .bind(&run_id)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "DELETE FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid
           AND id=$3::uuid AND run_id=$4::uuid AND role='assistant'",
    )
    .bind(ORG)
    .bind(CHAT)
    .bind(&assistant_message_id)
    .bind(&run_id)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let rejected = finalize_hermes(
        &database.pool,
        &observation.execution_principal,
        &observation.fence,
        &observation.turn_receipt,
        cleanup,
    )
    .await;
    assert!(
        matches!(
            rejected,
            Err(rudder_d1_persistence::runtime_spans::Error::Http(409, _))
        ),
        "terminal finalization must not recreate an assistant row after its progress projection disappears"
    );
    let (assistant_rows, run_hold, generation_hold): (i64, bool, bool) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM chat_messages m WHERE m.org_id=r.org_id
                   AND m.run_id=r.id AND m.role='assistant'),
                r.native_admission_hold,g.native_admission_hold
         FROM heartbeat_runs r JOIN chat_generations g
           ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        assistant_rows, 0,
        "failed finalization rolls back any new row"
    );
    assert!(
        run_hold && generation_hold,
        "failed finalization keeps both holds"
    );
}

async fn rewrite_progress_payload(
    pool: &sqlx::PgPool,
    run_id: &str,
    generation_id: &str,
    generation_seq: i32,
    payload: &Value,
) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_control',true)")
        .execute(&mut *tx)
        .await
        .unwrap();
    let updated = sqlx::query(
        "UPDATE chat_generation_events SET payload=$5
         WHERE org_id=$1::uuid AND generation_id=$2::uuid AND run_id=$3::uuid
           AND generation_seq=$4 AND event_kind='transcript'",
    )
    .bind(ORG)
    .bind(generation_id)
    .bind(run_id)
    .bind(generation_seq)
    .bind(payload)
    .execute(&mut *tx)
    .await
    .unwrap();
    assert_eq!(updated.rows_affected(), 1);
    tx.commit().await.unwrap();
}

async fn wait_for_path(path: &std::path::Path) {
    for _ in 0..1000 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "synthetic Hermes process did not reach barrier {}",
        path.display()
    );
}

async fn wait_for_first_progress(pool: &sqlx::PgPool, run_id: &str) -> (String, String) {
    for _ in 0..1000 {
        let row = sqlx::query_as::<_, (String, String)>(
            "SELECT g.id::text,e.assistant_message_id::text
             FROM chat_generation_events e
             JOIN chat_generations g ON g.org_id=e.org_id AND g.id=e.generation_id
             WHERE e.org_id=$1::uuid AND e.run_id=$2::uuid AND e.event_kind='transcript'
             ORDER BY e.generation_seq LIMIT 1",
        )
        .bind(ORG)
        .bind(run_id)
        .fetch_optional(pool)
        .await
        .unwrap();
        if let Some(row) = row {
            return row;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("first typed Hermes progress was not durably recorded");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn correlated_prompt_error_after_stop_terminalizes_without_claiming_provider_cancel_ack() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) =
        database_and_hermes_admission("hermes-stop-prompt-error").await;
    let pending = host.probe_path("progress-pending");
    let worker =
        spawn_native_executor_worker(&database, host, actor.clone(), run_id.clone(), attempt_id);
    wait_for_path(&pending).await;
    let (generation_id, assistant_id) = wait_for_first_progress(&database.pool, &run_id).await;
    let stop_receipt = request_stop(
        &database.pool,
        &actor,
        &StopRequest {
            conversation_id: CHAT.into(),
            generation_id: generation_id.clone(),
            control_action_id: "73000000-0000-4000-8000-000000000002".into(),
            expected_attempt_epoch: 1,
            expected_control_version: 0,
            requested_render_seq: 0,
            requested_body_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                .into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(stop_receipt.outcome, StopOutcome::StopIntentRecorded);
    let (result, _host) = worker.await.unwrap();
    let failure = match result {
        Err(failure) => failure,
        Ok(_) => {
            panic!("RPC error must remain distinct from a successful or cancelled Hermes turn")
        }
    };
    let error = failure
        .hermes_prompt_error_after_cancel_receipt()
        .expect("correlated post-cancel error receipt");
    assert_eq!(error.error_code(), -32603);
    let cleanup = failure
        .hermes_cleanup_receipt()
        .expect("same owned process cleanup");
    assert!(cleanup.proves_quiescence_for_prompt_error(error));
    let principal = failure.execution_principal().unwrap();
    let fence = failure.fence().unwrap();
    let stop = rudder_d1_persistence::native_chat::execution::observe_stop(
        &database.pool,
        principal,
        fence,
    )
    .await
    .unwrap()
    .unwrap();
    let connection = cleanup.connection_receipt();
    rudder_d1_persistence::native_chat::execution::bind_stopping_connection(
        &database.pool,
        principal,
        fence,
        &stop,
        &connection,
    )
    .await
    .unwrap();
    let (seq, original):(i32, Value) = sqlx::query_as("SELECT generation_seq,payload FROM chat_generation_events WHERE run_id=$1::uuid AND event_kind='transcript' ORDER BY generation_seq LIMIT 1").bind(&run_id).fetch_one(&database.pool).await.unwrap();
    let mut corrupt = original.clone();
    corrupt["nativeSource"]["requestId"] = serde_json::json!(error.request_id() + 1);
    rewrite_progress_payload(&database.pool, &run_id, &generation_id, seq, &corrupt).await;
    let rejected =
        rudder_d1_persistence::native_chat::execution::finalize_hermes_prompt_error_stopped(
            &database.pool,
            principal,
            fence,
            error,
            cleanup,
            &stop,
        )
        .await;
    assert!(
        matches!(
            rejected,
            Err(rudder_d1_persistence::runtime_spans::Error::Http(409, _))
        ),
        "even hidden progress must match the exact error receipt"
    );
    let held: bool =
        sqlx::query_scalar("SELECT native_admission_hold FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(&run_id)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert!(held);
    rewrite_progress_payload(&database.pool, &run_id, &generation_id, seq, &original).await;
    let result =
        rudder_d1_persistence::native_chat::execution::finalize_hermes_prompt_error_stopped(
            &database.pool,
            principal,
            fence,
            error,
            cleanup,
            &stop,
        )
        .await
        .unwrap();
    assert_eq!(result["status"], "cancelled");
    assert_eq!(result["generationStatus"], "stopped");
    assert_eq!(result["providerStatus"], "error_response");
    assert_eq!(result["providerErrorCode"], -32603);
    assert_eq!(result["cancelSent"], true);
    assert_eq!(result["providerCancelAcknowledged"], false);
    assert_eq!(result["usageAvailable"], false);
    assert!(
        result.get("inputDisposition").is_none(),
        "dispatched input is never labelled not submitted"
    );
    let terminal:(bool,bool,bool) = sqlx::query_as("SELECT r.native_admission_hold,g.native_admission_hold,g.runtime_terminal_at IS NOT NULL FROM heartbeat_runs r JOIN chat_generations g ON g.id=r.chat_generation_id WHERE r.id=$1::uuid").bind(&run_id).fetch_one(&database.pool).await.unwrap();
    assert_eq!(terminal, (false, false, true));
    let transcript = read_runtime_span(
        &database.pool,
        &actor,
        ORG,
        &RuntimeSpanRequest::ReadMessageTranscript {
            conversation_id: CHAT.into(),
            message_id: assistant_id,
            after_seq: 0,
            limit: 100,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        transcript["transcript"].as_array().unwrap().len(),
        0,
        "frozen cutoff hides the committed tail and late output"
    );
    let resolution:Value=sqlx::query_scalar("SELECT provider_evidence FROM chat_control_actions WHERE id='73000000-0000-4000-8000-000000000002'::uuid").fetch_one(&database.pool).await.unwrap();
    assert_eq!(
        resolution["stopResolution"]["actualProviderStatus"],
        "error_response"
    );
    assert_eq!(
        resolution["stopResolution"]["providerCancelAcknowledged"],
        false
    );
    let persisted = serde_json::to_string(&resolution).unwrap();
    assert!(!persisted.contains("private error sentinel"));
    assert!(!persisted.contains("private error data sentinel"));
    assert!(!persisted.contains("late ignored text"));
}
