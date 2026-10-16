use super::OfflineGrantConfig;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature,
};
use serde::Deserialize;
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

const MAX_OFFLINE_GRANT_LIFETIME_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const CLOCK_ROLLBACK_TOLERANCE_MS: i64 = 5 * 60 * 1000;
const PROOF_CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;
const MAX_TOKEN_BYTES: usize = 32 * 1024;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OfflineGrantProofPayload {
    pub version: u8,
    pub grant_hash: String,
    pub method: String,
    pub path: String,
    pub body_hash: String,
    pub nonce: String,
    pub issued_at_ms: i64,
}

#[derive(Clone, Debug)]
pub(super) struct VerifiedOfflineGrant {
    pub issuer: String,
    pub account_id: String,
    pub audience: String,
    pub expires_at_ms: i64,
    pub jti: String,
    pub next_trusted_time_ms: u64,
}

enum GrantClaims {
    V1 {
        issuer: String,
        account_id: String,
        device_id: String,
        installation_id: String,
        public_key_thumbprint: String,
        issued_at_ms: i64,
        expires_at_ms: i64,
        trusted_time_ms: i64,
        sign_out_epoch: i64,
        jti: String,
    },
    V2 {
        issuer: String,
        account_id: String,
        device_id: String,
        installation_id: String,
        public_key_thumbprint: String,
        issued_at_ms: i64,
        expires_at_ms: i64,
        trusted_time_ms: i64,
        local_sign_out_epoch: i64,
        auth_schema_epoch: i64,
        account_auth_epoch: i64,
        device_auth_epoch: i64,
        jti: String,
    },
}

impl GrantClaims {
    fn issuer(&self) -> &str {
        match self {
            Self::V1 { issuer, .. } | Self::V2 { issuer, .. } => issuer,
        }
    }

    fn account_id(&self) -> &str {
        match self {
            Self::V1 { account_id, .. } | Self::V2 { account_id, .. } => account_id,
        }
    }

    fn device_id(&self) -> &str {
        match self {
            Self::V1 { device_id, .. } | Self::V2 { device_id, .. } => device_id,
        }
    }

    fn installation_id(&self) -> &str {
        match self {
            Self::V1 {
                installation_id, ..
            }
            | Self::V2 {
                installation_id, ..
            } => installation_id,
        }
    }

    fn public_key_thumbprint(&self) -> &str {
        match self {
            Self::V1 {
                public_key_thumbprint,
                ..
            }
            | Self::V2 {
                public_key_thumbprint,
                ..
            } => public_key_thumbprint,
        }
    }

    fn issued_at_ms(&self) -> i64 {
        match self {
            Self::V1 { issued_at_ms, .. } | Self::V2 { issued_at_ms, .. } => *issued_at_ms,
        }
    }

    fn expires_at_ms(&self) -> i64 {
        match self {
            Self::V1 { expires_at_ms, .. } | Self::V2 { expires_at_ms, .. } => *expires_at_ms,
        }
    }

    fn trusted_time_ms(&self) -> i64 {
        match self {
            Self::V1 {
                trusted_time_ms, ..
            }
            | Self::V2 {
                trusted_time_ms, ..
            } => *trusted_time_ms,
        }
    }

    fn local_sign_out_epoch(&self) -> i64 {
        match self {
            Self::V1 { sign_out_epoch, .. } => *sign_out_epoch,
            Self::V2 {
                local_sign_out_epoch,
                ..
            } => *local_sign_out_epoch,
        }
    }

    fn jti(&self) -> &str {
        match self {
            Self::V1 { jti, .. } | Self::V2 { jti, .. } => jti,
        }
    }
}

