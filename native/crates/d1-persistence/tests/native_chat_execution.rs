#[allow(dead_code)]
mod support;

use rudder_auth_core::{
    ActorEnvelope, ActorIdentity, NonceReplayGuard, RequestContext, VerifiedActor,
};
use rudder_d1_persistence::native_chat::config::LocalHostContext;
use rudder_d1_persistence::native_chat::execution::{
    CheckpointTransition, EffectDispatch, EffectKind, advance_checkpoint, claim,
    current_checkpoint, load_submission, renew_lease,
};
use rudder_d1_persistence::native_chat::{Error, Request as AdmissionRequest, execute};
use rudder_d1_persistence::{goal_costs, goal_runs};
use rudder_runtime_core::native_chat::NativeChatProtocolPhase as Phase;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{fs, path::PathBuf, time::Duration};
use support::{CEO, Database, GOAL, ORG, OTHER};
use tempfile::TempDir;

const USER: &str = "native-chat-execution-owner";
const CHAT: &str = "21000000-0000-4000-8000-000000000201";
const SECRET: &[u8] = b"native-chat-execution-test-key";
const OPAQUE_THREAD: &str = " 线程-α==  ";
const OPAQUE_TURN: &str = " turn/δ== ";
const BUDGET_AGENT: &str = "50000000-0000-4000-8000-000000000002";
const FOREIGN_AGENT: &str = "50000000-0000-4000-8000-000000000003";

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
    verified_actor_kind(organization_id, "user", id, nonce)
}

