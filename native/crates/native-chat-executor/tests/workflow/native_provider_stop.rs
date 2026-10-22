use crate::fixture::*;
use rudder_auth_core::VerifiedActor;
use rudder_d1_persistence::native_chat::{
    control::{StopOutcome, StopRequest, request_stop},
    execution::{
        NativeProviderKind, NativeProviderStatus, NativeProviderTurnReceipt,
        finalize_native_stopped,
    },
};
use rudder_native_chat_executor::{ExecutionFailure, NativeExecutionObservation};
use rudder_opencode_native::OpenCodeInputTerminal;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

const FAKE_CURSOR: &str = r#"
import json, os, pathlib, select, signal, sys, time
home = pathlib.Path(os.environ['HOME'])
events = home / 'cursor-events.jsonl'
pending = home / 'cursor-prompt-pending'
release = home / 'cursor-prompt-release'
session = 'cursor-stop-session'

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
    if method == 'initialize':
        emit({'jsonrpc':'2.0','id':request['id'],
              'result':{'protocolVersion':1,'agentCapabilities':{'loadSession':True}}})
    elif method == 'authenticate':
        emit({'jsonrpc':'2.0','id':request['id'],'result':{}})
    elif method == 'session/new':
        emit({'jsonrpc':'2.0','id':request['id'],'result':{'sessionId':session}})
    elif method == 'session/prompt':
        pending.write_text('pending', encoding='utf-8')
        stream_many = home / 'cursor-stream-many-updates'
        if stream_many.exists():
            for index in range(300):
                emit({'jsonrpc':'2.0','method':'session/update',
                      'params':{'sessionId':session,'update':{
                          'sessionUpdate':'agent_message_chunk',
                          'content':{'type':'text','text':'x'}}}})
            (home / 'cursor-stream-many-ready').write_text('ready', encoding='utf-8')
        while True:
            ready, _, _ = select.select([sys.stdin], [], [], 0.02)
            if release.exists():
                emit({'jsonrpc':'2.0','id':request['id'],
                      'result':{'stopReason':'end_turn'}})
                break
            if ready:
                cancel = json.loads(sys.stdin.readline())
                record(cancel)
                assert cancel.get('method') == 'session/cancel'
                assert 'id' not in cancel
                assert cancel.get('params', {}).get('sessionId') == session
                if stream_many.exists():
                    emit({'jsonrpc':'2.0','method':'session/update',
                          'params':{'sessionId':session,'update':{
                              'sessionUpdate':'agent_message_chunk',
                              'content':{'type':'text','text':'tail'}}}})
                emit({'jsonrpc':'2.0','id':request['id'],
                      'result':{'stopReason':'cancelled'}})
                break
        raise SystemExit(0)
    elif method == 'session/load':
        emit({'jsonrpc':'2.0','id':request['id'],'result':{'sessionId':session}})
    else:
        raise SystemExit(31)
"#;

const FAKE_OPENCODE: &str = r#"
import json, os, signal, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

root = os.getcwd()
prompt_path = os.path.join(root, 'opencode-stop-prompt.json')
prompt_pending = os.path.join(root, 'opencode-stop-prompt-pending')
abort_path = os.path.join(root, 'opencode-stop-abort')
events = os.path.join(root, 'opencode-stop-events.jsonl')

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def respond(self, status, body=None):
        encoded = b'' if body is None else json.dumps(body, separators=(',', ':')).encode()
        self.send_response(status)
        if body is not None: self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(encoded)))
        self.send_header('Connection', 'close')
        self.end_headers()
        if encoded: self.wfile.write(encoded)
        self.close_connection = True
    def record(self, method, body=None):
        with open(events, 'a', encoding='utf-8') as output:
            output.write(json.dumps({'method':method,'body':body}, separators=(',', ':')) + '\n')
    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/doc': return self.respond(200, {'info':{'title':'synthetic OpenCode'}})
        if path == '/session/ses_stop/message':
            if not os.path.exists(abort_path): return self.respond(200, [])
            prompt = json.load(open(prompt_path, encoding='utf-8'))
            return self.respond(200, [{
                'info': {
                    'id':'msg_stop_error', 'sessionID':'ses_stop', 'role':'assistant',
                    'time':{'created':10,'completed':11}, 'parentID':prompt['messageID'],
                    'modelID':'synthetic-model','providerID':'synthetic-provider',
                    'finish':'error','error':{'name':'ProviderError',
                        'message':'private provider error sentinel',
                        'data':{'secret':'private provider error data sentinel'}}
                },
                'parts':[]
            }])
        return self.respond(404, {'error':'not found'})
    def do_POST(self):
        length = int(self.headers.get('Content-Length','0'))
        raw = self.rfile.read(length)
        body = json.loads(raw) if raw else {}
        path = urlparse(self.path).path
        if path == '/session':
            self.record('session_create', body)
            return self.respond(200, {
                'id':'ses_stop','slug':'native-stop','projectID':'project-stop',
                'directory':root,'title':'Native Stop','version':'1.15.11',
                'time':{'created':1,'updated':1}
            })
        if path == '/session/ses_stop/prompt_async':
            self.record('prompt_async', body)
            with open(prompt_path, 'w', encoding='utf-8') as output:
                json.dump(body, output, separators=(',', ':'))
            with open(prompt_pending, 'w', encoding='utf-8') as output:
                output.write('pending')
            return self.respond(204)
        if path == '/session/ses_stop/abort':
            self.record('abort')
            with open(abort_path, 'w', encoding='utf-8') as output:
                output.write('aborted')
            return self.respond(200, True)
        return self.respond(404, {'error':'not found'})

