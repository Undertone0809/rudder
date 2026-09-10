use rudder_authority_core::{
    AUTHORITY_PROTOCOL_VERSION, ActorIdentity, AuthorityError, ComponentAuthority, HandoffRequest,
    LegacyBridgeRequestEnvelope, MAX_BRIDGE_LIFETIME, MAX_NONCE_BYTES, MAX_REPLAY_CAPACITY,
    MigrationAuthority, NonceReplayGuard, OwnerId, RouteClaim, RouteDecision, RouteRejection,
};

fn legacy_authority() -> ComponentAuthority {
    ComponentAuthority::new("issues", "node-0.7.20", OwnerId::legacy()).expect("legacy authority")
}

fn legacy_registry() -> (MigrationAuthority, ComponentAuthority) {
    let authority = legacy_authority();
    let route =
        RouteClaim::new("/api/issues", "issues", authority.owner.clone()).expect("route claim");
    (
        MigrationAuthority::from_parts(vec![authority.clone()], vec![route]),
        authority,
    )
}

fn actor() -> ActorIdentity {
    ActorIdentity::new("user", "operator-1").expect("actor")
}

#[test]
fn authority_and_bridge_envelope_round_trip_with_versioned_fields() {
    let authority = legacy_authority();
    let envelope = LegacyBridgeRequestEnvelope::new(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        br#"{"issueId":"issue-1"}"#,
        "request-1",
        "nonce-1",
        900,
        1_200,
    )
    .expect("bridge envelope");

    let encoded = serde_json::to_value(&envelope).expect("serialize envelope");
    assert_eq!(encoded["protocolVersion"], AUTHORITY_PROTOCOL_VERSION);
    assert_eq!(encoded["authorityEpoch"], authority.epoch);
    assert_eq!(encoded["bodySha256"].as_str().map(str::len), Some(64));
    assert_eq!(encoded["organizationId"], "org-1");

    let decoded: LegacyBridgeRequestEnvelope =
        serde_json::from_value(encoded).expect("deserialize envelope");
    assert_eq!(decoded, envelope);
}

#[test]
fn bridge_nonce_is_bounded_on_construction_and_validation_before_replay_claim() {
    let (_, authority) = legacy_registry();
    let long_nonce = "n".repeat(MAX_NONCE_BYTES + 1);
    let error = LegacyBridgeRequestEnvelope::new(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        b"body",
        "request-long",
        long_nonce.clone(),
        900,
        1_200,
    )
    .expect_err("construction must reject an overlong nonce");
    assert!(matches!(
        error,
        AuthorityError::InvalidField { field: "nonce" }
    ));

    let valid = LegacyBridgeRequestEnvelope::new(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        b"body",
        "request-valid",
        "nonce-valid",
        900,
        1_200,
    )
    .expect("valid bridge envelope");
    for (request_id, nonce) in [
        ("request-long", long_nonce),
        ("request-control", "nonce\u{0001}".to_owned()),
    ] {
        let mut encoded = serde_json::to_value(&valid).expect("serialize envelope");
        let object = encoded.as_object_mut().expect("object envelope");
        object.insert(
            "requestId".to_owned(),
            serde_json::Value::String(request_id.to_owned()),
        );
        object.insert("nonce".to_owned(), serde_json::Value::String(nonce));
        let envelope: LegacyBridgeRequestEnvelope =
            serde_json::from_value(encoded).expect("deserialize envelope");
        let mut replay = NonceReplayGuard::new();
        let error = envelope
            .validate(
                &authority,
                &actor(),
                "org-1",
                "issue.read",
                b"body",
                request_id,
                1_000,
                &mut replay,
            )
            .expect_err("validation must reject an unsafe nonce");
        assert!(matches!(
            error,
            AuthorityError::InvalidField { field: "nonce" }
        ));
        assert!(
            replay.is_empty(),
            "invalid nonce must not reach replay storage"
        );
    }
}

