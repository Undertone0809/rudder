#![cfg(unix)]
//! Exact persisted-thread read contract and owned transport fixture coverage.
use rudder_codex_app_server::{
    MAX_FRAME_BYTES, OwnedTransport, ProcessLaunch, RequestId, SessionObservation, ThreadReadError,
    ThreadReadSelection, TransportEvent, select_thread_read_turn,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(10);

fn reply(id: i64, result: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"id": id, "result": result})).unwrap()
}

fn selected(response: &[u8], turn_id: &str) -> Result<ThreadReadSelection, ThreadReadError> {
    select_thread_read_turn(response, &RequestId::Number(7), "thread-exact", turn_id)
}

fn turn(id: &str, item_ids: &[&str]) -> Value {
    json!({
        "id": id,
        "status": "completed",
        "itemsView": "full",
        "items": item_ids.iter().map(|item_id| json!({"id": item_id, "type": "agentMessage"})).collect::<Vec<_>>(),
    })
}

fn read_result(thread_id: &str, turns: Vec<Value>) -> Value {
    json!({"thread":{"id":thread_id,"turns":turns}})
}

#[test]
fn selects_only_the_exact_durable_turn_and_preserves_its_items() {
    let response = reply(
        7,
        read_result(
            "thread-exact",
            vec![
                turn("turn-older", &["old-user", "old-assistant"]),
                turn(
                    "turn-requested",
                    &["requested-user", "requested-tool", "requested-answer"],
                ),
                turn("turn-newest", &["newest-answer"]),
            ],
        ),
    );
    let selection = selected(&response, "turn-requested").unwrap();
    assert!(!format!("{selection:?}").contains("requested-answer"));
    let ThreadReadSelection::Turn(turn) = selection else {
        panic!("the exact durable turn should be selected")
    };
    assert_eq!(turn["id"], "turn-requested");
    assert_eq!(
        turn["items"],
        json!([
            {"id":"requested-user","type":"agentMessage"},
            {"id":"requested-tool","type":"agentMessage"},
            {"id":"requested-answer","type":"agentMessage"},
        ])
    );
}

#[test]
fn missing_turn_is_unknown_without_latest_turn_fallback() {
    let response = reply(
        7,
        read_result(
            "thread-exact",
            vec![turn("turn-older", &["old"]), turn("turn-newest", &["new"])],
        ),
    );
    assert_eq!(
        selected(&response, "turn-missing").unwrap(),
        ThreadReadSelection::UnknownTurn
    );
}

#[test]
fn unsupported_method_has_its_own_result_state() {
    let response = serde_json::to_vec(&json!({
        "id":7,
        "error":{"code":-32601,"message":"unsupported"}
    }))
    .unwrap();
    assert_eq!(
        selected(&response, "turn-requested").unwrap(),
        ThreadReadSelection::Unsupported
    );
}

#[test]
fn provider_rejection_is_not_reported_as_missing_or_unsupported_history() {
    let response = serde_json::to_vec(&json!({
        "id":7,
        "error":{"code":-32000,"message":"private provider detail"}
    }))
    .unwrap();
    assert_eq!(
        selected(&response, "turn-requested"),
        Err(ThreadReadError::ProviderRejected)
    );
    assert!(
        !format!("{:?}", ThreadReadError::ProviderRejected).contains("private provider detail")
    );
}

#[test]
fn malformed_mismatched_duplicate_and_wrong_request_responses_fail_closed() {
    let wrong_thread = reply(7, read_result("another-thread", vec![]));
    assert_eq!(
        selected(&wrong_thread, "turn-requested"),
        Err(ThreadReadError::Malformed)
    );
    let no_turns = reply(7, json!({"thread":{"id":"thread-exact"}}));
    assert_eq!(
        selected(&no_turns, "turn-requested"),
        Err(ThreadReadError::Malformed)
    );
    let missing_turn_items = reply(
        7,
        read_result(
            "thread-exact",
            vec![json!({"id":"turn-requested","status":"completed","itemsView":"full"})],
        ),
    );
    assert_eq!(
        selected(&missing_turn_items, "turn-requested"),
        Err(ThreadReadError::Malformed)
    );
    assert_eq!(
        selected(
            br#"{"id":7,"result":{"thread":{"id":"thread-exact","turns":[]}},"result":{}}"#,
            "turn-requested"
        ),
        Err(ThreadReadError::Malformed)
    );
    let wrong_request_id = reply(8, read_result("thread-exact", vec![]));
    assert_eq!(
        selected(&wrong_request_id, "turn-requested"),
        Err(ThreadReadError::Malformed)
    );
    let duplicate_turn = reply(
        7,
        read_result(
            "thread-exact",
            vec![
                turn("turn-requested", &["one"]),
                turn("turn-requested", &["two"]),
            ],
        ),
    );
    assert_eq!(
        selected(&duplicate_turn, "turn-requested"),
        Err(ThreadReadError::Malformed)
    );
}

