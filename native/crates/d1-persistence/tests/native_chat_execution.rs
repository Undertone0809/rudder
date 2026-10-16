#[allow(dead_code)]
mod support;

use rudder_auth_core::{
    ActorEnvelope, ActorIdentity, NonceReplayGuard, RequestContext, VerifiedActor,
};
use rudder_d1_persistence::native_chat::config::LocalHostContext;
use rudder_d1_persistence::native_chat::execution::{
    CheckpointTransition, EffectKind, advance_checkpoint, claim, current_checkpoint, renew_lease,
};
use rudder_d1_persistence::native_chat::{Error, Request as AdmissionRequest, execute};
use rudder_runtime_core::native_chat::NativeChatProtocolPhase as Phase;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{fs, path::PathBuf, time::Duration};
use support::{CEO, Database, ORG, OTHER};
use tempfile::TempDir;

const USER: &str = "native-chat-execution-owner";
const CHAT: &str = "21000000-0000-4000-8000-000000000201";
const SECRET: &[u8] = b"native-chat-execution-test-key";
const OPAQUE_THREAD: &str = " 线程-α==  ";
const OPAQUE_TURN: &str = " turn/δ== ";

pub struct ExecutionHost {
    _root: TempDir,
    context: LocalHostContext,
    executable: PathBuf,
    cwd: PathBuf,
}

impl ExecutionHost {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("create isolated execution host tree");
        let instance = root.path().join("instance");
        let workspace_home = root.path().join("workspaces");
        let previous_documents = root.path().join("previous-documents");
        let profiles = root.path().join("managed-profiles");
        let operator_home = root.path().join("operator-home");
        let executable = root.path().join("bin/codex");
        let cwd = root.path().join("agent-cwd");
        let profile_home = profiles.join(ORG).join(CEO).join("default");
        for directory in [
            &instance,
            &workspace_home,
            &profiles,
            &operator_home,
            executable.parent().expect("binary directory"),
            &cwd,
            &profile_home,
        ] {
            fs::create_dir_all(directory).expect("create isolated host directory");
        }
        fs::write(&executable, b"fake codex executable")
            .expect("create non-running Codex executable fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
                .expect("mark fake executable");
        }
        // Preserve execution-ledger coverage on Windows with no filesystem
        // instruction bundle; supported hosts additionally exercise its content.
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let org_key = ORG
                .chars()
                .filter(|character| *character != '-')
                .take(12)
                .collect::<String>();
            let instructions = workspace_home
                .join(org_key)
                .join("workspaces/agents/codex-agent/instructions");
            fs::create_dir_all(&instructions).expect("create instruction directory");
            fs::write(instructions.join("SOUL.md"), "isolated test instructions\n")
                .expect("seed read-only instruction fixture");
        }
        let executable = executable
            .canonicalize()
            .expect("canonical fake executable");
        let cwd = cwd.canonicalize().expect("canonical Agent cwd");
        let context = LocalHostContext::from_rust_host(
            "execution-test-host".into(),
            instance,
            workspace_home,
            previous_documents,
            false,
            profiles,
            operator_home,
            executable.clone(),
        )
        .expect("construct trusted host context");
        Self {
            _root: root,
            context,
            executable,
            cwd,
        }
    }

    fn context(&self) -> &LocalHostContext {
        &self.context
    }

    fn persisted_agent_config(&self) -> Value {
        json!({
            "command": self.executable.to_string_lossy(),
            "cwd": self.cwd.to_string_lossy(),
            "profileId": "default",
            "instructionsBundleMode": "managed",
            "search": false,
        })
    }
}

