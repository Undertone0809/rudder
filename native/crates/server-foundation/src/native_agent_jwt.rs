//! Verification for the existing local Agent JWT contract.
//!
//! Tokens are issued by `server/src/agent-auth-jwt.ts`; this module mirrors
//! that verifier's HS256 and claim semantics. Agent status and organization
//! binding are checked against PostgreSQL by the bearer resolver.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::Serialize;
use serde_json::Value;
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub(super) struct NativeAgentJwtConfig {
    pub(super) secret: String,
    pub(super) issuer: String,
    pub(super) audience: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct NativeAgentJwtIdentity {
    pub(super) agent_id: String,
    pub(super) org_id: String,
    pub(super) adapter_type: String,
    pub(super) run_id: String,
    pub(super) expires_at: f64,
    pub(super) token_id: Option<String>,
}

pub(super) fn verify(
    token: &str,
    config: &NativeAgentJwtConfig,
    now_seconds: f64,
) -> Option<NativeAgentJwtIdentity> {
    // The Node verifier treats an empty selected secret as disabled auth.
    // Keep that behavior instead of accepting signatures made with an empty
    // HMAC key.
    if config.secret.is_empty() {
        return None;
    }
    let mut parts = token.split('.');
    let header = parts.next()?;
    let claims = parts.next()?;
    let signature = parts.next()?;
    if parts.next().is_some() {
        return None;
    }

    let header_value = decode_json_object(header)?;
    if header_value.get("alg")?.as_str()? != "HS256" {
        return None;
    }

    let supplied_signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
    let mut mac = HmacSha256::new_from_slice(config.secret.as_bytes()).ok()?;
    mac.update(format!("{header}.{claims}").as_bytes());
    mac.verify_slice(&supplied_signature).ok()?;

    let claims_value = decode_json_object(claims)?;
    let agent_id = nonempty_string(&claims_value, "sub")?;
    let org_id = nonempty_string(&claims_value, "org_id")?;
    let adapter_type = nonempty_string(&claims_value, "adapter_type")?;
    let run_id = nonempty_string(&claims_value, "run_id")?;
    let issued_at = truthy_number(&claims_value, "iat")?;
    let expires_at = truthy_number(&claims_value, "exp")?;

    // The legacy Node verifier requires a truthy numeric iat but does not
    // compare it to the current clock. Preserve that behavior.
    let _ = issued_at;
    if expires_at < now_seconds {
        return None;
    }

    if let Some(issuer) = claims_value.get("iss").and_then(Value::as_str)
        && !issuer.is_empty()
        && issuer != config.issuer
    {
        return None;
    }
    if let Some(audience) = claims_value.get("aud").and_then(Value::as_str)
        && !audience.is_empty()
        && audience != config.audience
    {
        return None;
    }

    Some(NativeAgentJwtIdentity {
        agent_id,
        org_id,
        adapter_type,
        run_id,
        expires_at,
        token_id: claims_value
            .get("jti")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// Sign the same short-lived Agent credential used by local runtime adapters.
/// The claim order mirrors `server/src/agent-auth-jwt.ts`; token verification
/// is still performed by the normal Rust bearer resolver on every request.
pub(super) fn sign_local_agent_jwt(
    agent_id: &str,
    org_id: &str,
    adapter_type: &str,
    run_id: &str,
    config: &NativeAgentJwtConfig,
) -> Option<String> {
    if config.secret.is_empty() {
        return None;
    }
    let issued_at = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    let ttl_seconds = parse_ttl_seconds(
        std::env::var("RUDDER_AGENT_JWT_TTL_SECONDS")
            .ok()
            .as_deref(),
    );
    let claims = LocalAgentJwtClaimsForSigning {
        sub: agent_id,
        org_id,
        adapter_type,
        run_id,
        iat: issued_at,
        exp: issued_at.saturating_add(ttl_seconds),
        iss: &config.issuer,
        aud: &config.audience,
    };
    let header = JwtHeaderForSigning {
        alg: "HS256",
        typ: "JWT",
    };
    let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).ok()?);
    let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).ok()?);
    let signing_input = format!("{header}.{claims}");
    let mut mac = HmacSha256::new_from_slice(config.secret.as_bytes()).ok()?;
    mac.update(signing_input.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Some(format!("{signing_input}.{signature}"))
}

fn parse_ttl_seconds(value: Option<&str>) -> u64 {
    const DEFAULT_TTL_SECONDS: u64 = 60 * 60 * 48;
    let Some(parsed) = value.and_then(|value| value.parse::<f64>().ok()) else {
        return DEFAULT_TTL_SECONDS;
    };
    if !parsed.is_finite() || parsed <= 0.0 {
        return DEFAULT_TTL_SECONDS;
    }
    parsed.floor().min(u64::MAX as f64) as u64
}

#[derive(Serialize)]
struct JwtHeaderForSigning {
    alg: &'static str,
    typ: &'static str,
}

#[derive(Serialize)]
struct LocalAgentJwtClaimsForSigning<'a> {
    sub: &'a str,
    org_id: &'a str,
    adapter_type: &'a str,
    run_id: &'a str,
    iat: u64,
    exp: u64,
    iss: &'a str,
    aud: &'a str,
}

