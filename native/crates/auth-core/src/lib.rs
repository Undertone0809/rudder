//! Signed, short-lived actor envelopes for the private Node/Rust boundary.
//!
//! This crate owns only protocol data and verification. It does not persist
//! credentials, contact an identity provider, write product state, or open a
//! network listener. The caller supplies the current request and a process-local
//! replay guard.

#![forbid(unsafe_code)]

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fmt};
use subtle::ConstantTimeEq;
use thiserror::Error;
use zeroize::Zeroizing;

/// The only protocol version accepted by this crate.
pub const PROTOCOL_VERSION: u16 = 2;
/// Stable protocol name used as domain separation in the signing bytes.
pub const PROTOCOL_SCHEMA: &str = "rudder.actor-envelope.v2";
/// Maximum size of a textual protocol field in bytes.
pub const MAX_FIELD_BYTES: usize = 256;
/// Maximum lifetime of an envelope, in Unix seconds.
pub const MAX_ENVELOPE_LIFETIME_SECONDS: u64 = 300;
/// Number of bytes in a SHA-256 digest.
pub const SHA256_BYTES: usize = 32;
/// Number of hexadecimal characters in a SHA-256 digest or signature.
pub const SHA256_HEX_LENGTH: usize = SHA256_BYTES * 2;
/// Default number of live nonces retained by the process-local replay guard.
pub const DEFAULT_REPLAY_CAPACITY: usize = 16 * 1024;
/// Maximum replay-guard capacity accepted by this crate.
pub const MAX_REPLAY_CAPACITY: usize = 64 * 1024;

/// Errors returned while constructing or verifying an actor envelope.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum AuthError {
    #[error("invalid {field}")]
    InvalidField { field: &'static str },
    #[error("unsupported actor envelope protocol version {actual}; expected {expected}")]
    UnsupportedProtocolVersion { actual: u16, expected: u16 },
    #[error("the signing key must not be empty")]
    InvalidSecretKey,
    #[error("actor envelope signature is invalid")]
    InvalidSignature,
    #[error("actor does not match the request")]
    ActorMismatch,
    #[error("organization does not match the request")]
    OrganizationMismatch,
    #[error("authentication session does not match the request")]
    SessionMismatch,
    #[error("authentication epoch does not match the request")]
    AuthEpochMismatch,
    #[error("audience does not match the request")]
    AudienceMismatch,
    #[error("HTTP method does not match the request")]
    MethodMismatch,
    #[error("path does not match the request")]
    PathMismatch,
    #[error("action does not match the request")]
    ActionMismatch,
    #[error("request id does not match the request")]
    RequestIdMismatch,
    #[error("request body hash does not match the envelope")]
    BodyHashMismatch,
    #[error("envelope timestamp range is invalid")]
    InvalidTimestamp,
    #[error("actor envelope has expired")]
    Expired,
    #[error("actor envelope is not valid yet")]
    NotYetValid,
    #[error("actor envelope nonce has already been used")]
    Replay,
    #[error("actor envelope replay guard capacity is exhausted")]
    ReplayCapacityExceeded,
    #[error("replay guard capacity must be between one and {max} entries")]
    InvalidReplayCapacity { max: usize },
}

/// Compatibility alias with a more descriptive name for downstream adapters.
pub type ActorEnvelopeError = AuthError;

/// The actor type and stable identifier bound into an envelope.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActorIdentity {
    pub kind: String,
    pub id: String,
}

/// A short alias for callers that refer to the claim as an actor.
pub type Actor = ActorIdentity;

impl ActorIdentity {
    /// Create a validated actor identity.
    pub fn new(kind: impl Into<String>, id: impl Into<String>) -> Result<Self, AuthError> {
        let kind = kind.into();
        let id = id.into();
        validate_text(&kind, "actorKind")?;
        validate_text(&id, "actorId")?;
        Ok(Self { kind, id })
    }

    fn validate(&self) -> Result<(), AuthError> {
        validate_text(&self.kind, "actorKind")?;
        validate_text(&self.id, "actorId")
    }
}

/// Request claims before an HMAC signature is attached.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UnsignedActorEnvelope {
    pub protocol_version: u16,
    pub actor: ActorIdentity,
    pub organization_id: String,
    pub session_id: String,
    pub auth_epoch: u64,
    pub audience: String,
    pub method: String,
    pub path: String,
    pub action: String,
    pub body_sha256: String,
    pub request_id: String,
    pub nonce: String,
    pub issued_at: u64,
    pub expires_at: u64,
}

