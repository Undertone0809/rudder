#[allow(dead_code)]
mod support;

use rudder_auth_core::{
    ActorEnvelope, ActorIdentity, NonceReplayGuard, RequestContext, VerifiedActor,
};
use rudder_d1_persistence::native_chat::config::LocalHostContext;
use rudder_d1_persistence::native_chat::{Error, Request, execute as execute_native};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{fs, path::PathBuf, sync::OnceLock};
use support::{CEO, Database, ORG};
use tempfile::TempDir;

const USER: &str = "native-chat-owner";
const CHAT: &str = "21000000-0000-4000-8000-000000000101";
const CHAT_ROLLBACK: &str = "21000000-0000-4000-8000-000000000102";
const CHAT_OPAQUE: &str = "21000000-0000-4000-8000-000000000103";
const CHAT_DENIED: &str = "21000000-0000-4000-8000-000000000104";
const CHAT_BUDGET: &str = "21000000-0000-4000-8000-000000000105";
const CHAT_FOREIGN: &str = "21000000-0000-4000-8000-000000000106";
const CHAT_BUDGET_START: &str = "21000000-0000-4000-8000-000000000107";
const CHAT_BUDGET_UNKNOWN: &str = "21000000-0000-4000-8000-000000000108";
const CHAT_BUDGET_MONTH_START: &str = "21000000-0000-4000-8000-000000000109";
const CHAT_BUDGET_MONTH_EDGES: &str = "21000000-0000-4000-8000-000000000110";
const CHAT_UNSUPPORTED: &str = "21000000-0000-4000-8000-000000000111";
const CHAT_LEGACY_CONTINUITY: &str = "21000000-0000-4000-8000-000000000112";
const CHAT_HANDOFF_CONTINUITY: &str = "21000000-0000-4000-8000-000000000113";
const WRONG_AGENT: &str = "50000000-0000-4000-8000-000000000002";
const LEGACY_GENERATION: &str = "24000000-0000-4000-8000-000000000011";
const LEGACY_RUN: &str = "25000000-0000-4000-8000-000000000011";
const LEGACY_ATTEMPT: &str = "26000000-0000-4000-8000-000000000011";
const LEGACY_USER_MESSAGE: &str = "27000000-0000-4000-8000-000000000011";
const LEGACY_ASSISTANT_MESSAGE: &str = "27000000-0000-4000-8000-000000000012";
const SECRET: &[u8] = b"native-chat-admission-test-key";

struct AdmissionHost {
    _root: TempDir,
    context: LocalHostContext,
    executable: PathBuf,
    cwd: PathBuf,
}

