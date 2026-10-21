#![cfg(unix)]
#![allow(dead_code)]

use rudder_auth_core::{
    ActorEnvelope, ActorIdentity, NonceReplayGuard, RequestContext, VerifiedActor,
};
use rudder_d1_persistence::native_chat::config::LocalHostContext;
pub(crate) use rudder_d1_persistence::native_chat::execution::claim;
pub(crate) use rudder_d1_persistence::native_chat::{
    FirstSendRequest, Request as AdmissionRequest, execute as admit,
    execute_first_send as admit_first_send,
};
pub(crate) use rudder_native_chat_executor::Error as ExecutorError;
use rudder_native_chat_executor::{
    ExecutionRequest, HostPaths, OwnedExecutionRequest, execute, provision_profile,
    run_observed_native_with_request_actor_on_blocking_thread, run_on_blocking_thread,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    fs,
    path::PathBuf,
    process::Command,
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
#[path = "../../../d1-persistence/tests/support/mod.rs"]
pub(crate) mod support;
pub(crate) use support::{CEO, Database, ORG};
use tempfile::TempDir;
use tokio::runtime::Handle;

const USER: &str = "native-chat-executor-owner";
pub(crate) const CHAT: &str = "21000000-0000-4000-8000-000000000301";
const SECRET: &[u8] = b"native-chat-executor-test-key";
pub(crate) const BODY: &str = "Keep only this admitted input: 雪🧭\nsecond line";
pub(crate) const THREAD: &str = " 线程-native-thread== ";
pub(crate) const TURN: &str = " turn/δ-native-turn== ";
pub(crate) const MODEL: &str = "vendor/native-chat-executor-model";

pub(crate) struct FixtureHost {
    root: TempDir,
    context: Option<LocalHostContext>,
    executable: PathBuf,
}

impl FixtureHost {
    pub(crate) fn new(mode: &str) -> Self {
        let root = tempfile::tempdir().expect("create isolated executor fixture");
        let instance = root.path().join("instance");
        let workspace_home = root.path().join("workspaces");
        let previous_documents = root.path().join("previous-documents");
        let profiles = root.path().join("managed-profiles");
        let operator_home = root.path().join("operator-home");
        let executable = root.path().join("bin/codex-fixture");
        let cwd = root.path().join("agent-cwd");
        let home = root.path().join("isolated-home");
        let runtime_root = root.path().join("runtime-root");
        let profile_home = profiles.join(ORG).join(CEO).join("default");
        for directory in [
            &instance,
            &workspace_home,
            &profiles,
            &operator_home,
            executable.parent().expect("provider directory"),
            &cwd,
            &home,
            &runtime_root,
            &profile_home,
        ] {
            fs::create_dir_all(directory).expect("create isolated fixture directory");
        }
        fs::write(home.join("mode.txt"), mode).expect("set provider fixture mode");

        let python = python_executable();
        let script = format!(
            "#!{}\n{}",
            python.to_string_lossy(),
            include_str!("../fixtures/fake_codex.py")
        );
        fs::write(&executable, script).expect("write synthetic Codex JSON-RPC provider");
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
            .expect("make synthetic provider executable");
        let executable = executable.canonicalize().expect("canonical provider path");
        provision_profile(&profile_home.canonicalize().expect("canonical profile"))
            .expect("provision isolated least-privilege profile");

        // Keep an instruction source so the configured managed bundle is
        // resolved by the same production path as ordinary native admission.
        let org_key = ORG
            .chars()
            .filter(|character| *character != '-')
            .take(12)
            .collect::<String>();
        let instructions = workspace_home
            .join(org_key)
            .join("workspaces/agents/codex-agent/instructions");
        fs::create_dir_all(&instructions).expect("create managed instruction bundle");
        fs::write(
            instructions.join("SOUL.md"),
            "synthetic local instructions\n",
        )
        .expect("seed managed instruction entry");

        let context = LocalHostContext::from_rust_host(
            "native-chat-executor-fixture-host".into(),
            instance,
            workspace_home,
            previous_documents,
            false,
            profiles,
            operator_home,
            executable.clone(),
        )
        .expect("construct trusted local host context");
        Self {
            root,
            context: Some(context),
            executable,
        }
    }

    pub(crate) fn enable_hermes_runtime(&mut self) {
        use std::os::unix::fs::PermissionsExt;

        // This transport fixture exercises owned-session ordering, not the
        // separately pinned ephemeral-instruction bootstrap. Leave the
        // synthetic workspace without an instruction entry so it uses the
        // ordinary Hermes ACP adapter path.
        let org_key = ORG
            .chars()
            .filter(|character| *character != '-')
            .take(12)
            .collect::<String>();
        let instructions = self
            .root
            .path()
            .join("workspaces")
            .join(org_key)
            .join("workspaces/agents/codex-agent/instructions/SOUL.md");
        fs::remove_file(instructions).expect("disable fixture instruction bootstrap for Hermes");

        let install = self.root.path().join("hermes-install");
        let bin = install.join("venv/bin");
        let profiles = self.root.path().join("hermes-profiles");
        let profile = profiles.join(ORG).join(CEO).join("default");
        for directory in [&bin, &profile] {
            fs::create_dir_all(directory).expect("create Hermes fixture directories");
        }

        let executable = bin.join("hermes");
        let wrapper = "#!/bin/sh\n'''exec' \"$(dirname -- \"$(realpath -- \"$0\")\")\"/'python3' \"$0\" \"$@\"\n' '''\n# -*- coding: utf-8 -*-\nimport sys\nfrom hermes_cli.main import main\nif __name__ == \"__main__\":\n";
        fs::write(&executable, wrapper).expect("write supported Hermes console wrapper");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
            .expect("make Hermes fixture executable");

        let python = bin.join("python3");
        let python_shim = format!(
            "#!/bin/sh\nPYTHONPATH='{}' exec python3 \"$@\"\n",
            install.display()
        );
        fs::write(&python, python_shim).expect("write Hermes fixture Python shim");
        fs::set_permissions(&python, fs::Permissions::from_mode(0o700))
            .expect("make Hermes fixture Python shim executable");

        for relative in [
            "hermes_bootstrap.py",
            "hermes_cli/__init__.py",
            "acp_adapter/entry.py",
            "acp_adapter/session.py",
            "agent/agent_init.py",
            "agent/chat_completion_helpers.py",
        ] {
            let path = install.join(relative);
            fs::create_dir_all(path.parent().expect("Hermes source parent"))
                .expect("create Hermes fixture source directory");
            let source = match relative {
                "hermes_cli/__init__.py" => "__version__ = \"0.21.0\"\n",
                "hermes_bootstrap.py" => "def harden_import_path(source_root):\n    return None\n",
                "acp_adapter/session.py" => {
                    "class SessionManager:\n    def _make_agent(self, session_id, cwd, model, requested_provider, base_url, api_mode):\n        return type('Agent', (), {'ephemeral_system_prompt': None})()\n"
                }
                _ => "# synthetic Hermes adapter fixture\n",
            };
            fs::write(path, source).expect("write Hermes adapter fixture source");
        }

        let home = self.root.path().join("isolated-home");
        let entry = format!(
            r#"import json, pathlib, signal, sys, time
home = pathlib.Path({home:?})
mode = home.joinpath("mode.txt").read_text(encoding="utf-8").strip()
session = "550e8400-e29b-41d4-a716-446655440000"

def main(argv=None):
    from acp_adapter.session import SessionManager
    home.joinpath("provider-started").write_text("started", encoding="utf-8")
    events = home.joinpath("provider-events.jsonl")
    def stop(signum, frame):
        home.joinpath("provider-stopped").write_text("stopped", encoding="utf-8")
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    def out(value):
        sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    manager = SessionManager()
    for raw in sys.stdin:
        message = json.loads(raw)
        with events.open("a", encoding="utf-8") as log:
            log.write(json.dumps({{"received": message}}) + "\n")
        method = message.get("method")
        if method == "initialize":
            out({{"jsonrpc":"2.0","id":message["id"],"result":{{"protocolVersion":1,"agentCapabilities":{{"loadSession":True}}}}}})
        elif method == "initialized":
            continue
        elif method == "session/new":
            manager._make_agent(session, None, None)
            home.joinpath("session-new-count").write_text("1", encoding="utf-8")
            out({{"jsonrpc":"2.0","id":message["id"],"result":{{"sessionId":session}}}})
        elif method == "session/load":
            manager._make_agent(message["params"]["sessionId"], None, None)
            out({{"jsonrpc":"2.0","id":message["id"],"result":{{"sessionId":session}}}})
        elif method == "session/set_model":
            out({{"jsonrpc":"2.0","id":message["id"],"result":{{}}}})
        elif method == "session/prompt":
            user_id = message["params"]["messageId"]
            if mode == "hermes-stop-pending":
                out({{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":session,"update":{{"sessionUpdate":"agent_thought_chunk","content":{{"type":"text","text":"unflushed thought"}}}}}}}})
                home.joinpath("progress-pending").write_text("pending", encoding="utf-8")
                cancel = json.loads(sys.stdin.readline())
                assert cancel.get("method") == "session/cancel"
                out({{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":session,"update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"late assistant chunk"}}}}}}}})
                out({{"jsonrpc":"2.0","id":message["id"],"result":{{"stopReason":"cancelled","userMessageId":user_id}}}})
            else:
                if mode == "hermes-live-progress":
                    home.joinpath("prompt-ready").write_text("ready", encoding="utf-8")
                    while not home.joinpath("first-progress-release").exists():
                        time.sleep(0.01)
                out({{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":session,"update":{{"sessionUpdate":"agent_thought_chunk","content":{{"type":"text","text":"Synthetic process thought."}}}}}}}})
                if mode == "hermes-live-progress":
                    home.joinpath("progress-pending").write_text("pending", encoding="utf-8")
                    while not home.joinpath("progress-release").exists():
                        time.sleep(0.01)
                out({{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":session,"update":{{"sessionUpdate":"tool_call","toolCallId":"fixture-tool","title":"Inspecting fixture","rawInput":{{"private":"raw input sentinel"}}}}}}}})
                out({{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":session,"update":{{"sessionUpdate":"tool_call_update","toolCallId":"fixture-tool","status":"completed","rawOutput":{{"private":"raw output sentinel"}}}}}}}})
                out({{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":session,"update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"synthetic "}}}}}}}})
                out({{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":session,"update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"answer"}}}}}}}})
                out({{"jsonrpc":"2.0","id":message["id"],"result":{{"stopReason":"end_turn","userMessageId":user_id}}}})
