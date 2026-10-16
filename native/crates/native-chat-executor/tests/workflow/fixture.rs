#![cfg(unix)]
#![allow(dead_code)]

use rudder_auth_core::{
    ActorEnvelope, ActorIdentity, NonceReplayGuard, RequestContext, VerifiedActor,
};
use rudder_d1_persistence::native_chat::config::LocalHostContext;
pub(crate) use rudder_d1_persistence::native_chat::execution::claim;
pub(crate) use rudder_d1_persistence::native_chat::{
    Request as AdmissionRequest, execute as admit,
};
pub(crate) use rudder_native_chat_executor::Error as ExecutorError;
use rudder_native_chat_executor::{
    ExecutionRequest, HostPaths, OwnedExecutionRequest, execute, provision_profile,
    run_on_blocking_thread,
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
    sqlx::query(
        "INSERT INTO chat_conversations
           (id, org_id, title, conversation_kind, created_by_user_id, status, preferred_agent_id)
         VALUES ($1::uuid, $2::uuid, 'Executor workflow fixture', 'chat', $3, 'active', $4::uuid)",
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
        "clientMutationId": "native-chat-executor-workflow-1",
        "body": BODY,
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

pub(crate) async fn database_and_admission(
    mode: &str,
) -> (Database, FixtureHost, VerifiedActor, String, String) {
    let database = Database::start().await;
    let host = FixtureHost::new(mode);
    let (actor, run_id, attempt_id) = admitted(&database, &host).await;
    (database, host, actor, run_id, attempt_id)
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