port = int(sys.argv[sys.argv.index('--port') + 1])
server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
def handle_term(*_):
    if os.path.exists(os.path.join(root, 'ignore-sigterm')):
        with open(os.path.join(root, 'cleanup-started'), 'w', encoding='utf-8') as output:
            output.write('cleanup')
        return
    raise SystemExit(0)
signal.signal(signal.SIGTERM, handle_term)
server.serve_forever()
"#;

// spawn_native_executor_worker gives each execution a 30-second deadline.
// Match the prompt gate to that real bound; shorter 10/15-second test gates
// fail before a slow CI host has exhausted its allowed startup/readiness work.
pub(super) const OPENCODE_PROMPT_GATE_TIMEOUT: Duration = Duration::from_secs(30);

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and a synthetic local Cursor ACP provider"]
async fn cursor_stop_sends_one_notification_and_waits_for_the_original_prompt_terminal() {
    cursor_stop_workflow(false).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and a synthetic local Cursor ACP provider"]
async fn cursor_stop_reduces_more_than_256_pending_updates_across_cancel_write_ack() {
    cursor_stop_workflow(true).await;
}

async fn cursor_stop_workflow(stream_many_updates: bool) {
    assert_ignored_external_dependencies();
    let database = Database::start().await;
    let mut host = FixtureHost::new("cursor-governed-stop");
    let provider = tempfile::tempdir().expect("create isolated Cursor install");
    let executable = install_executable(provider.path(), "cursor-agent", FAKE_CURSOR);
    let profiles = host.probe_path(".");
    fs::create_dir_all(profiles.join(".cursor")).expect("create stable managed Cursor profile");
    if stream_many_updates {
        fs::write(
            profiles.join("cursor-stream-many-updates"),
            "exercise bounded prompt reduction",
        )
        .expect("enable the deterministic large-update fixture mode");
    }
    let cwd = provider.path().join("cwd");
    fs::create_dir_all(&cwd).expect("create synthetic workspace");
    host.enable_cursor_runtime(executable, profiles);
    let (actor, run_id, attempt_id) = admitted_with_runtime(
        &database,
        &host,
        "cursor",
        json!({
            "profileId":"default",
            "model":"synthetic/model",
            "instructionsBundleMode":"managed"
        }),
    )
    .await;

    let pending = host.probe_path("cursor-prompt-pending");
    let stream_ready = host.probe_path("cursor-stream-many-ready");
    let release = HostFileRelease(host.probe_path("cursor-prompt-release"));
    let worker = spawn_native_executor_worker(
        &database,
        host,
        actor.clone(),
        run_id.clone(),
        attempt_id.clone(),
    );
    if !wait_for_file(&pending, Duration::from_secs(15)).await {
        let _ = worker.await;
        panic!("Cursor fixture did not receive the admitted prompt");
    }
    if stream_many_updates && !wait_for_file(&stream_ready, Duration::from_secs(15)).await {
        let _ = worker.await;
        panic!("Cursor fixture did not flush the large update sequence");
    }
    wait_phase(&database.pool, &attempt_id, "input_indeterminate").await;
    let stop = request_stop_for_run(
        &database,
        &actor,
        &run_id,
        "72000000-0000-4000-8000-000000000101",
    )
    .await;
    assert_eq!(stop.outcome, StopOutcome::StopIntentRecorded);

    let (result, host) = worker.await.expect("join Cursor executor");
    let NativeExecutionObservation::Cursor(observed) = result.expect("Cursor terminal observation")
    else {
        panic!("expected Cursor-specific observation");
    };
    let provider = observed.observation;
    assert_eq!(provider.stop_reason, "cancelled");
    assert_eq!(provider.session.as_str(), "cursor-stop-session");
    assert_eq!(
        provider.update_count,
        if stream_many_updates { 301 } else { 0 }
    );
    if stream_many_updates {
        let expected_text = format!("{}tail", "x".repeat(300));
        assert_eq!(provider.final_text.as_deref(), Some(expected_text.as_str()));
    }
    assert!(
        !release.0.exists(),
        "the matching cancellation response released the prompt"
    );
    assert_eq!(
        provider.connection.connection_receipt_id(),
        provider.cleanup.connection_receipt_id()
    );
    assert!(observed.fence.matches_host_cleanup_proof(&provider.cleanup));
    let stop = provider
        .stop
        .as_ref()
        .expect("exact Stop was observed by the owner");

    let events = fs::read_to_string(host.probe_path("cursor-events.jsonl"))
        .expect("read synthetic ACP messages");
    let messages = events
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("ACP message JSON"))
        .collect::<Vec<_>>();
    let prompts = messages
        .iter()
        .filter(|message| message["method"] == "session/prompt")
        .collect::<Vec<_>>();
    let cancels = messages
        .iter()
        .filter(|message| message["method"] == "session/cancel")
        .collect::<Vec<_>>();
    assert_eq!(prompts.len(), 1, "accepted Cursor input is never replayed");
    assert_eq!(
        cancels.len(),
        1,
        "the one-use interrupt permit sends one cancellation"
    );
    assert!(
        cancels[0].get("id").is_none(),
        "ACP cancel is a notification"
    );
    assert_eq!(cancels[0]["params"]["sessionId"], "cursor-stop-session");
    assert_eq!(
        prompts[0]["id"].as_str(),
        Some(provider.request_id.as_str())
    );
    assert_eq!(prompts[0]["params"]["prompt"][0]["text"], BODY);

    let turn = NativeProviderTurnReceipt {
        provider: NativeProviderKind::Cursor,
        session_id: provider.session.as_str().to_owned(),
        request_id: provider.request_id.clone(),
        final_text: provider.final_text.clone(),
        status: NativeProviderStatus::Interrupted,
        usage: None,
        evidence: json!({
            "provider":"cursor_local",
            "sessionId":provider.session.as_str(),
            "promptRequestId":provider.request_id,
            "stopReason":provider.stop_reason,
            "updateCount":provider.update_count
        }),
    };
    let result = finalize_native_stopped(
        &database.pool,
        &observed.execution_principal,
        &observed.fence,
        &turn,
        &provider.cleanup,
        stop,
    )
    .await
    .expect("exact ACP terminal and same-owned-process cleanup finalize Stop");
    assert_eq!(result["status"], "cancelled");
    assert_eq!(result["nativeAdmissionHold"], false);
    assert_no_provider_error_material(&database.pool, &run_id).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and a synthetic local OpenCode Server"]
async fn opencode_stop_waits_for_exact_failed_assistant_terminal_after_abort_ack() {
    opencode_stop_workflow(1, false).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires process host and disposable PostgreSQL; deliberately holds cleanup for 35 seconds across a 30-second generation lease"]
async fn opencode_cleanup_renews_stopping_lease_beyond_thirty_seconds() {
    opencode_stop_workflow(35, true).await;
}

async fn opencode_stop_workflow(grace_seconds: u64, hold_cleanup: bool) {
    assert_ignored_external_dependencies();
    let database = Database::start().await;
    let mut host = FixtureHost::new("opencode-governed-stop");
    let provider = tempfile::tempdir().expect("create synthetic OpenCode install");
    let cwd = provider
        .path()
        .canonicalize()
        .expect("canonical provider CWD");
    if hold_cleanup {
        fs::write(cwd.join("ignore-sigterm"), "hold cleanup").unwrap();
    }
    let executable = install_executable(provider.path(), "opencode", FAKE_OPENCODE);
    host.enable_opencode_runtime(executable);
    let (actor, run_id, attempt_id) = admitted_with_runtime(
        &database,
        &host,
        "opencode_local",
        json!({
            "profileId":"operator-default",
            "command":"opencode",
            "cwd":cwd.to_string_lossy(),
            "model":"synthetic/model",
            "graceSec":grace_seconds
        }),
    )
    .await;

    let pending = cwd.join("opencode-stop-prompt-pending");
    let mut worker = spawn_native_executor_worker(
        &database,
        host,
        actor.clone(),
        run_id.clone(),
        attempt_id.clone(),
    );
    let prompt_accepted = tokio::select! {
        accepted = wait_for_file(&pending, OPENCODE_PROMPT_GATE_TIMEOUT) => accepted,
        finished = &mut worker => {
            panic!("OpenCode executor ended before the prompt gate: {}",
                opencode_prompt_gate_failure(finished, &cwd.join("opencode-stop-events.jsonl")));
        }
    };
    if !prompt_accepted {
        let finished = worker.await;
        panic!(
            "OpenCode prompt gate did not open within the 30-second execution deadline: {}",
            opencode_prompt_gate_failure(finished, &cwd.join("opencode-stop-events.jsonl"))
        );
    }
    wait_phase(&database.pool, &attempt_id, "input_indeterminate").await;
    if hold_cleanup {
        // Complete the provider before Stop, then wait until its host is
        // genuinely inside cleanup. The later Stop must freeze output without
        // sending another abort and keep its 30s lease alive through 35s cleanup.
        fs::write(cwd.join("opencode-stop-abort"), "natural provider error").unwrap();
        assert!(wait_for_file(&cwd.join("cleanup-started"), Duration::from_secs(15)).await);
        wait_phase(&database.pool, &attempt_id, "provider_terminal_observed").await;
    }
    let stop = request_stop_for_run(
        &database,
        &actor,
        &run_id,
        "72000000-0000-4000-8000-000000000102",
    )
    .await;
    assert_eq!(stop.outcome, StopOutcome::StopIntentRecorded);

    let (result, _host) = worker.await.expect("join OpenCode executor");
    let NativeExecutionObservation::OpenCode(observed) =
        result.expect("OpenCode terminal observation")
    else {
        panic!("expected OpenCode-specific observation");
    };
    let provider = observed.observation;
    assert_eq!(provider.session.as_str(), "ses_stop");
    assert_eq!(
        provider.cancel_acknowledged,
        if hold_cleanup { None } else { Some(true) }
    );
    let OpenCodeInputTerminal::Failed(error) = &provider.terminal else {
        panic!("exact completed provider error remains a Failed terminal, not cancellation ACK");
    };
    assert_eq!(error.session_id, "ses_stop");
    assert_eq!(error.user_message_id, provider.request_id);
    assert_eq!(error.assistant_message_id, "msg_stop_error");
    assert!(!format!("{error:?}").contains("private provider error"));
    assert_eq!(
        provider.connection.connection_receipt_id(),
        provider.cleanup.connection_receipt_id()
    );
    assert!(observed.fence.matches_host_cleanup_proof(&provider.cleanup));
    let stop = provider
        .stop
        .as_ref()
        .expect("exact Stop was observed by the owner");

    let requests = fs::read_to_string(cwd.join("opencode-stop-events.jsonl"))
        .expect("read synthetic OpenCode requests");
    let requests = requests
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("OpenCode request JSON"))
        .collect::<Vec<_>>();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "prompt_async")
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["method"] == "abort")
            .count(),
        usize::from(!hold_cleanup),
        "cleanup never sends an interrupt after provider terminal"
    );
    let prompt = requests
        .iter()
        .find(|request| request["method"] == "prompt_async")
        .unwrap();
    assert_eq!(prompt["body"]["messageID"], provider.request_id);
    assert_eq!(prompt["body"]["parts"][0]["text"], BODY);

    let turn = NativeProviderTurnReceipt {
        provider: NativeProviderKind::OpenCode,
        session_id: provider.session.as_str().to_owned(),
        request_id: provider.request_id.clone(),
        final_text: None,
        status: NativeProviderStatus::Failed,
        usage: None,
        evidence: json!({
            "provider":"opencode_local",
            "sessionId":provider.session.as_str(),
            "inputMessageId":provider.request_id,
            "assistantMessageId":error.assistant_message_id,
            "terminal":"error",
            "cancelAcknowledged":provider.cancel_acknowledged
        }),
    };
    let result = finalize_native_stopped(
        &database.pool,
        &observed.execution_principal,
        &observed.fence,
        &turn,
        &provider.cleanup,
        stop,
    )
    .await
    .expect("exact failed assistant and same-server cleanup finalize Stop");
    assert_eq!(result["status"], "cancelled");
    assert_eq!(result["nativeAdmissionHold"], false);
    assert_no_provider_error_material(&database.pool, &run_id).await;

    let events = fs::read_to_string(cwd.join("opencode-stop-events.jsonl")).unwrap();
    assert!(!events.contains("private provider error sentinel"));
}