impl UnsignedActorEnvelope {
    /// Attach an HMAC-SHA256 signature. The secret is used only for this call
    /// and is never stored in or serialized with the returned envelope.
    pub fn sign(self, secret: &[u8]) -> Result<ActorEnvelope, AuthError> {
        self.validate()?;
        let signature = hmac_signature(secret, &self.signing_bytes())?;
        Ok(ActorEnvelope {
            protocol_version: self.protocol_version,
            actor: self.actor,
            organization_id: self.organization_id,
            session_id: self.session_id,
            auth_epoch: self.auth_epoch,
            audience: self.audience,
            method: self.method,
            path: self.path,
            action: self.action,
            body_sha256: self.body_sha256,
            request_id: self.request_id,
            nonce: self.nonce,
            issued_at: self.issued_at,
            expires_at: self.expires_at,
            signature,
        })
    }

    /// Sign using a non-serializable, zeroizing key wrapper.
    pub fn sign_with_key(self, key: &SigningKey) -> Result<ActorEnvelope, AuthError> {
        self.sign(key.as_bytes())
    }

    /// Return the exact bytes covered by the HMAC.
    ///
    /// The representation is a versioned domain separator followed by
    /// length-prefixed UTF-8 fields and big-endian integer timestamps. It is
    /// deterministic across Node and Rust implementations and excludes the
    /// signature itself.
    pub fn signing_bytes(&self) -> Vec<u8> {
        canonical_signing_bytes(
            self.protocol_version,
            &self.actor,
            &self.organization_id,
            &self.session_id,
            self.auth_epoch,
            &self.audience,
            &self.method,
            &self.path,
            &self.action,
            &self.body_sha256,
            &self.request_id,
            &self.nonce,
            self.issued_at,
            self.expires_at,
        )
    }

    fn validate(&self) -> Result<(), AuthError> {
        validate_version(self.protocol_version)?;
        validate_claims(
            &self.actor,
            &self.organization_id,
            &self.session_id,
            self.auth_epoch,
            &self.audience,
            &self.method,
            &self.path,
            &self.action,
            &self.body_sha256,
            &self.request_id,
            &self.nonce,
            self.issued_at,
            self.expires_at,
        )
    }
}

/// A complete actor envelope. It contains claims and a signature, never the
/// secret key used to produce that signature.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActorEnvelope {
    pub protocol_version: u16,
    pub actor: ActorIdentity,
    pub organization_id: String,
    pub session_id: String,
    pub auth_epoch: u64,
    pub audience: String,
    pub method: String,
    pub path: String,
    pub action: String,
    pub body_sha256: String,
    pub request_id: String,
    pub nonce: String,
    pub issued_at: u64,
    pub expires_at: u64,
    pub signature: String,
}

impl ActorEnvelope {
    /// Build validated unsigned claims for one HTTP/action request.
    #[allow(clippy::new_ret_no_self, clippy::too_many_arguments)]
    pub fn new(
        actor: ActorIdentity,
        organization_id: impl Into<String>,
        session_id: impl Into<String>,
        auth_epoch: u64,
        audience: impl Into<String>,
        method: impl Into<String>,
        path: impl Into<String>,
        action: impl Into<String>,
        body: &[u8],
        request_id: impl Into<String>,
        nonce: impl Into<String>,
        issued_at: u64,
        expires_at: u64,
    ) -> Result<UnsignedActorEnvelope, AuthError> {
        let envelope = UnsignedActorEnvelope {
            protocol_version: PROTOCOL_VERSION,
            actor,
            organization_id: organization_id.into(),
            session_id: session_id.into(),
            auth_epoch,
            audience: audience.into(),
            method: method.into(),
            path: path.into(),
            action: action.into(),
            body_sha256: body_sha256(body),
            request_id: request_id.into(),
            nonce: nonce.into(),
            issued_at,
            expires_at,
        };
        envelope.validate()?;
        Ok(envelope)
    }

    /// Sign an already-created unsigned envelope.
    pub fn from_unsigned(
        unsigned: UnsignedActorEnvelope,
        secret: &[u8],
    ) -> Result<Self, AuthError> {
        unsigned.sign(secret)
    }