fn verified_actor(organization_id: &str, id: &str, nonce: &str) -> VerifiedActor {
    let actor = ActorIdentity::new("user", id).expect("valid actor identity");
    let path = format!("/internal/orgs/{organization_id}/native-chat-execution");
    let body = b"{}";
    let request_id = format!("execution-{nonce}");
    let envelope = ActorEnvelope::new(
        actor.clone(),
        organization_id,
        "session-native-chat-execution",
        1,
        "rudder-server-foundation",
        "POST",
        &path,
        "runtime.native_chat.execution",
        body,
        &request_id,
        nonce,
        1_000,
        1_100,
    )
    .expect("unsigned envelope")
    .sign(SECRET)
    .expect("signed envelope");
    let request = RequestContext::new(
        &actor,
        organization_id,
        "session-native-chat-execution",
        1,
        "rudder-server-foundation",
        "POST",
        &path,
        "runtime.native_chat.execution",
        body,
        &request_id,
        1_050,
    );
    envelope
        .verify_to_actor(SECRET, &request, &mut NonceReplayGuard::new())
        .expect("verified actor")
}

async fn prepare(database: &Database, host: &ExecutionHost) -> (VerifiedActor, String, String) {
    sqlx::query(
        "INSERT INTO organization_memberships(org_id, principal_type, principal_id, membership_role, status)
         VALUES ($1::uuid, 'user', $2, 'member', 'active')",
    )
    .bind(ORG)
    .bind(USER)
    .execute(&database.pool)
    .await
    .expect("seed user membership");
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
    .expect("persist trusted Codex local runtime defaults");
    sqlx::query(
        "INSERT INTO chat_conversations
           (id, org_id, title, conversation_kind, created_by_user_id, status, preferred_agent_id)
         VALUES ($1::uuid, $2::uuid, 'Native execution fixture', 'chat', $3, 'active', $4::uuid)",
    )
    .bind(CHAT)
    .bind(ORG)
    .bind(USER)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed ordinary Chat conversation");

    let actor = verified_actor(ORG, USER, "owner");
    let admission: AdmissionRequest = serde_json::from_value(json!({
        "operation": "submit_native_chat_turn",
        "conversationId": CHAT,
        "clientMutationId": "native-execution-1",
        "body": "begin a durable native execution",
    }))
    .expect("valid admission request");
    let receipt = execute(&database.pool, &actor, ORG, &admission, host.context())
        .await
        .expect("admit native chat");
    (
        actor,
        receipt["runId"].as_str().unwrap().to_owned(),
        receipt["attemptId"].as_str().unwrap().to_owned(),
    )
}

async fn seed_execution(
    database: &Database,
) -> (
    VerifiedActor,
    String,
    String,
    rudder_d1_persistence::native_chat::execution::ExecutionFence,
) {
    let host = ExecutionHost::new();
    let (actor, run_id, attempt_id) = prepare(database, &host).await;
    let claimed = claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    .expect("claim first native execution owner");
    let fence = claimed.fence;
    (actor, run_id, attempt_id, fence)
}

