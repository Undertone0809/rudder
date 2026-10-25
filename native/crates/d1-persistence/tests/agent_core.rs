mod support;

use base64::Engine as _;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use rudder_auth_core::{
    ActorEnvelope, ActorIdentity, NonceReplayGuard, RequestContext, VerifiedActor,
};
use rudder_d1_persistence::agent_core::{
    AgentCoreError, AgentCoreRequest, NativeAgentAccess, NativeAgentAuthorizer,
    execute_agent_with_native_auth,
};
#[cfg(unix)]
use rudder_d1_persistence::agent_core::{
    execute_public_agent_create_with_native_auth, normalize_public_agent_create_input,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
#[cfg(unix)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{fs, future::Future, path::Path, pin::Pin, sync::OnceLock};
use support::{ASSET, Database, FOREIGN_ASSET, ORG, OTHER};
use tokio::sync::Mutex;

const SECRET: &[u8] = b"native-agent-core-roster-revalidation-test-key";
const BOARD_USER: &str = "roster-board-user";
const CREATE_USER: &str = "create-board-user";
const SECRET_ID: &str = "20000000-0000-4000-8000-000000000001";
const OTHER_SECRET_ID: &str = "20000000-0000-4000-8000-000000000002";
const MANAGED_SECRET_ID: &str = "20000000-0000-4000-8000-000000000003";
const SKILL_HOME_SECRET_ID: &str = "20000000-0000-4000-8000-000000000004";
const SKILL_CODEX_HOME_SECRET_ID: &str = "20000000-0000-4000-8000-000000000005";
const EXTERNAL_SKILL_HOME_SECRET_ID: &str = "20000000-0000-4000-8000-000000000006";
static CREATE_FEATURE_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

struct RestoreEnvironmentVariable {
    name: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl RestoreEnvironmentVariable {
    fn set(name: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(name);
        unsafe { std::env::set_var(name, value) };
        Self { name, previous }
    }
}

impl Drop for RestoreEnvironmentVariable {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => unsafe { std::env::set_var(self.name, value) },
            None => unsafe { std::env::remove_var(self.name) },
        }
    }
}

fn local_secret_material(value: &str) -> (serde_json::Value, String) {
    let key_bytes = *b"01234567890123456789012345678901";
    let nonce_bytes = [7; 12];
    let unbound = UnboundKey::new(&AES_256_GCM, &key_bytes).expect("AES key");
    let key = LessSafeKey::new(unbound);
    let mut ciphertext_and_tag = value.as_bytes().to_vec();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce_bytes),
        Aad::empty(),
        &mut ciphertext_and_tag,
    )
    .expect("encrypt local secret fixture");
    let tag_offset = ciphertext_and_tag.len() - 16;
    let tag = ciphertext_and_tag.split_off(tag_offset);
    let value_sha256 = format!("{:x}", Sha256::digest(value.as_bytes()));
    (
        json!({
            "scheme":"local_encrypted_v1",
            "iv":base64::engine::general_purpose::STANDARD.encode(nonce_bytes),
            "tag":base64::engine::general_purpose::STANDARD.encode(tag),
            "ciphertext":base64::engine::general_purpose::STANDARD.encode(ciphertext_and_tag)
        }),
        value_sha256,
    )
}

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
    verified_create_user_for_org(ORG, body)
}