pub(super) fn verify_grant_and_proof(
    policy: &OfflineGrantConfig,
    expected_issuer: &str,
    expected_installation_id: &str,
    grant: &str,
    device_public_key_spki: &str,
    proof: &super::LocalOfflineGrantProof,
    now_ms: i64,
    last_trusted_time_ms: u64,
) -> Result<VerifiedOfflineGrant, ()> {
    if grant.len() > MAX_TOKEN_BYTES
        || now_ms < 0
        || now_ms > MAX_SAFE_INTEGER
        || last_trusted_time_ms > MAX_SAFE_INTEGER as u64
        || policy.local_sign_out_epoch > MAX_SAFE_INTEGER as u64
        || proof.payload.version != 1
        || proof.payload.method != "POST"
        || proof.payload.path != "/api/auth/local-offline"
        || proof.payload.body_hash != sha256_base64url(b"")
        || !is_safe_integer(proof.payload.issued_at_ms)
        || now_ms.abs_diff(proof.payload.issued_at_ms) > PROOF_CLOCK_SKEW_MS as u64
    {
        return Err(());
    }
    validate_nonce(&proof.payload.nonce)?;

    let (header_part, claims_part, signature_part) = split_compact_jws(grant)?;
    let header = parse_json_segment(header_part)?;
    if header.get("alg").and_then(Value::as_str) != Some("EdDSA")
        || header.get("typ").and_then(Value::as_str) != Some("rudder-offline-grant+jwt")
        || header.get("kid").and_then(Value::as_str) != Some(policy.identity_key_id.as_str())
    {
        return Err(());
    }
    let identity_key = parse_ed25519_spki(&policy.identity_public_key_spki)?;
    let grant_signature = decode_base64url(signature_part)?;
    signature::UnparsedPublicKey::new(&signature::ED25519, &identity_key)
        .verify(
            format!("{header_part}.{claims_part}").as_bytes(),
            &grant_signature,
        )
        .map_err(|_| ())?;
    let claims = parse_claims(parse_json_segment(claims_part)?)?;
    let (expected_auth_schema_epoch, expected_account_auth_epoch, expected_device_auth_epoch) =
        policy_epochs(policy)?;
    if claims.issuer() != expected_issuer
        || claims.installation_id() != expected_installation_id
        || claims.device_id() != policy.expected_device_id
        || claims.account_id() != policy.expected_account_id
        || claims.expires_at_ms() <= claims.issued_at_ms()
        || claims
            .expires_at_ms()
            .checked_sub(claims.issued_at_ms())
            .filter(|duration| *duration <= MAX_OFFLINE_GRANT_LIFETIME_MS)
            .is_none()
        || now_ms
            .checked_add(CLOCK_ROLLBACK_TOLERANCE_MS)
            .map_or(true, |current| {
                current < claims.trusted_time_ms().max(last_trusted_time_ms as i64)
            })
        || now_ms < claims.issued_at_ms().saturating_sub(PROOF_CLOCK_SKEW_MS)
        || now_ms >= claims.expires_at_ms()
        || policy.local_sign_out_epoch as i64 > claims.local_sign_out_epoch()
    {
        return Err(());
    }
    if let GrantClaims::V2 {
        auth_schema_epoch,
        account_auth_epoch,
        device_auth_epoch,
        ..
    } = &claims
    {
        if expected_auth_schema_epoch.is_some_and(|expected| expected != *auth_schema_epoch)
            || expected_account_auth_epoch.is_some_and(|expected| expected != *account_auth_epoch)
            || expected_device_auth_epoch.is_some_and(|expected| expected != *device_auth_epoch)
        {
            return Err(());
        }
    }

    let device_key = parse_ed25519_spki(device_public_key_spki)?;
    if ed25519_thumbprint(&device_key)? != claims.public_key_thumbprint() {
        return Err(());
    }
    let expected_grant_hash = sha256_base64url(grant.as_bytes());
    if proof.payload.grant_hash != expected_grant_hash {
        return Err(());
    }
    let proof_payload = serde_json::json!({
        "version": proof.payload.version,
        "grantHash": proof.payload.grant_hash,
        "method": proof.payload.method,
        "path": proof.payload.path,
        "bodyHash": proof.payload.body_hash,
        "nonce": proof.payload.nonce,
        "issuedAtMs": proof.payload.issued_at_ms,
    });
    let proof_bytes = canonical_json(&proof_payload)?;
    let proof_signature = decode_base64url(&proof.signature)?;
    signature::UnparsedPublicKey::new(&signature::ED25519, &device_key)
        .verify(&proof_bytes, &proof_signature)
        .map_err(|_| ())?;

    let next_trusted_time_ms = now_ms
        .max(claims.trusted_time_ms())
        .max(last_trusted_time_ms as i64);
    Ok(VerifiedOfflineGrant {
        issuer: claims.issuer().to_owned(),
        account_id: claims.account_id().to_owned(),
        audience: "rudder-local-board".to_owned(),
        expires_at_ms: claims.expires_at_ms(),
        jti: claims.jti().to_owned(),
        next_trusted_time_ms: u64::try_from(next_trusted_time_ms).map_err(|_| ())?,
    })
}