#[tokio::test(flavor = "multi_thread")]
async fn admission_resumes_exact_open_binding_thread_and_claim_preserves_it() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, first_run_id, _first_attempt_id) = prepare(&database, &host).await;
    let context_snapshot: Value = sqlx::query_scalar(
        "SELECT context_snapshot FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&first_run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read first admitted binding association");
    let binding_id = context_snapshot["runtimeBindingId"]
        .as_str()
        .expect("RuntimeBinding id");
    let segment_id = context_snapshot["nativeSegmentId"]
        .as_str()
        .expect("NativeSegment id");

    // Model a finished earlier Run whose exact native Thread is still the
    // current open Segment. These fixture updates are fenced and affect only
    // the disposable PostgreSQL instance.
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin prior-run fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:admission', true)")
        .execute(&mut *tx)
        .await
        .expect("mark fixture transaction");
    sqlx::query(
        "UPDATE heartbeat_runs SET status='failed', finished_at=clock_timestamp(),
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&first_run_id)
    .execute(&mut *tx)
    .await
    .expect("finish earlier Run fixture");
    sqlx::query(
        "UPDATE chat_generations SET status='failed', completed_at=clock_timestamp(),
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND conversation_id=$2::uuid",
    )
    .bind(ORG)
    .bind(CHAT)
    .execute(&mut *tx)
    .await
    .expect("finish earlier Generation fixture");
    sqlx::query(
        "UPDATE native_segments SET state='open', native_session_id=$1,
             updated_at=clock_timestamp()
         WHERE org_id=$2::uuid AND binding_id=$3::uuid AND id=$4::uuid",
    )
    .bind(OPAQUE_THREAD)
    .bind(ORG)
    .bind(binding_id)
    .bind(segment_id)
    .execute(&mut *tx)
    .await
    .expect("persist exact existing Thread locator");
    tx.commit().await.expect("commit prior-run fixture");

    let second_request: AdmissionRequest = serde_json::from_value(json!({
        "operation": "submit_native_chat_turn",
        "conversationId": CHAT,
        "clientMutationId": "native-execution-resume-2",
        "body": "continue the exact Native Thread",
    }))
    .expect("valid continuation request");
    let receipt = execute(&database.pool, &actor, ORG, &second_request, host.context())
        .await
        .expect("admit exact existing Thread resume");
    let (run_id, attempt_id): (String, String) = sqlx::query_as(
        "SELECT r.id::text, a.id::text FROM heartbeat_runs r
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(receipt["runId"].as_str().expect("admitted Run id"))
    .fetch_one(&database.pool)
    .await
    .expect("read resumed execution identities");
    assert_eq!(run_id, receipt["runId"]);
    let (run_snapshot, intent, reuse_scope, session_before): (
        Value,
        Value,
        String,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT context_snapshot, session_intent_json, session_reuse_scope, session_id_before
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read resumed Run session intent");
    assert_eq!(run_snapshot["runtimeBindingId"], binding_id);
    assert_eq!(run_snapshot["nativeSegmentId"], segment_id);
    assert_eq!(intent["kind"], "resume");
    assert_eq!(intent["reuseScope"], "explicit");
    assert_eq!(intent["sessionId"], OPAQUE_THREAD);
    assert_eq!(reuse_scope, "explicit");
    assert_eq!(session_before.as_deref(), Some(OPAQUE_THREAD));
    let (phase, checkpoint_thread, provider_thread, resume_source): (
        String,
        Option<String>,
        Option<String>,
        String,
    ) = sqlx::query_as(
        "SELECT protocol_phase, checkpoint_json->>'threadId', provider_thread_id, resume_source
         FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_one(&database.pool)
    .await
    .expect("read resumed Attempt checkpoint");
    assert_eq!(phase, "thread_known");
    assert_eq!(checkpoint_thread.as_deref(), Some(OPAQUE_THREAD));
    assert_eq!(provider_thread.as_deref(), Some(OPAQUE_THREAD));
    assert_eq!(resume_source, "fresh");

    let claimed = claim(
        &database.pool,
        &actor,
        ORG,
        &run_id,
        &attempt_id,
        host.context(),
    )
    .await
    .expect("claim must revalidate and preserve exact Thread continuity");
    assert_eq!(claimed.fence.identity().run_id, run_id);
}

fn assert_conflict<T>(result: Result<T, Error>) {
    match result {
        Err(Error::Http(409, _)) => {}
        Err(Error::Http(status, _)) => panic!("expected 409, got HTTP {status}"),
        Err(Error::Database(_)) => panic!("expected 409, got database error"),
        Ok(_) => panic!("expected conflict, operation succeeded"),
    }
}

async fn wait_for_lock_wait(pool: &PgPool, fragment: &str) {
    for _ in 0..300 {
        let waiting: bool = sqlx::query_scalar(
            "SELECT EXISTS(
               SELECT 1 FROM pg_stat_activity
               WHERE datname=current_database() AND wait_event_type='Lock'
                 AND query ILIKE $1
             )",
        )
        .bind(format!("%{fragment}%"))
        .fetch_one(pool)
        .await
        .expect("read PostgreSQL lock wait");
        if waiting {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for lock: {fragment}");
}

#[path = "native_chat_execution/checkpoints.rs"]
mod checkpoints;
#[path = "native_chat_execution/deletions.rs"]
mod deletions;
#[path = "native_chat_execution/fencing.rs"]
mod fencing;
#[path = "native_chat_execution/ownership.rs"]
mod ownership;

#[path = "native_chat_execution/continuity.rs"]
mod continuity;