fn install_executable(directory: &Path, name: &str, source: &str) -> PathBuf {
    let python = Command::new("python3")
        .args(["-c", "import sys; print(sys.executable)"])
        .output()
        .expect("locate Python for the local fixture");
    assert!(
        python.status.success(),
        "python3 is available for synthetic provider"
    );
    let python = String::from_utf8(python.stdout)
        .expect("Python path is UTF-8")
        .trim()
        .to_owned();
    let executable = directory.join(name);
    fs::write(&executable, format!("#!{python}\n{source}")).expect("write synthetic executable");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
        .expect("make synthetic executable");
    executable
        .canonicalize()
        .expect("canonical executable path")
}

fn stop_request(generation_id: String, control_version: i32, action_id: &str) -> StopRequest {
    StopRequest {
        conversation_id: CHAT.into(),
        generation_id,
        control_action_id: action_id.into(),
        expected_attempt_epoch: 1,
        expected_control_version: control_version,
        requested_render_seq: 0,
        requested_body_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            .into(),
    }
}

async fn request_stop_for_run(
    database: &Database,
    actor: &VerifiedActor,
    run_id: &str,
    action_id: &str,
) -> rudder_d1_persistence::native_chat::control::StopReceipt {
    let (generation_id, control_version): (String, i32) = sqlx::query_as(
        "SELECT g.id::text,g.control_version FROM chat_generations g
         JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read current Stop fence");
    request_stop(
        &database.pool,
        actor,
        &stop_request(generation_id, control_version, action_id),
    )
    .await
    .expect("record one exact Stop action")
}

async fn wait_phase(pool: &sqlx::PgPool, attempt_id: &str, phase: &str) {
    for _ in 0..1500 {
        let current: String = sqlx::query_scalar(
            "SELECT protocol_phase FROM heartbeat_run_attempts WHERE id=$1::uuid",
        )
        .bind(attempt_id)
        .fetch_one(pool)
        .await
        .expect("read protocol phase");
        if current == phase {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("provider did not reach {phase}");
}

async fn wait_for_file(path: &Path, timeout: Duration) -> bool {
    tokio::time::timeout(timeout, async {
        while !path.is_file() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok()
}

pub(super) fn opencode_prompt_gate_failure(
    finished: Result<
        (
            Result<NativeExecutionObservation, ExecutionFailure>,
            FixtureHost,
        ),
        tokio::task::JoinError,
    >,
    request_log: &Path,
) -> String {
    let worker = match finished {
        Ok((Err(failure), _)) => format!(
            "worker ended with {} ({:?})",
            failure.diagnostic_code(),
            failure.process_disposition()
        ),
        Ok((Ok(_), _)) => "worker returned an observation before the prompt gate".to_owned(),
        Err(error) => format!("worker task ended unexpectedly ({error})"),
    };
    format!(
        "{worker}; OpenCode request methods=[{}]",
        opencode_request_methods(request_log)
    )
}

fn opencode_request_methods(path: &Path) -> String {
    let methods = fs::read_to_string(path)
        .ok()
        .into_iter()
        .flat_map(|contents| {
            contents
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter_map(|request| request["method"].as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    if methods.is_empty() {
        "<none>".to_owned()
    } else {
        methods.join(",")
    }
}

async fn assert_no_provider_error_material(pool: &sqlx::PgPool, run_id: &str) {
    let evidence: Value = sqlx::query_scalar(
        "SELECT provider_evidence FROM chat_control_actions a
         JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.chat_generation_id=a.expected_generation_id
         WHERE r.id=$1::uuid",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .expect("read final Stop evidence");
    let serialized = evidence.to_string();
    assert!(!serialized.contains("private provider error sentinel"));
    assert!(!serialized.contains("private provider error data sentinel"));
}

struct HostFileRelease(PathBuf);

impl Drop for HostFileRelease {
    fn drop(&mut self) {
        let _ = fs::write(&self.0, "release");
    }
}
