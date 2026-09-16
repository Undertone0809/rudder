use crate::valid_uuid;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use std::{
    fmt,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

/// Explicit configuration: there is no built-in production signing secret.
#[derive(Clone)]
pub struct JwtConfig {
    secret: Arc<[u8]>,
    issuer: String,
    audience: String,
}
impl fmt::Debug for JwtConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JwtConfig")
            .field("secret", &"[REDACTED]")
            .field("issuer", &self.issuer)
            .field("audience", &self.audience)
            .finish()
    }
}
#[derive(Debug, Error)]
#[error("JWT secret, issuer, and audience must be non-empty")]
pub struct AuthConfigError;

pub(crate) struct AgentClaims {
    pub agent: String,
    pub org: String,
    pub run: String,
    pub adapter: String,
}
impl JwtConfig {
    pub fn new(
        secret: impl Into<Vec<u8>>,
        issuer: impl Into<String>,
        audience: impl Into<String>,
    ) -> Result<Self, AuthConfigError> {
        let secret = secret.into();
        let issuer = issuer.into();
        let audience = audience.into();
        if secret.is_empty() || issuer.is_empty() || audience.is_empty() {
            return Err(AuthConfigError);
        }
        Ok(Self {
            secret: secret.into(),
            issuer,
            audience,
        })
    }
    pub(crate) fn verify(&self, token: &str) -> Option<AgentClaims> {
        let mut pieces = token.split('.');
        let header = pieces.next()?;
        let body = pieces.next()?;
        let signature = pieces.next()?;
        if pieces.next().is_some() {
            return None;
        }
        let header_value: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).ok()?).ok()?;
        if header_value.get("alg")?.as_str()? != "HS256" {
            return None;
        }
        let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
        let mut mac = HmacSha256::new_from_slice(&self.secret).ok()?;
        mac.update(header.as_bytes());
        mac.update(b".");
        mac.update(body.as_bytes());
        mac.verify_slice(&signature).ok()?;
        let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(body).ok()?).ok()?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() as f64;
        let iat = claims.get("iat")?.as_f64()?;
        let exp = claims.get("exp")?.as_f64()?;
        // The existing signer/validator accepts exp==now and optional iss/aud.
        if iat == 0.0 || exp == 0.0 || exp < now {
            return None;
        }
        for (name, expected) in [("iss", &self.issuer), ("aud", &self.audience)] {
            if claims
                .get(name)
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty() && s != expected)
            {
                return None;
            }
        }
        let required = |key: &str| {
            claims
                .get(key)?
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let agent = required("sub")?;
        let org = required("org_id")?;
        // Do not pass malformed signed identifiers to PostgreSQL UUID casts.
        if !valid_uuid(&agent) || !valid_uuid(&org) {
            return None;
        }
        Some(AgentClaims {
            agent,
            org,
            run: required("run_id")?,
            adapter: required("adapter_type")?,
        })
    }
}
// End of explicit, redacted HS256 configuration.
