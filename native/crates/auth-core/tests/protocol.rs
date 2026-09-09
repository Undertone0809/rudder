use rudder_auth_core::{ActorEnvelope, ActorIdentity, NonceReplayGuard, RequestContext};

const SECRET: &[u8] = b"deterministic-test-secret";
const BODY: &[u8] = br#"{"message":"hello"}"#;

fn actor() -> ActorIdentity {
    ActorIdentity::new("agent", "agent-1").expect("actor")
}

fn context<'a>(actor: &'a ActorIdentity) -> RequestContext<'a> {
    RequestContext::new(
        actor,
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        1_005,
    )
}

#[test]
fn signed_envelope_round_trips_and_verifies() {
    let unsigned = ActorEnvelope::new(
        actor(),
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        "nonce-1",
        1_000,
        1_010,
    )
    .expect("unsigned envelope");
    let envelope = unsigned.sign(SECRET).expect("signed envelope");
    let encoded = serde_json::to_string(&envelope).expect("serialize envelope");
    let decoded: ActorEnvelope = serde_json::from_str(&encoded).expect("deserialize envelope");
    let mut replay = NonceReplayGuard::new();

    decoded
        .verify(SECRET, &context(&actor()), &mut replay)
        .expect("valid envelope");
    assert_eq!(replay.len(), 1);
    assert_eq!(decoded.body_sha256, rudder_auth_core::body_sha256(BODY));
    assert_eq!(decoded.protocol_version, rudder_auth_core::PROTOCOL_VERSION);
    assert_eq!(
        decoded.signature,
        "5714667f8666a5a88711c93bdc096c93eedc3b449c01aec04e5f954704e80135"
    );
    assert!(!encoded.contains("deterministic-test-secret"));
}

#[test]
fn signature_tampering_is_rejected_without_consuming_nonce() {
    let unsigned = ActorEnvelope::new(
        actor(),
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        "nonce-2",
        1_000,
        1_010,
    )
    .expect("unsigned envelope");
    let mut envelope = unsigned.sign(SECRET).expect("signed envelope");
    let replacement = if envelope.signature.starts_with('0') {
        '1'
    } else {
        '0'
    };
    envelope
        .signature
        .replace_range(..1, &replacement.to_string());
    let mut replay = NonceReplayGuard::new();

    let error = envelope
        .verify(SECRET, &context(&actor()), &mut replay)
        .expect_err("tampered signature");
    assert_eq!(error, rudder_auth_core::AuthError::InvalidSignature);
    assert!(replay.is_empty());
}

#[test]
fn a_valid_envelope_nonce_is_single_use() {
    let envelope = ActorEnvelope::new(
        actor(),
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        "nonce-3",
        1_000,
        1_010,
    )
    .expect("unsigned envelope")
    .sign(SECRET)
    .expect("signed envelope");
    let request_actor = actor();
    let request = context(&request_actor);
    let mut replay = NonceReplayGuard::new();

    envelope
        .verify(SECRET, &request, &mut replay)
        .expect("first use");
    let error = envelope
        .verify(SECRET, &request, &mut replay)
        .expect_err("replay");
    assert_eq!(error, rudder_auth_core::AuthError::Replay);
    assert_eq!(replay.len(), 1);
}

#[test]
fn expiry_and_not_yet_valid_envelopes_do_not_consume_nonce() {
    let envelope = ActorEnvelope::new(
        actor(),
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        "nonce-4",
        1_000,
        1_010,
    )
    .expect("unsigned envelope")
    .sign(SECRET)
    .expect("signed envelope");
    let request_actor = actor();
    let mut replay = NonceReplayGuard::new();

    let expired = RequestContext::new(
        &request_actor,
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        1_010,
    );
    assert_eq!(
        envelope.verify(SECRET, &expired, &mut replay),
        Err(rudder_auth_core::AuthError::Expired)
    );

    let early = RequestContext::new(
        &request_actor,
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        999,
    );
    assert_eq!(
        envelope.verify(SECRET, &early, &mut replay),
        Err(rudder_auth_core::AuthError::NotYetValid)
    );
    assert!(replay.is_empty());
}

#[test]
fn body_binding_rejects_substitution_without_consuming_nonce() {
    let envelope = ActorEnvelope::new(
        actor(),
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        "nonce-5",
        1_000,
        1_010,
    )
    .expect("unsigned envelope")
    .sign(SECRET)
    .expect("signed envelope");
    let request_actor = actor();
    let changed_body = RequestContext::new(
        &request_actor,
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        b"changed body",
        "request-1",
        1_005,
    );
    let mut replay = NonceReplayGuard::new();

    assert_eq!(
        envelope.verify(SECRET, &changed_body, &mut replay),
        Err(rudder_auth_core::AuthError::BodyHashMismatch)
    );
    assert!(replay.is_empty());

    envelope
        .verify(SECRET, &context(&request_actor), &mut replay)
        .expect("original body remains valid");
}