#[test]
fn response_limit_and_invalid_durable_id_are_explicit() {
    let oversized = vec![b' '; MAX_FRAME_BYTES + 1];
    assert_eq!(
        selected(&oversized, "turn-requested"),
        Err(ThreadReadError::Oversized)
    );
    let response = reply(7, read_result("thread-exact", vec![]));
    assert_eq!(
        select_thread_read_turn(&response, &RequestId::Number(7), "", "turn"),
        Err(ThreadReadError::Malformed)
    );
}

fn launch(script: &str) -> (OwnedTransport, tempfile::TempDir) {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let transport = OwnedTransport::launch(ProcessLaunch {
        executable: "/bin/sh".into(),
        argv: vec!["-c".into(), script.into()],
        cwd: path.clone(),
        env: BTreeMap::new(),
        request_id: "thread-read-contract".into(),
        run_id: "thread-read-contract-run".into(),
        attempt_id: "thread-read-contract".into(),
        owner_token: "thread-read-contract-owner".into(),
        runtime_root: path,
    })
    .unwrap();
    (transport, root)
}

#[test]
fn owned_transport_sends_only_exact_read_request_and_receives_fixture_response() {
    let script = r#"
while IFS= read -r line; do
  case "$line" in *'"method":"thread/read"'*) ;; *) exit 91 ;; esac
  case "$line" in *'"includeTurns":true'*'"threadId":" thread-exact "'*) ;; *) exit 92 ;; esac
  case "$line" in *thread/start*|*turn/start*|*prompt*) exit 93 ;; esac
  printf '%s\n' '{"id":0,"result":{"thread":{"id":" thread-exact ","turns":[{"id":"turn-requested","status":"completed","itemsView":"full","items":[{"id":"item-exact","type":"agentMessage"}]},{"id":"turn-newest","status":"completed","itemsView":"full","items":[{"id":"item-newest","type":"agentMessage"}]}]}}}'
done
"#;
    let (mut transport, _root) = launch(script);
    loop {
        if let TransportEvent::Lifecycle(event) = transport.receive(WAIT).unwrap()
            && event["type"] == "spawned"
        {
            break;
        }
    }

    assert!(matches!(
        transport.request_thread_read(""),
        Err(rudder_codex_app_server::TransportError::InvalidThreadReadTarget)
    ));
    assert!(matches!(
        transport.request_thread_read(&"x".repeat(4097)),
        Err(rudder_codex_app_server::TransportError::InvalidThreadReadTarget)
    ));
    let request_id = transport.request_thread_read(" thread-exact ").unwrap();
    assert_eq!(request_id, RequestId::Number(0));
    let mut written = false;
    let mut selected = None;
    while !written || selected.is_none() {
        match transport.receive(WAIT).unwrap() {
            TransportEvent::FrameWritten { request_id: actual } => {
                assert_eq!(actual.as_ref(), Some(&request_id));
                written = true;
            }
            TransportEvent::Rpc(SessionObservation::Completed {
                id,
                method,
                outcome,
            }) => {
                assert_eq!(id, request_id);
                assert_eq!(method, "thread/read");
                selected = Some(outcome.unwrap());
            }
            TransportEvent::Lifecycle(event) => assert_ne!(event["type"], "terminal"),
            _ => panic!("unexpected thread/read event"),
        }
    }

    // The owned transport already bounded and strictly decoded this same frame.
    // Re-encode its correlated result only to exercise the public selector API.
    let response = reply(0, selected.unwrap());
    let ThreadReadSelection::Turn(turn) = select_thread_read_turn(
        &response,
        &RequestId::Number(0),
        " thread-exact ",
        "turn-requested",
    )
    .unwrap() else {
        panic!("fixture turn should be selected by durable ID")
    };
    assert_eq!(turn["id"], "turn-requested");
    assert_eq!(turn["items"][0]["id"], "item-exact");
    drop(transport);
}