"#
        );
        let entry_path = install.join("acp_adapter/entry.py");
        fs::write(entry_path, entry).expect("write synthetic Hermes ACP adapter entrypoint");
        let main_path = install.join("hermes_cli/main.py");
        fs::create_dir_all(main_path.parent().unwrap())
            .expect("create Hermes fixture module directory");
        fs::write(main_path, "from acp_adapter.entry import main\n")
            .expect("write synthetic Hermes CLI module");

        let context = self
            .context
            .take()
            .expect("fixture host context is present");
        self.context = Some(
            context
                .with_executable_search_path("/usr/bin:/bin".into())
                .expect("trust fixture Hermes executable search path")
                .with_hermes_runtime(executable.clone(), profiles)
                .expect("attach Hermes fixture runtime"),
        );
    }

    pub(crate) fn context(&self) -> &LocalHostContext {
        self.context
            .as_ref()
            .expect("fixture host context is present")
    }

    pub(crate) fn take_context(&mut self) -> LocalHostContext {
        self.context
            .take()
            .expect("fixture host context is present")
    }

    fn persisted_agent_config(&self) -> Value {
        json!({
            "command": self.executable.to_string_lossy(),
            "cwd": self.root.path().join("agent-cwd").to_string_lossy(),
            "profileId": "default",
            "model": MODEL,
            "instructionsBundleMode": "managed",
            "search": false,
        })
    }

    pub(crate) fn paths(&self) -> HostPaths {
        let process_host = std::env::var_os("RUDDER_TEST_PROCESS_HOST")
            .expect("set RUDDER_TEST_PROCESS_HOST to the built accepted process host");
        let process_host = PathBuf::from(process_host)
            .canonicalize()
            .expect("canonical accepted process-host binary");
        let runtime_root = self.root.path().join("runtime-root");
        let isolated_home = self.root.path().join("isolated-home");
        HostPaths {
            process_host,
            runtime_root: runtime_root.canonicalize().expect("canonical runtime root"),
            isolated_home: isolated_home
                .canonicalize()
                .expect("canonical isolated HOME"),
        }
    }

    pub(crate) fn events(&self) -> Vec<Value> {
        let Ok(contents) = fs::read_to_string(self.probe_path("provider-events.jsonl")) else {
            return Vec::new();
        };
        contents
            .lines()
            .map(|line| serde_json::from_str(line).expect("provider event JSON"))
            .collect()
    }

    pub(crate) fn provider_started(&self) -> bool {
        self.probe_path("provider-started").exists()
    }

    pub(crate) fn probe_path(&self, name: &str) -> PathBuf {
        self.root.path().join("isolated-home").join(name)
    }
}