pub(super) fn validate_policy(policy: &OfflineGrantConfig) -> Result<(), ()> {
    if policy.identity_key_id.trim().is_empty()
        || policy.identity_key_id.len() > 512
        || policy.expected_account_id.trim().is_empty()
        || policy.expected_account_id.len() > 512
        || policy.expected_device_id.trim().is_empty()
        || policy.expected_device_id.len() > 512
        || policy.identity_public_key_spki.len() > 128
        || policy.last_trusted_time_ms > MAX_SAFE_INTEGER as u64
        || policy.local_sign_out_epoch > MAX_SAFE_INTEGER as u64
    {
        return Err(());
    }
    parse_ed25519_spki(&policy.identity_public_key_spki)?;
    policy_epochs(policy)?;
    Ok(())
}

fn policy_epochs(
    policy: &OfflineGrantConfig,
) -> Result<(Option<i64>, Option<i64>, Option<i64>), ()> {
    let convert = |value: Option<u64>| -> Result<Option<i64>, ()> {
        match value {
            Some(value) if value <= MAX_SAFE_INTEGER as u64 => {
                Ok(Some(i64::try_from(value).map_err(|_| ())?))
            }
            Some(_) => Err(()),
            None => Ok(None),
        }
    };
    Ok((
        convert(policy.expected_auth_schema_epoch)?,
        convert(policy.expected_account_auth_epoch)?,
        convert(policy.expected_device_auth_epoch)?,
    ))
}

fn parse_claims(value: Value) -> Result<GrantClaims, ()> {
    let record = value.as_object().ok_or(())?;
    let version = integer(record, "version")?;
    if string(record, "audience")? != "rudder-local-board" {
        return Err(());
    }
    let issuer = string(record, "issuer")?;
    let account_id = string(record, "accountId")?;
    let device_id = string(record, "deviceId")?;
    let installation_id = string(record, "installationId")?;
    let public_key_thumbprint = string(record, "publicKeyThumbprint")?;
    let issued_at_ms = integer(record, "issuedAtMs")?;
    let expires_at_ms = integer(record, "expiresAtMs")?;
    let trusted_time_ms = integer(record, "trustedTimeMs")?;
    let jti = string(record, "jti")?;
    match version {
        1 => {
            let sign_out_epoch = integer(record, "signOutEpoch")?;
            if sign_out_epoch < 0 {
                return Err(());
            }
            Ok(GrantClaims::V1 {
                issuer,
                account_id,
                device_id,
                installation_id,
                public_key_thumbprint,
                issued_at_ms,
                expires_at_ms,
                trusted_time_ms,
                sign_out_epoch,
                jti,
            })
        }
        2 => {
            let local_sign_out_epoch = integer(record, "localSignOutEpoch")?;
            let auth_schema_epoch = integer(record, "authSchemaEpoch")?;
            let account_auth_epoch = integer(record, "accountAuthEpoch")?;
            let device_auth_epoch = integer(record, "deviceAuthEpoch")?;
            if local_sign_out_epoch < 0
                || auth_schema_epoch < 1
                || account_auth_epoch < 0
                || device_auth_epoch < 0
            {
                return Err(());
            }
            Ok(GrantClaims::V2 {
                issuer,
                account_id,
                device_id,
                installation_id,
                public_key_thumbprint,
                issued_at_ms,
                expires_at_ms,
                trusted_time_ms,
                local_sign_out_epoch,
                auth_schema_epoch,
                account_auth_epoch,
                device_auth_epoch,
                jti,
            })
        }
        _ => Err(()),
    }
}

fn split_compact_jws(value: &str) -> Result<(&str, &str, &str), ()> {
    let mut parts = value.split('.');
    let header = parts.next().ok_or(())?;
    let claims = parts.next().ok_or(())?;
    let signature = parts.next().ok_or(())?;
    if header.is_empty() || claims.is_empty() || signature.is_empty() || parts.next().is_some() {
        return Err(());
    }
    Ok((header, claims, signature))
}

fn parse_json_segment(segment: &str) -> Result<Value, ()> {
    serde_json::from_slice(&decode_base64url(segment)?).map_err(|_| ())
}