#[test]
fn bridge_lifetime_rejects_u64_max_and_far_future_expiry() {
    let (_, authority) = legacy_registry();
    for expires_at in [u64::MAX, 1_000 + MAX_BRIDGE_LIFETIME + 1] {
        let valid = LegacyBridgeRequestEnvelope::new(
            &authority,
            actor(),
            "org-1",
            "issue.read",
            b"body",
            "request-future",
            "nonce-future",
            1_000,
            1_200,
        )
        .expect("valid bridge envelope");
        let mut encoded = serde_json::to_value(&valid).expect("serialize envelope");
        encoded["expiresAt"] = serde_json::Value::from(expires_at);
        let envelope: LegacyBridgeRequestEnvelope =
            serde_json::from_value(encoded).expect("deserialize envelope");
        let mut replay = NonceReplayGuard::new();
        let error = envelope
            .validate(
                &authority,
                &actor(),
                "org-1",
                "issue.read",
                b"body",
                "request-future",
                1_000,
                &mut replay,
            )
            .expect_err("far-future expiry must fail closed");
        assert!(matches!(error, AuthorityError::LifetimeTooLong));
        assert!(replay.is_empty());
    }

    let error = LegacyBridgeRequestEnvelope::new(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        b"body",
        "request-construction-future",
        "nonce-construction-future",
        1_000,
        1_000 + MAX_BRIDGE_LIFETIME + 1,
    )
    .expect_err("construction must reject an overlong bridge lifetime");
    assert!(matches!(error, AuthorityError::LifetimeTooLong));
}

#[test]
fn bridge_validation_rejects_not_yet_valid_and_expired_envelopes() {
    let (_, authority) = legacy_registry();
    let not_yet_valid = LegacyBridgeRequestEnvelope::new(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        b"body",
        "request-future",
        "nonce-future",
        2_000,
        2_100,
    )
    .expect("future envelope fixture");
    let mut replay = NonceReplayGuard::new();
    let error = not_yet_valid
        .validate(
            &authority,
            &actor(),
            "org-1",
            "issue.read",
            b"body",
            "request-future",
            1_999,
            &mut replay,
        )
        .expect_err("not-yet-valid envelope must fail closed");
    assert!(matches!(error, AuthorityError::NotYetValid));
    assert!(replay.is_empty());

    let expired = LegacyBridgeRequestEnvelope::new(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        b"body",
        "request-expired",
        "nonce-expired",
        900,
        1_000,
    )
    .expect("expired envelope fixture");
    let error = expired
        .validate(
            &authority,
            &actor(),
            "org-1",
            "issue.read",
            b"body",
            "request-expired",
            1_000,
            &mut replay,
        )
        .expect_err("expired envelope must fail closed");
    assert!(matches!(error, AuthorityError::Expired));
    assert!(replay.is_empty());
}

#[test]
fn bridge_wire_without_issued_at_is_parse_compatible_but_rejected() {
    let (_, authority) = legacy_registry();
    let envelope = LegacyBridgeRequestEnvelope::new(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        b"body",
        "request-legacy-wire",
        "nonce-legacy-wire",
        900,
        1_200,
    )
    .expect("bridge envelope");
    let mut encoded = serde_json::to_value(&envelope).expect("serialize envelope");
    encoded
        .as_object_mut()
        .expect("object envelope")
        .remove("issuedAt");
    let decoded: LegacyBridgeRequestEnvelope =
        serde_json::from_value(encoded).expect("legacy wire remains parse-compatible");
    let mut replay = NonceReplayGuard::new();
    let error = decoded
        .validate(
            &authority,
            &actor(),
            "org-1",
            "issue.read",
            b"body",
            "request-legacy-wire",
            1_000,
            &mut replay,
        )
        .expect_err("missing issuedAt must not be accepted");
    assert!(matches!(
        error,
        AuthorityError::InvalidField { field: "issuedAt" }
    ));
    assert!(replay.is_empty());
}

#[test]
fn route_decision_rejects_unknown_owner_instead_of_falling_back() {
    let authority = legacy_authority();
    let unknown_owner = OwnerId::new("mystery-runtime").expect("unknown owner identity");
    let route =
        RouteClaim::new("/api/issues", "issues", unknown_owner.clone()).expect("route claim");
    let registry = MigrationAuthority::from_parts(vec![authority], vec![route]);

    assert!(matches!(
        registry.route_decision("/api/issues"),
        RouteDecision::Reject {
            reason: RouteRejection::UnknownOwner { owner }
        } if owner == unknown_owner
    ));
}