fn verified_actor_kind(organization_id: &str, kind: &str, id: &str, nonce: &str) -> VerifiedActor {
    let actor = ActorIdentity::new(kind, id).expect("valid actor identity");
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
    assert!(session_before.is_none());
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

#[tokio::test(flavor = "multi_thread")]
async fn hard_budget_stop_uses_native_chat_cleanup_and_marks_only_scoped_legacy_work() {
    let database = Database::start().await;
    let host = ExecutionHost::new();
    let (actor, chat_run, _chat_attempt) = prepare(&database, &host).await;
    claim(
        &database.pool,
        &actor,
        ORG,
        &chat_run,
        &_chat_attempt,
        host.context(),
    )
    .await
    .expect("claim Native Chat execution owner");

    sqlx::query(
        "INSERT INTO agents (id,org_id,name,role,status,agent_runtime_type)
         VALUES ($1::uuid,$2::uuid,'Budget Goal Agent','general','idle','claude_local'),
                ($3::uuid,$4::uuid,'Foreign Budget Agent','general','idle','claude_local')",
    )
    .bind(BUDGET_AGENT)
    .bind(ORG)
    .bind(FOREIGN_AGENT)
    .bind(OTHER)
    .execute(&database.pool)
    .await
    .expect("seed budget scope Agents");
    sqlx::query(
        "UPDATE goals SET owner_agent_id=$2::uuid,lifecycle='active',status='active',
           plan_revision=1 WHERE org_id=$1::uuid AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(BUDGET_AGENT)
    .bind(GOAL)
    .execute(&database.pool)
    .await
    .expect("assign the billed Goal to its Agent");
    let goal_wakeup: String = sqlx::query_scalar(
        "INSERT INTO agent_wakeup_requests(org_id,agent_id,source,trigger_detail,reason,payload,execution_authority)
         VALUES($1::uuid,$2::uuid,'on_demand','system','goal_started',$3::jsonb,'native_rust')
         RETURNING id::text",
    )
    .bind(ORG)
    .bind(BUDGET_AGENT)
    .bind(json!({
        "event":"goal_started",
        "goalId":GOAL,
        "taskKey":format!("goal:{GOAL}:goal_started:budget-stop"),
        "goalStartRequestId":"budget-stop",
        "_paperclipWakeContext":{
            "goalId":GOAL,
            "goal":{"id":GOAL,"title":"Budget stop"},
            "plan":{"revision":1},
            "continuation":{"summary":"Continue the Goal"}
        }
    }).to_string())
    .fetch_one(&database.pool)
    .await
    .expect("persist Goal Start wakeup");
    let goal_claim = goal_runs::claim_wakeup(&database.pool, ORG, &goal_wakeup)
        .await
        .expect("claim the native Goal run")
        .expect("Goal run launch permit");
    let usage = json!({
        "rawInputTokens":100,
        "rawCachedInputTokens":0,
        "rawOutputTokens":50,
        "billingType":"metered_api",
        "costUsd":0.25,
        "provider":"anthropic",
        "biller":"anthropic",
        "model":"claude-test"
    });
    let result = json!({"provider":"anthropic","biller":"anthropic","model":"claude-test"});
    goal_runs::finalize_unlaunched(
        &database.pool,
        &goal_claim,
        "succeeded",
        None,
        &usage,
        &result,
    )
    .await
    .expect("persist costed Goal terminal receipt");

    let legacy_running = uuid::Uuid::new_v4().to_string();
    let legacy_queued = uuid::Uuid::new_v4().to_string();
    let foreign_running = uuid::Uuid::new_v4().to_string();
    let pending_legacy_wakeup: String = sqlx::query_scalar(
        "INSERT INTO agent_wakeup_requests(org_id,agent_id,source,reason,execution_authority)
         VALUES($1::uuid,$2::uuid,'on_demand','manual','legacy_ts') RETURNING id::text",
    )
    .bind(ORG)
    .bind(BUDGET_AGENT)
    .fetch_one(&database.pool)
    .await
    .expect("seed pending legacy wakeup");
    sqlx::query(
        "INSERT INTO heartbeat_runs(id,org_id,agent_id,invocation_source,status,started_at,
           execution_owner_token,execution_lease_expires_at)
         VALUES($1::uuid,$2::uuid,$3::uuid,'on_demand','running',clock_timestamp(),
           'legacy-budget-owner',clock_timestamp()+interval '5 minutes'),
               ($4::uuid,$2::uuid,$3::uuid,'on_demand','queued',NULL,NULL,NULL),
               ($5::uuid,$6::uuid,$7::uuid,'on_demand','running',clock_timestamp(),
           'foreign-budget-owner',clock_timestamp()+interval '5 minutes')",
    )
    .bind(&legacy_running)
    .bind(ORG)
    .bind(BUDGET_AGENT)
    .bind(&legacy_queued)
    .bind(&foreign_running)
    .bind(OTHER)
    .bind(FOREIGN_AGENT)
    .execute(&database.pool)
    .await
    .expect("seed legacy owners inside and outside the budget scope");
    sqlx::query(
        "INSERT INTO budget_policies(org_id,scope_type,scope_id,metric,window_kind,amount,
           warn_percent,hard_stop_enabled,notify_enabled,is_active)
         VALUES($1::uuid,'organization',$1::uuid,'billed_cents','calendar_month_utc',10,80,true,true,true)",
    )
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("seed organization hard-stop policy");

    assert!(
        goal_costs::settle_terminal_effects(&database.pool, ORG, &goal_claim.run_id)
            .await
            .expect("settle cost and dispatch the budget decision")
    );

    type ChatStopState = (
        String,
        Option<String>,
        Option<String>,
        bool,
        String,
        String,
        bool,
        Option<String>,
    );
    let chat_state: ChatStopState = sqlx::query_as(
        "SELECT r.status,r.execution_owner_token,r.finished_at::text,r.native_admission_hold,
                    g.status,g.control_state,g.native_admission_hold,g.runtime_terminal_at::text
             FROM heartbeat_runs r JOIN chat_generations g
               ON g.org_id=r.org_id AND g.id=r.chat_generation_id
             WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&chat_run)
    .fetch_one(&database.pool)
    .await
    .expect("read Native Chat run and stop state");
    assert_eq!(chat_state.0, "running");
    assert!(chat_state.1.is_some());
    assert!(chat_state.2.is_none());
    assert!(chat_state.3);
    assert_eq!(chat_state.4, "stop_requested");
    assert_eq!(chat_state.5, "stopping");
    assert!(chat_state.6);
    assert!(chat_state.7.is_none());
    let stop_actions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_control_actions WHERE expected_generation_id=(
           SELECT chat_generation_id FROM heartbeat_runs WHERE id=$1::uuid)",
    )
    .bind(&chat_run)
    .fetch_one(&database.pool)
    .await
    .expect("count durable Native Chat stop action");
    assert_eq!(stop_actions, 1);

    let legacy_state: (String, Option<String>, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT status,error_code,error,execution_owner_token FROM heartbeat_runs
         WHERE id=$1::uuid",
    )
    .bind(&legacy_running)
    .fetch_one(&database.pool)
    .await
    .expect("read scoped running legacy intent");
    assert_eq!(legacy_state.0, "running");
    assert_eq!(legacy_state.1.as_deref(), Some("cancel_requested"));
    assert_eq!(
        legacy_state.2.as_deref(),
        Some("Cancelled due to budget pause")
    );
    assert_eq!(legacy_state.3.as_deref(), Some("legacy-budget-owner"));
    let queued_state: (String, Option<String>) =
        sqlx::query_as("SELECT status,error_code FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(&legacy_queued)
            .fetch_one(&database.pool)
            .await
            .expect("read scoped queued legacy intent");
    assert_eq!(
        queued_state,
        ("queued".into(), Some("cancel_requested".into()))
    );
    let wakeup_status: String = sqlx::query_scalar(
        "SELECT status FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(pending_legacy_wakeup)
    .fetch_one(&database.pool)
    .await
    .expect("read cancelled pending legacy wakeup");
    assert_eq!(wakeup_status, "cancelled");
    let foreign_error: Option<String> = sqlx::query_scalar(
        "SELECT error_code FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(OTHER)
    .bind(foreign_running)
    .fetch_one(&database.pool)
    .await
    .expect("read out-of-scope legacy run");
    assert_eq!(foreign_error, None);
}

#[path = "native_chat_execution/checkpoints.rs"]
mod checkpoints;
#[path = "native_chat_execution/deletions.rs"]
mod deletions;
#[path = "native_chat_execution/diagnostic.rs"]
mod diagnostic;
#[path = "native_chat_execution/fencing.rs"]
mod fencing;
#[path = "native_chat_execution/ownership.rs"]
mod ownership;

#[path = "native_chat_execution/continuity.rs"]
mod continuity;
#[path = "native_chat_execution/segment.rs"]
mod segment;
#[path = "native_chat_execution/submission.rs"]
mod submission;

#[path = "native_chat_execution/effects.rs"]
mod effects;

#[path = "native_chat_execution/effects_content.rs"]
mod effects_content;

#[path = "native_chat_execution/control.rs"]
mod control;

#[path = "native_chat_execution/browser_principal.rs"]
mod browser_principal;