fn python_executable() -> PathBuf {
    let output = Command::new("python3")
        .args(["-c", "import sys; print(sys.executable)"])
        .output()
        .expect("locate Python for the synthetic provider fixture");
    assert!(
        output.status.success(),
        "python3 must be available for this opt-in test"
    );
    PathBuf::from(
        String::from_utf8(output.stdout)
            .expect("Python path is UTF-8")
            .trim(),
    )
    .canonicalize()
    .expect("canonical Python interpreter")
}

pub(crate) fn verified_actor() -> VerifiedActor {
    let actor = ActorIdentity::new("user", USER).expect("valid test user");
    let path = format!("/internal/orgs/{ORG}/native-chat-executor-test");
    let body = b"{}";
    let request_id = "native-chat-executor-owner-request";
    let envelope = ActorEnvelope::new(
        actor.clone(),
        ORG,
        "session-native-chat-executor-test",
        1,
        "rudder-server-foundation",
        "POST",
        &path,
        "runtime.native_chat.executor_test",
        body,
        request_id,
        "executor-owner-nonce",
        1_000,
        1_100,
    )
    .expect("unsigned signed-actor fixture")
    .sign(SECRET)
    .expect("sign actor fixture");
    let request = RequestContext::new(
        &actor,
        ORG,
        "session-native-chat-executor-test",
        1,
        "rudder-server-foundation",
        "POST",
        &path,
        "runtime.native_chat.executor_test",
        body,
        request_id,
        1_050,
    );
    envelope
        .verify_to_actor(SECRET, &request, &mut NonceReplayGuard::new())
        .expect("verified test actor")
}

