use crate::fixture::*;
use rudder_d1_persistence::native_chat::execution::{
    NativeProviderKind, NativeProviderStatus, NativeProviderTurnReceipt, finalize_native,
};
use rudder_native_chat_executor::NativeExecutionObservation;
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

const CURSOR_SESSION: &str = "cursor-resume-session";
const FOLLOWUP_BODY: &str = "Continue this Cursor session exactly once";

const FAKE_CURSOR: &str = r#"
import json, os, pathlib, signal, sys
home = pathlib.Path(os.environ['HOME'])
events = home / 'cursor-events.jsonl'
session = 'cursor-resume-session'

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()
def record(value):
    with events.open('a', encoding='utf-8') as output:
        output.write(json.dumps(value, separators=(',', ':')) + '\n')
def stopping(*_):
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stopping)

while True:
    raw = sys.stdin.readline()
    if not raw:
        raise SystemExit(0)
    request = json.loads(raw)
    record(request)
    method = request.get('method')
    params = request.get('params', {})
    if method == 'initialize':
        emit({'jsonrpc':'2.0','id':request['id'],
              'result':{'protocolVersion':1,'agentCapabilities':{'loadSession':True}}})
    elif method == 'authenticate':
        emit({'jsonrpc':'2.0','id':request['id'],'result':{}})
    elif method == 'session/new':
        assert params.get('mcpServers') == []
        assert params.get('mode') == 'plan'
        emit({'jsonrpc':'2.0','id':request['id'],'result':{'sessionId':session}})
    elif method == 'session/load':
        assert sorted(params.keys()) == ['cwd', 'mcpServers', 'sessionId']
        assert params['sessionId'] == session
        assert params['mcpServers'] == []
        # Public ACP load replay is history, not this prompt's answer. More
        # chunks than the transport retention queue must still be consumed.
        for _ in range(160):
            emit({'jsonrpc':'2.0','method':'session/update',
                  'params':{'sessionId':session,'update':{
                      'sessionUpdate':'agent_message_chunk',
                      'content':{'type':'text','text':'OLD_CURSOR_HISTORY_雪🧭'}}}})
        # Cursor's load result intentionally omits sessionId.
        emit({'jsonrpc':'2.0','id':request['id'],
              'result':{'modes':{'available':[{'id':'plan','name':'Plan'}]}}})
    elif method == 'session/set_mode':
        assert params == {'sessionId':session,'modeId':'plan'}
        emit({'jsonrpc':'2.0','id':request['id'],'result':{}})
    elif method == 'session/prompt':
        assert params['sessionId'] == session
        emit({'jsonrpc':'2.0','method':'session/update',
              'params':{'sessionId':session,'update':{
                  'sessionUpdate':'agent_message_chunk',
                  'content':{'type':'text','text':'Cursor fixture reply'}}}})
        emit({'jsonrpc':'2.0','id':request['id'],
              'result':{'stopReason':'end_turn'}})
    else:
        raise SystemExit(31)