    /// Verify signature, freshness, request bindings, and then consume the
    /// nonce exactly once. No state is changed when any earlier check fails.
    pub fn verify(
        &self,
        secret: &[u8],
        request: &RequestContext<'_>,
        replay: &mut NonceReplayGuard,
    ) -> Result<(), AuthError> {
        self.validate()?;
        if request.now < self.issued_at {
            return Err(AuthError::NotYetValid);
        }
        if request.now >= self.expires_at {
            return Err(AuthError::Expired);
        }
        self.verify_signature(secret)?;
        self.verify_request_bindings(request)?;
        replay.claim(&self.nonce, self.expires_at, request.now)
    }

    /// Verify using a non-serializable, zeroizing key wrapper.
    pub fn verify_with_key(
        &self,
        key: &SigningKey,
        request: &RequestContext<'_>,
        replay: &mut NonceReplayGuard,
    ) -> Result<(), AuthError> {
        self.verify(key.as_bytes(), request, replay)
    }

    /// Return the exact unsigned claims covered by the signature.
    pub fn signing_bytes(&self) -> Vec<u8> {
        canonical_signing_bytes(
            self.protocol_version,
            &self.actor,
            &self.organization_id,
            &self.session_id,
            self.auth_epoch,
            &self.audience,
            &self.method,
            &self.path,
            &self.action,
            &self.body_sha256,
            &self.request_id,
            &self.nonce,
            self.issued_at,
            self.expires_at,
        )
    }

    fn validate(&self) -> Result<(), AuthError> {
        validate_version(self.protocol_version)?;
        validate_claims(
            &self.actor,
            &self.organization_id,
            &self.session_id,
            self.auth_epoch,
            &self.audience,
            &self.method,
            &self.path,
            &self.action,
            &self.body_sha256,
            &self.request_id,
            &self.nonce,
            self.issued_at,
            self.expires_at,
        )?;
        if self.signature.is_empty() {
            return Err(AuthError::InvalidSignature);
        }
        Ok(())
    }

    fn verify_signature(&self, secret: &[u8]) -> Result<(), AuthError> {
        let provided = hex::decode(&self.signature).map_err(|_| AuthError::InvalidSignature)?;
        if provided.len() != SHA256_BYTES {
            return Err(AuthError::InvalidSignature);
        }
        let expected = hmac_bytes(secret, &self.signing_bytes())?;
        if expected.as_slice().ct_eq(provided.as_slice()).unwrap_u8() != 1 {
            return Err(AuthError::InvalidSignature);
        }
        Ok(())
    }

    fn verify_request_bindings(&self, request: &RequestContext<'_>) -> Result<(), AuthError> {
        request.actor.validate()?;
        validate_text(request.organization_id, "organizationId")?;
        validate_text(request.session_id, "sessionId")?;
        validate_auth_epoch(request.auth_epoch)?;
        validate_text(request.audience, "audience")?;
        validate_text(request.method, "method")?;
        validate_path(request.path)?;
        validate_text(request.action, "action")?;
        validate_text(request.request_id, "requestId")?;

        if self.actor != *request.actor {
            return Err(AuthError::ActorMismatch);
        }
        if self.organization_id != request.organization_id {
            return Err(AuthError::OrganizationMismatch);
        }
        if self.session_id != request.session_id {
            return Err(AuthError::SessionMismatch);
        }
        if self.auth_epoch != request.auth_epoch {
            return Err(AuthError::AuthEpochMismatch);
        }
        if self.audience != request.audience {
            return Err(AuthError::AudienceMismatch);
        }
        if self.method != request.method {
            return Err(AuthError::MethodMismatch);
        }
        if self.path != request.path {
            return Err(AuthError::PathMismatch);
        }
        if self.action != request.action {
            return Err(AuthError::ActionMismatch);
        }
        if self.request_id != request.request_id {
            return Err(AuthError::RequestIdMismatch);
        }
        if self.body_sha256 != body_sha256(request.body) {
            return Err(AuthError::BodyHashMismatch);
        }
        Ok(())
    }
}