pub(crate) async fn admitted(
    database: &Database,
    host: &FixtureHost,
) -> (VerifiedActor, String, String) {
    admitted_with_runtime(database, host, "codex_local", host.persisted_agent_config()).await
}

pub(crate) async fn admitted_hermes(
    database: &Database,
    host: &FixtureHost,
) -> (VerifiedActor, String, String) {
    admitted_hermes_with_input(database, host, "native-chat-executor-workflow-1", BODY).await
}

pub(crate) async fn admitted_hermes_with_input(
    database: &Database,
    host: &FixtureHost,
    client_mutation_id: &str,
    body: &str,
) -> (VerifiedActor, String, String) {
    admitted_with_runtime_input(
        database,
        host,
        "hermes_local",
        json!({"profileId":"default","model":MODEL}),
        client_mutation_id,
        body,
    )
    .await
}

async fn admitted_with_runtime(
    database: &Database,
    host: &FixtureHost,
    runtime_type: &str,
    runtime_config: Value,
) -> (VerifiedActor, String, String) {
    admitted_with_runtime_input(
        database,
        host,
        runtime_type,
        runtime_config,
        "native-chat-executor-workflow-1",
        BODY,
    )
    .await
}

async fn admitted_with_runtime_input(
    database: &Database,
    host: &FixtureHost,
    runtime_type: &str,
    runtime_config: Value,
    client_mutation_id: &str,
    body: &str,
) -> (VerifiedActor, String, String) {
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at)
         VALUES ($1,'Native Chat executor fixture','native-chat-executor@example.test',now(),now())
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("seed executor fixture user row");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id, principal_type, principal_id, membership_role, status)
         VALUES ($1::uuid, 'user', $2, 'member', 'active')
         ON CONFLICT (org_id, principal_type, principal_id) DO NOTHING",
    )
    .bind(ORG)
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("seed active organization membership");
    sqlx::query(
        "UPDATE agents SET agent_runtime_type=$1, status='idle',
           workspace_key='codex-agent', agent_runtime_config=$2::jsonb
         WHERE org_id=$3::uuid AND id=$4::uuid",
    )
    .bind(runtime_type)
    .bind(runtime_config.to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("persist selected local Agent config");
    sqlx::query(
        "INSERT INTO chat_conversations
           (id, org_id, title, conversation_kind, created_by_user_id, status, preferred_agent_id)
         VALUES ($1::uuid, $2::uuid, 'Executor workflow fixture', 'chat', $3, 'active', $4::uuid)
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(CHAT)
    .bind(ORG)
    .bind(USER)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed ordinary shared Chat");

    sqlx::query(
        "INSERT INTO chat_messages (org_id, conversation_id, role, kind, status, body)
         VALUES ($1::uuid, $2::uuid, 'assistant', 'message', 'completed', 'old private history')",
    )
    .bind(ORG)
    .bind(CHAT)
    .execute(&database.pool)
    .await
    .expect("seed prior chat history that must not be submitted");

    let actor = verified_actor();
    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation": "submit_native_chat_turn",
        "conversationId": CHAT,
        "clientMutationId": client_mutation_id,
        "body": body,
    }))
    .expect("typed ordinary Chat admission request");
    let receipt = admit(&database.pool, &actor, ORG, &request, host.context())
        .await
        .expect("admit one native Chat input");
    (
        actor,
        receipt["runId"].as_str().expect("Run id").to_owned(),
        receipt["attemptId"]
            .as_str()
            .expect("Attempt id")
            .to_owned(),
    )
}