#[test]
fn route_decision_rejects_dual_component_ownership() {
    let legacy = legacy_authority();
    let rust =
        ComponentAuthority::new("issues", "rust-0.1.0", OwnerId::rust()).expect("rust authority");
    let route =
        RouteClaim::new("/api/issues", "issues", legacy.owner.clone()).expect("route claim");
    let registry = MigrationAuthority::from_parts(vec![legacy, rust], vec![route]);

    assert!(matches!(
        registry.route_decision("/api/issues"),
        RouteDecision::Reject {
            reason: RouteRejection::DualOwnership { .. }
        }
    ));
}

#[test]
fn bridge_validation_rejects_stale_epoch_before_legacy_owner_fallback() {
    let (mut registry, old_authority) = legacy_registry();
    let envelope = LegacyBridgeRequestEnvelope::new(
        &old_authority,
        actor(),
        "org-1",
        "issue.read",
        b"body",
        "request-1",
        "nonce-1",
        900,
        1_200,
    )
    .expect("bridge envelope");
    let current = registry
        .handoff(HandoffRequest::new(
            "issues",
            old_authority.owner.clone(),
            old_authority.epoch,
            old_authority.fencing_token.clone(),
            OwnerId::rust(),
            "rust-0.1.0",
        ))
        .expect("handoff");

    let mut replay = NonceReplayGuard::new();
    let error = envelope
        .validate(
            &current,
            &actor(),
            "org-1",
            "issue.read",
            b"body",
            "request-1",
            1_000,
            &mut replay,
        )
        .expect_err("stale epoch must fail closed");
    assert!(matches!(error, AuthorityError::StaleEpoch { .. }));
}

#[test]
fn bridge_validation_rejects_a_mismatched_body_hash_without_consuming_nonce() {
    let (_, authority) = legacy_registry();
    let envelope = LegacyBridgeRequestEnvelope::new(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        b"body",
        "request-1",
        "nonce-1",
        900,
        1_200,
    )
    .expect("bridge envelope");
    let mut replay = NonceReplayGuard::new();
    let error = envelope
        .validate(
            &authority,
            &actor(),
            "org-1",
            "issue.read",
            b"changed-body",
            "request-1",
            1_000,
            &mut replay,
        )
        .expect_err("body substitution must fail closed");
    assert!(matches!(error, AuthorityError::BodyHashMismatch));
    assert_eq!(replay.len(), 0);

    envelope
        .validate(
            &authority,
            &actor(),
            "org-1",
            "issue.read",
            b"body",
            "request-1",
            1_000,
            &mut replay,
        )
        .expect("correct body should still be accepted");
}

#[test]
fn bridge_validation_rejects_fencing_token_mismatch() {
    let (_, authority) = legacy_registry();
    let mut envelope = LegacyBridgeRequestEnvelope::new(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        b"body",
        "request-1",
        "nonce-1",
        900,
        1_200,
    )
    .expect("bridge envelope");
    envelope.fencing_token = "not-the-current-fence".into();

    let mut replay = NonceReplayGuard::new();
    let error = envelope
        .validate(
            &authority,
            &actor(),
            "org-1",
            "issue.read",
            b"body",
            "request-1",
            1_000,
            &mut replay,
        )
        .expect_err("fence substitution must fail closed");
    assert!(matches!(error, AuthorityError::FencingTokenMismatch));
}

#[test]
fn bridge_validation_rejects_replay_and_expiry() {
    let (_, authority) = legacy_registry();
    let envelope = LegacyBridgeRequestEnvelope::new(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        b"body",
        "request-1",
        "nonce-1",
        900,
        1_200,
    )
    .expect("bridge envelope");
    let mut replay = NonceReplayGuard::new();
    envelope
        .validate(
            &authority,
            &actor(),
            "org-1",
            "issue.read",
            b"body",
            "request-1",
            1_000,
            &mut replay,
        )
        .expect("first request");
    let error = envelope
        .validate(
            &authority,
            &actor(),
            "org-1",
            "issue.read",
            b"body",
            "request-1",
            1_000,
            &mut replay,
        )
        .expect_err("same nonce must not replay");
    assert!(matches!(error, AuthorityError::Replay));

    let expired = LegacyBridgeRequestEnvelope::new(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        b"body",
        "request-2",
        "nonce-2",
        900,
        1_000,
    )
    .expect("expired envelope fixture");
    let error = expired
        .validate(
            &authority,
            &actor(),
            "org-1",
            "issue.read",
            b"body",
            "request-2",
            1_000,
            &mut replay,
        )
        .expect_err("expired request must fail closed");
    assert!(matches!(error, AuthorityError::Expired));
}

