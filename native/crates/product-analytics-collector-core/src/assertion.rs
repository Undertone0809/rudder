use crate::error::CollectorError;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::Deserialize;
use std::time::{SystemTime, UNIX_EPOCH};

pub const ASSERTION_AUDIENCE: &str = "telemetry-collector";
pub const MAX_ASSERTION_LIFETIME_MS: u64 = 15 * 60 * 1000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssertionHeader {
    alg: String,
    typ: String,
    kid: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryClaims {
    pub version: u8,
    pub issuer: String,
    pub audience: String,
    pub installation_id: String,
    pub pseudonymous_installation_id: String,
    pub analytics_subject: Option<String>,
    pub consent_version: String,
    pub consent_epoch: u64,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub jti: String,
}

#[derive(Clone, Debug)]
pub struct VerifiedAssertion {
    pub claims: TelemetryClaims,
}

pub struct AssertionVerificationContext<'a> {
    pub identity_public_key: &'a [u8],
    pub expected_key_id: &'a str,
    pub expected_issuer: &'a str,
    pub expected_installation_id: &'a str,
    pub expected_consent_epoch: Option<u64>,
    pub expected_analytics_subject: Option<Option<&'a str>>,
    pub now_ms: Option<u64>,
}

pub fn decode_identity_public_key(value: &str) -> Result<Vec<u8>, CollectorError> {
    let trimmed = value.trim();
    let der_or_raw = if trimmed.contains("BEGIN PUBLIC KEY") {
        let body = trimmed
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect::<String>();
        STANDARD
            .decode(body.as_bytes())
            .map_err(|_| CollectorError::Configuration("invalid_identity_public_key".into()))?
    } else {
        URL_SAFE_NO_PAD
            .decode(trimmed.as_bytes())
            .or_else(|_| STANDARD.decode(trimmed.as_bytes()))
            .map_err(|_| CollectorError::Configuration("invalid_identity_public_key".into()))?
    };
    // SubjectPublicKeyInfo for Ed25519 is the fixed 12-byte prefix followed
    // by the 32-byte raw key. Ring's ED25519 verifier accepts the raw key.
    const ED25519_SPKI_PREFIX: &[u8] = &[
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if der_or_raw.len() == 44 && der_or_raw.starts_with(ED25519_SPKI_PREFIX) {
        return Ok(der_or_raw[12..].to_vec());
    }
    if der_or_raw.len() == 32 {
        return Ok(der_or_raw);
    }
    Err(CollectorError::Configuration(
        "invalid_identity_public_key".into(),
    ))
}

pub fn verify_product_analytics_assertion(
    assertion: &str,
    context: AssertionVerificationContext<'_>,
) -> Result<VerifiedAssertion, CollectorError> {
    let parts = assertion.split('.').collect::<Vec<_>>();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err(CollectorError::Unauthorized);
    }
    let header: AssertionHeader =
        decode_part(parts[0]).map_err(|_| CollectorError::Unauthorized)?;
    let claims: TelemetryClaims =
        decode_part(parts[1]).map_err(|_| CollectorError::Unauthorized)?;
    if header.alg != "EdDSA"
        || header.typ != "rudder-telemetry-assertion+jwt"
        || header.kid != context.expected_key_id
    {
        return Err(CollectorError::Unauthorized);
    }
    if context.identity_public_key.len() != 32 {
        return Err(CollectorError::Unauthorized);
    }
    UnparsedPublicKey::new(&ED25519, context.identity_public_key)
        .verify(
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &decode_signature(parts[2])?,
        )
        .map_err(|_| CollectorError::Unauthorized)?;
    let now_ms = context.now_ms.unwrap_or_else(current_time_ms);
    if claims.version != 1
        || claims.audience != ASSERTION_AUDIENCE
        || claims.issuer != context.expected_issuer
        || claims.installation_id != context.expected_installation_id
        || claims.pseudonymous_installation_id.is_empty()
        || claims.consent_version.is_empty()
        || claims.consent_version.len() > 80
        || claims.consent_epoch < 1
        || claims.expires_at_ms <= claims.issued_at_ms
        || claims.expires_at_ms - claims.issued_at_ms > MAX_ASSERTION_LIFETIME_MS
        || claims.expires_at_ms <= now_ms
        || claims.issued_at_ms > now_ms.saturating_add(60_000)
        || claims.jti.is_empty()
    {
        return Err(CollectorError::Unauthorized);
    }
    if let Some(epoch) = context.expected_consent_epoch
        && claims.consent_epoch != epoch
    {
        return Err(CollectorError::Unauthorized);
    }
    if let Some(subject) = context.expected_analytics_subject
        && claims.analytics_subject.as_deref() != subject
    {
        return Err(CollectorError::Unauthorized);
    }
    Ok(VerifiedAssertion { claims })
}

fn decode_part<T: for<'de> Deserialize<'de>>(part: &str) -> Result<T, CollectorError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(part.as_bytes())
        .map_err(|_| CollectorError::Unauthorized)?;
    serde_json::from_slice(&bytes).map_err(|_| CollectorError::Unauthorized)
}

fn decode_signature(part: &str) -> Result<Vec<u8>, CollectorError> {
    URL_SAFE_NO_PAD
        .decode(part.as_bytes())
        .map_err(|_| CollectorError::Unauthorized)
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_raw_and_spki_public_keys() {
        let raw = [7_u8; 32];
        assert_eq!(
            decode_identity_public_key(&URL_SAFE_NO_PAD.encode(raw)).unwrap(),
            raw
        );
        let mut spki = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        spki.extend(raw);
        assert_eq!(
            decode_identity_public_key(&STANDARD.encode(spki)).unwrap(),
            raw
        );
    }
}