/// The trusted request values that must match a signed envelope.
///
/// The caller owns these values and supplies the current clock. Keeping the
/// context separate prevents verification from trusting claims copied out of
/// the untrusted envelope. `session_id` and `auth_epoch` must be read from the
/// currently active authentication state, so logout or credential revocation
/// invalidates envelopes issued under the previous state.
pub struct RequestContext<'a> {
    pub actor: &'a ActorIdentity,
    pub organization_id: &'a str,
    pub session_id: &'a str,
    pub auth_epoch: u64,
    pub audience: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub action: &'a str,
    pub body: &'a [u8],
    pub request_id: &'a str,
    pub now: u64,
}

impl<'a> RequestContext<'a> {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        actor: &'a ActorIdentity,
        organization_id: &'a str,
        session_id: &'a str,
        auth_epoch: u64,
        audience: &'a str,
        method: &'a str,
        path: &'a str,
        action: &'a str,
        body: &'a [u8],
        request_id: &'a str,
        now: u64,
    ) -> Self {
        Self {
            actor,
            organization_id,
            session_id,
            auth_epoch,
            audience,
            method,
            path,
            action,
            body,
            request_id,
            now,
        }
    }
}

/// A process-local single-use nonce guard.
///
/// This is deliberately an in-memory primitive. A caller that spans processes
/// must provide an equivalent atomic store at its boundary; this crate does not
/// create a database or credential store.
#[derive(Clone, Debug)]
pub struct NonceReplayGuard {
    used: BTreeMap<String, u64>,
    capacity: usize,
}

impl NonceReplayGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(capacity: usize) -> Result<Self, AuthError> {
        if capacity == 0 || capacity > MAX_REPLAY_CAPACITY {
            return Err(AuthError::InvalidReplayCapacity {
                max: MAX_REPLAY_CAPACITY,
            });
        }
        Ok(Self {
            used: BTreeMap::new(),
            capacity,
        })
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn len(&self) -> usize {
        self.used.len()
    }

    pub fn is_empty(&self) -> bool {
        self.used.is_empty()
    }

    pub fn contains(&self, nonce: &str) -> bool {
        self.used.contains_key(nonce)
    }

    pub fn claim(&mut self, nonce: &str, expires_at: u64, now: u64) -> Result<(), AuthError> {
        validate_text(nonce, "nonce")?;
        self.used.retain(|_, expiry| *expiry > now);
        if expires_at <= now {
            return Err(AuthError::Expired);
        }
        if self.used.contains_key(nonce) {
            return Err(AuthError::Replay);
        }
        if self.used.len() >= self.capacity {
            return Err(AuthError::ReplayCapacityExceeded);
        }
        self.used.insert(nonce.to_owned(), expires_at);
        Ok(())
    }
}

impl Default for NonceReplayGuard {
    fn default() -> Self {
        Self {
            used: BTreeMap::new(),
            capacity: DEFAULT_REPLAY_CAPACITY,
        }
    }
}

/// A signing key that cannot be serialized and prints only a redacted debug
/// representation. Its bytes are zeroized when the wrapper is dropped.
pub struct SigningKey {
    secret: Zeroizing<Vec<u8>>,
}

impl SigningKey {
    pub fn new(secret: &[u8]) -> Result<Self, AuthError> {
        if secret.is_empty() {
            return Err(AuthError::InvalidSecretKey);
        }
        Ok(Self {
            secret: Zeroizing::new(secret.to_vec()),
        })
    }

    fn as_bytes(&self) -> &[u8] {
        self.secret.as_slice()
    }
}

impl Clone for SigningKey {
    fn clone(&self) -> Self {
        Self {
            secret: Zeroizing::new(self.secret.to_vec()),
        }
    }
}

impl fmt::Debug for SigningKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SigningKey(REDACTED)")
    }
}

impl Serialize for SigningKey {
    fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        Err(serde::ser::Error::custom(
            "signing key serialization is prohibited",
        ))
    }
}

/// Hash an HTTP request body using SHA-256 and return lowercase hexadecimal.
pub fn body_sha256(body: &[u8]) -> String {
    hex::encode(Sha256::digest(body))
}

/// Alias used by adapters that call the field a body hash.
pub fn hash_body(body: &[u8]) -> String {
    body_sha256(body)
}

type HmacSha256 = Hmac<Sha256>;

fn hmac_signature(secret: &[u8], input: &[u8]) -> Result<String, AuthError> {
    Ok(hex::encode(hmac_bytes(secret, input)?))
}

