//! Native validation and refresh of the existing Better Auth and Desktop
//! account session cookies used by the public HTTP listener.
//!
//! This deliberately does not issue sessions or replace Better Auth/local
//! account lifecycle routes. Cookie semantics preserve the pinned parsers:
//! both Better Auth and Desktop keep the first duplicate cookie. Better Auth
//! expires at `expires_at < now` and refreshes an active remembered session;
//! Desktop account sessions expire at `<= now` and are read-only.

use crate::native_agent_jwt::NativeAgentJwtIdentity;
use crate::public_ingress_config::{NativeSessionAuthConfig, NativeSessionAuthKind};
use crate::{AppState, DatabaseState};
use actix_web::http::header::{COOKIE, HeaderMap};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;
use sqlx::{PgConnection, Pool, Postgres};

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub(super) struct NativeSessionIdentity {
    pub user_id: String,
    pub session_id: String,
    token: String,
}

#[derive(Clone)]
pub(super) enum NativeIngressIdentity {
    None,
    LocalImplicit,
    Session(NativeSessionIdentity),
    BoardKey {
        user_id: String,
        key_id: String,
        token_hash: String,
    },
    AgentKey {
        agent_id: String,
        org_id: String,
        key_id: String,
        token_hash: String,
    },
    AgentJwt(NativeAgentJwtIdentity),
}

pub(super) enum NativeSessionResolution {
    Anonymous,
    Authenticated(NativeSessionIdentity),
    DatabaseDisabled,
    Unavailable,
}

#[derive(Serialize)]
struct NativeIdentityAssertion<'a> {
    schema: &'static str,
    audience: &'static str,
    method: &'a str,
    target: &'a str,
    issued_at: i64,
    expires_at: i64,
    request_id: String,
    nonce: String,
    identity: AssertionIdentity<'a>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AssertionIdentity<'a> {
    None,
    LocalImplicit,
    Session {
        session_id: &'a str,
        user_id: &'a str,
    },
    BoardKey {
        key_id: &'a str,
        session_id: String,
        user_id: &'a str,
    },
    AgentKey {
        agent_id: &'a str,
        key_id: &'a str,
        org_id: &'a str,
        session_id: String,
    },
    AgentJwt {
        adapter_type: &'a str,
        agent_id: &'a str,
        expires_at: f64,
        org_id: &'a str,
        run_id: &'a str,
        session_id: String,
    },
}

pub(super) fn issue_assertion(
    assertion_key: &str,
    method: &str,
    target: &str,
    identity: &NativeIngressIdentity,
) -> Result<String, ()> {
    let now = i64::try_from(crate::unix_time_seconds()).map_err(|_| ())?;
    let payload = NativeIdentityAssertion {
        schema: "rudder.native-identity-assertion.v1",
        audience: "rudder-node-private-ingress",
        method,
        target,
        issued_at: now,
        expires_at: now + 30,
        request_id: uuid::Uuid::new_v4().to_string(),
        nonce: uuid::Uuid::new_v4().to_string(),
        identity: match identity {
            NativeIngressIdentity::None => AssertionIdentity::None,
            NativeIngressIdentity::LocalImplicit => AssertionIdentity::LocalImplicit,
            NativeIngressIdentity::Session(identity) => AssertionIdentity::Session {
                session_id: &identity.session_id,
                user_id: &identity.user_id,
            },
            NativeIngressIdentity::BoardKey {
                user_id, key_id, ..
            } => AssertionIdentity::BoardKey {
                key_id,
                session_id: format!("board-key:{key_id}"),
                user_id,
            },
            NativeIngressIdentity::AgentKey {
                agent_id,
                org_id,
                key_id,
                ..
            } => AssertionIdentity::AgentKey {
                agent_id,
                key_id,
                org_id,
                session_id: format!("agent-key:{key_id}"),
            },
            NativeIngressIdentity::AgentJwt(identity) => AssertionIdentity::AgentJwt {
                adapter_type: &identity.adapter_type,
                agent_id: &identity.agent_id,
                expires_at: identity.expires_at,
                org_id: &identity.org_id,
                run_id: &identity.run_id,
                session_id: format!("agent-jwt:{}", identity.agent_id),
            },
        },
    };
    let bytes = serde_json::to_vec(&payload).map_err(|_| ())?;
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes);
    let mut mac = HmacSha256::new_from_slice(assertion_key.as_bytes()).map_err(|_| ())?;
    mac.update(encoded.as_bytes());
    let signature =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!("{encoded}.{signature}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NativeSessionAccess {
    Authorized,
    Unauthorized,
    Forbidden,
}

