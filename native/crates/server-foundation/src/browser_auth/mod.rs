//! Browser identity resolution owned by Rust. Cookie issuance stays with the
//! existing auth runtime; cookie caches and request-supplied identity are never
//! authority. Call again in the transaction snapshot used by a scoped operation.
use actix_web::{HttpRequest, http::header};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::PgConnection;

mod config;
use config::Mode;
pub use config::{BrowserAuthConfig, BrowserAuthConfigError, SessionPolicy};

/// An authenticated identity, not a serialized client assertion or UI session ID.
/// Organization access is checked during `authenticate` when a scope is supplied.
pub struct BrowserActor {
    user_id: String,
    session_id: String,
    source: &'static str,
}
impl BrowserActor {
    pub fn user_id(&self) -> &str {
        &self.user_id
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn source(&self) -> &str {
        self.source
    }
    pub(crate) fn public_session(&self) -> serde_json::Value {
        serde_json::json!({
            "session": {"id": format!("rudder:{}:{}", self.source, self.user_id), "userId": self.user_id},
            "user": {"id": self.user_id, "email": null,
                "name": if self.source == "local_implicit" { Some("Local Board") } else { None }},
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BrowserAuthError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("organization access denied")]
    Forbidden,
    #[error("authentication storage unavailable")]
    Unavailable,
}

// Tokens are deliberately not Debug/Serialize, and never included in errors.
enum Credential {
    Session { token: String, refresh: bool },
    BoardKey(String),
    LocalImplicit,
}

fn credential(
    config: &BrowserAuthConfig,
    request: &HttpRequest,
) -> Result<Credential, BrowserAuthError> {
    let mut authorization = request.headers().get_all(header::AUTHORIZATION);
    let first = authorization.next();
    if authorization.next().is_some() {
        return Err(BrowserAuthError::Unauthorized);
    }
    if let Some(value) = first {
        let value = value.to_str().map_err(|_| BrowserAuthError::Unauthorized)?;
        if value
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer "))
        {
            let token = value[7..].trim();
            return if token.starts_with("pcp_") && token.len() <= 4096 {
                Ok(Credential::BoardKey(super::native_bearer_auth::hash_token(
                    token,
                )))
            } else {
                Err(BrowserAuthError::Unauthorized)
            };
        }
    }
    match &config.mode {
        Mode::LocalImplicit => Ok(Credential::LocalImplicit),
        Mode::Required {
            secret,
            secure_cookie,
            session_policy,
        } => {
            let name = if *secure_cookie {
                "__Secure-better-auth.session_token"
            } else {
                "better-auth.session_token"
            };
            let signed = cookie_value(request, name)?.ok_or(BrowserAuthError::Unauthorized)?;
            let token = verify_cookie(signed, secret).ok_or(BrowserAuthError::Unauthorized)?;
            let dont_remember_name = if *secure_cookie {
                "__Secure-better-auth.dont_remember"
            } else {
                "better-auth.dont_remember"
            };
            let dont_remember = cookie_value(request, dont_remember_name)?
                .and_then(|signed| verify_cookie(signed, secret))
                .is_some();
            Ok(Credential::Session {
                token,
                refresh: *session_policy == SessionPolicy::BetterAuth && !dont_remember,
            })
        }
    }
}

fn cookie_value<'a>(
    request: &'a HttpRequest,
    name: &str,
) -> Result<Option<&'a str>, BrowserAuthError> {
    let mut found = None;
    let mut total = 0usize;
    for value in request.headers().get_all(header::COOKIE) {
        total += value.as_bytes().len();
        if total > 16384 {
            return Err(BrowserAuthError::Unauthorized);
        }
        let value = value.to_str().map_err(|_| BrowserAuthError::Unauthorized)?;
        for part in value.split(';') {
            if let Some((key, value)) = part.split_once('=')
                && key.trim() == name
            {
                if found.is_some() {
                    return Err(BrowserAuthError::Unauthorized);
                }
                found = Some(value.trim());
            }
        }
    }
    Ok(found)
}

fn verify_cookie(encoded: &str, secret: &[u8]) -> Option<String> {
    if encoded.len() > 8192 {
        return None;
    }
    for (i, byte) in encoded.as_bytes().iter().enumerate() {
        if *byte == b'%'
            && !encoded
                .as_bytes()
                .get(i + 1..i + 3)
                .is_some_and(|s| s.iter().all(u8::is_ascii_hexdigit))
        {
            return None;
        }
    }
    let value = percent_encoding::percent_decode_str(encoded)
        .decode_utf8()
        .ok()?;
    let (token, signature) = value.rsplit_once('.')?;
    if token.is_empty() || token.len() > 4096 || signature.len() != 44 || !signature.ends_with('=')
    {
        return None;
    }
    let signature = STANDARD.decode(signature).ok()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).ok()?;
    mac.update(token.as_bytes());
    mac.verify_slice(&signature).ok()?;
    Some(token.to_owned())
}

