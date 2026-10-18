mod support;

use rudder_auth_core::{
    ActorEnvelope, ActorIdentity, NonceReplayGuard, RequestContext, VerifiedActor,
};
use rudder_d1_persistence::agent_core::{
    AgentCoreError, AgentCoreRequest, NativeAgentAccess, NativeAgentAuthorizer,
    execute_agent_with_native_auth,
};
use serde_json::json;
use sqlx::PgConnection;
#[cfg(unix)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{future::Future, path::Path, pin::Pin, sync::OnceLock};
use support::{Database, ORG};
use tokio::sync::Mutex;

const SECRET: &[u8] = b"native-agent-core-roster-revalidation-test-key";
const BOARD_USER: &str = "roster-board-user";
const CREATE_USER: &str = "create-board-user";
const SECRET_ID: &str = "20000000-0000-4000-8000-000000000001";
const OTHER_SECRET_ID: &str = "20000000-0000-4000-8000-000000000002";
const MANAGED_SECRET_ID: &str = "20000000-0000-4000-8000-000000000003";
static CREATE_FEATURE_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn verified_board_user() -> VerifiedActor {
    let actor = ActorIdentity::new("user", BOARD_USER).expect("valid board user identity");
    let path = format!("/api/orgs/{ORG}/agents");
    let body = br#"{"operation":"list"}"#;
    let request_id = "agent-core-roster-revalidation-request";
    let nonce = "agent-core-roster-revalidation-nonce";
    let envelope = ActorEnvelope::new(
        actor.clone(),
        ORG,
        "board-session",
        1,
        "rudder-server-foundation",
        "GET",
        &path,
        "agent-core.execute",
        body,
        request_id,
        nonce,
        1_000,
        1_100,
    )
    .expect("unsigned actor envelope")
    .sign(SECRET)
    .expect("signed actor envelope");
    let request = RequestContext::new(
        &actor,
        ORG,
        "board-session",
        1,
        "rudder-server-foundation",
        "GET",
        &path,
        "agent-core.execute",
        body,
        request_id,
        1_050,
    );
    envelope
        .verify_to_actor(SECRET, &request, &mut NonceReplayGuard::new())
        .expect("verified actor envelope")
}

fn verified_create_user() -> VerifiedActor {
    verified_create_user_with_body(
        br#"{"operation":"create","orgId":"10000000-0000-4000-8000-000000000001","input":{"name":"Rust Created","budgetMonthlyCents":1250}}"#,
    )
}

fn verified_create_user_with_body(body: &[u8]) -> VerifiedActor {
    let actor = ActorIdentity::new("user", CREATE_USER).expect("valid board user identity");
    let path = format!("/internal/agent-core/{ORG}/create");
    let request_id = "agent-core-create-request";
    let nonce = "agent-core-create-nonce";
    let envelope = ActorEnvelope::new(
        actor.clone(),
        ORG,
        "board-session",
        1,
        "rudder-server-foundation",
        "POST",
        &path,
        "agent-core.execute",
        body,
        request_id,
        nonce,
        1_000,
        1_100,
    )
    .expect("unsigned actor envelope")
    .sign(SECRET)
    .expect("signed actor envelope");
    let request = RequestContext::new(
        &actor,
        ORG,
        "board-session",
        1,
        "rudder-server-foundation",
        "POST",
        &path,
        "agent-core.execute",
        body,
        request_id,
        1_050,
    );
    envelope
        .verify_to_actor(SECRET, &request, &mut NonceReplayGuard::new())
        .expect("verified actor envelope")
}

async fn execute_create_body(
    database: &Database,
    body: serde_json::Value,
) -> Result<(u16, String), AgentCoreError> {
    let bytes = serde_json::to_vec(&body).expect("serialize create body");
    let request = AgentCoreRequest::parse(&bytes).expect("valid create request");
    execute_agent_with_native_auth(
        &database.pool,
        &verified_create_user_with_body(&bytes),
        &request,
        &NoopNativeAuthorizer,
    )
    .await
}

struct NoopNativeAuthorizer;

impl NativeAgentAuthorizer for NoopNativeAuthorizer {
    fn revalidate<'a>(
        &'a self,
        _connection: &'a mut PgConnection,
        _org_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>> {
        Box::pin(async { Ok(NativeAgentAccess::Authorized) })
    }
}