fn decode_base64url(value: &str) -> Result<Vec<u8>, ()> {
    if value.is_empty()
        || value.len() > MAX_TOKEN_BYTES * 2
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(());
    }
    URL_SAFE_NO_PAD.decode(value).map_err(|_| ())
}

fn parse_ed25519_spki(encoded: &str) -> Result<Vec<u8>, ()> {
    let decoded = decode_base64url(encoded)?;
    if decoded.len() != ED25519_SPKI_PREFIX.len() + 32
        || decoded[..ED25519_SPKI_PREFIX.len()] != ED25519_SPKI_PREFIX
    {
        return Err(());
    }
    Ok(decoded[ED25519_SPKI_PREFIX.len()..].to_vec())
}

fn ed25519_thumbprint(raw_public_key: &[u8]) -> Result<String, ()> {
    if raw_public_key.len() != 32 {
        return Err(());
    }
    let x = URL_SAFE_NO_PAD.encode(raw_public_key);
    let jwk = serde_json::json!({"crv": "Ed25519", "kty": "OKP", "x": x});
    Ok(sha256_base64url(&canonical_json(&jwk)?))
}

fn canonical_json(value: &Value) -> Result<Vec<u8>, ()> {
    let mut output = String::new();
    append_canonical_json(value, &mut output)?;
    Ok(output.into_bytes())
}

fn append_canonical_json(value: &Value, output: &mut String) -> Result<(), ()> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => output.push_str(&canonical_number(value)?),
        Value::String(value) => output.push_str(&serde_json::to_string(value).map_err(|_| ())?),
        Value::Array(values) => {
            output.push('[');
            for (index, item) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                append_canonical_json(item, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).map_err(|_| ())?);
                output.push(':');
                append_canonical_json(&values[key], output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

fn canonical_number(value: &Number) -> Result<String, ()> {
    if let Some(integer) = value.as_i64() {
        if !is_safe_integer(integer) {
            return Err(());
        }
        return Ok(integer.to_string());
    }
    let float = value.as_f64().ok_or(())?;
    if !float.is_finite() || float.fract() != 0.0 || float.abs() > MAX_SAFE_INTEGER as f64 {
        return Err(());
    }
    Ok((float as i64).to_string())
}

fn integer(record: &Map<String, Value>, key: &str) -> Result<i64, ()> {
    let value = record.get(key).and_then(Value::as_i64).ok_or(())?;
    if !is_safe_integer(value) {
        return Err(());
    }
    Ok(value)
}

fn string(record: &Map<String, Value>, key: &str) -> Result<String, ()> {
    let value = record.get(key).and_then(Value::as_str).ok_or(())?;
    if value.is_empty() || value.len() > 512 {
        return Err(());
    }
    Ok(value.to_owned())
}

fn is_safe_integer(value: i64) -> bool {
    value.unsigned_abs() <= MAX_SAFE_INTEGER as u64
}

fn validate_nonce(value: &str) -> Result<(), ()> {
    if !(16..=256).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(());
    }
    Ok(())
}

pub(super) fn sha256_base64url(value: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value))
}