impl AdmissionHost {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("create isolated admission host tree");
        let instance = root.path().join("instance");
        let workspace_home = root.path().join("workspaces");
        let previous_documents = root.path().join("previous-documents");
        let profiles = root.path().join("managed-profiles");
        let operator_home = root.path().join("operator-home");
        let executable = root.path().join("bin/codex");
        let cwd = root.path().join("agent-cwd");
        let profile_home = profiles.join(ORG).join(CEO).join("default");
        let other_profile_home = profiles.join(ORG).join(WRONG_AGENT).join("default");
        for directory in [
            &instance,
            &workspace_home,
            &previous_documents,
            &profiles,
            &operator_home,
            executable.parent().expect("binary directory"),
            &cwd,
            &profile_home,
            &other_profile_home,
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
        // Windows admission/ledger tests use the supported absent-bundle path.
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
            fs::write(
                instructions.join("SOUL.md"),
                "isolated admission instructions\n",
            )
            .expect("seed read-only instruction fixture");
        }
        let executable = executable
            .canonicalize()
            .expect("canonical fake executable");
        let cwd = cwd.canonicalize().expect("canonical Agent cwd");
        let context = LocalHostContext::from_rust_host(
            "admission-test-host".into(),
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

fn admission_host() -> &'static AdmissionHost {
    static HOST: OnceLock<AdmissionHost> = OnceLock::new();
    HOST.get_or_init(AdmissionHost::new)
}

async fn execute(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &Request,
) -> Result<Value, Error> {
    execute_native(
        pool,
        actor,
        organization_id,
        request,
        &admission_host().context,
    )
    .await
}

fn verified_actor(id: &str, nonce: &str) -> VerifiedActor {
    verified_actor_kind("user", id, nonce)
}

fn verified_actor_kind(kind: &str, id: &str, nonce: &str) -> VerifiedActor {
    let actor = ActorIdentity::new(kind, id).expect("valid actor identity");
    let path = format!("/internal/orgs/{ORG}/chat/native-admission");
    let body = b"{}";
    let request_id = format!("request-{nonce}");
    let envelope = ActorEnvelope::new(
        actor.clone(),
        ORG,
        "session-native-chat",
        3,
        "rudder-server-foundation",
        "POST",
        &path,
        "chat.native_turn.submit",
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
        ORG,
        "session-native-chat",
        3,
        "rudder-server-foundation",
        "POST",
        &path,
        "chat.native_turn.submit",
        body,
        &request_id,
        1_050,
    );
    envelope
        .verify_to_actor(SECRET, &request, &mut NonceReplayGuard::new())
        .expect("verified actor")
}

fn request(conversation_id: &str, mutation_id: &str, body: &str) -> Request {
    serde_json::from_value(json!({
        "operation": "submit_native_chat_turn",
        "conversationId": conversation_id,
        "clientMutationId": mutation_id,
        "body": body,
    }))
    .expect("valid native chat request")
}

async fn seed_membership(pool: &PgPool, user: &str) {
    sqlx::query(
        "INSERT INTO organization_memberships(org_id, principal_type, principal_id, membership_role, status)
         VALUES ($1::uuid, 'user', $2, 'member', 'active')",
    )
    .bind(ORG)
    .bind(user)
    .execute(pool)
    .await
    .expect("seed membership");
}

async fn seed_chat(pool: &PgPool, id: &str) {
    seed_chat_in_org(pool, id, ORG, Some(CEO)).await;
}

async fn seed_chat_in_org(pool: &PgPool, id: &str, organization_id: &str, agent_id: Option<&str>) {
    sqlx::query(
        "INSERT INTO chat_conversations
           (id, org_id, title, conversation_kind, created_by_user_id, status, preferred_agent_id)
         VALUES ($1::uuid, $2::uuid, 'Native admission fixture', 'chat', $3, 'active', $4::uuid)",
    )
    .bind(id)
    .bind(organization_id)
    .bind(USER)
    .bind(agent_id)
    .execute(pool)
    .await
    .expect("seed chat");
}

async fn prepare(database: &Database) {
    seed_membership(&database.pool, USER).await;
    sqlx::query("UPDATE agents SET agent_runtime_type='codex_local', status='idle', workspace_key='codex-agent', agent_runtime_config=$1::jsonb WHERE org_id=$2::uuid AND id=$3::uuid")
        .bind(admission_host().persisted_agent_config().to_string())
        .bind(ORG)
        .bind(CEO)
        .execute(&database.pool)
        .await
        .expect("select Codex local runtime");
    sqlx::query(
        "INSERT INTO agents (id, org_id, name, role, status, agent_runtime_type)
         VALUES ($1::uuid, $2::uuid, 'Other member agent', 'general', 'idle', 'codex_local')",
    )
    .bind(WRONG_AGENT)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("seed distinct organization Agent");
    sqlx::query("UPDATE agents SET agent_runtime_type='codex_local', status='idle', workspace_key='codex-other', agent_runtime_config=$1::jsonb WHERE org_id=$2::uuid AND id=$3::uuid")
        .bind(admission_host().persisted_agent_config().to_string())
        .bind(ORG)
        .bind(WRONG_AGENT)
        .execute(&database.pool)
        .await
        .expect("configure distinct Agent for budget preflight fixture");
    for id in [
        CHAT,
        CHAT_ROLLBACK,
        CHAT_OPAQUE,
        CHAT_DENIED,
        CHAT_BUDGET,
        CHAT_BUDGET_START,
        CHAT_BUDGET_UNKNOWN,
        CHAT_BUDGET_MONTH_START,
        CHAT_BUDGET_MONTH_EDGES,
        CHAT_UNSUPPORTED,
        CHAT_LEGACY_CONTINUITY,
        CHAT_HANDOFF_CONTINUITY,
    ] {
        seed_chat(&database.pool, id).await;
    }
    seed_chat_in_org(&database.pool, CHAT_FOREIGN, support::OTHER, None).await;
}

async fn row_counts(pool: &PgPool, conversation_id: &str) -> (i64, i64, i64, i64, i64) {
    sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid),
           (SELECT count(*) FROM chat_generations WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND execution_authority='native_rust'),
           (SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid AND chat_conversation_id=$2::uuid AND execution_authority='native_rust'),
           (SELECT count(*) FROM heartbeat_run_attempts a JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id WHERE r.org_id=$1::uuid AND r.chat_conversation_id=$2::uuid AND r.execution_authority='native_rust'),
           (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_type='chat' AND entity_id=$2::text AND action='chat.message_added')",
    )
    .bind(ORG)
    .bind(conversation_id)
    .fetch_one(pool)
    .await
    .expect("count admission effects")
}

async fn assert_native_attempt_update_rejected(
    pool: &PgPool,
    attempt_id: &str,
    sql: &str,
    label: &str,
) {
    let mut tx = pool.begin().await.expect("begin invalid checkpoint test");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:admission', true)")
        .execute(&mut *tx)
        .await
        .expect("mark authorized transaction");
    let result = sqlx::query(sql)
        .bind(attempt_id)
        .bind(ORG)
        .execute(&mut *tx)
        .await;
    assert!(
        result.is_err(),
        "invalid native checkpoint must fail: {label}"
    );
    tx.rollback()
        .await
        .expect("rollback invalid checkpoint mutation");
}