/// Resolve and revalidate against the caller's PostgreSQL connection/snapshot.
/// The returned actor is not a durable credential: mutations must authenticate
/// again in their own transaction instead of trusting an earlier GET response.
pub async fn authenticate(
    config: &BrowserAuthConfig,
    request: &HttpRequest,
    connection: &mut PgConnection,
    organization_id: Option<&str>,
) -> Result<BrowserActor, BrowserAuthError> {
    let credential = credential(config, request)?;
    let (session_id, user_id, source, allowed) = match credential {
        Credential::LocalImplicit => {
            return Ok(BrowserActor {
                user_id: "local-board".into(),
                session_id: "local-implicit".into(),
                source: "local_implicit",
            });
        }
        Credential::Session { token, refresh } => {
            let rows = sqlx::query_as::<_, (String, String, bool, bool)>(
                r#"SELECT s.id, u.id,
                    ($2::text IS NULL OR EXISTS (SELECT 1 FROM instance_user_roles r WHERE r.user_id=u.id AND r.role='instance_admin')
                    OR EXISTS (SELECT 1 FROM organization_memberships m WHERE m.principal_type='user' AND m.principal_id=u.id AND m.status='active' AND m.org_id::text=$2)), s.expires_at-interval '6 days'<=clock_timestamp()
                    FROM session s JOIN "user" u ON u.id=s.user_id
                    WHERE s.token=$1 AND s.expires_at>clock_timestamp() LIMIT 2"#,
            ).bind(&token).bind(organization_id).fetch_all(&mut *connection).await.map_err(|_| BrowserAuthError::Unavailable)?;
            // Legacy schema does not enforce token uniqueness. Ambiguity must
            // not silently choose a user or a session.
            if rows.len() != 1 {
                return Err(BrowserAuthError::Unauthorized);
            }
            let (session, user, allowed, needs_refresh) = rows.into_iter().next().unwrap();
            if refresh && needs_refresh {
                // Current Better Auth defaults: seven-day lifetime, one-day
                // update age. Local-account sessions and dont_remember cookies
                // never slide. Guard the update against concurrent revocation.
                let refreshed = sqlx::query_scalar::<_, String>(
                    "UPDATE session SET expires_at = CASE WHEN expires_at-interval '6 days'<=clock_timestamp() THEN clock_timestamp()+interval '7 days' ELSE expires_at END,
                     updated_at = CASE WHEN expires_at-interval '6 days'<=clock_timestamp() THEN clock_timestamp() ELSE updated_at END
                     WHERE id=$1 AND user_id=$2 AND token=$3 AND expires_at>clock_timestamp() RETURNING id"
                ).bind(&session).bind(&user).bind(&token).fetch_optional(&mut *connection).await.map_err(|_| BrowserAuthError::Unavailable)?;
                if refreshed.is_none() {
                    return Err(BrowserAuthError::Unauthorized);
                }
            }

            (session, user, "session", allowed)
        }
        Credential::BoardKey(hash) => {
            let row = sqlx::query_as::<_, (String, String, bool)>(
                r#"UPDATE board_api_keys k SET last_used_at=clock_timestamp()
                    FROM "user" u WHERE k.user_id=u.id AND k.key_hash=$1 AND k.revoked_at IS NULL
                    AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())
                    RETURNING k.id::text, u.id,
                    ($2::text IS NULL OR EXISTS (SELECT 1 FROM instance_user_roles r WHERE r.user_id=u.id AND r.role='instance_admin')
                    OR EXISTS (SELECT 1 FROM organization_memberships m WHERE m.principal_type='user' AND m.principal_id=u.id AND m.status='active' AND m.org_id::text=$2))"#,
            ).bind(hash).bind(organization_id).fetch_optional(&mut *connection).await.map_err(|_| BrowserAuthError::Unavailable)?;
            let (key, user, allowed) = row.ok_or(BrowserAuthError::Unauthorized)?;
            (format!("board-key:{key}"), user, "board_key", allowed)
        }
    };
    if !allowed {
        return Err(BrowserAuthError::Forbidden);
    }
    Ok(BrowserActor {
        user_id,
        session_id,
        source,
    })
}

#[cfg(test)]
mod tests;
