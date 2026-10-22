use crate::fixture::*;
use rudder_native_chat_executor::NativeExecutionObservation;
use rudder_opencode_native::OpenCodeInputTerminal;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const FAKE_OPENCODE: &str = r#"
import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

root = os.getcwd()
request_log = os.path.join(root, 'opencode-requests.jsonl')
prompt_path = os.path.join(root, 'opencode-prompt.json')
prompt_pending = os.path.join(root, 'opencode-prompt-pending')
prompt_release = os.path.join(root, 'opencode-prompt-release')

if os.path.exists(os.path.join(root, 'opencode-exit-before-ready')):
    sys.exit(0)

# Key/type constraints from installed OpenCode 1.15.11 /doc. In particular,
# optional fields are not nullable, and prompt model selectors have no variant.
def strings_if_present(body, names):
    return all(name not in body or isinstance(body[name], str) for name in names)

def valid_model(model, required, optional=()):
    return (isinstance(model, dict) and set(required) <= set(model)
            and set(model) <= set(required + optional)
            and all(isinstance(value, str) for value in model.values()))

def valid_session_create(body):
    return (isinstance(body, dict)
            and set(body) <= {'parentID', 'title', 'agent', 'model', 'permission', 'workspaceID'}
            and strings_if_present(body, ('parentID', 'title', 'agent', 'workspaceID'))
            and ('permission' not in body or isinstance(body['permission'], list))
            and ('model' not in body or valid_model(body['model'], ('id', 'providerID'), ('variant',))))

def valid_prompt(body):
    return (isinstance(body, dict)
            and set(body) <= {'messageID', 'model', 'agent', 'noReply', 'tools', 'system', 'variant', 'parts'}
            and strings_if_present(body, ('messageID', 'agent', 'system', 'variant'))
            and ('noReply' not in body or isinstance(body['noReply'], bool))
            and ('model' not in body or valid_model(body['model'], ('providerID', 'modelID')))
            and ('tools' not in body or (isinstance(body['tools'], dict)
                 and all(isinstance(value, bool) for value in body['tools'].values())))
            and isinstance(body.get('parts'), list)
            and all(isinstance(part, dict) and set(part) <= {'type', 'text', 'id'}
                    and part.get('type') == 'text' and isinstance(part.get('text'), str)
                    and strings_if_present(part, ('id',)) for part in body['parts']))

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def respond(self, status, body=None):
        encoded = b'' if body is None else json.dumps(body, separators=(',', ':')).encode()
        self.send_response(status)
        if body is not None:
            self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)

    def record(self, method, body):
        with open(request_log, 'a', encoding='utf-8') as output:
            output.write(json.dumps({'method': method, 'body': body}, separators=(',', ':')) + '\n')

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/doc':
            return self.respond(200, {'info': {'title': 'synthetic OpenCode'}})
        if path == '/session/ses_split/message':
            if not os.path.exists(prompt_path):
                return self.respond(200, [])
            prompt = json.load(open(prompt_path, encoding='utf-8'))
            input_id = prompt['messageID']
            return self.respond(200, [{
                'info': {
                    'id': 'msg_split_assistant', 'sessionID': 'ses_split', 'role': 'assistant',
                    'time': {'created': 10, 'completed': 11}, 'parentID': input_id,
                    'modelID': 'synthetic-model', 'providerID': 'synthetic-provider', 'finish': 'stop'
                },
                'parts': [{
                    'id': 'prt_split_text', 'sessionID': 'ses_split',
                    'messageID': 'msg_split_assistant', 'type': 'text', 'text': 'synthetic OpenCode answer'
                }]
            }])
        return self.respond(404, {'error': 'not found'})

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        raw = self.rfile.read(length)
        body = json.loads(raw) if raw else {}
        path = urlparse(self.path).path
        if path == '/session':
            if not valid_session_create(body):
                return self.respond(400, {'_tag': 'SchemaError'})
            self.record('session_create', body)
            return self.respond(200, {
                'id': 'ses_split', 'slug': 'native-split', 'projectID': 'project-split',
                'directory': root, 'title': 'Native split workflow', 'version': '1.15.11',
                'time': {'created': 1, 'updated': 1}
            })
        if path == '/session/ses_split/prompt_async':
            if not valid_prompt(body):
                return self.respond(400, {'_tag': 'SchemaError'})
            self.record('prompt_async', body)
            with open(prompt_path, 'w', encoding='utf-8') as output:
                json.dump(body, output, separators=(',', ':'))
            with open(prompt_pending, 'w', encoding='utf-8') as output:
                output.write('pending')
            import time
            while not os.path.exists(prompt_release):
                time.sleep(0.01)
            return self.respond(204)
        return self.respond(404, {'error': 'not found'})