impl AppState {
    pub(super) async fn resolve_public_session(
        &self,
        config: &NativeSessionAuthConfig,
        headers: &HeaderMap,
    ) -> NativeSessionResolution {
        let (token, dont_remember) = match session_token(config, headers) {
            Some(token) => token,
            None => return NativeSessionResolution::Anonymous,
        };
        let DatabaseState::Configured(pool) = &self.database else {
            return NativeSessionResolution::DatabaseDisabled;
        };
        match resolve(pool, config, token, dont_remember).await {
            Ok(Some(identity)) => NativeSessionResolution::Authenticated(identity),
            Ok(None) => NativeSessionResolution::Anonymous,
            Err(_) => NativeSessionResolution::Unavailable,
        }
    }
}

pub(super) fn has_session_cookie(headers: &HeaderMap) -> bool {
    let cookie = headers
        .get_all(COOKIE)
        .filter_map(|value| value.to_str().ok())
        .collect::<Vec<_>>()
        .join(";");
    cookie.split(';').any(|part| {
        part.trim()
            .split_once('=')
            .is_some_and(|(name, _)| is_session_cookie_name(name.trim()))
    })
}

fn is_session_cookie_name(name: &str) -> bool {
    matches!(
        name,
        "better-auth.session_token" | "__Secure-better-auth.session_token"
    )
}

fn session_token(config: &NativeSessionAuthConfig, headers: &HeaderMap) -> Option<(String, bool)> {
    let name = config.session_cookie_name();
    let cookie = headers
        .get_all(COOKIE)
        .filter_map(|value| value.to_str().ok())
        .collect::<Vec<_>>()
        .join(";");
    let session_value = cookie_value(&cookie, name, config.kind);
    let signed_value = session_value.as_deref()?;
    let token = verify_signed_cookie(signed_value, &config.secret)?;

    let dont_remember = if config.kind == NativeSessionAuthKind::BetterAuth {
        let dont_remember = cookie_value(
            &cookie,
            config.dont_remember_cookie_name(),
            NativeSessionAuthKind::BetterAuth,
        )
        .and_then(|value| verify_signed_cookie(&value, &config.secret));
        dont_remember.is_some_and(|value| !value.is_empty())
    } else {
        false
    };

    Some((token, dont_remember))
}

fn cookie_value(raw: &str, name: &str, kind: NativeSessionAuthKind) -> Option<String> {
    for part in raw.split(';') {
        let Some((key, value)) = part.trim().split_once('=') else {
            continue;
        };
        if key.trim() != name {
            continue;
        }
        let mut value = value.trim().to_owned();
        if kind == NativeSessionAuthKind::BetterAuth && value.starts_with('"') {
            value.remove(0);
            value.pop();
        }
        let decoded = decode_cookie_component(&value);
        // The pinned Better Call parser keeps the first duplicate in its Map;
        // the existing Desktop resolver also returns the first occurrence.
        return match (kind, decoded) {
            (_, Ok(decoded)) => Some(decoded),
            // better-call's tryDecode returns the original text on a malformed
            // percent escape or invalid UTF-8; Desktop's decodeURIComponent
            // resolver rejects the cookie instead.
            (NativeSessionAuthKind::BetterAuth, Err(())) => Some(value),
            (NativeSessionAuthKind::LocalAccount, Err(())) => None,
        };
    }
    None
}

fn decode_cookie_component(value: &str) -> Result<String, ()> {
    if !value.as_bytes().contains(&b'%') {
        return Ok(value.to_owned());
    }
    let source = value.as_bytes();
    let mut decoded = Vec::with_capacity(source.len());
    let mut index = 0;
    while index < source.len() {
        if source[index] != b'%' {
            decoded.push(source[index]);
            index += 1;
            continue;
        }
        if index + 2 >= source.len() {
            return Err(());
        }
        let high = hex_digit(source[index + 1]).ok_or(())?;
        let low = hex_digit(source[index + 2]).ok_or(())?;
        decoded.push((high << 4) | low);
        index += 3;
    }
    String::from_utf8(decoded).map_err(|_| ())
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn verify_signed_cookie(value: &str, secret: &str) -> Option<String> {
    let (token, signature) = value.rsplit_once('.')?;
    if token.is_empty() || signature.len() != 44 || !signature.ends_with('=') {
        return None;
    }
    let supplied = STANDARD.decode(signature).ok()?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(token.as_bytes());
    mac.verify_slice(&supplied).ok()?;
    Some(token.to_owned())
}

/// Sign the Better Auth session token using the same padded standard-Base64
/// HMAC representation accepted by `verify_signed_cookie` above. Local
/// account lifecycle issuance uses this helper so the public cookie reader
/// and writer cannot drift apart.
pub(super) fn sign_session_token(token: &str, secret: &str) -> Result<String, ()> {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| ())?;
    mac.update(token.as_bytes());
    let signature = STANDARD.encode(mac.finalize().into_bytes());
    Ok(format!("{token}.{signature}"))
}