"#;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and a synthetic local Cursor ACP provider"]
async fn cursor_resume_sends_required_empty_mcp_servers_and_keeps_selected_session_without_response_id()
 {
    verify_cursor_resume_replay(1).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and a synthetic local Cursor ACP provider"]
async fn cursor_resume_consumes_history_larger_than_the_transport_queue_without_repeating_it() {
    verify_cursor_resume_replay(160).await;
}

async fn verify_cursor_resume_replay(replay_chunks: usize) {
    assert_ignored_external_dependencies();
    let database = Database::start().await;
    let mut host = FixtureHost::new("cursor-resume");
    let provider = tempfile::tempdir().expect("create isolated Cursor fixture");
    let executable = install_cursor(
        provider.path(),
        &FAKE_CURSOR.replace("range(160)", &format!("range({replay_chunks})")),
    );
    let profiles = host.probe_path(".");
    fs::create_dir_all(profiles.join(".cursor")).expect("create stable managed Cursor profile");
    host.enable_cursor_runtime(executable, profiles);

    let config = json!({
        "profileId":"default",
        "model":"synthetic/model",
        "mode":"plan",
        "instructionsBundleMode":"managed"
    });
    let (actor, first_run, first_attempt) =
        admitted_with_runtime(&database, &host, "cursor", config.clone()).await;

    let (first, host) =
        execute_native_on_worker(&database, host, actor.clone(), first_run, first_attempt).await;
    let NativeExecutionObservation::Cursor(first) = first.expect("fresh Cursor turn succeeds")
    else {
        panic!("expected a typed Cursor observation");
    };
    assert_eq!(first.observation.session.as_str(), CURSOR_SESSION);
    assert_eq!(first.observation.stop_reason, "end_turn");
    assert_eq!(
        first.observation.final_text.as_deref(),
        Some("Cursor fixture reply")
    );
    let first_receipt = NativeProviderTurnReceipt {
        provider: NativeProviderKind::Cursor,
        session_id: first.observation.session.as_str().to_owned(),
        request_id: first.observation.request_id.clone(),
        final_text: first.observation.final_text.clone(),
        status: NativeProviderStatus::Completed,
        usage: None,
        evidence: json!({
            "provider":"cursor_local",
            "sessionId":first.observation.session.as_str(),
            "promptRequestId":first.observation.request_id,
            "stopReason":first.observation.stop_reason,
            "updateCount":first.observation.update_count
        }),
    };
    let first_result = finalize_native(
        &database.pool,
        &first.execution_principal,
        &first.fence,
        &first_receipt,
        &first.observation.cleanup,
    )
    .await
    .expect("finalize the first Cursor turn with its owned host proof");
    assert_eq!(first_result["status"], "succeeded");
    assert_eq!(first_result["nativeAdmissionHold"], false);

    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn",
        "conversationId":CHAT,
        "clientMutationId":"native-chat-cursor-resume-2",
        "body":FOLLOWUP_BODY
    }))
    .expect("typed exact-session continuation request");
    let receipt = admit(&database.pool, &actor, ORG, &request, host.context())
        .await
        .expect("admit the follow-up against the existing Cursor session");
    let second_run = receipt["runId"].as_str().expect("second Run id").to_owned();
    let second_attempt = receipt["attemptId"]
        .as_str()
        .expect("second Attempt id")
        .to_owned();
    let (second, host) =
        execute_native_on_worker(&database, host, actor, second_run, second_attempt).await;
    let NativeExecutionObservation::Cursor(second) = second.expect("Cursor resume succeeds") else {
        panic!("expected a typed Cursor observation");
    };
    assert_eq!(second.observation.session.as_str(), CURSOR_SESSION);
    assert_eq!(second.observation.stop_reason, "end_turn");
    assert_eq!(
        second.observation.final_text.as_deref(),
        Some("Cursor fixture reply")
    );
    assert_eq!(
        second.observation.update_count, 1,
        "load replay does not count as current prompt updates"
    );
    assert_eq!(
        second.observation.connection.connection_receipt_id(),
        second.observation.cleanup.connection_receipt_id()
    );
    let second_receipt = NativeProviderTurnReceipt {
        provider: NativeProviderKind::Cursor,
        session_id: second.observation.session.as_str().to_owned(),
        request_id: second.observation.request_id.clone(),
        final_text: second.observation.final_text.clone(),
        status: NativeProviderStatus::Completed,
        usage: None,
        evidence: json!({
            "provider":"cursor_local",
            "sessionId":second.observation.session.as_str(),
            "promptRequestId":second.observation.request_id,
            "stopReason":second.observation.stop_reason,
            "updateCount":second.observation.update_count
        }),
    };
    let second_result = finalize_native(
        &database.pool,
        &second.execution_principal,
        &second.fence,
        &second_receipt,
        &second.observation.cleanup,
    )
    .await
    .expect("finalize the resumed turn with the same-session owned host proof");
    assert_eq!(second_result["status"], "succeeded");
    assert_eq!(second_result["nativeAdmissionHold"], false);

    let events = fs::read_to_string(host.probe_path("cursor-events.jsonl"))
        .expect("read synthetic Cursor ACP request log");
    let messages = events
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("valid ACP JSON"))
        .collect::<Vec<_>>();
    let methods = messages
        .iter()
        .filter_map(|message| message.get("method").and_then(Value::as_str))
        .collect::<Vec<_>>();
    let load_index = methods
        .iter()
        .position(|method| *method == "session/load")
        .expect("continuation loads the exact existing session");
    let set_mode_index = methods
        .iter()
        .position(|method| *method == "session/set_mode")
        .expect("configured mode is explicitly restored after load");
    let prompts = messages
        .iter()
        .filter(|message| message["method"] == "session/prompt")
        .collect::<Vec<_>>();
    assert_eq!(prompts.len(), 2, "each admitted input is submitted once");
    assert_eq!(prompts[0]["params"]["sessionId"], CURSOR_SESSION);
    assert_eq!(prompts[0]["params"]["prompt"][0]["text"], BODY);
    assert_eq!(prompts[1]["params"]["sessionId"], CURSOR_SESSION);
    assert_eq!(prompts[1]["params"]["prompt"][0]["text"], FOLLOWUP_BODY);
    assert!(load_index < set_mode_index);
    assert!(
        set_mode_index
            < methods
                .iter()
                .rposition(|method| *method == "session/prompt")
                .unwrap()
    );
    let load = messages
        .iter()
        .find(|message| message["method"] == "session/load")
        .expect("one session/load request");
    assert_eq!(
        load["params"],
        json!({
            "sessionId":CURSOR_SESSION,
            "cwd":load["params"]["cwd"],
            "mcpServers":[]
        })
    );
    assert_eq!(
        messages
            .iter()
            .find(|message| message["method"] == "session/set_mode")
            .expect("one explicit mode request")["params"],
        json!({"sessionId":CURSOR_SESSION,"modeId":"plan"})
    );
}

fn install_cursor(directory: &Path, source: &str) -> std::path::PathBuf {
    let python = Command::new("python3")
        .args(["-c", "import sys; print(sys.executable)"])
        .output()
        .expect("locate Python for the synthetic ACP provider");
    assert!(python.status.success(), "Python executable lookup succeeds");
    let python = String::from_utf8(python.stdout)
        .expect("Python executable path is UTF-8")
        .trim()
        .to_owned();
    let executable = directory.join("cursor-agent");
    fs::write(&executable, format!("#!{python}\n{source}"))
        .expect("write the synthetic Cursor ACP provider");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
        .expect("make the synthetic Cursor provider executable");
    executable
        .canonicalize()
        .expect("canonicalize the synthetic Cursor executable")
}