#[test]
fn valid_handoff_advances_epoch_changes_fence_and_transfers_routes() {
    let (mut registry, old_authority) = legacy_registry();
    let new_authority = registry
        .handoff(HandoffRequest::new(
            "issues",
            old_authority.owner.clone(),
            old_authority.epoch,
            old_authority.fencing_token.clone(),
            OwnerId::rust(),
            "rust-0.1.0",
        ))
        .expect("valid handoff");

    assert_eq!(new_authority.epoch, old_authority.epoch + 1);
    assert_ne!(new_authority.fencing_token, old_authority.fencing_token);
    assert_eq!(new_authority.owner, OwnerId::rust());
    assert!(matches!(
        registry.route_decision("/api/issues"),
        RouteDecision::Rust { authority } if authority == new_authority
    ));
    registry.validate().expect("handoff remains one-writer");
}

#[test]
fn stale_handoff_cannot_replace_current_authority() {
    let (mut registry, authority) = legacy_registry();
    let first = registry
        .handoff(HandoffRequest::new(
            "issues",
            authority.owner.clone(),
            authority.epoch,
            authority.fencing_token.clone(),
            OwnerId::rust(),
            "rust-0.1.0",
        ))
        .expect("first handoff");
    let error = registry
        .handoff(HandoffRequest::new(
            "issues",
            authority.owner,
            authority.epoch,
            authority.fencing_token,
            OwnerId::legacy(),
            "node-0.7.21",
        ))
        .expect_err("stale writer must not regain ownership");

    assert!(matches!(error, AuthorityError::StaleEpoch { .. }));
    assert_eq!(registry.current_authority("issues"), Some(&first));
}

#[test]
fn bridge_replay_guard_evicts_expired_entries_and_rejects_active_overflow() {
    let (_, authority) = legacy_registry();
    let first = LegacyBridgeRequestEnvelope::new(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        b"body",
        "request-replay-1",
        "nonce-replay-1",
        900,
        1_010,
    )
    .expect("first bridge envelope");
    let second = LegacyBridgeRequestEnvelope::new(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        b"body",
        "request-replay-2",
        "nonce-replay-2",
        900,
        1_020,
    )
    .expect("second bridge envelope");
    let mut replay = NonceReplayGuard::with_capacity(1).expect("capacity");

    first
        .validate(
            &authority,
            &actor(),
            "org-1",
            "issue.read",
            b"body",
            "request-replay-1",
            1_000,
            &mut replay,
        )
        .expect("first request");
    let error = second
        .validate(
            &authority,
            &actor(),
            "org-1",
            "issue.read",
            b"body",
            "request-replay-2",
            1_000,
            &mut replay,
        )
        .expect_err("active replay entries must remain bounded");
    assert!(matches!(error, AuthorityError::ReplayCapacityExceeded));
    assert_eq!(replay.len(), 1);

    second
        .validate(
            &authority,
            &actor(),
            "org-1",
            "issue.read",
            b"body",
            "request-replay-2",
            1_010,
            &mut replay,
        )
        .expect("expired entries are evicted before a new claim");
    assert_eq!(replay.len(), 1);
}

#[test]
fn bridge_replay_guard_rejects_zero_and_oversized_capacity() {
    assert!(matches!(
        NonceReplayGuard::with_capacity(0),
        Err(AuthorityError::InvalidReplayCapacity {
            max: MAX_REPLAY_CAPACITY
        })
    ));
    assert!(matches!(
        NonceReplayGuard::with_capacity(MAX_REPLAY_CAPACITY + 1),
        Err(AuthorityError::InvalidReplayCapacity {
            max: MAX_REPLAY_CAPACITY
        })
    ));
}