fn decode_json_object(value: &str) -> Option<serde_json::Map<String, Value>> {
    let bytes = URL_SAFE_NO_PAD.decode(value).ok()?;
    let parsed = serde_json::from_slice::<Value>(&bytes).ok()?;
    parsed.as_object().cloned()
}

fn nonempty_string(value: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    let value = value.get(key)?.as_str()?;
    (!value.is_empty()).then(|| value.to_owned())
}

fn truthy_number(value: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
    let number = value.get(key)?.as_number()?.as_f64()?;
    (number.is_finite() && number != 0.0).then_some(number)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use serde_json::json;

    const SECRET: &str = "legacy-agent-jwt-secret";

    fn config() -> NativeAgentJwtConfig {
        NativeAgentJwtConfig {
            secret: SECRET.to_owned(),
            issuer: "rudder".to_owned(),
            audience: "rudder-api".to_owned(),
        }
    }

    fn token(header: Value, claims: Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap());
        let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let signing_input = format!("{header}.{claims}");
        let mut mac = HmacSha256::new_from_slice(SECRET.as_bytes()).unwrap();
        mac.update(signing_input.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{signing_input}.{signature}")
    }

    fn claims() -> Value {
        json!({
            "sub": "agent-1",
            "org_id": "org-1",
            "adapter_type": "codex_local",
            "run_id": "run-1",
            "iat": 100,
            "exp": 200,
            "iss": "rudder",
            "aud": "rudder-api"
        })
    }

    #[test]
    fn verifies_legacy_hs256_claims_and_accepts_expiry_equal_to_now() {
        let token = token(json!({"alg": "HS256", "typ": "JWT"}), claims());
        assert_eq!(
            verify(&token, &config(), 200.0),
            Some(NativeAgentJwtIdentity {
                agent_id: "agent-1".into(),
                org_id: "org-1".into(),
                adapter_type: "codex_local".into(),
                run_id: "run-1".into(),
                expires_at: 200.0,
                token_id: None,
            })
        );
    }

    #[test]
    fn preserves_optional_issuer_audience_and_future_issued_at_semantics() {
        let token = token(
            json!({"alg": "HS256"}),
            json!({
                "sub": "agent-1", "org_id": "org-1", "adapter_type": "x",
                "run_id": "run-1", "iat": 999_999, "exp": 300, "jti": "token-1"
            }),
        );
        assert_eq!(
            verify(&token, &config(), 200.0)
                .unwrap()
                .token_id
                .as_deref(),
            Some("token-1")
        );
    }

    #[test]
    fn signs_runtime_agent_jwt_accepted_by_the_native_verifier() {
        let config = config();
        let token =
            sign_local_agent_jwt("agent-1", "org-1", "claude_local", "run-1", &config).unwrap();
        let identity = verify(&token, &config, 0.0).unwrap();
        assert_eq!(identity.agent_id, "agent-1");
        assert_eq!(identity.org_id, "org-1");
        assert_eq!(identity.adapter_type, "claude_local");
        assert_eq!(identity.run_id, "run-1");
        assert_eq!(identity.expires_at - identity.expires_at.floor(), 0.0);
    }

    #[test]
    fn refuses_to_sign_when_agent_jwt_secret_is_empty() {
        let mut config = config();
        config.secret.clear();
        assert!(
            sign_local_agent_jwt("agent-1", "org-1", "claude_local", "run-1", &config).is_none()
        );
    }

    #[test]
    fn parses_the_legacy_agent_jwt_ttl_setting_and_default() {
        assert_eq!(parse_ttl_seconds(None), 172_800);
        assert_eq!(parse_ttl_seconds(Some("900.8")), 900);
        assert_eq!(parse_ttl_seconds(Some("0")), 172_800);
        assert_eq!(parse_ttl_seconds(Some("NaN")), 172_800);
    }

    #[test]
    fn rejects_forged_expired_wrong_algorithm_and_wrong_issuer_or_audience_tokens() {
        let signed = token(json!({"alg": "HS256"}), claims());
        let forged = format!("{}x", signed);
        assert!(verify(&forged, &config(), 100.0).is_none());
        assert!(verify(&signed, &config(), 201.0).is_none());
        assert!(verify(&token(json!({"alg": "none"}), claims()), &config(), 100.0).is_none());

        let mut wrong_issuer = claims();
        wrong_issuer["iss"] = json!("other");
        assert!(
            verify(
                &token(json!({"alg": "HS256"}), wrong_issuer),
                &config(),
                100.0
            )
            .is_none()
        );

        let mut wrong_audience = claims();
        wrong_audience["aud"] = json!("other");
        assert!(
            verify(
                &token(json!({"alg": "HS256"}), wrong_audience),
                &config(),
                100.0
            )
            .is_none()
        );
    }

    #[test]
    fn rejects_missing_empty_or_zero_required_claims_and_malformed_tokens() {
        assert!(verify("not.a.jwt.with.extra", &config(), 100.0).is_none());
        for (claim, value) in [
            ("sub", json!("")),
            ("org_id", json!("")),
            ("adapter_type", json!("")),
            ("run_id", json!("")),
            ("iat", json!(0)),
            ("exp", json!(0)),
        ] {
            let mut invalid = claims();
            invalid[claim] = value;
            assert!(verify(&token(json!({"alg": "HS256"}), invalid), &config(), 100.0).is_none());
        }
    }
}