port = int(sys.argv[sys.argv.index('--port') + 1])
server = HTTPServer(('127.0.0.1', port), Handler)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
server.serve_forever()
"#;

#[test]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local OpenCode Server only"]
fn opencode_records_fresh_session_before_one_exact_input_dispatch() {
    // Match Foundation's local listener runtime and its blocking executor.
    // A multi-thread test alone misses HTTP client construction using a
    // LocalRuntime handle from a different thread.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build_local(tokio::runtime::LocalOptions::default())
        .expect("listener-shaped local runtime");
    runtime.block_on(opencode_records_fresh_session_workflow());
}

async fn opencode_records_fresh_session_workflow() {
    assert_ignored_external_dependencies();
    let database = Database::start().await;
    let mut host = FixtureHost::new("opencode-split");
    let provider = tempfile::tempdir().expect("create synthetic OpenCode install");
    let cwd = provider
        .path()
        .canonicalize()
        .expect("canonical fixture CWD");
    let executable = install_fake_opencode(provider.path());
    host.enable_opencode_runtime(executable);

    let runtime_config = json!({
        "profileId": "operator-default",
        "command": "opencode",
        "cwd": cwd.to_string_lossy(),
        "model": "synthetic-provider/synthetic-model",
        "variant": "synthetic-effort",
        "graceSec": 1,
    });
    let (actor, run_id, attempt_id) =
        admitted_with_runtime(&database, &host, "opencode_local", runtime_config).await;
    let prompt_pending = cwd.join("opencode-prompt-pending");
    let prompt_release = PromptRelease(cwd.join("opencode-prompt-release"));
    let worker =
        spawn_native_executor_worker(&database, host, actor, run_id.clone(), attempt_id.clone());
    wait_for_file(&prompt_pending).await;
    let checkpoint_at_prompt: (String, Value) = sqlx::query_as(
        "SELECT protocol_phase, checkpoint_json FROM heartbeat_run_attempts
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read checkpoint while provider holds the prompt response");
    fs::write(&prompt_release.0, "release").expect("release fake prompt response");
    let (result, _host) = worker.await.expect("executor worker joins");
    let NativeExecutionObservation::OpenCode(observation) =
        result.expect("synthetic OpenCode workflow should produce typed observation")
    else {
        panic!("OpenCode must retain its provider-native observation")
    };

    assert_eq!(observation.observation.session.as_str(), "ses_split");
    let OpenCodeInputTerminal::Completed(turn) = &observation.observation.terminal else {
        panic!("synthetic response should be a completed terminal");
    };
    assert_eq!(
        turn.user_message_id.as_deref(),
        Some(observation.observation.request_id.as_str())
    );
    assert_eq!(turn.assistant_message_id, "msg_split_assistant");
    assert_eq!(turn.final_text, "synthetic OpenCode answer");
    assert_eq!(checkpoint_at_prompt.0, "input_indeterminate");
    assert_eq!(checkpoint_at_prompt.1["opencodeSession"], "ses_split");
    assert_eq!(
        checkpoint_at_prompt.1["opencodePromptRequestId"],
        observation.observation.request_id
    );
    assert!(observation.observation.cleanup.matches_execution(
        &run_id,
        &attempt_id,
        observation.fence.run_execution_owner_token()
    ));

    let requests = fs::read_to_string(cwd.join("opencode-requests.jsonl"))
        .expect("fake server captured effect requests");
    let requests = requests
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("captured request JSON"))
        .collect::<Vec<_>>();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "session_create")
            .count(),
        1,
        "fresh execution creates one provider session"
    );
    let prompt = requests
        .iter()
        .find(|request| request["method"] == "prompt_async")
        .expect("one prompt dispatch");
    assert_eq!(
        requests
            .iter()
            .find(|request| request["method"] == "session_create")
            .expect("one session create")["body"]["model"],
        json!({"id":"synthetic-model","providerID":"synthetic-provider","variant":"synthetic-effort"})
    );
    let prompt_id = prompt["body"]["messageID"]
        .as_str()
        .expect("client-assigned native input ID");
    assert!(prompt_id.starts_with("msg_"));
    assert_eq!(prompt_id, observation.observation.request_id);
    assert_eq!(prompt["body"]["parts"][0]["text"], BODY);
    assert_eq!(prompt["body"]["variant"], "synthetic-effort");
    assert_eq!(
        prompt["body"]["model"],
        json!({"providerID":"synthetic-provider","modelID":"synthetic-model"})
    );
    assert!(prompt["body"]["model"].get("variant").is_none());
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "prompt_async")
            .count(),
        1,
        "the input is not replayed"
    );

    let (phase, checkpoint): (String, Value) = sqlx::query_as(
        "SELECT protocol_phase, checkpoint_json FROM heartbeat_run_attempts
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read durable OpenCode checkpoint");
    assert_eq!(phase, "provider_terminal_observed");
    assert_eq!(checkpoint["opencodeSession"], "ses_split");
    assert_eq!(checkpoint["opencodePromptRequestId"], prompt_id);
    let provider = &observation.observation;
    let rudder_opencode_native::OpenCodeInputTerminal::Completed(terminal) = &provider.terminal
    else {
        panic!("expected completed exact-input OpenCode terminal");
    };
    let turn = rudder_d1_persistence::native_chat::execution::NativeProviderTurnReceipt {
        provider: rudder_d1_persistence::native_chat::execution::NativeProviderKind::OpenCode,
        session_id: terminal.session_id.clone(),
        request_id: provider.request_id.clone(),
        final_text: Some(terminal.final_text.clone()),
        status: rudder_d1_persistence::native_chat::execution::NativeProviderStatus::Completed,
        usage: None,
        evidence: json!({"assistantMessageId":terminal.assistant_message_id}),
    };
    let finalized = rudder_d1_persistence::native_chat::execution::finalize_native(
        &database.pool,
        &observation.execution_principal,
        &observation.fence,
        &turn,
        &provider.cleanup,
    )
    .await
    .expect("first native OpenCode input commits its terminal projection");
    assert_eq!(finalized["status"], "succeeded");
    assert_eq!(finalized["nativeAdmissionHold"], false);
    let retry = rudder_d1_persistence::native_chat::execution::finalize_native(
        &database.pool,
        &observation.execution_principal,
        &observation.fence,
        &turn,
        &provider.cleanup,
    )
    .await
    .expect("same exact terminal receipt is idempotent");
    assert_eq!(retry, finalized);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local OpenCode child only"]
async fn opencode_startup_exit_preserves_cleanup_without_submitting_input() {
    assert_ignored_external_dependencies();
    let database = Database::start().await;
    let mut host = FixtureHost::new("opencode-startup-exit");
    let provider = tempfile::tempdir().expect("create synthetic OpenCode install");
    let cwd = provider.path().canonicalize().unwrap();
    fs::write(cwd.join("opencode-exit-before-ready"), "exit").unwrap();
    host.enable_opencode_runtime(install_fake_opencode(provider.path()));
    let (actor, run, attempt) = admitted_with_runtime(
        &database,
        &host,
        "opencode_local",
        json!({"profileId":"operator-default","command":"opencode",
            "cwd":cwd.to_string_lossy(),"model":"synthetic-provider/synthetic-model",
            "graceSec":1}),
    )
    .await;
    let (result, _) =
        spawn_native_executor_worker(&database, host, actor, run.clone(), attempt.clone())
            .await
            .expect("blocking worker must not panic while constructing its HTTP client");
    let failure = match result {
        Ok(_) => panic!("startup exit cannot produce a provider turn receipt"),
        Err(failure) => failure,
    };
    assert_eq!(failure.diagnostic_code(), "opencode_server_not_ready");
    assert!(failure.process_quiescent());
    assert!(failure.host_cleanup_proof().is_some());
    assert!(!cwd.join("opencode-requests.jsonl").exists());
    let state: (String, bool, bool) = sqlx::query_as(
        "SELECT a.protocol_phase,r.native_admission_hold,g.native_admission_hold
         FROM heartbeat_run_attempts a JOIN heartbeat_runs r ON r.id=a.run_id
         JOIN chat_generations g ON g.id=r.chat_generation_id
         WHERE a.org_id=$1::uuid AND a.id=$2::uuid",
    )
    .bind(ORG)
    .bind(attempt)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(state, ("no_thread_request".into(), true, true));
}

fn install_fake_opencode(directory: &Path) -> PathBuf {
    let output = Command::new("python3")
        .args(["-c", "import sys; print(sys.executable)"])
        .output()
        .expect("locate Python for the local synthetic server");
    assert!(
        output.status.success(),
        "python3 is available for this opt-in test"
    );
    let python = String::from_utf8(output.stdout)
        .expect("Python interpreter path is UTF-8")
        .trim()
        .to_owned();
    let executable = directory.join("opencode");
    fs::write(&executable, format!("#!{python}\n{FAKE_OPENCODE}"))
        .expect("write fake OpenCode server executable");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
        .expect("make fake OpenCode server executable");
    executable
        .canonicalize()
        .expect("canonical executable path")
}

struct PromptRelease(PathBuf);

impl Drop for PromptRelease {
    fn drop(&mut self) {
        let _ = fs::write(&self.0, "release");
    }
}

async fn wait_for_file(path: &Path) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fake OpenCode provider reached the prompt gate");
}