pub(crate) async fn first_send_admitted(
    database: &Database,
    host: &FixtureHost,
) -> (VerifiedActor, String, String, String) {
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at)
         VALUES ($1,'Native Chat executor fixture','native-chat-executor@example.test',now(),now())
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("seed executor fixture user row");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id, principal_type, principal_id, membership_role, status)
         VALUES ($1::uuid, 'user', $2, 'member', 'active')",
    )
    .bind(ORG)
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("seed active organization membership");
    sqlx::query(
        "UPDATE agents SET agent_runtime_type='codex_local', status='idle',
           workspace_key='codex-agent', agent_runtime_config=$1::jsonb
         WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(host.persisted_agent_config().to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("persist selected local Codex Agent config");

    let actor = verified_actor();
    let request: FirstSendRequest = serde_json::from_value(json!({
        "clientMutationId": "native-chat-executor-first-send-1",
        "preferredAgentId": CEO,
        "body": BODY,
    }))
    .expect("typed first-send Chat admission request");
    let receipt = admit_first_send(&database.pool, &actor, ORG, &request, host.context())
        .await
        .expect("atomically admit the first Chat message");
    let conversation_id = receipt["conversationId"]
        .as_str()
        .expect("first-send conversation id")
        .to_owned();

    // A post-admission old message models an existing transcript while proving
    // the fresh provider Turn receives only the exact admitted first input.
    sqlx::query(
        "INSERT INTO chat_messages (org_id, conversation_id, role, kind, status, body)
         VALUES ($1::uuid, $2::uuid, 'assistant', 'message', 'completed', 'old private history')",
    )
    .bind(ORG)
    .bind(&conversation_id)
    .execute(&database.pool)
    .await
    .expect("seed transcript that must not be replayed to the provider");

    (
        actor,
        conversation_id,
        receipt["runId"].as_str().expect("Run id").to_owned(),
        receipt["attemptId"]
            .as_str()
            .expect("Attempt id")
            .to_owned(),
    )
}

pub(crate) async fn database_and_admission(
    mode: &str,
) -> (Database, FixtureHost, VerifiedActor, String, String) {
    let database = Database::start().await;
    let host = FixtureHost::new(mode);
    let (actor, run_id, attempt_id) = admitted(&database, &host).await;
    (database, host, actor, run_id, attempt_id)
}

pub(crate) async fn database_and_hermes_admission(
    mode: &str,
) -> (Database, FixtureHost, VerifiedActor, String, String) {
    let database = Database::start().await;
    let mut host = FixtureHost::new(mode);
    host.enable_hermes_runtime();
    let (actor, run_id, attempt_id) = admitted_hermes(&database, &host).await;
    (database, host, actor, run_id, attempt_id)
}

pub(crate) async fn database_and_first_send_admission(
    mode: &str,
) -> (Database, FixtureHost, VerifiedActor, String, String, String) {
    let database = Database::start().await;
    let host = FixtureHost::new(mode);
    let (actor, conversation_id, run_id, attempt_id) = first_send_admitted(&database, &host).await;
    (database, host, actor, conversation_id, run_id, attempt_id)
}

pub(crate) async fn execute_on_worker(
    database: &Database,
    host: FixtureHost,
    actor: VerifiedActor,
    run_id: String,
    attempt_id: String,
) -> (
    Result<rudder_native_chat_executor::ExecutionObservation, ExecutorError>,
    FixtureHost,
) {
    spawn_executor_worker(
        database.pool.clone(),
        host,
        actor,
        run_id,
        attempt_id,
        false,
    )
    .await
    .expect("executor blocking worker must join")
}

pub(crate) async fn execute_native_on_worker(
    database: &Database,
    host: FixtureHost,
    actor: VerifiedActor,
    run_id: String,
    attempt_id: String,
) -> (
    Result<
        rudder_native_chat_executor::NativeExecutionObservation,
        rudder_native_chat_executor::ExecutionFailure,
    >,
    FixtureHost,
) {
    spawn_native_executor_worker(database, host, actor, run_id, attempt_id)
        .await
        .expect("native executor blocking worker must join")
}

pub(crate) fn spawn_native_executor_worker(
    database: &Database,
    host: FixtureHost,
    actor: VerifiedActor,
    run_id: String,
    attempt_id: String,
) -> tokio::task::JoinHandle<(
    Result<
        rudder_native_chat_executor::NativeExecutionObservation,
        rudder_native_chat_executor::ExecutionFailure,
    >,
    FixtureHost,
)> {
    let pool = database.pool.clone();
    let handle = Handle::current();
    tokio::task::spawn_blocking(move || {
        let paths = host.paths();
        let cancelled = AtomicBool::new(false);
        let result = run_observed_native_with_request_actor_on_blocking_thread(
            &handle,
            &pool,
            actor,
            host.context(),
            &paths,
            ExecutionRequest {
                organization_id: ORG,
                run_id: &run_id,
                attempt_id: &attempt_id,
                timeout: Duration::from_secs(30),
                cancelled: &cancelled,
            },
        );
        (result, host)
    })
}

pub(crate) async fn execute_cancelled_on_worker(
    database: &Database,
    host: FixtureHost,
    actor: VerifiedActor,
    run_id: String,
    attempt_id: String,
) -> (
    Result<rudder_native_chat_executor::ExecutionObservation, ExecutorError>,
    FixtureHost,
) {
    spawn_executor_worker(database.pool.clone(), host, actor, run_id, attempt_id, true)
        .await
        .expect("executor blocking worker must join")
}

pub(crate) fn spawn_executor_worker(
    pool: PgPool,
    host: FixtureHost,
    actor: VerifiedActor,
    run_id: String,
    attempt_id: String,
    cancelled_before_start: bool,
) -> tokio::task::JoinHandle<(
    Result<rudder_native_chat_executor::ExecutionObservation, ExecutorError>,
    FixtureHost,
)> {
    let handle = Handle::current();
    tokio::task::spawn_blocking(move || {
        let paths = host.paths();
        let cancelled = AtomicBool::new(cancelled_before_start);
        let result = run_on_blocking_thread(
            &handle,
            &pool,
            &actor,
            host.context(),
            &paths,
            ExecutionRequest {
                organization_id: ORG,
                run_id: &run_id,
                attempt_id: &attempt_id,
                timeout: Duration::from_secs(30),
                cancelled: &cancelled,
            },
        );
        (result, host)
    })
}

pub(crate) fn spawn_owned_executor_task(
    pool: PgPool,
    actor: VerifiedActor,
    context: LocalHostContext,
    paths: HostPaths,
    run_id: String,
    attempt_id: String,
    cancelled: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<Result<rudder_native_chat_executor::ExecutionObservation, ExecutorError>>
{
    tokio::spawn(execute(
        pool,
        actor,
        context,
        paths,
        OwnedExecutionRequest {
            organization_id: ORG.to_owned(),
            run_id,
            attempt_id,
            timeout: Duration::from_secs(30),
            cancelled,
        },
    ))
}

pub(crate) fn assert_ignored_external_dependencies() {
    assert!(
        std::env::var_os("RUDDER_TEST_PROCESS_HOST").is_some(),
        "set RUDDER_TEST_PROCESS_HOST to the Rust process-host binary; these tests never call a real provider"
    );
}