fn hmac_bytes(secret: &[u8], input: &[u8]) -> Result<Vec<u8>, AuthError> {
    if secret.is_empty() {
        return Err(AuthError::InvalidSecretKey);
    }
    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| AuthError::InvalidSecretKey)?;
    mac.update(input);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn validate_version(version: u16) -> Result<(), AuthError> {
    if version != PROTOCOL_VERSION {
        return Err(AuthError::UnsupportedProtocolVersion {
            actual: version,
            expected: PROTOCOL_VERSION,
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_claims(
    actor: &ActorIdentity,
    organization_id: &str,
    session_id: &str,
    auth_epoch: u64,
    audience: &str,
    method: &str,
    path: &str,
    action: &str,
    body_hash: &str,
    request_id: &str,
    nonce: &str,
    issued_at: u64,
    expires_at: u64,
) -> Result<(), AuthError> {
    actor.validate()?;
    validate_text(organization_id, "organizationId")?;
    validate_text(session_id, "sessionId")?;
    validate_auth_epoch(auth_epoch)?;
    validate_text(audience, "audience")?;
    validate_text(method, "method")?;
    validate_path(path)?;
    validate_text(action, "action")?;
    validate_body_hash(body_hash)?;
    validate_text(request_id, "requestId")?;
    validate_text(nonce, "nonce")?;
    if issued_at == 0 || expires_at <= issued_at {
        return Err(AuthError::InvalidTimestamp);
    }
    if expires_at - issued_at > MAX_ENVELOPE_LIFETIME_SECONDS {
        return Err(AuthError::InvalidTimestamp);
    }
    Ok(())
}

fn validate_auth_epoch(auth_epoch: u64) -> Result<(), AuthError> {
    if auth_epoch == 0 {
        return Err(AuthError::InvalidField { field: "authEpoch" });
    }
    Ok(())
}

fn validate_text(value: &str, field: &'static str) -> Result<(), AuthError> {
    if value.is_empty()
        || value.trim().is_empty()
        || value.len() > MAX_FIELD_BYTES
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(AuthError::InvalidField { field });
    }
    Ok(())
}

fn validate_path(path: &str) -> Result<(), AuthError> {
    validate_text(path, "path")?;
    if !path.starts_with('/') {
        return Err(AuthError::InvalidField { field: "path" });
    }
    Ok(())
}

fn validate_body_hash(body_hash: &str) -> Result<(), AuthError> {
    if body_hash.len() != SHA256_HEX_LENGTH
        || !body_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || body_hash.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err(AuthError::InvalidField {
            field: "bodySha256",
        });
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn canonical_signing_bytes(
    protocol_version: u16,
    actor: &ActorIdentity,
    organization_id: &str,
    session_id: &str,
    auth_epoch: u64,
    audience: &str,
    method: &str,
    path: &str,
    action: &str,
    body_hash: &str,
    request_id: &str,
    nonce: &str,
    issued_at: u64,
    expires_at: u64,
) -> Vec<u8> {
    let fields = [
        actor.kind.as_bytes(),
        actor.id.as_bytes(),
        organization_id.as_bytes(),
        session_id.as_bytes(),
        audience.as_bytes(),
        method.as_bytes(),
        path.as_bytes(),
        action.as_bytes(),
        body_hash.as_bytes(),
        request_id.as_bytes(),
        nonce.as_bytes(),
    ];
    let mut output =
        Vec::with_capacity(64 + fields.iter().map(|field| field.len() + 8).sum::<usize>());
    output.extend_from_slice(PROTOCOL_SCHEMA.as_bytes());
    output.push(0);
    output.extend_from_slice(&protocol_version.to_be_bytes());
    for field in fields {
        output.extend_from_slice(&(field.len() as u64).to_be_bytes());
        output.extend_from_slice(field);
    }
    output.extend_from_slice(&auth_epoch.to_be_bytes());
    output.extend_from_slice(&issued_at.to_be_bytes());
    output.extend_from_slice(&expires_at.to_be_bytes());
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signing_key_debug_is_redacted() {
        let key = SigningKey::new(b"not-for-output").expect("key");
        assert!(!format!("{key:?}").contains("not-for-output"));
        let serialization_error = serde_json::to_string(&key).expect_err("key serialization");
        assert!(!serialization_error.to_string().contains("not-for-output"));
    }
}