struct RevokedMembershipAuthorizer {
    user_id: &'static str,
}

#[cfg(unix)]
struct RevokeAfterFilesystemAuthorizer {
    user_id: &'static str,
    calls: AtomicUsize,
}

#[cfg(unix)]
impl NativeAgentAuthorizer for RevokeAfterFilesystemAuthorizer {
    fn revalidate<'a>(
        &'a self,
        connection: &'a mut PgConnection,
        org_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>> {
        Box::pin(async move {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                return Ok(NativeAgentAccess::Authorized);
            }
            sqlx::query(
                "UPDATE organization_memberships SET status='revoked' WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2",
            )
            .bind(org_id)
            .bind(self.user_id)
            .execute(&mut *connection)
            .await?;
            Ok(NativeAgentAccess::Forbidden)
        })
    }
}

impl NativeAgentAuthorizer for RevokedMembershipAuthorizer {
    fn revalidate<'a>(
        &'a self,
        connection: &'a mut PgConnection,
        org_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>> {
        Box::pin(async move {
            // Revoke the board user's membership after the initial
            // authorize_org check. This mirrors the production membership
            // query and exercises a real scope denial during revalidation.
            sqlx::query(
                "UPDATE organization_memberships SET status='revoked' WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2",
            )
                .bind(org_id)
                .bind(self.user_id)
                .execute(&mut *connection)
                .await?;
            let active = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM organization_memberships WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2 AND status='active')",
            )
            .bind(org_id)
            .bind(self.user_id)
            .fetch_one(&mut *connection)
            .await?;
            Ok(if active {
                NativeAgentAccess::Authorized
            } else {
                NativeAgentAccess::Forbidden
            })
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn roster_revalidation_denial_returns_forbidden_after_initial_board_access() {
    let database = Database::start().await;
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES ($1,'Roster User','roster-user@example.test',now(),now())",
    )
    .bind(BOARD_USER)
    .execute(&database.pool)
    .await
    .expect("seed board user");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES ($1::uuid,'user',$2,'member','active')",
    )
    .bind(ORG)
    .bind(BOARD_USER)
    .execute(&database.pool)
    .await
    .expect("seed active organization membership");

    let actor = verified_board_user();
    let request = AgentCoreRequest::parse(
        br#"{"operation":"list","orgId":"10000000-0000-4000-8000-000000000001","query":{}}"#,
    )
    .expect("valid roster request");

    let result = execute_agent_with_native_auth(
        &database.pool,
        &actor,
        &request,
        &RevokedMembershipAuthorizer {
            user_id: BOARD_USER,
        },
    )
    .await;
    match result {
        Err(AgentCoreError::Http(403, message, _)) => assert_eq!(message, "Forbidden"),
        other => panic!("expected revalidation denial, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_create_is_transactional_and_records_default_side_effects() {
    let database = Database::start().await;
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES ($1,'Create User','create-user@example.test',now(),now())",
    )
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed create user");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES ($1::uuid,'user',$2,'member','active')",
    )
    .bind(ORG)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed create membership");