#[test]
fn cross_organization_actor_and_audience_bindings_are_rejected() {
    let envelope = ActorEnvelope::new(
        actor(),
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        "nonce-6",
        1_000,
        1_010,
    )
    .expect("unsigned envelope")
    .sign(SECRET)
    .expect("signed envelope");
    let request_actor = actor();
    let mut replay = NonceReplayGuard::new();

    let cross_org = RequestContext::new(
        &request_actor,
        "org-2",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        1_005,
    );
    assert_eq!(
        envelope.verify(SECRET, &cross_org, &mut replay),
        Err(rudder_auth_core::AuthError::OrganizationMismatch)
    );

    let other_actor = ActorIdentity::new("agent", "agent-2").expect("other actor");
    let actor_mismatch = RequestContext::new(
        &other_actor,
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        1_005,
    );
    assert_eq!(
        envelope.verify(SECRET, &actor_mismatch, &mut replay),
        Err(rudder_auth_core::AuthError::ActorMismatch)
    );

    let audience_mismatch = RequestContext::new(
        &request_actor,
        "org-1",
        "session-1",
        7,
        "other-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        1_005,
    );
    assert_eq!(
        envelope.verify(SECRET, &audience_mismatch, &mut replay),
        Err(rudder_auth_core::AuthError::AudienceMismatch)
    );
    assert!(replay.is_empty());
}

#[test]
fn path_mismatch_and_wrong_secret_are_rejected() {
    let envelope = ActorEnvelope::new(
        actor(),
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        "nonce-7",
        1_000,
        1_010,
    )
    .expect("unsigned envelope")
    .sign(SECRET)
    .expect("signed envelope");
    let request_actor = actor();
    let wrong_path = RequestContext::new(
        &request_actor,
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/other-action",
        "agent.execute",
        BODY,
        "request-1",
        1_005,
    );
    let mut replay = NonceReplayGuard::new();

    assert_eq!(
        envelope.verify(SECRET, &wrong_path, &mut replay),
        Err(rudder_auth_core::AuthError::PathMismatch)
    );
    assert_eq!(
        envelope.verify(b"different-secret", &context(&request_actor), &mut replay),
        Err(rudder_auth_core::AuthError::InvalidSignature)
    );
    assert!(replay.is_empty());
}

#[test]
fn malformed_and_unknown_versions_are_rejected() {
    let mut envelope = ActorEnvelope::new(
        actor(),
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        "nonce-8",
        1_000,
        1_010,
    )
    .expect("unsigned envelope")
    .sign(SECRET)
    .expect("signed envelope");
    envelope.protocol_version = 99;
    let mut replay = NonceReplayGuard::new();
    assert_eq!(
        envelope.verify(SECRET, &context(&actor()), &mut replay),
        Err(rudder_auth_core::AuthError::UnsupportedProtocolVersion {
            actual: 99,
            expected: rudder_auth_core::PROTOCOL_VERSION,
        })
    );
    envelope.protocol_version = 1;
    assert_eq!(
        envelope.verify(SECRET, &context(&actor()), &mut replay),
        Err(rudder_auth_core::AuthError::UnsupportedProtocolVersion {
            actual: 1,
            expected: rudder_auth_core::PROTOCOL_VERSION,
        })
    );

    assert!(serde_json::from_str::<ActorEnvelope>(
        r#"{"protocolVersion":2,"actor":{"kind":"agent","id":"agent-1"},"organizationId":"org-1","sessionId":"session-1","authEpoch":7,"audience":"rudder-node","method":"POST","path":"/api/agent-actions","action":"agent.execute","bodySha256":"not-a-hash","requestId":"request-1","nonce":"nonce-9","issuedAt":1000,"expiresAt":1010,"signature":"00"}"#
    )
    .expect("well-typed but malformed claims")
    .verify(SECRET, &context(&actor()), &mut replay)
    .is_err());
    assert!(serde_json::from_str::<ActorEnvelope>(
        r#"{"protocolVersion":2,"actor":{"kind":"agent","id":"agent-1"},"organizationId":"org-1","sessionId":"session-1","authEpoch":7,"audience":"rudder-node","method":"POST","path":"/api/agent-actions","action":"agent.execute","bodySha256":"0000000000000000000000000000000000000000000000000000000000000000","requestId":"request-1","nonce":"nonce-9","issuedAt":1000,"expiresAt":1010,"signature":"00","secret":"must-not-be-accepted"}"#
    )
    .is_err());
}

