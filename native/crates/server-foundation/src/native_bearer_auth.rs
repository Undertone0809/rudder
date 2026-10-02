//! Native resolution for persisted Rudder bearer API keys.
//!
//! This is deliberately limited to `pcp_` API keys. Cookie sessions, local
//! Agent JWTs, and local-trusted/local-implicit identities remain on the
//! explicit private-Node compatibility path in public ingress.

use super::{ActorIdentity, AppState, DatabaseState};
use sha2::{Digest, Sha256};
use sqlx::{Pool, Postgres};

#[derive(Debug)]
pub(super) enum NativeBearerResolution {
    Compatibility,
    Authorized {
        actor: ActorIdentity,
        session_id: String,
    },
    Unauthorized,
    Forbidden,
    DatabaseDisabled,
    Unavailable,
}

pub(super) fn is_native_bearer(token: &str) -> bool {
    token.starts_with("pcp_")
}

pub(super) fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut encoded = String::with_capacity(digest.len() * 2);
    use std::fmt::Write as _;
    for byte in digest.iter() {
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

impl AppState {
    pub(super) async fn resolve_native_bearer(
        &self,
        token: &str,
        requested_org_id: &str,
    ) -> NativeBearerResolution {
        if !is_native_bearer(token) {
            return NativeBearerResolution::Compatibility;
        }

        let DatabaseState::Configured(pool) = &self.database else {
            return NativeBearerResolution::DatabaseDisabled;
        };
        match resolve(pool, token, requested_org_id).await {
            Ok(resolution) => resolution,
            Err(_) => NativeBearerResolution::Unavailable,
        }
    }
}

async fn resolve(
    pool: &Pool<Postgres>,
    token: &str,
    requested_org_id: &str,
) -> Result<NativeBearerResolution, sqlx::Error> {
    let token_hash = hash_token(token);

    // Node checks board keys first, then agent keys. Preserve that precedence
    // (including falling through when a board row has no corresponding user).
    if let Some(board) = resolve_board_key(pool, &token_hash, requested_org_id).await? {
        return Ok(board);
    }
    if let Some(agent) = resolve_agent_key(pool, &token_hash, requested_org_id).await? {
        return Ok(agent);
    }

    // A recognized native credential never falls through to the Node grant
    // adapter, even when it is unknown, revoked, expired, or otherwise denied.
    Ok(NativeBearerResolution::Unauthorized)
}

async fn resolve_board_key(
    pool: &Pool<Postgres>,
    token_hash: &str,
    requested_org_id: &str,
) -> Result<Option<NativeBearerResolution>, sqlx::Error> {
    let key = sqlx::query_as::<_, (String, String)>(
        r#"
        SELECT id::text, user_id
        FROM board_api_keys
        WHERE key_hash = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > clock_timestamp())
        LIMIT 1
        "#,
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?;
    let Some((key_id, user_id)) = key else {
        return Ok(None);
    };

    let user_exists: bool =
        sqlx::query_scalar(r#"SELECT EXISTS (SELECT 1 FROM "user" WHERE id = $1)"#)
            .bind(&user_id)
            .fetch_one(pool)
            .await?;
    // The Node middleware tries an agent key if the Board key's user row is
    // absent (possible only during legacy/manual data repair or deletion race).
    if !user_exists {
        return Ok(None);
    }

    let (is_instance_admin, has_membership): (bool, bool) = sqlx::query_as(
        r#"
        SELECT
          EXISTS (
            SELECT 1 FROM instance_user_roles
            WHERE user_id = $1 AND role = 'instance_admin'
          ),
          EXISTS (
            SELECT 1 FROM organization_memberships
            WHERE principal_type = 'user'
              AND principal_id = $1
              AND status = 'active'
              AND org_id::text = $2
          )
        "#,
    )
    .bind(&user_id)
    .bind(requested_org_id)
    .fetch_one(pool)
    .await?;

    // Match the existing Board-key touch order: a known key belonging to an
    // existing user is touched before organization-scope denial. The guarded
    // update also makes a concurrent revoke/expiry win if it commits first.
    let touched = sqlx::query(
        r#"
        UPDATE board_api_keys
        SET last_used_at = clock_timestamp()
        WHERE id = $1::uuid
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > clock_timestamp())
        "#,
    )
    .bind(&key_id)
    .execute(pool)
    .await?
    .rows_affected();
    if touched != 1 {
        return Ok(Some(NativeBearerResolution::Unauthorized));
    }

    if !is_instance_admin && !has_membership {
        return Ok(Some(NativeBearerResolution::Forbidden));
    }

    let actor = match ActorIdentity::new("user", &user_id) {
        Ok(actor) => actor,
        Err(_) => return Ok(Some(NativeBearerResolution::Unauthorized)),
    };
    Ok(Some(NativeBearerResolution::Authorized {
        actor,
        session_id: format!("board-key:{key_id}"),
    }))
}

async fn resolve_agent_key(
    pool: &Pool<Postgres>,
    token_hash: &str,
    requested_org_id: &str,
) -> Result<Option<NativeBearerResolution>, sqlx::Error> {
    let key = sqlx::query_as::<_, (String, String, String)>(
        r#"
        SELECT id::text, agent_id::text, org_id::text
        FROM agent_api_keys
        WHERE key_hash = $1 AND revoked_at IS NULL
        LIMIT 1
        "#,
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?;
    let Some((key_id, agent_id, key_org_id)) = key else {
        return Ok(None);
    };

    // Node touches a valid, non-revoked agent key before checking agent status.
    // Keep that observable side effect, while preventing a concurrent revoke
    // from being overwritten or authenticated after it has committed.
    let touched = sqlx::query(
        r#"
        UPDATE agent_api_keys
        SET last_used_at = clock_timestamp()
        WHERE id = $1::uuid AND revoked_at IS NULL
        "#,
    )
    .bind(&key_id)
    .execute(pool)
    .await?
    .rows_affected();
    if touched != 1 {
        return Ok(Some(NativeBearerResolution::Unauthorized));
    }

    let agent = sqlx::query_as::<_, (String, String)>(
        "SELECT org_id::text, status FROM agents WHERE id = $1::uuid LIMIT 1",
    )
    .bind(&agent_id)
    .fetch_optional(pool)
    .await?;
    let Some((agent_org_id, status)) = agent else {
        return Ok(Some(NativeBearerResolution::Unauthorized));
    };

    if status == "terminated" || status == "pending_approval" {
        return Ok(Some(NativeBearerResolution::Unauthorized));
    }
    // Fail closed on inconsistent legacy data rather than letting the key's
    // org claim diverge from its owning agent.
    if key_org_id != agent_org_id || key_org_id != requested_org_id {
        return Ok(Some(NativeBearerResolution::Forbidden));
    }

    let actor = match ActorIdentity::new("agent", &agent_id) {
        Ok(actor) => actor,
        Err(_) => return Ok(Some(NativeBearerResolution::Unauthorized)),
    };
    Ok(Some(NativeBearerResolution::Authorized {
        actor,
        session_id: format!("agent-key:{key_id}"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Pool, Postgres, postgres::PgPoolOptions};
    use std::{env, time::Duration};
    use uuid::Uuid;

    #[test]
    fn only_rudder_native_api_key_prefixes_enter_the_fail_closed_path() {
        for token in [
            "pcp_board_secret",
            "pcp_agent_secret",
            "pcp_cli_auth_secret",
        ] {
            assert!(is_native_bearer(token));
        }
        for token in ["", "Bearer pcp_secret", "synthetic-invalid-jwt", "other"] {
            assert!(!is_native_bearer(token));
        }
        assert_eq!(
            hash_token("pcp_example"),
            "416e146654fabbed34677878b10e0947b89905541cbab16da13528b6508e0dab"
        );
    }

    async fn disposable_test_pool() -> Pool<Postgres> {
        let url = env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL")
            .expect("set RUDDER_NATIVE_AUTH_TEST_DATABASE_URL to a migrated disposable DB");
        let parsed = url::Url::parse(&url).expect("test database URL must be valid");
        let database_name = parsed.path().trim_start_matches('/').to_ascii_lowercase();
        assert!(
            database_name.contains("test"),
            "refusing auth fixtures unless database name contains 'test'"
        );
        PgPoolOptions::new()
            .max_connections(4)
            .acquire_timeout(Duration::from_secs(3))
            .connect(&url)
            .await
            .expect("connect to the migrated disposable test database")
    }

    async fn insert_org(pool: &Pool<Postgres>) -> String {
        let suffix = Uuid::new_v4().simple().to_string();
        sqlx::query_scalar(
            "INSERT INTO organizations (url_key, name, issue_prefix) VALUES ($1, $2, $3) RETURNING id::text",
        )
        .bind(format!("native-auth-{suffix}"))
        .bind(format!("Native auth {suffix}"))
        .bind(format!("N{}", suffix[..7].to_ascii_uppercase()))
        .fetch_one(pool)
        .await
        .unwrap()
    }

    async fn insert_board_key(
        pool: &Pool<Postgres>,
        user_id: &str,
        token: &str,
        expired: bool,
        revoked: bool,
    ) -> String {
        let query = match (expired, revoked) {
            (true, true) => {
                "INSERT INTO board_api_keys (user_id, name, key_hash, expires_at, revoked_at) VALUES ($1, 'native test', $2, now() - interval '1 second', now()) RETURNING id::text"
            }
            (true, false) => {
                "INSERT INTO board_api_keys (user_id, name, key_hash, expires_at) VALUES ($1, 'native test', $2, now() - interval '1 second') RETURNING id::text"
            }
            (false, true) => {
                "INSERT INTO board_api_keys (user_id, name, key_hash, revoked_at) VALUES ($1, 'native test', $2, now()) RETURNING id::text"
            }
            (false, false) => {
                "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'native test', $2) RETURNING id::text"
            }
        };
        sqlx::query_scalar(query)
            .bind(user_id)
            .bind(hash_token(token))
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn last_used_is_set(pool: &Pool<Postgres>, table: &str, id: &str) -> bool {
        // `table` is supplied only by the fixed test call sites below.
        sqlx::query_scalar::<_, bool>(&format!(
            "SELECT last_used_at IS NOT NULL FROM {table} WHERE id = $1::uuid"
        ))
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    #[tokio::test]
    #[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB"]
    async fn postgres_bearer_resolution_preserves_scope_status_expiry_and_touch_contracts() {
        let pool = disposable_test_pool().await;
        let org_a = insert_org(&pool).await;
        let org_b = insert_org(&pool).await;
        let user_id = format!("native-auth-user-{}", Uuid::new_v4());
        sqlx::query(
            r#"INSERT INTO "user" (id, name, email, created_at, updated_at)
               VALUES ($1, 'Native Test User', $2, now(), now())"#,
        )
        .bind(&user_id)
        .bind(format!("{user_id}@invalid.test"))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO organization_memberships (org_id, principal_type, principal_id, status) VALUES ($1::uuid, 'user', $2, 'active')",
        )
        .bind(&org_a)
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();

        let board_token = format!("pcp_board_{}", Uuid::new_v4().simple());
        let board_id = insert_board_key(&pool, &user_id, &board_token, false, false).await;
        let resolved = resolve(&pool, &board_token, &org_a).await.unwrap();
        assert!(
            matches!(resolved, NativeBearerResolution::Authorized { actor, .. } if actor.kind == "user" && actor.id == user_id)
        );
        assert!(last_used_is_set(&pool, "board_api_keys", &board_id).await);

        assert!(matches!(
            resolve(&pool, &board_token, &org_b).await.unwrap(),
            NativeBearerResolution::Forbidden
        ));

        // Keep the non-admin/no-membership denial case ahead of the admin
        // grant below; instance admins intentionally bypass organization
        // membership checks.
        let no_scope_token = format!("pcp_board_{}", Uuid::new_v4().simple());
        let no_scope_id = insert_board_key(&pool, &user_id, &no_scope_token, false, false).await;
        assert!(matches!(
            resolve(&pool, &no_scope_token, &org_b).await.unwrap(),
            NativeBearerResolution::Forbidden
        ));
        assert!(last_used_is_set(&pool, "board_api_keys", &no_scope_id).await);

        sqlx::query(
            "INSERT INTO instance_user_roles (user_id, role) VALUES ($1, 'instance_admin')",
        )
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();
        assert!(matches!(
            resolve(&pool, &board_token, &org_b).await.unwrap(),
            NativeBearerResolution::Authorized { .. }
        ));

        let expired_token = format!("pcp_board_{}", Uuid::new_v4().simple());
        let expired_id = insert_board_key(&pool, &user_id, &expired_token, true, false).await;
        assert!(matches!(
            resolve(&pool, &expired_token, &org_a).await.unwrap(),
            NativeBearerResolution::Unauthorized
        ));
        assert!(!last_used_is_set(&pool, "board_api_keys", &expired_id).await);
        let revoked_token = format!("pcp_board_{}", Uuid::new_v4().simple());
        let revoked_id = insert_board_key(&pool, &user_id, &revoked_token, false, true).await;
        assert!(matches!(
            resolve(&pool, &revoked_token, &org_a).await.unwrap(),
            NativeBearerResolution::Unauthorized
        ));
        assert!(!last_used_is_set(&pool, "board_api_keys", &revoked_id).await);

        let agent_id: String = sqlx::query_scalar(
            "INSERT INTO agents (org_id, name, status) VALUES ($1::uuid, 'Native Test Agent', 'idle') RETURNING id::text",
        )
        .bind(&org_a)
        .fetch_one(&pool)
        .await
        .unwrap();
        let agent_token = format!("pcp_{}", Uuid::new_v4().simple());
        let agent_key_id: String = sqlx::query_scalar(
            "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash) VALUES ($1::uuid, $2::uuid, 'native test', $3) RETURNING id::text",
        )
        .bind(&agent_id)
        .bind(&org_a)
        .bind(hash_token(&agent_token))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(matches!(
            resolve(&pool, &agent_token, &org_a).await.unwrap(),
            NativeBearerResolution::Authorized { actor, .. } if actor.kind == "agent" && actor.id == agent_id
        ));
        assert!(last_used_is_set(&pool, "agent_api_keys", &agent_key_id).await);
        assert!(matches!(
            resolve(&pool, &agent_token, &org_b).await.unwrap(),
            NativeBearerResolution::Forbidden
        ));
        let cross_org_token = format!("pcp_{}", Uuid::new_v4().simple());
        let cross_org_key_id: String = sqlx::query_scalar(
            "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash) VALUES ($1::uuid, $2::uuid, 'native test cross-org', $3) RETURNING id::text",
        )
        .bind(&agent_id)
        .bind(&org_a)
        .bind(hash_token(&cross_org_token))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(matches!(
            resolve(&pool, &cross_org_token, &org_b).await.unwrap(),
            NativeBearerResolution::Forbidden
        ));
        assert!(last_used_is_set(&pool, "agent_api_keys", &cross_org_key_id).await);

        let inconsistent_token = format!("pcp_{}", Uuid::new_v4().simple());
        let inconsistent_key_id: String = sqlx::query_scalar(
            "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash) VALUES ($1::uuid, $2::uuid, 'native test inconsistent scope', $3) RETURNING id::text",
        )
        .bind(&agent_id)
        .bind(&org_b)
        .bind(hash_token(&inconsistent_token))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(matches!(
            resolve(&pool, &inconsistent_token, &org_b).await.unwrap(),
            NativeBearerResolution::Forbidden
        ));
        assert!(last_used_is_set(&pool, "agent_api_keys", &inconsistent_key_id).await);

        sqlx::query("UPDATE agents SET status = 'terminated' WHERE id = $1::uuid")
            .bind(&agent_id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            resolve(&pool, &agent_token, &org_a).await.unwrap(),
            NativeBearerResolution::Unauthorized
        ));
        // A non-revoked agent key is touched before a terminal-status denial,
        // matching the current Node middleware's observable side effect.
        assert!(last_used_is_set(&pool, "agent_api_keys", &agent_key_id).await);
        sqlx::query("UPDATE agents SET status = 'pending_approval' WHERE id = $1::uuid")
            .bind(&agent_id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(matches!(
            resolve(&pool, &agent_token, &org_a).await.unwrap(),
            NativeBearerResolution::Unauthorized
        ));

        let revoked_agent_token = format!("pcp_{}", Uuid::new_v4().simple());
        let revoked_agent_key_id: String = sqlx::query_scalar(
            "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash, revoked_at) VALUES ($1::uuid, $2::uuid, 'native test revoked', $3, now()) RETURNING id::text",
        )
        .bind(&agent_id)
        .bind(&org_a)
        .bind(hash_token(&revoked_agent_token))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(matches!(
            resolve(&pool, &revoked_agent_token, &org_a).await.unwrap(),
            NativeBearerResolution::Unauthorized
        ));
        assert!(!last_used_is_set(&pool, "agent_api_keys", &revoked_agent_key_id).await);

        // Cleanup only fixture rows created above, in FK-safe order.
        sqlx::query("DELETE FROM agent_api_keys WHERE agent_id = $1::uuid")
            .bind(&agent_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM agents WHERE id = $1::uuid")
            .bind(&agent_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM board_api_keys WHERE user_id = $1")
            .bind(&user_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM instance_user_roles WHERE user_id = $1")
            .bind(&user_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "DELETE FROM organization_memberships WHERE principal_type = 'user' AND principal_id = $1 AND org_id IN ($2::uuid, $3::uuid)",
        )
        .bind(&user_id)
        .bind(&org_a)
        .bind(&org_b)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(r#"DELETE FROM "user" WHERE id = $1"#)
            .bind(&user_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)")
            .bind(&org_a)
            .bind(&org_b)
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB"]
    async fn committed_revocation_or_expiry_wins_a_concurrent_last_used_touch() {
        let pool = disposable_test_pool().await;
        let org_id = insert_org(&pool).await;
        let user_id = format!("native-auth-race-user-{}", Uuid::new_v4());
        sqlx::query(
            r#"INSERT INTO "user" (id, name, email, created_at, updated_at)
               VALUES ($1, 'Native Race User', $2, now(), now())"#,
        )
        .bind(&user_id)
        .bind(format!("{user_id}@invalid.test"))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO organization_memberships (org_id, principal_type, principal_id, status) VALUES ($1::uuid, 'user', $2, 'active')",
        )
        .bind(&org_id)
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();
        for (suffix, invalidation_sql) in [
            (
                "revoked",
                "UPDATE board_api_keys SET revoked_at = now() WHERE id = $1::uuid",
            ),
            (
                "expired",
                "UPDATE board_api_keys SET expires_at = now() - interval '1 second' WHERE id = $1::uuid",
            ),
        ] {
            let token = format!("pcp_board_{}_{}", suffix, Uuid::new_v4().simple());
            let key_id = insert_board_key(&pool, &user_id, &token, false, false).await;

            let mut invalidation = pool.begin().await.unwrap();
            sqlx::query(invalidation_sql)
                .bind(&key_id)
                .execute(&mut *invalidation)
                .await
                .unwrap();
            let auth_pool = pool.clone();
            let auth_token = token.clone();
            let auth_org = org_id.clone();
            let auth =
                tokio::spawn(async move { resolve(&auth_pool, &auth_token, &auth_org).await });
            // Let the resolver read the still-committed credential and block
            // on its guarded touch before the invalidation transaction commits.
            tokio::time::sleep(Duration::from_millis(25)).await;
            invalidation.commit().await.unwrap();
            let resolution = tokio::time::timeout(Duration::from_secs(3), auth)
                .await
                .expect("auth update should unblock after credential invalidation commits")
                .unwrap()
                .unwrap();
            assert!(matches!(resolution, NativeBearerResolution::Unauthorized));
            assert!(!last_used_is_set(&pool, "board_api_keys", &key_id).await);

            sqlx::query("DELETE FROM board_api_keys WHERE id = $1::uuid")
                .bind(&key_id)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query(
            "DELETE FROM organization_memberships WHERE org_id = $1::uuid AND principal_id = $2",
        )
        .bind(&org_id)
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(r#"DELETE FROM "user" WHERE id = $1"#)
            .bind(&user_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM organizations WHERE id = $1::uuid")
            .bind(&org_id)
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "isolated connection-failure case; never retries through the compatibility grant adapter"]
    async fn sql_transport_error_is_unavailable_not_compatibility() {
        let state = AppState::new(super::super::ServerConfig {
            database_url: Some(
                "postgres://invalid:invalid@127.0.0.1:1/native_auth_unavailable".into(),
            ),
            ..super::super::ServerConfig::default()
        })
        .unwrap();
        assert!(matches!(
            state
                .resolve_native_bearer("pcp_unknown", "10000000-0000-0000-0000-000000000001")
                .await,
            NativeBearerResolution::Unavailable
        ));
    }
}
