use crate::fixture::*;
use rudder_native_chat_executor::NativeExecutionObservation;
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
            self.record('session_create', body)
            return self.respond(200, {
                'id': 'ses_split', 'slug': 'native-split', 'projectID': 'project-split',
                'directory': root, 'title': 'Native split workflow', 'version': '1.15.11',
                'time': {'created': 1, 'updated': 1}
            })
        if path == '/session/ses_split/prompt_async':
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

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local OpenCode Server only"]
async fn opencode_records_fresh_session_before_one_exact_input_dispatch() {
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
    assert_eq!(
        observation.observation.turn.user_message_id.as_deref(),
        Some(observation.observation.request_id.as_str())
    );
    assert_eq!(
        observation.observation.turn.assistant_message_id,
        "msg_split_assistant"
    );
    assert_eq!(
        observation.observation.turn.final_text,
        "synthetic OpenCode answer"
    );
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
    let prompt_id = prompt["body"]["messageID"]
        .as_str()
        .expect("client-assigned native input ID");
    assert!(prompt_id.starts_with("msg_"));
    assert_eq!(prompt_id, observation.observation.request_id);
    assert_eq!(prompt["body"]["parts"][0]["text"], BODY);
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
