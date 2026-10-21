use crate::fixture::*;
use serde_json::Value;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn exact_admitted_input_excludes_chat_history_and_persists_thread_turn_without_finishing_run()
{
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) = database_and_admission("complete").await;
    let (result, host) =
        execute_on_worker(&database, host, actor, run_id.clone(), attempt_id.clone()).await;
    let observation = result.expect("synthetic completed turn should be observed");
    assert_eq!(observation.turn_receipt.thread_id(), THREAD);
    assert_eq!(observation.turn_receipt.turn_id(), TURN);
    assert_eq!(
        observation.turn_receipt.final_text(),
        Some("synthetic answer")
    );
    let usage = observation
        .turn_receipt
        .usage()
        .expect("typed token usage receipt");
    assert_eq!(usage.input_tokens(), 5);
    assert_eq!(usage.cached_input_tokens(), 2);
    assert_eq!(usage.output_tokens(), 7);
    assert_eq!(usage.reasoning_output_tokens(), 3);
    assert_eq!(usage.total_tokens(), 12);
    let cleanup = observation
        .cleanup_receipt
        .as_ref()
        .expect("typed cleanup receipt");
    assert!(cleanup.matches_execution(
        &run_id,
        &attempt_id,
        observation.fence.run_execution_owner_token()
    ));
    assert!(cleanup.proves_quiescence_for(&observation.turn_receipt));
    assert!(
        cleanup
            .evidence_fingerprint()
            .starts_with("codex-owned-cleanup-v1:")
    );
    assert!(
        observation.cleanup_proven,
        "accepted host must prove child cleanup"
    );
    assert!(host.provider_started());

    let events = host.events();
    assert_eq!(
        events
            .iter()
            .filter(|event| event["received"]["method"] == "thread/start")
            .count(),
        1,
        "a fresh admitted conversation must issue one thread/start"
    );
    assert!(
        !events
            .iter()
            .any(|event| event["received"]["method"] == "thread/resume"),
        "a fresh admitted conversation must not resume an unrecorded Thread"
    );
    let turn_start = events
        .iter()
        .find(|event| event.get("turnStart").is_some())
        .expect("provider received one turn/start request");
    let frame = &turn_start["turnStart"];
    assert_eq!(frame["method"], "turn/start");
    assert_eq!(frame["params"]["input"].as_array().unwrap().len(), 1);
    assert_eq!(frame["params"]["input"][0]["text"], BODY);
    assert!(frame["params"].get("history").is_none());
    let source_message: String = sqlx::query_scalar(
        "SELECT g.source_message_id::text FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read exact admitted source message");
    assert_eq!(frame["params"]["clientUserMessageId"], source_message);

    let (run_status, run_hold, generation_status, generation_hold, phase, checkpoint, thread_id, turn_id, segment_thread): (
        String, bool, String, bool, String, Value, String, Option<String>, Option<String>,
    ) = sqlx::query_as(
        "SELECT r.status, r.native_admission_hold, g.status, g.native_admission_hold,
                a.protocol_phase, a.checkpoint_json, g.provider_thread_id, r.session_id_after,
                s.native_session_id
         FROM heartbeat_runs r
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$3::uuid
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN runtime_bindings b ON b.org_id=g.org_id AND b.id=(r.context_snapshot->>'runtimeBindingId')::uuid
         JOIN native_segments s ON s.org_id=b.org_id AND s.binding_id=b.id
                              AND s.id=(r.context_snapshot->>'nativeSegmentId')::uuid
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read durable execution and binding state");
    assert_eq!(
        run_status, "running",
        "provider observation does not finish the Run"
    );
    assert!(run_hold);
    assert_eq!(
        generation_status, "starting",
        "provider observation does not finalize the Generation"
    );
    assert!(generation_hold);
    assert_eq!(phase, "provider_terminal_observed");
    assert_eq!(checkpoint["phase"], "provider_terminal_observed");
    assert_eq!(checkpoint["threadId"], THREAD);
    assert_eq!(checkpoint["turnId"], TURN);
    assert_eq!(thread_id, THREAD);
    assert_eq!(turn_id, None);
    assert_eq!(segment_thread.as_deref(), Some(THREAD));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn first_send_runs_through_owned_codex_workflow_with_one_exact_input() {
    for mode in ["complete", "desktop-user-agent"] {
        assert_first_send_runs_through_owned_codex_workflow(mode).await;
    }
}

async fn assert_first_send_runs_through_owned_codex_workflow(mode: &str) {
    assert_ignored_external_dependencies();
    let (database, host, actor, _conversation_id, run_id, attempt_id) =
        database_and_first_send_admission(mode).await;
    let (result, host) = execute_on_worker(&database, host, actor, run_id, attempt_id).await;
    let observation = result.expect("synthetic first Chat Turn should be observed");
    assert_eq!(observation.turn_receipt.thread_id(), THREAD);
    assert_eq!(observation.turn_receipt.turn_id(), TURN);
    assert_eq!(
        observation.turn_receipt.final_text(),
        Some("synthetic answer")
    );
    assert!(observation.cleanup_proven);
    assert!(host.provider_started());

    let events = host.events();
    assert_eq!(
        events
            .iter()
            .filter(|event| event["received"]["method"] == "thread/start")
            .count(),
        1,
        "first-send creates one owned Codex Thread"
    );
    let turn_start = events
        .iter()
        .find(|event| event.get("turnStart").is_some())
        .expect("provider received the first admitted Turn");
    let input = turn_start["turnStart"]["params"]["input"]
        .as_array()
        .expect("single Codex input array");
    assert_eq!(input.len(), 1, "first-send submits exactly one input item");
    assert_eq!(input[0]["text"], BODY);
    assert!(
        turn_start["turnStart"]["params"].get("history").is_none(),
        "the provider request does not replay SQL conversation history"
    );
    assert!(
        !input[0]["text"]
            .as_str()
            .unwrap()
            .contains("old private history"),
        "post-admission transcript content is not submitted"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn terminal_notification_before_turn_response_is_buffered_and_observed() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) =
        database_and_admission("early-terminal").await;
    let (result, host) =
        execute_on_worker(&database, host, actor, run_id.clone(), attempt_id.clone()).await;
    let observation = result.expect("early terminal must wait for its matching turn response");
    assert_eq!(
        observation.turn_receipt.status(),
        rudder_codex_app_server::TurnStatus::Completed
    );
    assert!(observation.cleanup_proven);
    let phase: String = sqlx::query_scalar(
        "SELECT protocol_phase FROM heartbeat_run_attempts
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read terminal checkpoint phase");
    assert_eq!(phase, "provider_terminal_observed");
    assert!(host.provider_started());
}