#[tokio::test(flavor = "multi_thread")]
async fn admission_is_atomic_idempotent_held_and_preserves_binding_identity() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "native-admit");
    let first_request = request(CHAT, "mutation-1", "first private prompt sentinel");

    let receipt = execute(&database.pool, &actor, ORG, &first_request)
        .await
        .expect("native turn admitted");
    assert_eq!(receipt["executionAuthority"], "native_rust");
    assert_eq!(receipt["nativeAdmissionHold"], false);
    assert_eq!(receipt["idempotentReplay"], false);
    assert_eq!(row_counts(&database.pool, CHAT).await, (1, 1, 1, 1, 1));
    let fresh_phase: (Value, Option<String>) = sqlx::query_as(
        "SELECT checkpoint_json, protocol_phase FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(receipt["attemptId"].as_str().unwrap())
    .fetch_one(&database.pool)
    .await
    .expect("read fresh protocol checkpoint");
    assert_eq!(fresh_phase.0["phase"], "no_thread_request");
    assert_eq!(fresh_phase.1.as_deref(), Some("no_thread_request"));
    let (run_snapshot, session_intent, session_scope, session_before): (
        Value,
        Value,
        String,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT context_snapshot, session_intent_json, session_reuse_scope, session_id_before
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(receipt["runId"].as_str().unwrap())
    .fetch_one(&database.pool)
    .await
    .expect("read admitted Run binding and SessionIntent");
    let binding_id = run_snapshot["runtimeBindingId"]
        .as_str()
        .expect("binding id");
    let segment_id = run_snapshot["nativeSegmentId"]
        .as_str()
        .expect("segment id");
    let binding_state: (String, Option<String>, String, Option<String>) = sqlx::query_as(
        "SELECT b.status, b.current_segment_id::text, s.state, s.native_session_id
         FROM runtime_bindings b JOIN native_segments s
           ON s.org_id=b.org_id AND s.binding_id=b.id
         WHERE b.org_id=$1::uuid AND b.id=$2::uuid AND s.id=$3::uuid",
    )
    .bind(ORG)
    .bind(binding_id)
    .bind(segment_id)
    .fetch_one(&database.pool)
    .await
    .expect("read atomically created Native Chat binding");
    assert_eq!(
        binding_state,
        (
            "active".into(),
            Some(segment_id.into()),
            "pending".into(),
            None
        )
    );
    assert_eq!(session_intent["kind"], "fresh");
    assert_eq!(session_intent["reuseScope"], "none");
    assert_eq!(session_scope, "none");
    assert!(session_before.is_none());
    for (label, sql) in [
        (
            "native epochs with null phase",
            "UPDATE heartbeat_run_attempts SET protocol_phase=NULL WHERE id=$1::uuid AND org_id=$2::uuid",
        ),
        (
            "native epochs with null checkpoint",
            "UPDATE heartbeat_run_attempts SET checkpoint_json=NULL WHERE id=$1::uuid AND org_id=$2::uuid",
        ),
        (
            "native checkpoint object with missing phase",
            "UPDATE heartbeat_run_attempts SET checkpoint_json='{}'::jsonb WHERE id=$1::uuid AND org_id=$2::uuid",
        ),
        (
            "only one native epoch present",
            "UPDATE heartbeat_run_attempts SET generation_attempt_epoch=NULL WHERE id=$1::uuid AND org_id=$2::uuid",
        ),
        (
            "checkpoint phase differs from indexed protocol phase",
            "UPDATE heartbeat_run_attempts SET protocol_phase='thread_known' WHERE id=$1::uuid AND org_id=$2::uuid",
        ),
    ] {
        assert_native_attempt_update_rejected(
            &database.pool,
            receipt["attemptId"].as_str().unwrap(),
            sql,
            label,
        )
        .await;
    }

    let activity: (String, String, Option<String>, Value) = sqlx::query_as(
        "SELECT actor_type, actor_id, run_id::text, details
         FROM activity_log
         WHERE org_id=$1::uuid AND action='chat.message_added' AND entity_id=$2",
    )
    .bind(ORG)
    .bind(CHAT)
    .fetch_one(&database.pool)
    .await
    .expect("read actor-scoped activity");
    assert_eq!(activity.0, "user");
    assert_eq!(activity.1, USER);
    assert_eq!(activity.2.as_deref(), receipt["runId"].as_str());
    assert_eq!(activity.3["messageId"], receipt["userMessageId"]);
    assert!(
        !activity
            .3
            .to_string()
            .contains("first private prompt sentinel")
    );

    // A byte-identical retry bypasses new configuration resolution and
    // returns the original durable receipt even if config changed afterward.
    sqlx::query(
        "UPDATE agents SET agent_runtime_config=$1::jsonb WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(json!({"mcpServers":{"unsupported":{"command":"tool"}}}).to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("change Agent config after admission");
    let replay = execute(&database.pool, &actor, ORG, &first_request)
        .await
        .expect("exact retry returns original receipt");
    for key in ["userMessageId", "generationId", "runId", "attemptId"] {
        assert_eq!(receipt[key], replay[key]);
    }
    assert_eq!(replay["idempotentReplay"], true);
    assert_eq!(row_counts(&database.pool, CHAT).await, (1, 1, 1, 1, 1));
    sqlx::query(
        "UPDATE agents SET agent_runtime_config=$1::jsonb WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(admission_host().persisted_agent_config().to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("restore supported Agent config for later test paths");

    // Reusing the mutation key for changed content fails without side effects.
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(CHAT, "mutation-1", "changed content"),
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(row_counts(&database.pool, CHAT).await, (1, 1, 1, 1, 1));

    // The DB trigger rejects legacy or unmarked writes to a Rust-owned row.
    let unmarked = sqlx::query(
        "UPDATE chat_generations SET native_admission_hold=true
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(receipt["generationId"].as_str().unwrap())
    .execute(&database.pool)
    .await;
    assert!(unmarked.is_err(), "unmarked Native Chat mutation must fail");

    // Composite identity constraints reject a same-org conversation rotation
    // even when the caller carries the Rust transaction marker.
    let mut mismatched_conversation = database
        .pool
        .begin()
        .await
        .expect("begin identity constraint check");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:admission', true)")
        .execute(&mut *mismatched_conversation)
        .await
        .expect("mark authorized transaction");
    sqlx::query("UPDATE chat_generations SET conversation_id=$1::uuid WHERE org_id=$2::uuid AND id=$3::uuid")
        .bind(CHAT_ROLLBACK)
        .bind(ORG)
        .bind(receipt["generationId"].as_str().unwrap())
        .execute(&mut *mismatched_conversation)
        .await
        .expect("stage generation conversation rotation");
    sqlx::query("UPDATE heartbeat_runs SET chat_conversation_id=$1::uuid, target_id=$1 WHERE org_id=$2::uuid AND id=$3::uuid")
        .bind(CHAT_ROLLBACK)
        .bind(ORG)
        .bind(receipt["runId"].as_str().unwrap())
        .execute(&mut *mismatched_conversation)
        .await
        .expect("stage matching Run conversation rotation");
    assert!(
        mismatched_conversation.commit().await.is_err(),
        "source-message composite FK must reject conversation rotation"
    );
    assert_eq!(row_counts(&database.pool, CHAT).await, (1, 1, 1, 1, 1));

    // A marked Rust transaction can install the durable hold on both rows.
    let mut tx = database.pool.begin().await.expect("begin Rust update");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:admission', true)")
        .execute(&mut *tx)
        .await
        .expect("set transaction-local Rust marker");
    sqlx::query("UPDATE chat_generations SET native_admission_hold=true WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG)
        .bind(receipt["generationId"].as_str().unwrap())
        .execute(&mut *tx)
        .await
        .expect("hold generation");
    sqlx::query("UPDATE heartbeat_runs SET native_admission_hold=true WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG)
        .bind(receipt["runId"].as_str().unwrap())
        .execute(&mut *tx)
        .await
        .expect("hold run");
    tx.commit().await.expect("commit hold");

    // Exact retry is still safe while held and reports the held state; new
    // content receives a conflict before creating another message/activity.
    let held_replay = execute(&database.pool, &actor, ORG, &first_request)
        .await
        .expect("same-key held retry is safe");
    assert_eq!(held_replay["nativeAdmissionHold"], true);
    assert_eq!(held_replay["idempotentReplay"], true);
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(CHAT, "mutation-2", "must wait for reconciliation"),
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(row_counts(&database.pool, CHAT).await, (1, 1, 1, 1, 1));

    // A failure in the activity write rolls back the source message and all
    // Rust authority rows; activity is part of the admission transaction.
    database
        .sql(
            "CREATE FUNCTION fail_native_chat_activity() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF NEW.action='chat.message_added' THEN RAISE EXCEPTION 'synthetic activity failure'; END IF;
               RETURN NEW;
             END; $$;
             CREATE TRIGGER fail_native_chat_activity_trigger
               BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_native_chat_activity();",
        )
        .await;
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(CHAT_ROLLBACK, "rollback-1", "transaction must roll back"),
        )
        .await,
        Err(Error::Database(_))
    ));
    database
        .sql(
            "DROP TRIGGER fail_native_chat_activity_trigger ON activity_log;
             DROP FUNCTION fail_native_chat_activity();",
        )
        .await;
    assert_eq!(
        row_counts(&database.pool, CHAT_ROLLBACK).await,
        (0, 0, 0, 0, 0)
    );
    let rollback_bindings: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM runtime_bindings WHERE org_id=$1::uuid AND target_id=$2),
                (SELECT count(*) FROM native_segments s JOIN runtime_bindings b
                   ON b.org_id=s.org_id AND b.id=s.binding_id
                 WHERE b.org_id=$1::uuid AND b.target_id=$2)",
    )
    .bind(ORG)
    .bind(CHAT_ROLLBACK)
    .fetch_one(&database.pool)
    .await
    .expect("count rolled-back binding effects");
    assert_eq!(rollback_bindings, (0, 0));

    // An active Binding with a pending Segment but a different resolved
    // identity conflicts without rotating the binding or adding a message.
    let conflict_binding_id = "22000000-0000-4000-8000-000000000103";
    let segment_id = "23000000-0000-4000-8000-000000000103";
    sqlx::query(
        "INSERT INTO runtime_bindings
           (id, org_id, conversation_id, target_type, target_id,
            principal_scope_ref, agent_id, runtime_type, host_id, profile_id,
            instructions_revision, capability_revision, continuity, binding_epoch, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'chat_conversation', $3,
                 $4, $5::uuid, 'codex_local', 'local', 'default', 'test', 'test',
                 'native', 0, 'active')",
    )
    .bind(conflict_binding_id)
    .bind(ORG)
    .bind(CHAT_OPAQUE)
    .bind(format!("org:{ORG}"))
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed mismatched active binding identity");
    sqlx::query(
        "INSERT INTO native_segments
           (id, org_id, binding_id, runtime_type, segment_ordinal, native_session_id, state)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'codex_local', 0, NULL, 'pending')",
    )
    .bind(segment_id)
    .bind(ORG)
    .bind(conflict_binding_id)
    .execute(&database.pool)
    .await
    .expect("seed pending Segment");
    sqlx::query("UPDATE runtime_bindings SET current_segment_id=$1::uuid WHERE org_id=$2::uuid AND id=$3::uuid")
        .bind(segment_id)
        .bind(ORG)
        .bind(conflict_binding_id)
        .execute(&database.pool)
        .await
        .expect("select exact current Segment");

    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(CHAT_OPAQUE, "opaque-1", "must not rotate active identity"),
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(
        row_counts(&database.pool, CHAT_OPAQUE).await,
        (0, 0, 0, 0, 0)
    );
    let conflict_identity: (String, Option<String>, i32, String) = sqlx::query_as(
        "SELECT b.id::text, b.current_segment_id::text, b.binding_epoch, s.id::text
         FROM runtime_bindings b JOIN native_segments s
           ON s.org_id=b.org_id AND s.binding_id=b.id
         WHERE b.org_id=$1::uuid AND b.target_id=$2",
    )
    .bind(ORG)
    .bind(CHAT_OPAQUE)
    .fetch_one(&database.pool)
    .await
    .expect("read unchanged conflicting binding");
    assert_eq!(conflict_identity.0, conflict_binding_id);
    assert_eq!(conflict_identity.1.as_deref(), Some(segment_id));
    assert_eq!(conflict_identity.2, 0);
    assert_eq!(conflict_identity.3, segment_id);

    // Exact replay remains available with the active binding; new content is
    // blocked by the existing active Run until reconciliation.
    let replay_through_binding = execute(&database.pool, &actor, ORG, &first_request)
        .await
        .expect("exact retry remains available under Binding guard");
    assert_eq!(replay_through_binding["idempotentReplay"], true);
    assert_eq!(row_counts(&database.pool, CHAT).await, (1, 1, 1, 1, 1));
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(CHAT, "mutation-after-binding", "must remain blocked"),
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(row_counts(&database.pool, CHAT).await, (1, 1, 1, 1, 1));

    // One Generation has exactly one native Run. Repointing another admitted
    // Run to the same Generation fails its partial unique index.
    let mut duplicate_generation_run = database
        .pool
        .begin()
        .await
        .expect("begin unique Run constraint check");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:admission', true)")
        .execute(&mut *duplicate_generation_run)
        .await
        .expect("mark authorized transaction");
    let duplicate_run = sqlx::query(
        "INSERT INTO heartbeat_runs
           (org_id, agent_id, status, chat_conversation_id, chat_generation_id,
            execution_authority, native_admission_hold, scene, target_type, target_id,
            idempotency_key, session_reuse_scope, session_intent_json)
         VALUES ($1::uuid, $2::uuid, 'succeeded', $3::uuid, $4::uuid,
                 'native_rust', false, 'chat', 'chat_conversation', $3,
                 'native-chat:duplicate-generation-run', 'none',
                 '{\"kind\":\"fresh\",\"reuseScope\":\"none\",\"sourceRunId\":null,\"sessionId\":null,\"sessionParams\":null}'::jsonb)",
    )
        .bind(ORG)
        .bind(CEO)
        .bind(CHAT)
        .bind(receipt["generationId"].as_str().unwrap())
        .execute(&mut *duplicate_generation_run)
        .await;
    assert!(duplicate_run.is_err(), "a Generation must have one Run");
    drop(duplicate_generation_run);
    assert_eq!(row_counts(&database.pool, CHAT).await, (1, 1, 1, 1, 1));

    // Authorization is checked before admission effects. A valid actor token
    // alone cannot write into a conversation without organization membership.
    let outsider = verified_actor("not-a-member", "native-admit-denied");
    assert!(matches!(
        execute(
            &database.pool,
            &outsider,
            ORG,
            &request(CHAT_DENIED, "denied-1", "must not be stored"),
        )
        .await,
        Err(Error::Http(403, _))
    ));
    assert_eq!(
        row_counts(&database.pool, CHAT_DENIED).await,
        (0, 0, 0, 0, 0)
    );

    // A valid Agent identity in the same organization cannot act through a
    // conversation assigned to a different Agent.
    let wrong_agent = verified_actor_kind("agent", WRONG_AGENT, "native-admit-wrong-agent");
    assert!(matches!(
        execute(
            &database.pool,
            &wrong_agent,
            ORG,
            &request(CHAT_DENIED, "wrong-agent-1", "must not be stored"),
        )
        .await,
        Err(Error::Http(403, _))
    ));
    assert_eq!(
        row_counts(&database.pool, CHAT_DENIED).await,
        (0, 0, 0, 0, 0)
    );

    // A conversation that exists only under another organization is
    // indistinguishable from a missing target and causes no writes.
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(CHAT_FOREIGN, "foreign-target-1", "must not be stored"),
        )
        .await,
        Err(Error::Http(404, _))
    ));
    assert_eq!(
        row_counts(&database.pool, CHAT_FOREIGN).await,
        (0, 0, 0, 0, 0)
    );

    // Hard-stop preflight is read-only and prevents any admission writes.
    sqlx::query(
        "INSERT INTO budget_policies
           (org_id, scope_type, scope_id, metric, window_kind, amount, hard_stop_enabled, is_active)
         VALUES ($1::uuid, 'organization', $1::uuid, 'billed_cents', 'lifetime', 1, true, true)",
    )
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("seed organization hard stop");
    sqlx::query(
        "INSERT INTO cost_events (org_id, agent_id, provider, model, cost_cents, occurred_at)
         VALUES ($1::uuid, $2::uuid, 'test', 'test', 1, now())",
    )
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed cost at limit");
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(CHAT_BUDGET, "budget-1", "must not cross hard stop"),
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(
        row_counts(&database.pool, CHAT_BUDGET).await,
        (0, 0, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn unsupported_persisted_config_leaves_no_message_binding_or_audit() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "native-config-unsupported");
    sqlx::query(
        "UPDATE agents SET agent_runtime_config=$1::jsonb WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(json!({"mcpServers":{"unsupported":{"command":"tool"}}}).to_string())
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed unsupported persisted configuration");

    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(
                CHAT_UNSUPPORTED,
                "unsupported-config",
                "must not be admitted"
            ),
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(
        row_counts(&database.pool, CHAT_UNSUPPORTED).await,
        (0, 0, 0, 0, 0)
    );
    let binding_effects: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM runtime_bindings WHERE org_id=$1::uuid AND target_id=$2),
                (SELECT count(*) FROM native_segments s JOIN runtime_bindings b
                   ON b.org_id=s.org_id AND b.id=s.binding_id
                 WHERE b.org_id=$1::uuid AND b.target_id=$2),
                (SELECT count(*) FROM activity_log
                 WHERE org_id=$1::uuid AND entity_type='chat' AND entity_id=$2
                   AND action='runtime.binding.created')",
    )
    .bind(ORG)
    .bind(CHAT_UNSUPPORTED)
    .fetch_one(&database.pool)
    .await
    .expect("count unsupported-config transaction effects");
    assert_eq!(binding_effects, (0, 0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn lifetime_budget_counts_all_time_and_unknown_windows_fail_closed() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "budget-window-1");

    sqlx::query(
        "INSERT INTO budget_policies
           (org_id, scope_type, scope_id, metric, window_kind, amount, hard_stop_enabled, is_active)
         VALUES ($1::uuid, 'organization', $1::uuid, 'billed_cents', 'lifetime', 1, true, true)",
    )
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("seed lifetime hard stop");
    sqlx::query(
        "INSERT INTO cost_events (org_id, agent_id, provider, model, cost_cents, occurred_at)
         VALUES ($1::uuid, $2::uuid, 'test', 'test', 1, '1969-12-31 23:59:59.999999+00'),
                ($1::uuid, $2::uuid, 'test', 'test', 1, '9999-01-01 00:00:00+00')",
    )
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed pre-epoch and far-future costs");
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(
                CHAT_BUDGET,
                "budget-lifetime-all-time",
                "pre-epoch and future costs count"
            ),
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(
        row_counts(&database.pool, CHAT_BUDGET).await,
        (0, 0, 0, 0, 0)
    );

    // Malformed active hard-stop windows have no database constraint. Reject
    // them even when no costs exist rather than silently admitting work.
    sqlx::query("UPDATE budget_policies SET is_active=false WHERE org_id=$1::uuid AND window_kind='lifetime'")
        .bind(ORG)
        .execute(&database.pool)
        .await
        .expect("disable the independently verified lifetime policy");
    sqlx::query(
        "UPDATE chat_conversations SET preferred_agent_id=$1::uuid WHERE org_id=$2::uuid AND id=$3::uuid",
    )
    .bind(WRONG_AGENT)
    .bind(ORG)
    .bind(CHAT_BUDGET_UNKNOWN)
    .execute(&database.pool)
    .await
    .expect("select an Agent with no cost rows for unknown-window test");
    sqlx::query(
        "INSERT INTO budget_policies
           (org_id, scope_type, scope_id, metric, window_kind, amount, hard_stop_enabled, is_active)
         VALUES ($1::uuid, 'agent', $2::uuid, 'billed_cents', 'legacy_unknown', 1, true, true)",
    )
    .bind(ORG)
    .bind(WRONG_AGENT)
    .execute(&database.pool)
    .await
    .expect("seed legacy unknown hard-stop window");
    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(
                CHAT_BUDGET_UNKNOWN,
                "budget-unknown-window",
                "unknown window"
            ),
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(
        row_counts(&database.pool, CHAT_BUDGET_UNKNOWN).await,
        (0, 0, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn budget_preflight_checks_all_policies_after_nonblocking_policy() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "budget-all-policies-1");

    sqlx::query(
        "INSERT INTO budget_policies
           (org_id, scope_type, scope_id, metric, window_kind, amount, hard_stop_enabled, is_active)
         VALUES ($1::uuid, 'organization', $1::uuid, 'billed_cents', 'calendar_month_utc', 100, true, true),
                ($1::uuid, 'agent', $2::uuid, 'billed_cents', 'calendar_month_utc', 1, true, true)",
    )
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed non-blocking organization and exhausted agent policies");
    sqlx::query(
        "INSERT INTO cost_events (org_id, agent_id, provider, model, cost_cents, occurred_at)
         VALUES ($1::uuid, $2::uuid, 'test', 'test', 1, now())",
    )
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed current-month cost at the agent limit");

    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(
                CHAT_BUDGET_START,
                "budget-check-every-policy",
                "agent hard stop must apply"
            ),
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(
        row_counts(&database.pool, CHAT_BUDGET_START).await,
        (0, 0, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn calendar_month_budget_includes_exact_utc_month_start() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "budget-month-start-1");

    sqlx::query(
        "INSERT INTO budget_policies
           (org_id, scope_type, scope_id, metric, window_kind, amount, hard_stop_enabled, is_active)
         VALUES ($1::uuid, 'organization', $1::uuid, 'billed_cents', 'calendar_month_utc', 1, true, true)",
    )
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("seed exact-boundary organization hard stop");
    sqlx::query(
        "WITH bounds AS (
           SELECT date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS month_start
         )
         INSERT INTO cost_events (org_id, agent_id, provider, model, cost_cents, occurred_at)
         SELECT $1::uuid, $2::uuid, 'test', 'test', 1, month_start FROM bounds",
    )
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed cost exactly at UTC month start");

    assert!(matches!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(
                CHAT_BUDGET_MONTH_START,
                "budget-month-start",
                "the inclusive UTC lower boundary counts"
            ),
        )
        .await,
        Err(Error::Http(409, _))
    ));
    assert_eq!(
        row_counts(&database.pool, CHAT_BUDGET_MONTH_START).await,
        (0, 0, 0, 0, 0)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn calendar_month_budget_uses_post_lock_clock_and_excludes_adjacent_utc_months() {
    let database = Database::start().await;
    prepare(&database).await;
    let actor = verified_actor(USER, "budget-month-clock-1");

    // Model time spent after the conversation fence in the admission
    // transaction. `statement_timestamp()` must move beyond its stale
    // transaction-start value before the budget window clock is captured.
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin lock clock fixture");
    let transaction_started_at: String = sqlx::query_scalar("SELECT transaction_timestamp()::text")
        .fetch_one(&mut *tx)
        .await
        .expect("read transaction start");
    let _: String = sqlx::query_scalar(
        "SELECT id::text FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    )
    .bind(ORG)
    .bind(CHAT_BUDGET_MONTH_EDGES)
    .fetch_one(&mut *tx)
    .await
    .expect("lock conversation before waiting");
    sqlx::query("SELECT pg_sleep(0.025)")
        .execute(&mut *tx)
        .await
        .expect("simulate time after the conversation lock");
    let captured_statement_time: String = sqlx::query_scalar("SELECT statement_timestamp()::text")
        .fetch_one(&mut *tx)
        .await
        .expect("capture post-lock statement time");
    let statement_time_is_fresh: bool =
        sqlx::query_scalar("SELECT $1::timestamptz < $2::timestamptz")
            .bind(&transaction_started_at)
            .bind(&captured_statement_time)
            .fetch_one(&mut *tx)
            .await
            .expect("compare captured clock with transaction start");
    assert!(statement_time_is_fresh);
    tx.rollback().await.expect("release lock clock fixture");

    sqlx::query(
        "INSERT INTO budget_policies
           (org_id, scope_type, scope_id, metric, window_kind, amount, hard_stop_enabled, is_active)
         VALUES ($1::uuid, 'organization', $1::uuid, 'billed_cents', 'calendar_month_utc', 1, true, true)",
    )
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("seed adjacent-boundary organization hard stop");
    sqlx::query(
        "WITH bounds AS (
           SELECT date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS month_start
         ), edges AS (
           SELECT month_start, (month_start + interval '1 month') AS next_month_start FROM bounds
         )
         INSERT INTO cost_events (org_id, agent_id, provider, model, cost_cents, occurred_at)
         SELECT $1::uuid, $2::uuid, 'test', 'test', 1, month_start - interval '1 microsecond' FROM edges
         UNION ALL
         SELECT $1::uuid, $2::uuid, 'test', 'test', 1, next_month_start FROM edges",
    )
    .bind(ORG)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed costs immediately outside UTC month bounds");

    assert!(
        execute(
            &database.pool,
            &actor,
            ORG,
            &request(
                CHAT_BUDGET_MONTH_EDGES,
                "budget-month-adjacent-edges",
                "adjacent UTC month costs are outside the half-open window"
            ),
        )
        .await
        .is_ok()
    );
    assert_eq!(
        row_counts(&database.pool, CHAT_BUDGET_MONTH_EDGES).await,
        (1, 1, 1, 1, 1)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn migration_refuses_legacy_cross_org_generation_and_rolls_back() {
    let database = Database::start_before_migration("0179_native_chat_rust_admission").await;
    seed_chat(&database.pool, CHAT).await;
    sqlx::query(
        "INSERT INTO chat_generations (id, org_id, conversation_id, status)
         VALUES ('24000000-0000-4000-8000-000000000001'::uuid, $1::uuid, $2::uuid, 'active')",
    )
    .bind(support::OTHER)
    .bind(CHAT)
    .execute(&database.pool)
    .await
    .expect("legacy independent FKs permit a mismatched org/conversation pair");

    let error = database
        .apply_migration("0179_native_chat_rust_admission")
        .await
        .expect_err("migration must report existing cross-org corruption");
    assert!(
        error
            .to_string()
            .contains("pair an organization with a conversation from another organization")
    );

    let (generation_count, execution_authority_column): (i64, bool) = sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM chat_generations WHERE id='24000000-0000-4000-8000-000000000001'::uuid),
           EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='chat_generations' AND column_name='execution_authority')",
    )
    .fetch_one(&database.pool)
    .await
    .expect("read state after refused migration");
    assert_eq!(generation_count, 1, "legacy row must remain untouched");
    assert!(
        !execution_authority_column,
        "migration DDL must roll back atomically"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn migration_preserves_populated_legacy_chat_without_native_linkage() {
    let database = Database::start_before_migration("0179_native_chat_rust_admission").await;
    seed_chat(&database.pool, CHAT).await;
    sqlx::query(
        "INSERT INTO chat_messages (id, org_id, conversation_id, role, body)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'user', 'legacy prompt preserved'),
                ($4::uuid, $2::uuid, $3::uuid, 'assistant', 'legacy answer preserved')",
    )
    .bind(LEGACY_USER_MESSAGE)
    .bind(ORG)
    .bind(CHAT)
    .bind(LEGACY_ASSISTANT_MESSAGE)
    .execute(&database.pool)
    .await
    .expect("seed legacy message content");
    sqlx::query(
        "INSERT INTO chat_generations (id, org_id, conversation_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'completed')",
    )
    .bind(LEGACY_GENERATION)
    .bind(ORG)
    .bind(CHAT)
    .execute(&database.pool)
    .await
    .expect("seed legacy Generation");
    sqlx::query(
        "INSERT INTO heartbeat_runs (id, org_id, agent_id, status, chat_conversation_id, context_snapshot)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'succeeded', $4::uuid, '{\"legacyMarker\":\"preserved\"}'::jsonb)",
    )
    .bind(LEGACY_RUN)
    .bind(ORG)
    .bind(CEO)
    .bind(CHAT)
    .execute(&database.pool)
    .await
    .expect("seed legacy Run");
    sqlx::query("UPDATE chat_messages SET run_id=$1::uuid WHERE id=$2::uuid")
        .bind(LEGACY_RUN)
        .bind(LEGACY_ASSISTANT_MESSAGE)
        .execute(&database.pool)
        .await
        .expect("preserve legacy reply-to-Run relation");
    sqlx::query(
        "INSERT INTO heartbeat_run_attempts (id, org_id, run_id, agent_id, attempt_index, runtime_type, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'codex_local', 'succeeded')",
    )
    .bind(LEGACY_ATTEMPT)
    .bind(ORG)
    .bind(LEGACY_RUN)
    .bind(CEO)
    .execute(&database.pool)
    .await
    .expect("seed legacy Attempt");

    database
        .apply_migration("0179_native_chat_rust_admission")
        .await
        .expect("migration accepts valid populated legacy data");

    let generation: (String, Option<String>, Option<i32>, bool) = sqlx::query_as(
        "SELECT execution_authority, source_message_id::text, source_turn_variant, native_admission_hold
         FROM chat_generations WHERE org_id=$1::uuid AND id=$2::uuid AND conversation_id=$3::uuid",
    )
    .bind(ORG)
    .bind(LEGACY_GENERATION)
    .bind(CHAT)
    .fetch_one(&database.pool)
    .await
    .expect("read preserved Generation");
    assert_eq!(generation, ("legacy_ts".to_owned(), None, None, false));

    let run: (String, Option<String>, bool, Value) = sqlx::query_as(
        "SELECT execution_authority, chat_generation_id::text, native_admission_hold, context_snapshot
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid AND chat_conversation_id=$3::uuid",
    )
    .bind(ORG)
    .bind(LEGACY_RUN)
    .bind(CHAT)
    .fetch_one(&database.pool)
    .await
    .expect("read preserved legacy Run");
    assert_eq!(run.0, "legacy_ts");
    assert_eq!(run.1, None, "migration must not infer a Generation link");
    assert!(!run.2);
    assert_eq!(run.3["legacyMarker"], "preserved");

    let attempt: (Option<i32>, Option<i32>, Option<String>, Option<Value>) = sqlx::query_as(
        "SELECT generation_attempt_epoch, connection_epoch, protocol_phase, checkpoint_json
         FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND id=$2::uuid AND run_id=$3::uuid",
    )
    .bind(ORG)
    .bind(LEGACY_ATTEMPT)
    .bind(LEGACY_RUN)
    .fetch_one(&database.pool)
    .await
    .expect("read preserved legacy Attempt");
    assert_eq!(attempt, (None, None, None, None));

    let messages: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT body, run_id::text FROM chat_messages
         WHERE org_id=$1::uuid AND conversation_id=$2::uuid ORDER BY role",
    )
    .bind(ORG)
    .bind(CHAT)
    .fetch_all(&database.pool)
    .await
    .expect("read preserved legacy chat content");
    assert!(
        messages
            .iter()
            .any(|row| row.0 == "legacy prompt preserved" && row.1.is_none())
    );
    assert!(
        messages
            .iter()
            .any(|row| row.0 == "legacy answer preserved" && row.1.as_deref() == Some(LEGACY_RUN))
    );
}

#[path = "native_chat/continuity.rs"]
mod continuity;
