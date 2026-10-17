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
use std::{future::Future, pin::Pin, sync::OnceLock};
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
                    "modelFallbacks":["gpt-4o-mini",{"agentRuntimeType":"codex_local","model":"gpt-4o","config":{"env":{"MODE":"backup"}}}]
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