fn verified_create_user_for_org(org: &str, body: &[u8]) -> VerifiedActor {
    let actor = ActorIdentity::new("user", CREATE_USER).expect("valid board user identity");
    let path = format!("/internal/agent-core/{org}/create");
    let request_id = "agent-core-create-request";
    let nonce = "agent-core-create-nonce";
    let envelope = ActorEnvelope::new(
        actor.clone(),
        org,
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
        org,
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
async fn rust_create_identity_slice_persists_profile_and_rejects_cross_org_avatar() {
    let database = Database::start().await;
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES ($1,'Identity User','identity-user@example.test',now(),now())",
    )
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed identity user");
    for org in [ORG, OTHER] {
        sqlx::query(
            "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES ($1::uuid,'user',$2,'member','active')",
        )
        .bind(org)
        .bind(CREATE_USER)
        .execute(&database.pool)
        .await
        .expect("seed identity membership");
    }

    let body = serde_json::json!({
        "operation": "create",
        "orgId": OTHER,
        "input": {
            "name": "Identity Slice",
            "agentRuntimeType": "codex_local",
            "agentRuntimeConfig": {"model": "legacy-model", "reasoningEffort": "high"},
            "nodeOwned": {
                "normalizedAgentRuntimeConfig": {"model": "legacy-model", "reasoningEffort": "high"},
                "avatarIcon": format!("ASSET:{FOREIGN_ASSET}?BG=MIST"),
                "intelligenceDefaults": {
                    "status": "configured",
                    "lastVerifiedAt": "2026-10-18T01:02:03Z"
                }
            }
        }
    });
    let _feature_env_guard = CREATE_FEATURE_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    unsafe {
        std::env::set_var("RUDDER_AGENT_CREATE_RUST_ENABLED", "1");
        std::env::set_var("RUDDER_AGENT_CREATE_INTELLIGENCE_AVATAR_RUST_ENABLED", "1");
    }
    let bytes = serde_json::to_vec(&body).expect("serialize identity create body");
    let request = AgentCoreRequest::parse(&bytes).expect("valid identity create request");
    let (status, response_body) = execute_agent_with_native_auth(
        &database.pool,
        &verified_create_user_for_org(OTHER, &bytes),
        &request,
        &NoopNativeAuthorizer,
    )
    .await
    .expect("identity create succeeds");
    assert_eq!(status, 201);
    let response: serde_json::Value =
        serde_json::from_str(&response_body).expect("identity create response");
    assert_eq!(response["icon"], format!("ASSET:{FOREIGN_ASSET}?BG=MIST"));
    let agent_id = response["id"].as_str().expect("identity agent id");
    let profile: (
        String,
        serde_json::Value,
        String,
        Option<String>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT agent_runtime_type,agent_runtime_config,status,last_error,last_verified_at::text
         FROM organization_intelligence_profiles WHERE org_id=$1::uuid AND purpose='default'",
    )
    .bind(OTHER)
    .fetch_one(&database.pool)
    .await
    .expect("identity profile");
    assert_eq!(profile.0, "codex_local");
    assert_eq!(profile.1["model"], "gpt-6-luna");
    assert_eq!(profile.1["modelReasoningEffort"], "medium");
    assert_eq!(profile.1.get("reasoningEffort"), None);
    assert_eq!(profile.2, "configured");
    assert_eq!(profile.3, None);
    let verified_at = profile
        .4
        .as_deref()
        .expect("verified timestamp")
        .replace(' ', "T")
        .replace("+00", "Z");
    let parsed_verified_at =
        time::OffsetDateTime::parse(&verified_at, &time::format_description::well_known::Rfc3339)
            .expect("timestamp");
    let expected_verified_at = time::OffsetDateTime::parse(
        "2026-10-18T01:02:03Z",
        &time::format_description::well_known::Rfc3339,
    )
    .expect("expected timestamp");
    assert_eq!(parsed_verified_at, expected_verified_at);
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM agents WHERE id=$1::uuid AND org_id=$2::uuid)",
        )
        .bind(agent_id)
        .bind(OTHER)
        .fetch_one(&database.pool)
        .await
        .expect("identity agent row")
    );

    let malformed_body = serde_json::json!({
        "operation": "create",
        "orgId": OTHER,
        "input": {
            "name": "Malformed Avatar",
            "nodeOwned": {
                "normalizedAgentRuntimeConfig": {},
                "avatarIcon": "notionists:legacy"
            }
        }
    });
    let malformed_bytes = serde_json::to_vec(&malformed_body).expect("serialize malformed body");
    let malformed_request =
        AgentCoreRequest::parse(&malformed_bytes).expect("valid malformed avatar request");
    let malformed = execute_agent_with_native_auth(
        &database.pool,
        &verified_create_user_for_org(OTHER, &malformed_bytes),
        &malformed_request,
        &NoopNativeAuthorizer,
    )
    .await
    .expect_err("malformed avatar must be rejected");
    assert!(matches!(
        malformed,
        AgentCoreError::Http(422, ref message, _) if message == "Invalid avatar reference"
    ));

    sqlx::query("UPDATE assets SET content_type='application/octet-stream' WHERE id=$1::uuid")
        .bind(ASSET)
        .execute(&database.pool)
        .await
        .expect("make non-image avatar asset");
    let non_image_body = serde_json::json!({
        "operation": "create",
        "orgId": ORG,
        "input": {
            "name": "Non Image Avatar",
            "nodeOwned": {
                "normalizedAgentRuntimeConfig": {},
                "avatarIcon": format!("asset:{ASSET}")
            }
        }
    });
    let non_image_bytes = serde_json::to_vec(&non_image_body).expect("serialize non-image body");
    let non_image_request =
        AgentCoreRequest::parse(&non_image_bytes).expect("valid non-image avatar request");
    let non_image = execute_agent_with_native_auth(
        &database.pool,
        &verified_create_user_for_org(ORG, &non_image_bytes),
        &non_image_request,
        &NoopNativeAuthorizer,
    )
    .await
    .expect_err("non-image avatar must be rejected");
    assert!(matches!(
        non_image,
        AgentCoreError::Http(422, ref message, _) if message == "Avatar asset must be an image"
    ));

    let before_cross_org: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agents WHERE org_id=$1::uuid AND name='Cross Org Avatar'",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .expect("cross-org baseline");
    let cross_org_body = serde_json::json!({
        "operation": "create",
        "orgId": ORG,
        "input": {
            "name": "Cross Org Avatar",
            "nodeOwned": {
                "normalizedAgentRuntimeConfig": {},
                "avatarIcon": format!("asset:{FOREIGN_ASSET}")
            }
        }
    });
    let cross_org_bytes = serde_json::to_vec(&cross_org_body).expect("serialize cross-org body");
    let cross_org_request =
        AgentCoreRequest::parse(&cross_org_bytes).expect("valid cross-org request");
    let cross_org = execute_agent_with_native_auth(
        &database.pool,
        &verified_create_user_for_org(ORG, &cross_org_bytes),
        &cross_org_request,
        &NoopNativeAuthorizer,
    )
    .await
    .expect_err("cross-org avatar must be rejected");
    assert!(matches!(
        cross_org,
        AgentCoreError::Http(403, ref message, _) if message == "Avatar asset belongs to another organization"
    ));
    let after_cross_org: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agents WHERE org_id=$1::uuid AND name='Cross Org Avatar'",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .expect("cross-org rollback check");
    assert_eq!(before_cross_org, after_cross_org);

    unsafe {
        std::env::remove_var("RUDDER_AGENT_CREATE_RUST_ENABLED");
        std::env::remove_var("RUDDER_AGENT_CREATE_INTELLIGENCE_AVATAR_RUST_ENABLED");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_create_identity_slice_respects_legacy_default_profile() {
    let database = Database::start().await;
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES ($1,'Legacy User','legacy-user@example.test',now(),now())",
    )
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed legacy identity user");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES ($1::uuid,'user',$2,'member','active')",
    )
    .bind(OTHER)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed legacy identity membership");
    sqlx::query(
        "INSERT INTO organization_intelligence_profiles
         (org_id,purpose,agent_runtime_type,agent_runtime_config,status,last_error,last_verified_at)
         VALUES ($1::uuid,'lightweight','codex_local','{}'::jsonb,'configured',NULL,now())",
    )
    .bind(OTHER)
    .execute(&database.pool)
    .await
    .expect("seed legacy profile");

    let _feature_env_guard = CREATE_FEATURE_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    unsafe {
        std::env::set_var("RUDDER_AGENT_CREATE_RUST_ENABLED", "1");
        std::env::set_var("RUDDER_AGENT_CREATE_INTELLIGENCE_AVATAR_RUST_ENABLED", "1");
    }
    let body = serde_json::json!({
        "operation": "create",
        "orgId": OTHER,
        "input": {
            "name": "Legacy Resolver",
            "agentRuntimeType": "codex_local",
            "nodeOwned": {
                "normalizedAgentRuntimeConfig": {},
                "intelligenceDefaults": {
                    "status": "configured",
                    "lastVerifiedAt": "2026-10-18T01:02:03Z"
                }
            }
        }
    });
    let bytes = serde_json::to_vec(&body).expect("serialize legacy create body");
    let request = AgentCoreRequest::parse(&bytes).expect("valid legacy create request");
    execute_agent_with_native_auth(
        &database.pool,
        &verified_create_user_for_org(OTHER, &bytes),
        &request,
        &NoopNativeAuthorizer,
    )
    .await
    .expect("legacy profile does not block agent create");

    let purposes: Vec<String> = sqlx::query_scalar(
        "SELECT purpose FROM organization_intelligence_profiles WHERE org_id=$1::uuid ORDER BY purpose",
    )
    .bind(OTHER)
    .fetch_all(&database.pool)
    .await
    .expect("read legacy profile purposes");
    assert_eq!(purposes, vec!["lightweight"]);

    let invalid_body = serde_json::json!({
        "operation": "create",
        "orgId": OTHER,
        "input": {
            "name": "Non Codex Invalid",
            "agentRuntimeType": "gemini_local",
            "nodeOwned": {
                "normalizedAgentRuntimeConfig": {},
                "intelligenceDefaults": {
                    "status": "configured",
                    "lastVerifiedAt": "2026-10-18T01:02:03Z"
                }
            }
        }
    });
    let invalid_bytes = serde_json::to_vec(&invalid_body).expect("serialize invalid body");
    let invalid_request = AgentCoreRequest::parse(&invalid_bytes).expect("valid invalid request");
    let invalid = execute_agent_with_native_auth(
        &database.pool,
        &verified_create_user_for_org(OTHER, &invalid_bytes),
        &invalid_request,
        &NoopNativeAuthorizer,
    )
    .await
    .expect_err("non-codex configured profile must reject");
    assert!(matches!(
        invalid,
        AgentCoreError::Http(422, ref message, _)
            if message == "Non-codex intelligence profiles must be disabled without error"
    ));
    assert!(!sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM agents WHERE org_id=$1::uuid AND name='Non Codex Invalid')",
    )
    .bind(OTHER)
    .fetch_one(&database.pool)
    .await
    .expect("read rejected agent"));
    unsafe {
        std::env::remove_var("RUDDER_AGENT_CREATE_RUST_ENABLED");
        std::env::remove_var("RUDDER_AGENT_CREATE_INTELLIGENCE_AVATAR_RUST_ENABLED");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_create_materializes_instruction_bundle_after_commit_and_retries_safely() {
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

    let filesystem = tempfile::tempdir().expect("filesystem fixture");
    let instance_root = filesystem.path().join("instances/default");
    let workspace_home = instance_root.join("organizations");
    let previous_documents_root = filesystem.path().join("Documents/organizations");
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
            "homeDirectory": filesystem.path(),
            "processWorkingDirectory": filesystem.path(),
            "deploymentMode": "local_trusted",
            "instructionsHost": {
                "instanceRoot": instance_root,
                "workspaceHome": workspace_home,
                "previousDocumentsRoot": previous_documents_root,
                "friendlyWorkspaceHome": false,
                "hostname": "durable-bundle-test-host"
            },
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
    assert_eq!(row.3, "materialized");
    let workspace_key: String =
        sqlx::query_scalar("SELECT workspace_key FROM agents WHERE id=$1::uuid")
            .bind(&agent_id)
            .fetch_one(&database.pool)
            .await
            .expect("workspace key");
    let instructions = workspace_home
        .join("100000000000/workspaces/agents")
        .join(&workspace_key)
        .join("instructions");
    assert_eq!(
        std::fs::read_to_string(instructions.join("SOUL.md")).unwrap(),
        "# Durable"
    );
    assert_eq!(
        std::fs::read_to_string(instructions.join("nested/TOOLS.md")).unwrap(),
        "tools"
    );

    // The Agent transaction remains a 201 after a post-commit path failure.
    // Its exact outbox row stays repairable, and an authorized detail read can
    // finish projection after the obstruction is removed without creating a
    // second Agent.
    #[cfg(unix)]
    {
        let retry_fs = tempfile::tempdir().expect("retry filesystem fixture");
        let retry_instance_root = retry_fs.path().join("instances/default");
        let retry_workspace_home = retry_instance_root.join("organizations");
        let retry_previous_documents_root = retry_fs.path().join("Documents/organizations");
        std::fs::create_dir_all(&retry_workspace_home).expect("retry workspace home");
        let outside = retry_fs.path().join("outside");
        std::fs::create_dir_all(&outside).expect("outside path");
        let org_root = retry_workspace_home.join("100000000000");
        std::os::unix::fs::symlink(&outside, &org_root).expect("obstruct org root with symlink");

        unsafe {
            std::env::set_var("RUDDER_AGENT_CREATE_RUST_ENABLED", "1");
            std::env::set_var("RUDDER_AGENT_CREATE_INSTRUCTIONS_DURABLE_ENABLED", "1");
        }
        let retry_create = execute_create_body(
            &database,
            json!({
                "operation": "create",
                "orgId": ORG,
                "homeDirectory": retry_fs.path(),
                "processWorkingDirectory": retry_fs.path(),
                "deploymentMode": "local_trusted",
                "instructionsHost": {
                    "instanceRoot": retry_instance_root,
                    "workspaceHome": retry_workspace_home,
                    "previousDocumentsRoot": retry_previous_documents_root,
                    "friendlyWorkspaceHome": false,
                    "hostname": "retryable-create-test-host"
                },
                "input": {
                    "name": "Retryable Materialization",
                    "nodeOwned": {
                        "normalizedAgentRuntimeConfig": {},
                        "instructionsBundle": {
                            "entryFile": "SOUL.md",
                            "files": {"SOUL.md": "# Retryable"},
                            "clearLegacyPromptTemplate": true
                        }
                    }
                }
            }),
        )
        .await
        .expect("committed create must not surface post-commit provisioning error");
        unsafe {
            std::env::remove_var("RUDDER_AGENT_CREATE_RUST_ENABLED");
            std::env::remove_var("RUDDER_AGENT_CREATE_INSTRUCTIONS_DURABLE_ENABLED");
        }
        assert_eq!(retry_create.0, 201);
        let retry_agent_id: String = sqlx::query_scalar(
            "SELECT id::text FROM agents WHERE org_id=$1::uuid AND name='Retryable Materialization'",
        )
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .expect("committed retryable Agent");
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM agents WHERE org_id=$1::uuid AND name='Retryable Materialization'",
        )
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .expect("one committed Agent");
        assert_eq!(count, 1);
        let (state, last_error): (String, Option<String>) = sqlx::query_as(
            "SELECT state,last_error FROM agent_instruction_bundles WHERE org_id=$1::uuid AND agent_id=$2::uuid",
        )
        .bind(ORG)
        .bind(&retry_agent_id)
        .fetch_one(&database.pool)
        .await
        .expect("repairable outbox row");
        assert_eq!(state, "repair");
        assert!(
            last_error.is_some(),
            "repair failure must remain observable"
        );
        assert!(!outside.join("instructions/SOUL.md").exists());

        std::fs::remove_file(&org_root).expect("remove obstructing symlink");
        sqlx::query("UPDATE agents SET agent_runtime_config=$1::jsonb WHERE id=$2::uuid")
            .bind(json!({
                "promptTemplate": "legacy prompt",
                "bootstrapPromptTemplate": "legacy boot"
            }))
            .bind(&retry_agent_id)
            .execute(&database.pool)
            .await
            .expect("seed legacy prompt state before authorized repair");
        let retry_detail = json!({
            "operation": "detail",
            "orgId": ORG,
            "id": retry_agent_id,
            "homeDirectory": retry_fs.path(),
            "processWorkingDirectory": retry_fs.path(),
            "deploymentMode": "local_trusted",
            "instructionsHost": {
                "instanceRoot": retry_instance_root,
                "workspaceHome": retry_workspace_home,
                "previousDocumentsRoot": retry_previous_documents_root,
                "friendlyWorkspaceHome": false,
                "hostname": "retryable-create-test-host"
            }
        });
        let retry_detail_bytes = serde_json::to_vec(&retry_detail).expect("serialize retry detail");
        let retry_detail_request =
            AgentCoreRequest::parse(&retry_detail_bytes).expect("valid retry detail");
        let retry_detail_result = execute_agent_with_native_auth(
            &database.pool,
            &verified_create_user_with_body(&retry_detail_bytes),
            &retry_detail_request,
            &NoopNativeAuthorizer,
        )
        .await
        .expect("detail retry materializes the same Agent");
        assert_eq!(retry_detail_result.0, 200);
        let retry_detail_response: serde_json::Value =
            serde_json::from_str(&retry_detail_result.1).expect("repair detail JSON");
        assert!(retry_detail_response["agentRuntimeConfig"]["promptTemplate"].is_null());
        assert!(retry_detail_response["agentRuntimeConfig"]["bootstrapPromptTemplate"].is_null());
        let recovered_state: String = sqlx::query_scalar(
            "SELECT state FROM agent_instruction_bundles WHERE org_id=$1::uuid AND agent_id=$2::uuid",
        )
        .bind(ORG)
        .bind(&retry_agent_id)
        .fetch_one(&database.pool)
        .await
        .expect("recovered outbox row");
        assert_eq!(recovered_state, "materialized");
        let retry_workspace_key: String =
            sqlx::query_scalar("SELECT workspace_key FROM agents WHERE id=$1::uuid")
                .bind(&retry_agent_id)
                .fetch_one(&database.pool)
                .await
                .expect("same workspace key");
        assert_eq!(
            std::fs::read_to_string(
                retry_workspace_home
                    .join("100000000000/workspaces/agents")
                    .join(retry_workspace_key)
                    .join("instructions/SOUL.md")
            )
            .unwrap(),
            "# Retryable"
        );
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM agents WHERE org_id=$1::uuid AND name='Retryable Materialization'",
        )
        .bind(ORG)
        .fetch_one(&database.pool)
        .await
        .expect("still exactly one Agent after repair");
        assert_eq!(count, 1);
    }

    // Create materialized the bundle before returning 201. A subsequent detail
    // read remains idempotent and reports the persisted canonical paths.
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
async fn rust_create_resolves_local_encrypted_home_roots_without_persisting_plaintext() {
    let database = Database::start().await;
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES ($1,'Secret Skill User','secret-skill-user@example.test',now(),now()) ON CONFLICT (id) DO NOTHING",
    )
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed skill user");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES ($1::uuid,'user',$2,'member','active') ON CONFLICT DO NOTHING",
    )
    .bind(ORG)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed skill membership");

    let home = tempfile::tempdir().expect("secret HOME root");
    let codex_home = tempfile::tempdir().expect("secret CODEX_HOME root");
    let home_skill = home.path().join(".agents/skills/home-secret/SKILL.md");
    let codex_skill = codex_home.path().join("skills/codex-secret/SKILL.md");
    fs::create_dir_all(home_skill.parent().expect("HOME skill directory"))
        .expect("create HOME skill directory");
    fs::create_dir_all(codex_skill.parent().expect("Codex skill directory"))
        .expect("create Codex skill directory");
    fs::write(&home_skill, "# Home secret skill\n").expect("write HOME skill");
    fs::write(&codex_skill, "# Codex secret skill\n").expect("write Codex skill");

    for (secret_id, name, value) in [
        (
            SKILL_HOME_SECRET_ID,
            "skill-home",
            home.path().to_string_lossy(),
        ),
        (
            SKILL_CODEX_HOME_SECRET_ID,
            "skill-codex-home",
            codex_home.path().to_string_lossy(),
        ),
    ] {
        let (material, value_sha256) = local_secret_material(&value);
        sqlx::query(
            "INSERT INTO organization_secrets(id,org_id,name,provider,purpose,latest_version,created_by_user_id) VALUES ($1::uuid,$2::uuid,$3,'local_encrypted','user_managed',1,$4)",
        )
        .bind(secret_id)
        .bind(ORG)
        .bind(name)
        .bind(CREATE_USER)
        .execute(&database.pool)
        .await
        .expect("seed local encrypted secret");
        sqlx::query(
            "INSERT INTO organization_secret_versions(secret_id,version,material,value_sha256,created_by_user_id) VALUES ($1::uuid,1,$2::jsonb,$3,$4)",
        )
        .bind(secret_id)
        .bind(material.to_string())
        .bind(value_sha256)
        .bind(CREATE_USER)
        .execute(&database.pool)
        .await
        .expect("seed encrypted secret version");
    }
    sqlx::query(
        "INSERT INTO organization_secrets(id,org_id,name,provider,purpose,latest_version,created_by_user_id) VALUES ($1::uuid,$2,'external-skill-home','vault','user_managed',1,$3)",
    )
    .bind(EXTERNAL_SKILL_HOME_SECRET_ID)
    .bind(ORG)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed external provider secret");
    sqlx::query(
        "INSERT INTO organization_secret_versions(secret_id,version,material,value_sha256,created_by_user_id) VALUES ($1::uuid,1,'{}'::jsonb,$2,$3)",
    )
    .bind(EXTERNAL_SKILL_HOME_SECRET_ID)
    .bind("0".repeat(64))
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed external provider secret version");

    let _feature_env_guard = CREATE_FEATURE_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    let _create_feature = RestoreEnvironmentVariable::set("RUDDER_AGENT_CREATE_RUST_ENABLED", "1");
    let _master_key = RestoreEnvironmentVariable::set(
        "RUDDER_SECRETS_MASTER_KEY",
        "01234567890123456789012345678901",
    );
    let result = execute_create_body(
        &database,
        json!({
            "operation":"create",
            "orgId":ORG,
            "input":{
                "name":"Secret Root Skills",
                "agentRuntimeType":"codex_local",
                "agentRuntimeConfig":{
                    "env":{
                        "HOME":{"type":"secret_ref","secretId":SKILL_HOME_SECRET_ID},
                        "CODEX_HOME":{"type":"secret_ref","secretId":SKILL_CODEX_HOME_SECRET_ID}
                    }
                },
                "desiredSkills":["global:home-secret","adapter:codex_local:codex-secret"]
            }
        }),
    )
    .await
    .expect("Create resolves local encrypted skill roots");

    assert_eq!(result.0, 201);
    let response: serde_json::Value = serde_json::from_str(&result.1).expect("response JSON");
    let agent_id = response["id"].as_str().expect("created Agent id");
    let assigned = sqlx::query_scalar::<_, String>(
        "SELECT skill_key FROM agent_enabled_skills WHERE org_id=$1::uuid AND agent_id=$2::uuid ORDER BY skill_key",
    )
    .bind(ORG)
    .bind(agent_id)
    .fetch_all(&database.pool)
    .await
    .expect("assigned secret-root skills");
    assert_eq!(
        assigned,
        ["adapter:codex_local:codex-secret", "global:home-secret"]
    );
    let config = sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT agent_runtime_config FROM agents WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(agent_id)
    .fetch_one(&database.pool)
    .await
    .expect("persisted runtime config");
    assert_eq!(config["env"]["HOME"]["type"], "secret_ref");
    assert_eq!(config["env"]["CODEX_HOME"]["type"], "secret_ref");
    assert!(
        !config
            .to_string()
            .contains(home.path().to_string_lossy().as_ref())
    );
    assert!(
        !config
            .to_string()
            .contains(codex_home.path().to_string_lossy().as_ref())
    );
    assert!(!result.1.contains(home.path().to_string_lossy().as_ref()));
    assert!(
        !result
            .1
            .contains(codex_home.path().to_string_lossy().as_ref())
    );

    let external_secret_result = execute_create_body(
        &database,
        json!({
            "operation":"create",
            "orgId":ORG,
            "input":{
                "name":"External Skill Root",
                "agentRuntimeType":"codex_local",
                "agentRuntimeConfig":{
                    "env":{"HOME":{"type":"secret_ref","secretId":EXTERNAL_SKILL_HOME_SECRET_ID}}
                },
                "desiredSkills":["global:home-secret"]
            }
        }),
    )
    .await;
    assert!(
        matches!(
            external_secret_result,
            Err(AgentCoreError::Http(422, ref message, _))
                if message == "vault provider is not configured in this deployment"
        ),
        "external secret references preserve the provider's 422 diagnostic: {external_secret_result:?}"
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

#[cfg(unix)]
fn verified_public_create_user_for_org(org: &str, body: &[u8]) -> VerifiedActor {
    let actor = ActorIdentity::new("user", CREATE_USER).expect("valid board user identity");
    let path = format!("/api/orgs/{org}/agents");
    let request_id = "agent-core-public-create-request";
    let nonce = "agent-core-public-create-nonce";
    let envelope = ActorEnvelope::new(
        actor.clone(),
        org,
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
    .expect("unsigned public Agent-create envelope")
    .sign(SECRET)
    .expect("signed public Agent-create envelope");
    let request = RequestContext::new(
        &actor,
        org,
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
        .expect("verified public Agent-create actor")
}

#[cfg(unix)]
async fn seed_public_create_membership(database: &Database) {
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES ($1,'Seed User','seed-user@example.test',now(),now())",
    )
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed public-create user");
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES ($1::uuid,'user',$2,'member','active')",
    )
    .bind(OTHER)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed public-create membership");
    sqlx::query(
        "INSERT INTO principal_permission_grants(org_id,principal_type,principal_id,permission_key) VALUES ($1::uuid,'user',$2,'agents:create')",
    )
    .bind(OTHER)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("grant public-create permission");
}

#[cfg(unix)]
fn write_probe_script(path: &Path, script: &str) {
    use std::os::unix::fs::PermissionsExt;

    fs::write(path, script).expect("write synthetic Codex executable");
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .expect("make synthetic Codex executable");
}

#[cfg(unix)]
async fn execute_public_seed_create(
    database: &Database,
    name: &str,
    command: &Path,
    model_fallbacks: serde_json::Value,
    environment: serde_json::Value,
) -> Result<(u16, String), AgentCoreError> {
    execute_public_seed_create_for_runtime(
        database,
        name,
        "codex_local",
        command,
        model_fallbacks,
        environment,
    )
    .await
}

#[cfg(unix)]
async fn execute_public_seed_create_for_runtime(
    database: &Database,
    name: &str,
    runtime_type: &str,
    command: &Path,
    model_fallbacks: serde_json::Value,
    environment: serde_json::Value,
) -> Result<(u16, String), AgentCoreError> {
    let command = command.to_string_lossy().into_owned();
    let input = normalize_public_agent_create_input(Some(json!({
        "name": name,
        "agentRuntimeType": runtime_type,
        "agentRuntimeConfig": {
            "command": command,
            "env": environment,
            "modelFallbacks": model_fallbacks
        },
        "seedOrganizationIntelligenceDefaults": true
    })))
    .expect("normalize public Agent-create input");
    let bytes = serde_json::to_vec(&json!({
        "operation": "create",
        "orgId": OTHER,
        "input": input
    }))
    .expect("serialize normalized public Agent-create request");
    let request =
        AgentCoreRequest::parse(&bytes).expect("parse normalized public Agent-create request");
    execute_public_agent_create_with_native_auth(
        &database.pool,
        &verified_public_create_user_for_org(OTHER, &bytes),
        &request,
        &NoopNativeAuthorizer,
    )
    .await
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn public_first_agent_seed_runs_codex_and_process_fallback_without_persisting_secret_plaintext()
 {
    let database = Database::start().await;
    seed_public_create_membership(&database).await;

    let temp = tempfile::tempdir().expect("public seed runtime fixture");
    let operator_home = temp.path().join("operator-home");
    fs::create_dir_all(&operator_home).expect("create isolated operator home");
    let source_codex_home = temp.path().join("source-codex-home");
    fs::create_dir_all(&source_codex_home).expect("create source Codex home");
    let source_codex_config =
        "[mcp_servers.rudder-tools]\ncommand = \"rudder\"\nargs = [\"mcp-server\"]\n";
    fs::write(source_codex_home.join("config.toml"), source_codex_config)
        .expect("write source Codex MCP config");
    let codex = temp.path().join("codex");
    write_probe_script(
        &codex,
        r###"#!/bin/sh
MCP_COMMAND=$(awk '
/^\[mcp_servers\.rudder-tools\]$/ { in_rudder=1; next }
/^\[/ { in_rudder=0 }
in_rudder && /^command = / { sub(/^command = "/, ""); sub(/"$/, ""); print; exit }
' "$CODEX_HOME/config.toml")
case "$MCP_COMMAND" in */rudder-native|*/rudder-cli) ;; *) echo "untrusted MCP command: $MCP_COMMAND" >&2; exit 3;; esac
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"seed-probe","version":"1"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | "$MCP_COMMAND" mcp-server > "$CODEX_HOME/native-tools.jsonl" || exit 4
grep -q '"name":"rudder_issue_search"' "$CODEX_HOME/native-tools.jsonl" || { echo "Rust MCP issue tool missing" >&2; exit 5; }
grep -q '"name":"rudder_agent_skills_create"' "$CODEX_HOME/native-tools.jsonl" || { echo "Rust MCP Skill tool missing" >&2; exit 6; }
cat >/dev/null
if [ "$OPENAI_API_KEY" != "seed-probe-secret-value" ]; then echo missing-secret >&2; exit 2; fi
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}' '{"type":"turn.completed"}'
"###,
    );
    let (material, value_sha256) = local_secret_material("seed-probe-secret-value");
    sqlx::query(
        "INSERT INTO organization_secrets(id,org_id,name,provider,purpose,latest_version,created_by_user_id) VALUES ($1::uuid,$2::uuid,'seed-probe','local_encrypted','user_managed',1,$3)",
    )
    .bind(SKILL_HOME_SECRET_ID)
    .bind(OTHER)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed runtime-chain secret");
    sqlx::query(
        "INSERT INTO organization_secret_versions(secret_id,version,material,value_sha256,created_by_user_id) VALUES ($1::uuid,1,$2::jsonb,$3,$4)",
    )
    .bind(SKILL_HOME_SECRET_ID)
    .bind(material.to_string())
    .bind(value_sha256)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed runtime-chain secret version");

    let _feature_env_guard = CREATE_FEATURE_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    let _operator_home = RestoreEnvironmentVariable::set(
        "RUDDER_OPERATOR_HOME",
        operator_home.to_str().expect("operator home path"),
    );
    let _rudder_home = RestoreEnvironmentVariable::set(
        "RUDDER_HOME",
        temp.path()
            .join("rudder-home")
            .to_str()
            .expect("Rudder home path"),
    );
    let _master_key = RestoreEnvironmentVariable::set(
        "RUDDER_SECRETS_MASTER_KEY",
        "01234567890123456789012345678901",
    );
    let result = execute_public_seed_create(
        &database,
        "Public seeded Agent",
        &codex,
        json!([{
            "agentRuntimeType": "process",
            "model": "fallback-check",
            "config": {"command": codex.to_string_lossy().into_owned()}
        }]),
        json!({
            "OPENAI_API_KEY": {"type": "secret_ref", "secretId": SKILL_HOME_SECRET_ID},
            "CODEX_HOME": source_codex_home.to_string_lossy()
        }),
    )
    .await
    .expect("public seeded create");
    assert_eq!(result.0, 201, "{}", result.1);

    let profile: (serde_json::Value, String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT agent_runtime_config,status,last_error,last_verified_at::text FROM organization_intelligence_profiles WHERE org_id=$1::uuid AND purpose='default'",
    )
    .bind(OTHER)
    .fetch_one(&database.pool)
    .await
    .expect("persisted seeded profile");
    assert_eq!(profile.0["env"]["OPENAI_API_KEY"]["type"], "secret_ref");
    assert_eq!(profile.1, "configured");
    assert_eq!(profile.2, None);
    assert!(profile.3.is_some());
    assert!(!profile.0.to_string().contains("seed-probe-secret-value"));
    assert!(!result.1.contains("seed-probe-secret-value"));
    assert_eq!(
        fs::read_to_string(source_codex_home.join("config.toml")).unwrap(),
        source_codex_config,
        "configured Codex source must remain untouched"
    );
    let managed_codex_config = temp
        .path()
        .join("rudder-home/instances/default/organizations/100000000000/codex-home/config.toml");
    let managed_codex_config = fs::read_to_string(managed_codex_config)
        .expect("managed Codex config with trusted native MCP command");
    assert!(managed_codex_config.contains("[mcp_servers.rudder-tools]"));
    assert!(!managed_codex_config.contains("command = \"rudder\""));
    assert!(managed_codex_config.contains("command = \""));

    let fallback_agent_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agents WHERE org_id=$1::uuid AND name='Public seeded Agent')",
    )
    .bind(OTHER)
    .fetch_one(&database.pool)
    .await
    .expect("created public Agent");
    assert!(fallback_agent_exists);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn public_first_agent_seed_persists_invalid_profile_for_runtime_auth_warning() {
    let database = Database::start().await;
    seed_public_create_membership(&database).await;

    let temp = tempfile::tempdir().expect("public seed runtime failure fixture");
    let operator_home = temp.path().join("operator-home");
    fs::create_dir_all(&operator_home).expect("create isolated operator home");
    let codex = temp.path().join("codex");
    write_probe_script(
        &codex,
        "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{\"type\":\"error\",\"message\":\"authentication required\"}' >&2\nexit 1\n",
    );

    let _feature_env_guard = CREATE_FEATURE_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    let _operator_home = RestoreEnvironmentVariable::set(
        "RUDDER_OPERATOR_HOME",
        operator_home.to_str().expect("operator home path"),
    );
    let _rudder_home = RestoreEnvironmentVariable::set(
        "RUDDER_HOME",
        temp.path()
            .join("rudder-home")
            .to_str()
            .expect("Rudder home path"),
    );
    let result = execute_public_seed_create(
        &database,
        "Invalid seeded Agent",
        &codex,
        json!([]),
        json!({}),
    )
    .await
    .expect("runtime warning should persist as an invalid default, not abort Agent creation");
    assert_eq!(result.0, 201, "{}", result.1);
    let profile: (String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT status,last_error,last_verified_at::text FROM organization_intelligence_profiles WHERE org_id=$1::uuid AND purpose='default'",
    )
    .bind(OTHER)
    .fetch_one(&database.pool)
    .await
    .expect("persisted invalid profile");
    assert_eq!(profile.0, "invalid");
    assert_eq!(
        profile.1.as_deref(),
        Some("Runtime chain test failed for Primary: Runtime environment returned warn status.")
    );
    assert_eq!(profile.2, None);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn public_first_agent_seed_records_secret_resolution_failure_without_launching_probe() {
    let database = Database::start().await;
    seed_public_create_membership(&database).await;

    let temp = tempfile::tempdir().expect("public seed secret-resolution fixture");
    let operator_home = temp.path().join("operator-home");
    fs::create_dir_all(&operator_home).expect("create isolated operator home");
    let codex = temp.path().join("codex");
    let launched = temp.path().join("codex-launched");
    write_probe_script(
        &codex,
        &format!("#!/bin/sh\ntouch '{}'\nexit 0\n", launched.display()),
    );
    let (material, value_sha256) = local_secret_material("secret-value-must-not-persist");
    sqlx::query(
        "INSERT INTO organization_secrets(id,org_id,name,provider,purpose,latest_version,created_by_user_id) VALUES ($1::uuid,$2::uuid,'seed-probe','local_encrypted','user_managed',1,$3)",
    )
    .bind(SKILL_HOME_SECRET_ID)
    .bind(OTHER)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed runtime-chain secret");
    sqlx::query(
        "INSERT INTO organization_secret_versions(secret_id,version,material,value_sha256,created_by_user_id) VALUES ($1::uuid,1,$2::jsonb,$3,$4)",
    )
    .bind(SKILL_HOME_SECRET_ID)
    .bind(material.to_string())
    .bind(value_sha256)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed runtime-chain secret version");

    let _feature_env_guard = CREATE_FEATURE_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    let _operator_home = RestoreEnvironmentVariable::set(
        "RUDDER_OPERATOR_HOME",
        operator_home.to_str().expect("operator home path"),
    );
    let _rudder_home = RestoreEnvironmentVariable::set(
        "RUDDER_HOME",
        temp.path()
            .join("rudder-home")
            .to_str()
            .expect("Rudder home path"),
    );
    let _wrong_master_key = RestoreEnvironmentVariable::set(
        "RUDDER_SECRETS_MASTER_KEY",
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    let result = execute_public_seed_create(
        &database,
        "Secret failure seeded Agent",
        &codex,
        json!([]),
        json!({
            "OPENAI_API_KEY": {"type": "secret_ref", "secretId": SKILL_HOME_SECRET_ID}
        }),
    )
    .await
    .expect("secret-resolution failure should persist as an invalid profile");
    assert_eq!(result.0, 201, "{}", result.1);
    assert!(
        !launched.exists(),
        "the CLI must not run after secret resolution fails"
    );

    let profile: (serde_json::Value, String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT agent_runtime_config,status,last_error,last_verified_at::text FROM organization_intelligence_profiles WHERE org_id=$1::uuid AND purpose='default'",
    )
    .bind(OTHER)
    .fetch_one(&database.pool)
    .await
    .expect("persisted invalid profile after secret resolution failure");
    assert_eq!(profile.0["env"]["OPENAI_API_KEY"]["type"], "secret_ref");
    assert_eq!(profile.1, "invalid");
    assert_eq!(
        profile.2.as_deref(),
        Some("Secret provider is not configured in this deployment"),
        "the unresolved local secret_ref should persist its diagnostic"
    );
    assert_eq!(profile.3, None);
    assert!(
        !profile
            .0
            .to_string()
            .contains("secret-value-must-not-persist")
    );
    assert!(!result.1.contains("secret-value-must-not-persist"));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn public_first_agent_seed_preserves_external_secret_provider_diagnostic() {
    let database = Database::start().await;
    seed_public_create_membership(&database).await;

    let temp = tempfile::tempdir().expect("public external secret fixture");
    let operator_home = temp.path().join("operator-home");
    fs::create_dir_all(&operator_home).expect("create isolated operator home");
    let codex = temp.path().join("codex");
    let launched = temp.path().join("codex-launched");
    write_probe_script(
        &codex,
        &format!("#!/bin/sh\ntouch '{}'\nexit 0\n", launched.display()),
    );
    sqlx::query(
        "INSERT INTO organization_secrets(id,org_id,name,provider,purpose,latest_version,created_by_user_id) VALUES ($1::uuid,$2::uuid,'external-seed','aws_secrets_manager','user_managed',1,$3)",
    )
    .bind(SKILL_HOME_SECRET_ID)
    .bind(OTHER)
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed external provider secret");
    sqlx::query(
        "INSERT INTO organization_secret_versions(secret_id,version,material,value_sha256,created_by_user_id) VALUES ($1::uuid,1,'{}'::jsonb,$2,$3)",
    )
    .bind(SKILL_HOME_SECRET_ID)
    .bind("0".repeat(64))
    .bind(CREATE_USER)
    .execute(&database.pool)
    .await
    .expect("seed external provider secret version");

    let _feature_env_guard = CREATE_FEATURE_ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .await;
    let _operator_home = RestoreEnvironmentVariable::set(
        "RUDDER_OPERATOR_HOME",
        operator_home.to_str().expect("operator home path"),
    );
    let _rudder_home = RestoreEnvironmentVariable::set(
        "RUDDER_HOME",
        temp.path()
            .join("rudder-home")
            .to_str()
            .expect("Rudder home path"),
    );
    let result = execute_public_seed_create(
        &database,
        "External secret seeded Agent",
        &codex,
        json!([]),
        json!({
            "OPENAI_API_KEY": {"type": "secret_ref", "secretId": SKILL_HOME_SECRET_ID}
        }),
    )
    .await
    .expect("external provider warning should persist as an invalid default");
    assert_eq!(result.0, 201, "{}", result.1);
    assert!(!launched.exists(), "the Codex CLI must not run");

    let profile: (serde_json::Value, String, Option<String>) = sqlx::query_as(
        "SELECT agent_runtime_config,status,last_error FROM organization_intelligence_profiles WHERE org_id=$1::uuid AND purpose='default'",
    )
    .bind(OTHER)
    .fetch_one(&database.pool)
    .await
    .expect("persisted external-provider profile");
    assert_eq!(profile.0["env"]["OPENAI_API_KEY"]["type"], "secret_ref");
    assert_eq!(profile.1, "invalid");
    assert_eq!(
        profile.2.as_deref(),
        Some("aws_secrets_manager provider is not configured in this deployment")
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn public_non_codex_first_agent_seed_persists_disabled_without_running_cli() {
    let database = Database::start().await;
    seed_public_create_membership(&database).await;

    let temp = tempfile::tempdir().expect("public non-Codex seed runtime fixture");
    let command = temp.path().join("process-probe");
    let launched = temp.path().join("process-launched");
    write_probe_script(
        &command,
        &format!("#!/bin/sh\ntouch '{}'\nexit 0\n", launched.display()),
    );

    let result = execute_public_seed_create_for_runtime(
        &database,
        "Non-Codex seeded Agent",
        "process",
        &command,
        json!([]),
        json!({}),
    )
    .await
    .expect("non-Codex create should not run the Codex preflight");
    assert_eq!(result.0, 201, "{}", result.1);
    assert!(
        !launched.exists(),
        "a non-Codex seed must not run a CLI probe"
    );

    let profile: (String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT status,last_error,last_verified_at::text FROM organization_intelligence_profiles WHERE org_id=$1::uuid AND purpose='default'",
    )
    .bind(OTHER)
    .fetch_one(&database.pool)
    .await
    .expect("persisted disabled profile for non-Codex first Agent");
    assert_eq!(profile, ("disabled".to_owned(), None, None));
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn public_seed_with_existing_default_profile_skips_codex_probe() {
    let database = Database::start().await;
    seed_public_create_membership(&database).await;
    sqlx::query(
        "INSERT INTO organization_intelligence_profiles(org_id,purpose,agent_runtime_type,agent_runtime_config,status) VALUES ($1::uuid,'default','codex_local',$2::jsonb,'disabled')",
    )
    .bind(OTHER)
    .bind(json!({"model":"preserved-default-model"}).to_string())
    .execute(&database.pool)
    .await
    .expect("seed existing default intelligence profile");

    let temp = tempfile::tempdir().expect("existing-profile seed runtime fixture");
    let codex = temp.path().join("codex");
    let launched = temp.path().join("codex-launched");
    write_probe_script(
        &codex,
        &format!("#!/bin/sh\ntouch '{}'\nexit 0\n", launched.display()),
    );
    let result = execute_public_seed_create(
        &database,
        "Agent with existing default profile",
        &codex,
        json!([]),
        json!({}),
    )
    .await
    .expect("existing default profile should skip preflight");
    assert_eq!(result.0, 201, "{}", result.1);
    assert!(
        !launched.exists(),
        "existing default must short-circuit the probe"
    );

    let profile: (serde_json::Value, String, String) = sqlx::query_as(
        "SELECT agent_runtime_config,status,purpose FROM organization_intelligence_profiles WHERE org_id=$1::uuid AND purpose='default'",
    )
    .bind(OTHER)
    .fetch_one(&database.pool)
    .await
    .expect("existing default profile remains present");
    assert_eq!(profile.0["model"], "preserved-default-model");
    assert_eq!(profile.1, "disabled");
    assert_eq!(profile.2, "default");
}