    let request = AgentCoreRequest::parse(
        br#"{"operation":"create","orgId":"10000000-0000-4000-8000-000000000001","input":{"name":"Rust Created","budgetMonthlyCents":1250}}"#,
    )
    .expect("valid create request");
    // This operation is intentionally private and disabled unless explicitly
    // enabled by the migration pilot.
    let result = {
        let _feature_env_guard = CREATE_FEATURE_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .await;
        unsafe { std::env::set_var("RUDDER_AGENT_CREATE_RUST_ENABLED", "1") };
        let result = rudder_d1_persistence::agent_core::execute_agent(
            &database.pool,
            &verified_create_user(),
            &request,
        )
        .await;
        unsafe { std::env::remove_var("RUDDER_AGENT_CREATE_RUST_ENABLED") };
        result
    };
    let (status, body) = result.expect("create succeeds");
    assert_eq!(status, 201);
    let response: serde_json::Value = serde_json::from_str(&body).expect("JSON response");
    let agent_id = response["id"].as_str().expect("created id");
    assert_eq!(response["name"], "Rust Created");
    assert!(
        response["icon"]
            .as_str()
            .is_some_and(|value| value.starts_with("oreo:bloom:rose-milk:"))
    );
    assert!(sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM agents WHERE id=$1::uuid AND org_id=$2::uuid AND workspace_key IS NOT NULL)")
        .bind(agent_id)
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .expect("agent row"));
    assert!(sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM organization_memberships WHERE org_id=$1::uuid AND principal_type='agent' AND principal_id=$2 AND status='active')")
        .bind(ORG)
        .bind(agent_id)
        .fetch_one(&database.pool)
        .await
        .expect("agent membership"));
    assert!(sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM principal_permission_grants WHERE org_id=$1::uuid AND principal_type='agent' AND principal_id=$2 AND permission_key='tasks:assign')")
        .bind(ORG)
        .bind(agent_id)
        .fetch_one(&database.pool)
        .await
        .expect("task assignment grant"));
    assert_eq!(sqlx::query_scalar::<_, i32>("SELECT amount FROM budget_policies WHERE org_id=$1::uuid AND scope_type='agent' AND scope_id=$2::uuid AND window_kind='calendar_month_utc'")
        .bind(ORG)
        .bind(agent_id)
        .fetch_one(&database.pool)
        .await
        .expect("budget policy"), 1250);
    assert!(sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM activity_log WHERE org_id=$1::uuid AND action='agent.created' AND entity_id=$2)")
        .bind(ORG)
        .bind(agent_id)
        .fetch_one(&database.pool)
        .await
        .expect("creation activity"));
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_create_persists_instruction_bundle_outbox_without_touching_filesystem() {
    let database = Database::start().await;
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES ($1,'Bundle User','bundle-user@example.test',now(),now())",
    )
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed bundle user");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES ($1::uuid,'user',$2,'member','active')",
    )
    .bind(ORG)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed bundle membership");

    let input = json!({
        "name": "Durable Bundle",
        "nodeOwned": {
            "normalizedAgentRuntimeConfig": {},
            "instructionsBundle": {
                "entryFile": "SOUL.md",
                "files": {
                    "SOUL.md": "# Durable",
                    "nested/TOOLS.md": "tools"
                },
                "clearLegacyPromptTemplate": true
            }
        }
    });
    let _feature_env_guard = CREATE_FEATURE_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    unsafe {
        std::env::set_var("RUDDER_AGENT_CREATE_RUST_ENABLED", "1");
        std::env::set_var("RUDDER_AGENT_CREATE_INSTRUCTIONS_DURABLE_ENABLED", "1");
    }
    let result = execute_create_body(
        &database,
        json!({
            "operation": "create",
            "orgId": ORG,
            "input": input,
        }),
    )
    .await
    .expect("bundle create succeeds");
    unsafe {
        std::env::remove_var("RUDDER_AGENT_CREATE_RUST_ENABLED");
        std::env::remove_var("RUDDER_AGENT_CREATE_INSTRUCTIONS_DURABLE_ENABLED");
    }
    assert_eq!(result.0, 201);
    let agent_id: String = sqlx::query_scalar(
        "SELECT id::text FROM agents WHERE org_id=$1::uuid AND name='Durable Bundle'",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .expect("created agent");
    let row = sqlx::query_as::<_, (String, String, bool, String)>(
        "SELECT entry_file,files::text,clear_legacy_prompt_template,state
           FROM agent_instruction_bundles WHERE org_id=$1::uuid AND agent_id=$2::uuid",
    )
    .bind(ORG)
    .bind(&agent_id)
    .fetch_one(&database.pool)
    .await
    .expect("durable instruction bundle");
    assert_eq!(row.0, "SOUL.md");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&row.1).unwrap()["nested/TOOLS.md"],
        "tools"
    );
    assert!(row.2);
    assert_eq!(row.3, "pending");
    sqlx::query("UPDATE agents SET agent_runtime_config=$1::jsonb WHERE id=$2::uuid")
        .bind(json!({
            "promptTemplate": "legacy prompt",
            "bootstrapPromptTemplate": "legacy boot"
        }))
        .bind(&agent_id)
        .execute(&database.pool)
        .await
        .expect("seed legacy prompt config");

    // A later detail read is the current private reconciler trigger. It
    // materializes the pending row, consumes clearLegacyPromptTemplate, and
    // records canonical runtime paths only after filesystem success.
    let filesystem = tempfile::tempdir().expect("filesystem fixture");
    let instance_root = filesystem.path().join("instances/default");
    let workspace_home = instance_root.join("organizations");
    let previous_documents_root = filesystem.path().join("Documents/organizations");
    let detail_body = json!({
        "operation": "detail",
        "orgId": ORG,
        "id": agent_id,
        "homeDirectory": filesystem.path(),
        "processWorkingDirectory": filesystem.path(),
        "deploymentMode": "local_trusted",
        "instructionsHost": {
            "instanceRoot": instance_root,
            "workspaceHome": workspace_home,
            "previousDocumentsRoot": previous_documents_root,
            "friendlyWorkspaceHome": false,
            "hostname": "durable-bundle-test-host"
        }
    });
    let detail_bytes = serde_json::to_vec(&detail_body).expect("serialize detail body");
    let detail_request = AgentCoreRequest::parse(&detail_bytes).expect("valid detail request");
    let detail_result = execute_agent_with_native_auth(
        &database.pool,
        &verified_create_user_with_body(&detail_bytes),
        &detail_request,
        &NoopNativeAuthorizer,
    )
    .await
    .expect("detail reconciler succeeds");
    assert_eq!(detail_result.0, 200);
    let detail_response: serde_json::Value =
        serde_json::from_str(&detail_result.1).expect("detail JSON response");
    assert_eq!(
        detail_response["agentRuntimeConfig"]["instructionsBundleMode"],
        "managed"
    );
    assert!(detail_response["agentRuntimeConfig"]["promptTemplate"].is_null());
    let stored_state: (String, serde_json::Value) = sqlx::query_as(
        "SELECT b.state, a.agent_runtime_config FROM agent_instruction_bundles b JOIN agents a ON a.id=b.agent_id WHERE b.org_id=$1::uuid AND b.agent_id=$2::uuid",
    )
    .bind(ORG)
    .bind(&agent_id)
    .fetch_one(&database.pool)
    .await
    .expect("materialized durable row");
    assert_eq!(stored_state.0, "materialized");
    assert_eq!(stored_state.1["instructionsBundleMode"], "managed");
    assert_eq!(stored_state.1["instructionsEntryFile"], "SOUL.md");
    assert!(
        stored_state.1["instructionsRootPath"]
            .as_str()
            .is_some_and(|path| Path::new(path).ends_with("instructions"))
    );
    assert!(
        stored_state.1["instructionsFilePath"]
            .as_str()
            .is_some_and(|path| {
                Path::new(path).ends_with(Path::new("instructions").join("SOUL.md"))
            })
    );
    assert!(stored_state.1["promptTemplate"].is_null());
    let workspace_key: String =
        sqlx::query_scalar("SELECT workspace_key FROM agents WHERE id=$1::uuid")
            .bind(&agent_id)
            .fetch_one(&database.pool)
            .await
            .expect("workspace key");
    let instructions = workspace_home
        .join("100000000000/workspaces/agents")
        .join(workspace_key)
        .join("instructions");
    assert_eq!(
        std::fs::read_to_string(instructions.join("SOUL.md")).unwrap(),
        "# Durable"
    );
    assert_eq!(
        std::fs::read_to_string(instructions.join("nested/TOOLS.md")).unwrap(),
        "tools"
    );

    // A filesystem failure must not update the pending row when native auth
    // is revoked during materialization. The second revalidation runs after
    // the filesystem attempt and the transaction rolls back all repair state.
    #[cfg(unix)]
    {
        unsafe {
            std::env::set_var("RUDDER_AGENT_CREATE_RUST_ENABLED", "1");
            std::env::set_var("RUDDER_AGENT_CREATE_INSTRUCTIONS_DURABLE_ENABLED", "1");
        }
        let broken = execute_create_body(
            &database,
            json!({
                "operation": "create",
                "orgId": ORG,
                "input": {
                    "name": "Durable Bundle Auth Race",
                    "nodeOwned": {
                        "normalizedAgentRuntimeConfig": {},
                        "instructionsBundle": {
                            "entryFile": "SOUL.md",
                            "files": {"SOUL.md": "# Broken"},
                            "clearLegacyPromptTemplate": false
                        }
                    }
                }
            }),
        )
        .await
        .expect("second bundle create succeeds");
        unsafe {
            std::env::remove_var("RUDDER_AGENT_CREATE_RUST_ENABLED");
            std::env::remove_var("RUDDER_AGENT_CREATE_INSTRUCTIONS_DURABLE_ENABLED");
        }
        assert_eq!(broken.0, 201);
        let broken_id: String = sqlx::query_scalar(
            "SELECT id::text FROM agents WHERE org_id=$1::uuid AND name='Durable Bundle Auth Race'",
        )
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .expect("created auth race agent");
        let broken_key: String =
            sqlx::query_scalar("SELECT workspace_key FROM agents WHERE id=$1::uuid")
                .bind(&broken_id)
                .fetch_one(&database.pool)
                .await
                .expect("auth race workspace key");
        let broken_workspace = workspace_home
            .join("100000000000/workspaces/agents")
            .join(&broken_key);
        let outside = filesystem.path().join("outside-auth-race");
        std::fs::create_dir_all(&outside).expect("outside auth race directory");
        std::fs::create_dir_all(broken_workspace.parent().expect("workspace parent"))
            .expect("agents directory");
        std::os::unix::fs::symlink(&outside, &broken_workspace)
            .expect("symlink workspace to force materialization failure");

        let broken_detail = json!({
            "operation": "detail",
            "orgId": ORG,
            "id": broken_id,
            "homeDirectory": filesystem.path(),
            "processWorkingDirectory": filesystem.path(),
            "deploymentMode": "local_trusted",
            "instructionsHost": {
                "instanceRoot": instance_root,
                "workspaceHome": workspace_home,
                "previousDocumentsRoot": previous_documents_root,
                "friendlyWorkspaceHome": false,
                "hostname": "durable-bundle-auth-race-host"
            }
        });
        let broken_detail_bytes =
            serde_json::to_vec(&broken_detail).expect("serialize race detail");
        let broken_detail_request =
            AgentCoreRequest::parse(&broken_detail_bytes).expect("valid race detail request");
        let broken_result = execute_agent_with_native_auth(
            &database.pool,
            &verified_create_user_with_body(&broken_detail_bytes),
            &broken_detail_request,
            &RevokeAfterFilesystemAuthorizer {
                user_id: CREATE_USER,
                calls: AtomicUsize::new(0),
            },
        )
        .await;
        assert!(matches!(
            broken_result,
            Err(AgentCoreError::Http(403, ref message, _)) if message == "Forbidden"
        ));
        let broken_state: (String, Option<String>) = sqlx::query_as(
            "SELECT state,last_error FROM agent_instruction_bundles WHERE org_id=$1::uuid AND agent_id=$2::uuid",
        )
        .bind(ORG)
        .bind(&broken_id)
        .fetch_one(&database.pool)
        .await
        .expect("auth race outbox row");
        assert_eq!(broken_state.0, "pending");
        assert!(broken_state.1.is_none());
        assert!(!outside.join("instructions/SOUL.md").exists());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_create_normalizes_secret_refs_and_fallback_configs_with_org_isolation() {
    let database = Database::start().await;
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES ($1,'Create User','create-secrets@example.test',now(),now()) ON CONFLICT (id) DO NOTHING",
    )
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed create user");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES ($1::uuid,'user',$2,'member','active') ON CONFLICT DO NOTHING",
    )
    .bind(ORG)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed create membership");
    for (id, org, purpose) in [
        (SECRET_ID, ORG, "user_managed"),
        (OTHER_SECRET_ID, support::OTHER, "user_managed"),
        (MANAGED_SECRET_ID, ORG, "runtime_managed"),
    ] {
        sqlx::query(
            "INSERT INTO organization_secrets(id,org_id,name,purpose,provider) VALUES ($1::uuid,$2::uuid,$3,$4,'local_encrypted')",
        )
        .bind(id)
        .bind(org)
        .bind(format!("secret-{id}"))
        .bind(purpose)
        .execute(&database.pool)
        .await
        .expect("seed organization secret");
    }

    let _feature_env_guard = CREATE_FEATURE_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    unsafe { std::env::set_var("RUDDER_AGENT_CREATE_RUST_ENABLED", "1") };
    unsafe { std::env::remove_var("RUDDER_SECRETS_STRICT_MODE") };
    let valid = execute_create_body(
        &database,
        json!({
            "operation":"create",
            "orgId":ORG,
            "input":{
                "name":"Secret Ref",
                "agentRuntimeConfig":{
                    "env":{"MODEL":"fast","RUDDER_TOKEN":{"type":"secret_ref","secretId":SECRET_ID}},
                    "modelFallbacks":["gpt-4o-mini",{"agentRuntimeType":"gemini_local","model":"gemini-2.5-pro","config":{"env":{"MODE":"backup"}}}]
                }
            }
        }),
    )
    .await
    .expect("valid secret-ref create");
    let response: serde_json::Value = serde_json::from_str(&valid.1).expect("response json");
    let config = sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT agent_runtime_config FROM agents WHERE id=$1::uuid",
    )
    .bind(response["id"].as_str().expect("agent id"))
    .fetch_one(&database.pool)
    .await
    .expect("stored runtime config");
    assert_eq!(
        config["env"]["MODEL"],
        json!({"type":"plain","value":"fast"})
    );
    assert_eq!(config["env"]["RUDDER_TOKEN"]["type"], "secret_ref");
    assert_eq!(config["modelFallbacks"][0], "gpt-4o-mini");
    assert_eq!(
        config["modelFallbacks"][1]["config"]["env"]["MODE"]["type"],
        "plain"
    );

    for (name, fallback) in [
        (
            "Fallback Raw Key",
            json!({"agentRuntimeType":"codex_local","model":"x","config":{"apiKey":"raw"}}),
        ),
        (
            "Fallback Whitespace Runtime",
            json!({"agentRuntimeType":" codex_local ","model":"x"}),
        ),
    ] {
        let result = execute_create_body(
            &database,
            json!({"operation":"create","orgId":ORG,"input":{"name":name,"agentRuntimeConfig":{"modelFallbacks":[fallback]}}}),
        )
        .await;
        assert!(
            matches!(result, Err(AgentCoreError::Http(422, _, _))),
            "{name}: {result:?}"
        );
    }

    unsafe { std::env::set_var("RUDDER_SECRETS_STRICT_MODE", "true") };
    let strict = execute_create_body(
        &database,
        json!({"operation":"create","orgId":ORG,"input":{"name":"Strict Plain","agentRuntimeConfig":{"env":{"API_KEY":"plaintext"}}}}),
    )
    .await;
    assert!(matches!(strict, Err(AgentCoreError::Http(422, _, _))));
    unsafe { std::env::remove_var("RUDDER_SECRETS_STRICT_MODE") };

    for (name, secret_id) in [
        ("Missing Secret", "20000000-0000-4000-8000-000000000099"),
        ("Cross Org Secret", OTHER_SECRET_ID),
        ("Managed Secret", MANAGED_SECRET_ID),
    ] {
        let result = execute_create_body(
            &database,
            json!({"operation":"create","orgId":ORG,"input":{"name":name,"agentRuntimeConfig":{"env":{"TOKEN":{"type":"secret_ref","secretId":secret_id}}}}}),
        )
        .await;
        assert!(
            matches!(result, Err(AgentCoreError::Http(422, _, _))),
            "{name}: {result:?}"
        );
    }
    unsafe { std::env::remove_var("RUDDER_AGENT_CREATE_RUST_ENABLED") };
}
#[tokio::test(flavor = "multi_thread")]
async fn rust_create_managed_mcp_gate_inherits_organization_defaults() {
    let database = Database::start().await;
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES ($1,'Create MCP User','create-mcp-user@example.test',now(),now())",
    )
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed create MCP user");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES ($1::uuid,'user',$2,'member','active')",
    )
    .bind(ORG)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed create MCP membership");

    let linear = "63000000-0000-4000-8000-000000000001";
    let notion = "63000000-0000-4000-8000-000000000002";
    let legacy = "63000000-0000-4000-8000-000000000003";
    let tool = "64000000-0000-4000-8000-000000000001";
    for (id, name, provider, access_mode, transport, status, enabled) in [
        (
            linear,
            "rust-linear",
            "linear",
            "read_write",
            "streamable_http",
            "active",
            true,
        ),
        (
            notion,
            "rust-notion",
            "notion",
            "provider_default",
            "streamable_http",
            "active",
            true,
        ),
        (
            legacy,
            "rust-legacy",
            "custom",
            "provider_default",
            "legacy_manual",
            "disabled",
            false,
        ),
    ] {
        sqlx::query(
            "INSERT INTO mcp_connections
               (id, org_id, name, display_name, provider, transport, access_mode,
                status, canonical_state, safe_config, enabled)
             VALUES ($1::uuid, $2::uuid, $3, $3, $4, $5, $6, $7, 'canonical', '{}'::jsonb, $8)",
        )
        .bind(id)
        .bind(ORG)
        .bind(name)
        .bind(provider)
        .bind(transport)
        .bind(access_mode)
        .bind(status)
        .bind(enabled)
        .execute(&database.pool)
        .await
        .expect("seed create MCP connection");
    }
    sqlx::query(
        "INSERT INTO custom_integration_tools
           (id, org_id, connection_id, external_tool_name, rudder_tool_name,
            input_schema, status, enabled)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'issues', 'linear.issues', '{}', 'active', true)",
    )
    .bind(tool)
    .bind(ORG)
    .bind(linear)
    .execute(&database.pool)
    .await
    .expect("seed create MCP tool");

    let request = AgentCoreRequest::parse(
        br#"{"operation":"create","orgId":"10000000-0000-4000-8000-000000000001","input":{"name":"Rust Managed MCP","budgetMonthlyCents":0}}"#,
    )
    .expect("valid managed MCP create request");
    let result = {
        let _feature_env_guard = CREATE_FEATURE_ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .await;
        unsafe {
            std::env::set_var("RUDDER_AGENT_CREATE_RUST_ENABLED", "1");
            std::env::set_var("RUDDER_AGENT_CREATE_RUST_MANAGED_MCP_ENABLED", "1");
        }
        let result = rudder_d1_persistence::agent_core::execute_agent(
            &database.pool,
            &verified_create_user(),
            &request,
        )
        .await;
        unsafe {
            std::env::remove_var("RUDDER_AGENT_CREATE_RUST_ENABLED");
            std::env::remove_var("RUDDER_AGENT_CREATE_RUST_MANAGED_MCP_ENABLED");
        }
        result
    };
    let (_, body) = result.expect("managed MCP create succeeds");
    let agent_id = serde_json::from_str::<serde_json::Value>(&body)
        .expect("managed MCP create response")["id"]
        .as_str()
        .expect("created agent id")
        .to_owned();
    let bindings: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT connection_id::text, access_mode, enabled_tool_ids::text
         FROM agent_custom_integration_bindings
         WHERE org_id=$1::uuid AND agent_id=$2::uuid
         ORDER BY connection_id",
    )
    .bind(ORG)
    .bind(&agent_id)
    .fetch_all(&database.pool)
    .await
    .expect("read managed MCP bindings");
    assert_eq!(
        bindings,
        vec![
            (linear.into(), "read_write".into(), format!("[\"{tool}\"]")),
            (notion.into(), "provider_granted".into(), "[]".into()),
        ]
    );
    let activities: Vec<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT entity_type, actor_type, actor_id, details->>'source'
         FROM activity_log
         WHERE org_id=$1::uuid AND action='mcp_agent_binding.created' AND agent_id=$2::uuid",
    )
    .bind(ORG)
    .bind(&agent_id)
    .fetch_all(&database.pool)
    .await
    .expect("read managed MCP activities");
    assert_eq!(activities.len(), 2);
    assert!(
        activities
            .iter()
            .all(|(entity_type, actor_type, actor_id, source)| {
                entity_type == "mcp_agent_binding"
                    && actor_type == "system"
                    && actor_id == "system"
                    && source.as_deref() == Some("agent_creation")
            })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_create_assigns_canonical_org_skills_and_omits_bundled_skills() {
    let database = Database::start().await;
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES ($1,'Skill User','skill-user@example.test',now(),now())",
    )
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed skill user");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES ($1::uuid,'user',$2,'member','active')",
    )
    .bind(ORG)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed skill membership");
    sqlx::query(
        "INSERT INTO organization_skills(org_id,key,slug,name,markdown,source_type) VALUES
         ($1::uuid,'rudder/browser','browser','Browser','bundled','rudder_bundled'),
         ($1::uuid,'organization/' || $1::text || '/alpha','alpha','Alpha','alpha','local_path'),
         ($1::uuid,'organization/' || $1::text || '/beta','beta','Beta','beta','local_path'),
         ($1::uuid,'organization/' || $1::text || '/beta-copy','beta','Beta copy','beta','local_path')",
    )
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("seed skill catalog");

    let _feature_env_guard = CREATE_FEATURE_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    unsafe { std::env::set_var("RUDDER_AGENT_CREATE_RUST_ENABLED", "1") };
    let result = execute_create_body(
        &database,
        json!({
            "operation":"create",
            "orgId":ORG,
            "input":{
                "name":"Skill Create",
                "desiredSkills":[
                    "rudder/browser",
                    "bundled:rudder/browser",
                    "org:organization/10000000-0000-4000-8000-000000000001/alpha",
                    "alpha",
                    "alpha"
                ]
            }
        }),
    )
    .await
    .expect("skill create succeeds");
    unsafe { std::env::remove_var("RUDDER_AGENT_CREATE_RUST_ENABLED") };

    let response: serde_json::Value = serde_json::from_str(&result.1).expect("response json");
    let agent_id = response["id"].as_str().expect("created agent id");
    let assigned = sqlx::query_scalar::<_, String>(
        "SELECT skill_key FROM agent_enabled_skills WHERE org_id=$1::uuid AND agent_id=$2::uuid ORDER BY skill_key",
    )
    .bind(ORG)
    .bind(agent_id)
    .fetch_all(&database.pool)
    .await
    .expect("assigned skills");
    assert_eq!(
        assigned,
        ["org:organization/10000000-0000-4000-8000-000000000001/alpha"]
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM agent_enabled_skills WHERE agent_id=$1::uuid"
        )
        .bind(agent_id)
        .fetch_one(&database.pool)
        .await
        .expect("assignment count"),
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_create_rejects_unknown_ambiguous_and_cross_org_skills_atomically() {
    let database = Database::start().await;
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES ($1,'Skill User 2','skill-user-2@example.test',now(),now())",
    )
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed skill user");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES ($1::uuid,'user',$2,'member','active')",
    )
    .bind(ORG)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed skill membership");
    let foreign_skill_id = sqlx::query_scalar::<_, String>(
        "INSERT INTO organization_skills(org_id,key,slug,name,markdown,source_type) VALUES ($1::uuid,'organization/' || $1::text || '/shared','shared','Shared','shared','local_path') RETURNING id::text",
    )
    .bind(support::OTHER)
    .fetch_one(&database.pool)
    .await
    .expect("seed foreign skill");
    sqlx::query(
        "INSERT INTO organization_skills(org_id,key,slug,name,markdown,source_type) VALUES
         ($1::uuid,'organization/' || $1::text || '/dup-one','dup','Dup one','dup','local_path'),
         ($1::uuid,'organization/' || $1::text || '/dup-two','dup','Dup two','dup','local_path')",
    )
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("seed ambiguous skills");

    let _feature_env_guard = CREATE_FEATURE_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    unsafe { std::env::set_var("RUDDER_AGENT_CREATE_RUST_ENABLED", "1") };
    for (name, reference) in [
        (
            "Unknown skill",
            "org:organization/10000000-0000-4000-8000-000000000001/missing".to_owned(),
        ),
        ("Ambiguous skill", "dup".to_owned()),
        (
            "Unavailable bundled skill",
            "bundled:rudder/browser".to_owned(),
        ),
        ("Cross org skill", foreign_skill_id),
    ] {
        let before =
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM agents WHERE org_id=$1::uuid")
                .bind(ORG)
                .fetch_one(&database.pool)
                .await
                .expect("agent count before");
        let result = execute_create_body(
            &database,
            json!({"operation":"create","orgId":ORG,"input":{"name":name,"desiredSkills":[reference]}}),
        )
        .await;
        assert!(
            matches!(result, Err(AgentCoreError::Http(422, _, _))),
            "{name}: {result:?}"
        );
        let after =
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM agents WHERE org_id=$1::uuid")
                .bind(ORG)
                .fetch_one(&database.pool)
                .await
                .expect("agent count after");
        assert_eq!(before, after, "{name} must roll back the Agent row");
    }
    unsafe { std::env::remove_var("RUDDER_AGENT_CREATE_RUST_ENABLED") };
}