#[test]
fn constructor_rejects_long_lifetime_and_invalid_path() {
    assert_eq!(
        ActorEnvelope::new(
            actor(),
            "org-1",
            "session-1",
            7,
            "rudder-node",
            "POST",
            "not-an-http-path",
            "agent.execute",
            BODY,
            "request-1",
            "nonce-10",
            1_000,
            1_010,
        )
        .expect_err("path must be absolute"),
        rudder_auth_core::AuthError::InvalidField { field: "path" }
    );
    assert_eq!(
        ActorEnvelope::new(
            actor(),
            "org-1",
            "session-1",
            7,
            "rudder-node",
            "POST",
            "/api/agent-actions",
            "agent.execute",
            BODY,
            "request-1",
            "nonce-11",
            1_000,
            1_301,
        )
        .expect_err("envelopes are short-lived"),
        rudder_auth_core::AuthError::InvalidTimestamp
    );
}

#[test]
fn authentication_session_and_epoch_are_bound_to_the_envelope() {
    let envelope = ActorEnvelope::new(
        actor(),
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-session-binding",
        "nonce-session-binding",
        1_000,
        1_010,
    )
    .expect("unsigned envelope")
    .sign(SECRET)
    .expect("signed envelope");
    let request_actor = actor();
    let mut replay = NonceReplayGuard::new();

    let revoked_session = RequestContext::new(
        &request_actor,
        "org-1",
        "session-2",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-session-binding",
        1_005,
    );
    assert_eq!(
        envelope.verify(SECRET, &revoked_session, &mut replay),
        Err(rudder_auth_core::AuthError::SessionMismatch)
    );

    let advanced_epoch = RequestContext::new(
        &request_actor,
        "org-1",
        "session-1",
        8,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-session-binding",
        1_005,
    );
    assert_eq!(
        envelope.verify(SECRET, &advanced_epoch, &mut replay),
        Err(rudder_auth_core::AuthError::AuthEpochMismatch)
    );
    assert!(replay.is_empty());
}

#[test]
fn replay_guard_evicts_expired_entries_and_rejects_active_overflow() {
    let first = ActorEnvelope::new(
        actor(),
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        "nonce-replay-1",
        1_000,
        1_010,
    )
    .expect("unsigned envelope")
    .sign(SECRET)
    .expect("signed envelope");
    let second = ActorEnvelope::new(
        actor(),
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        "nonce-replay-2",
        1_000,
        1_020,
    )
    .expect("unsigned envelope")
    .sign(SECRET)
    .expect("signed envelope");
    let request_actor = actor();
    let mut replay = NonceReplayGuard::with_capacity(1).expect("capacity");

    first
        .verify(SECRET, &context(&request_actor), &mut replay)
        .expect("first request");
    let error = second
        .verify(SECRET, &context(&request_actor), &mut replay)
        .expect_err("active replay entries must remain bounded");
    assert_eq!(error, rudder_auth_core::AuthError::ReplayCapacityExceeded);
    assert_eq!(replay.len(), 1);

    let after_expiry = RequestContext::new(
        &request_actor,
        "org-1",
        "session-1",
        7,
        "rudder-node",
        "POST",
        "/api/agent-actions",
        "agent.execute",
        BODY,
        "request-1",
        1_010,
    );
    second
        .verify(SECRET, &after_expiry, &mut replay)
        .expect("expired entries are evicted before a new claim");
    assert_eq!(replay.len(), 1);
}

#[test]
fn canonical_signing_bytes_match_machine_readable_cross_language_vector() {
    let vector: serde_json::Value =
        serde_json::from_str(include_str!("../test-vectors/actor-envelope-v2.json"))
            .expect("canonicalization vector");
    assert_eq!(vector["protocolSchema"], "rudder.actor-envelope.v2");
    let claims = &vector["claims"];
    let actor = ActorIdentity::new(
        claims["actor"]["kind"].as_str().expect("actor kind"),
        claims["actor"]["id"].as_str().expect("actor id"),
    )
    .expect("actor");
    let envelope = ActorEnvelope::new(
        actor,
        claims["organizationId"].as_str().expect("organization id"),
        claims["sessionId"].as_str().expect("session id"),
        claims["authEpoch"].as_u64().expect("auth epoch"),
        claims["audience"].as_str().expect("audience"),
        claims["method"].as_str().expect("method"),
        claims["path"].as_str().expect("path"),
        claims["action"].as_str().expect("action"),
        claims["body"].as_str().expect("body").as_bytes(),
        claims["requestId"].as_str().expect("request id"),
        claims["nonce"].as_str().expect("nonce"),
        claims["issuedAt"].as_u64().expect("issued at"),
        claims["expiresAt"].as_u64().expect("expires at"),
    )
    .expect("envelope");
    assert_eq!(
        hex::encode(envelope.signing_bytes()),
        vector["signingBytesHex"].as_str().expect("signing bytes")
    );
}