async fn resolve(
    pool: &Pool<Postgres>,
    config: &NativeSessionAuthConfig,
    token: String,
    dont_remember: bool,
) -> Result<Option<NativeSessionIdentity>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let rows = sqlx::query_as::<_, (String, String)>(
        r#"
        SELECT s.id, s.user_id
        FROM session AS s
        INNER JOIN "user" AS u ON u.id = s.user_id
        WHERE s.token = $1
        ORDER BY s.id
        LIMIT 2
        FOR UPDATE OF s
        "#,
    )
    .bind(&token)
    .fetch_all(&mut *tx)
    .await?;
    if rows.len() != 1 {
        tx.commit().await?;
        return Ok(None);
    }
    let (session_id, user_id) = rows.into_iter().next().expect("one row checked");
    let (expired, should_refresh): (bool, bool) = sqlx::query_as(
        r#"
        SELECT
          CASE WHEN $2 THEN expires_at < clock_timestamp()
               ELSE expires_at <= clock_timestamp() END,
          expires_at - interval '7 days' + interval '24 hours' <= clock_timestamp()
        FROM session
        WHERE id = $1
        "#,
    )
    .bind(&session_id)
    .bind(config.kind == NativeSessionAuthKind::BetterAuth)
    .fetch_one(&mut *tx)
    .await?;

    if expired {
        if config.kind == NativeSessionAuthKind::BetterAuth {
            sqlx::query("DELETE FROM session WHERE id = $1")
                .bind(&session_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        return Ok(None);
    }

    if config.kind == NativeSessionAuthKind::BetterAuth && should_refresh && !dont_remember {
        let updated = sqlx::query(
            r#"
            UPDATE session
            SET expires_at = clock_timestamp() + interval '7 days',
                updated_at = clock_timestamp()
            WHERE id = $1
            "#,
        )
        .bind(&session_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if updated != 1 {
            tx.commit().await?;
            return Ok(None);
        }
    }

    tx.commit().await?;
    Ok(Some(NativeSessionIdentity {
        user_id,
        session_id,
        token,
    }))
}

/// Revalidates the session, user, current role and membership inside the same
/// repeatable-read snapshot used for the direct member-directory data query.
pub(super) async fn revalidate_in_snapshot(
    connection: &mut PgConnection,
    identity: &NativeSessionIdentity,
    org_id: &str,
    kind: NativeSessionAuthKind,
) -> Result<NativeSessionAccess, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String, String)>(
        r#"
        SELECT s.id, s.user_id
        FROM session AS s
        INNER JOIN "user" AS u ON u.id = s.user_id
        WHERE s.id = $1
          AND s.token = $2
          AND CASE WHEN $3 THEN s.expires_at >= clock_timestamp()
                   ELSE s.expires_at > clock_timestamp() END
        LIMIT 2
        "#,
    )
    .bind(&identity.session_id)
    .bind(&identity.token)
    .bind(kind == NativeSessionAuthKind::BetterAuth)
    .fetch_all(&mut *connection)
    .await?;
    if rows.len() != 1 || rows[0].0 != identity.session_id || rows[0].1 != identity.user_id {
        return Ok(NativeSessionAccess::Unauthorized);
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
    .bind(&identity.user_id)
    .bind(org_id)
    .fetch_one(&mut *connection)
    .await?;
    Ok(if is_instance_admin || has_membership {
        NativeSessionAccess::Authorized
    } else {
        NativeSessionAccess::Forbidden
    })
}

pub(super) fn session_cookie_header_names(config: &NativeSessionAuthConfig) -> [&str; 2] {
    [
        config.session_cookie_name(),
        config.dont_remember_cookie_name(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::public_ingress_config::NativeSessionAuthConfig;
    use actix_web::http::header::HeaderValue;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    fn settings(kind: NativeSessionAuthKind, secure: bool) -> NativeSessionAuthConfig {
        NativeSessionAuthConfig::new(kind, "a sufficiently long secret", secure, KEY)
            .expect("valid test auth settings")
    }

    fn signed(value: &str, secret: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(value.as_bytes());
        format!("{value}.{}", STANDARD.encode(mac.finalize().into_bytes()))
    }

    const KEY: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn cookie_names_follow_secure_cookie_policy_and_session_kind() {
        assert_eq!(
            settings(NativeSessionAuthKind::BetterAuth, false).session_cookie_name(),
            "better-auth.session_token"
        );
        assert_eq!(
            settings(NativeSessionAuthKind::BetterAuth, true).session_cookie_name(),
            "__Secure-better-auth.session_token"
        );
        assert_eq!(
            settings(NativeSessionAuthKind::LocalAccount, false).session_cookie_name(),
            "better-auth.session_token"
        );
    }

    #[test]
    fn signed_cookie_verification_matches_better_auth_and_local_account_vectors() {
        let ba_secret = "test-better-auth-secret";
        let local_secret = "test-local-account-secret";
        assert_eq!(
            verify_signed_cookie(&signed("ba-token", ba_secret), ba_secret).as_deref(),
            Some("ba-token")
        );
        assert_eq!(
            verify_signed_cookie(&signed("local-token", local_secret), local_secret).as_deref(),
            Some("local-token")
        );
        assert_eq!(
            verify_signed_cookie(&signed("ba-token", ba_secret), local_secret),
            None
        );
        assert_eq!(
            verify_signed_cookie("token.not-a-signature", ba_secret),
            None
        );
    }

    #[test]
    fn issued_local_session_cookie_uses_the_reader_hmac_representation() {
        let secret = "test-local-account-secret";
        let issued = sign_session_token("new-session-token", secret).unwrap();
        assert_eq!(
            verify_signed_cookie(&issued, secret).as_deref(),
            Some("new-session-token")
        );
    }

    #[test]
    fn duplicate_cookie_selection_matches_both_existing_resolvers() {
        for (raw, first) in [
            (
                "better-auth.session_token=first; better-auth.session_token=last",
                "first",
            ),
            (
                "better-auth.session_token=last; better-auth.session_token=first",
                "last",
            ),
        ] {
            assert_eq!(
                cookie_value(
                    raw,
                    "better-auth.session_token",
                    NativeSessionAuthKind::BetterAuth
                )
                .as_deref(),
                Some(first)
            );
            assert_eq!(
                cookie_value(
                    raw,
                    "better-auth.session_token",
                    NativeSessionAuthKind::LocalAccount
                )
                .as_deref(),
                Some(first)
            );
        }
    }

    #[test]
    fn malformed_percent_encoding_matches_each_pinned_parser() {
        let raw = "better-auth.session_token=invalid%ZZ";
        assert_eq!(
            cookie_value(
                raw,
                "better-auth.session_token",
                NativeSessionAuthKind::BetterAuth
            )
            .as_deref(),
            Some("invalid%ZZ")
        );
        assert_eq!(
            cookie_value(
                raw,
                "better-auth.session_token",
                NativeSessionAuthKind::LocalAccount
            ),
            None
        );
    }

    #[test]
    fn signed_dont_remember_value_is_verified_and_any_nonempty_value_is_truthy() {
        let secret = "remember-secret";
        assert_eq!(
            verify_signed_cookie(&signed("true", secret), secret).as_deref(),
            Some("true")
        );
        assert_eq!(
            verify_signed_cookie(&signed("false", secret), secret).as_deref(),
            Some("false")
        );
        assert_eq!(
            verify_signed_cookie(&signed("true", secret), "wrong-secret"),
            None
        );
    }

    #[test]
    fn configured_cookie_parser_decodes_cookie_serialization() {
        let config = settings(NativeSessionAuthKind::BetterAuth, false);
        let value = signed("encoded.token", &config.secret);
        let encoded =
            percent_encoding::utf8_percent_encode(&value, percent_encoding::NON_ALPHANUMERIC)
                .to_string();
        let mut headers = HeaderMap::new();
        headers.insert(
            COOKIE,
            HeaderValue::from_str(&format!("{}={encoded}", config.session_cookie_name())).unwrap(),
        );
        assert_eq!(
            session_token(&config, &headers)
                .as_ref()
                .map(|(token, _)| token.as_str()),
            Some("encoded.token")
        );
    }
}