pub(super) fn random_session_token() -> Result<String, ring::error::Unspecified> {
    let mut token = [0u8; 32];
    SystemRandom::new().fill(&mut token)?;
    Ok(URL_SAFE_NO_PAD.encode(token))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::KeyPair;
    use serde_json::json;

    fn signed_compact(
        key_pair: &signature::Ed25519KeyPair,
        header: Value,
        claims: Value,
    ) -> String {
        let header = URL_SAFE_NO_PAD.encode(canonical_json(&header).unwrap());
        let claims = URL_SAFE_NO_PAD.encode(canonical_json(&claims).unwrap());
        let input = format!("{header}.{claims}");
        let signature = key_pair.sign(input.as_bytes());
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref()))
    }

    fn spki(public_key: &[u8]) -> String {
        let mut encoded = ED25519_SPKI_PREFIX.to_vec();
        encoded.extend_from_slice(public_key);
        URL_SAFE_NO_PAD.encode(encoded)
    }

    fn policy(identity_key: &str) -> OfflineGrantConfig {
        OfflineGrantConfig {
            identity_key_id: "key-1".into(),
            identity_public_key_spki: identity_key.into(),
            expected_account_id: "account-1".into(),
            expected_device_id: "device-1".into(),
            last_trusted_time_ms: 1_000_000,
            local_sign_out_epoch: 0,
            expected_auth_schema_epoch: None,
            expected_account_auth_epoch: None,
            expected_device_auth_epoch: None,
        }
    }

    #[test]
    fn verifies_ed25519_grant_and_device_proof_with_stable_json_contract() {
        let rng = SystemRandom::new();
        let identity_pkcs8 = signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let identity = signature::Ed25519KeyPair::from_pkcs8(identity_pkcs8.as_ref()).unwrap();
        let device_pkcs8 = signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let device = signature::Ed25519KeyPair::from_pkcs8(device_pkcs8.as_ref()).unwrap();
        let identity_spki = spki(identity.public_key().as_ref());
        let device_spki = spki(device.public_key().as_ref());
        let thumbprint = ed25519_thumbprint(device.public_key().as_ref()).unwrap();
        let now_ms = 1_100_000;
        let grant = signed_compact(
            &identity,
            json!({"alg":"EdDSA","typ":"rudder-offline-grant+jwt","kid":"key-1"}),
            json!({
                "version":2,"issuer":"https://accounts.example","accountId":"account-1",
                "deviceId":"device-1","installationId":"installation-1",
                "audience":"rudder-local-board","publicKeyThumbprint":thumbprint,
                "issuedAtMs":1_000_000,"expiresAtMs":20_000_000,
                "trustedTimeMs":1_000_000,"localSignOutEpoch":0,
                "authSchemaEpoch":2,"accountAuthEpoch":0,"deviceAuthEpoch":0,"jti":"grant-1"
            }),
        );
        let nonce = "abcdefghijklmnop0123456789";
        let grant_hash = sha256_base64url(grant.as_bytes());
        let payload = json!({
            "version":1,"grantHash":grant_hash,"method":"POST",
            "path":"/api/auth/local-offline","bodyHash":sha256_base64url(b""),
            "nonce":nonce,"issuedAtMs":now_ms
        });
        let proof = super::super::LocalOfflineGrantProof {
            payload: serde_json::from_value(payload.clone()).unwrap(),
            signature: URL_SAFE_NO_PAD
                .encode(device.sign(&canonical_json(&payload).unwrap()).as_ref()),
        };
        let configuration = policy(&identity_spki);
        let verified = verify_grant_and_proof(
            &configuration,
            "https://accounts.example",
            "installation-1",
            &grant,
            &device_spki,
            &proof,
            now_ms,
            1_000_000,
        )
        .unwrap();
        assert_eq!(verified.jti, "grant-1");
        assert_eq!(verified.next_trusted_time_ms, now_ms as u64);
    }

    #[test]
    fn rejects_malformed_spki_nonce_and_noncanonical_request_binding() {
        assert!(parse_ed25519_spki("Zm9v").is_err());
        assert!(validate_nonce("short").is_err());
        assert!(decode_base64url("abc=").is_err());
        assert_eq!(
            sha256_base64url(b""),
            "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
        );
    }

    #[test]
    fn offline_request_deserialization_rejects_unknown_fields_at_every_level() {
        let valid = json!({
            "grant": "a".repeat(32),
            "devicePublicKeySpki": "b".repeat(32),
            "proof": {
                "payload": {
                    "version": 1,
                    "grantHash": "h".repeat(16),
                    "method": "POST",
                    "path": "/api/auth/local-offline",
                    "bodyHash": "h".repeat(16),
                    "nonce": "abcdefghijklmnop",
                    "issuedAtMs": 1000000
                },
                "signature": "s".repeat(16)
            }
        });
        assert!(
            serde_json::from_value::<super::super::LocalOfflineGrantRequest>(valid.clone()).is_ok()
        );

        let mut root_unknown = valid.clone();
        root_unknown["extra"] = json!(true);
        assert!(
            serde_json::from_value::<super::super::LocalOfflineGrantRequest>(root_unknown).is_err()
        );

        let mut payload_unknown = valid;
        payload_unknown["proof"]["payload"]["extra"] = json!(true);
        assert!(
            serde_json::from_value::<super::super::LocalOfflineGrantRequest>(payload_unknown)
                .is_err()
        );
    }
}
