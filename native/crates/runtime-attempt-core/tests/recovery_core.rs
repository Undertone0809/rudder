use rudder_runtime_attempt_core::{
    ATTEMPT_PROTOCOL_VERSION, AttemptMachine, BackoffDelay, CancellationReason, CancellationState,
    Failure, FailureClassification, HeartbeatIdentity, IdempotencyDecision, IdempotencyKey,
    IdempotencyLedger, LeaseFence, MAX_ATTEMPTS, MAX_NETWORK_WAITS, NETWORK_BACKOFF_SECONDS, Phase,
    RecoveryDecision, RecoveryResult, TransportFailure,
};

fn lease() -> LeaseFence {
    LeaseFence::new("worker-1", 1, 0, 100_000).unwrap()
}

#[test]
fn starts_the_first_attempt_and_replays_duplicate_start() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();

    assert_eq!(machine.phase(), Phase::Pristine);
    let attempt = machine.start(&fence, 10).unwrap();
    assert_eq!(attempt.attempt, 1);
    assert_eq!(machine.phase(), Phase::Executing);
    assert_eq!(machine.start(&fence, 10).unwrap(), attempt);
}

#[test]
fn checkpoint_round_trip_preserves_identity_phase_and_session_metadata() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 10).unwrap();

    let checkpoint = machine.checkpoint();
    assert_eq!(checkpoint.protocol_version, ATTEMPT_PROTOCOL_VERSION);
    assert_eq!(checkpoint.attempt.attempt, 1);
    assert_eq!(checkpoint.phase, Phase::Executing);
    assert_eq!(checkpoint.session.session_id, "session-1");
    assert!(checkpoint.session.pristine);

    let restored = AttemptMachine::from_checkpoint(checkpoint.clone()).unwrap();
    assert_eq!(restored.checkpoint(), checkpoint);
    let encoded = serde_json::to_string(&checkpoint).unwrap();
    let decoded: rudder_runtime_attempt_core::Checkpoint = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded, checkpoint);
}

#[test]
fn v1_recovery_checkpoint_migration_is_safe_for_same_session_only() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut resume_machine = AttemptMachine::new(
        identity.clone(),
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    resume_machine.start(&fence, 0).unwrap();
    resume_machine.checkpoint_progress(&fence, 0).unwrap();
    resume_machine.mark_waiting_for_network(&fence, 0).unwrap();
    resume_machine
        .record_failure(
            Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
            &fence,
            0,
            None,
        )
        .unwrap();

    let mut legacy_resume = serde_json::to_value(resume_machine.checkpoint()).unwrap();
    let recovery = legacy_resume["recovery"].as_object_mut().unwrap();
    assert!(recovery.remove("sourceSessionId").is_some());
    assert!(recovery.remove("replacementSessionId").is_some());
    let migrated: rudder_runtime_attempt_core::Checkpoint =
        serde_json::from_value(legacy_resume).unwrap();
    assert_eq!(
        migrated.recovery.as_ref().unwrap().source_session_id,
        "session-1"
    );
    assert_eq!(
        migrated.recovery.as_ref().unwrap().replacement_session_id,
        None
    );
    let encoded = serde_json::to_string(&migrated).unwrap();
    assert_eq!(
        serde_json::from_str::<rudder_runtime_attempt_core::Checkpoint>(&encoded).unwrap(),
        migrated
    );
    let next_attempt_at_millis = migrated.recovery.as_ref().unwrap().next_attempt_at_millis;
    let mut restored = AttemptMachine::from_checkpoint(migrated).unwrap();
    assert_eq!(
        restored
            .resume_same_session(&fence, next_attempt_at_millis)
            .unwrap()
            .attempt,
        2
    );

    let mut fresh_machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-2",
        "fingerprint-2",
    )
    .unwrap();
    fresh_machine.start(&fence, 0).unwrap();
    fresh_machine.mark_waiting_for_network(&fence, 0).unwrap();
    fresh_machine
        .record_failure(
            Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
            &fence,
            0,
            None,
        )
        .unwrap();
    let mut legacy_fresh = serde_json::to_value(fresh_machine.checkpoint()).unwrap();
    let recovery = legacy_fresh["recovery"].as_object_mut().unwrap();
    assert!(recovery.remove("sourceSessionId").is_some());
    assert!(recovery.remove("replacementSessionId").is_some());
    assert!(
        serde_json::from_value::<rudder_runtime_attempt_core::Checkpoint>(legacy_fresh).is_err()
    );
}

#[test]
fn backoff_is_frozen_and_deterministic_jitter_stays_bounded() {
    assert_eq!(NETWORK_BACKOFF_SECONDS, [2, 5, 10, 20, 30, 60]);
    for (retry_number, expected_seconds) in NETWORK_BACKOFF_SECONDS.into_iter().enumerate() {
        let retry_number = retry_number as u8 + 1;
        assert_eq!(
            BackoffDelay::for_retry(retry_number, None)
                .unwrap()
                .delay_millis,
            expected_seconds * 1_000
        );
    }

    let first = BackoffDelay::for_retry(1, Some(42)).unwrap();
    let replay = BackoffDelay::for_retry(1, Some(42)).unwrap();
    assert_eq!(first, replay);
    assert!(first.jitter_millis <= 500);
    assert!(first.delay_millis <= 2_500);
    assert!(BackoffDelay::for_retry(0, None).is_err());
    assert!(BackoffDelay::for_retry(7, None).is_err());
}

#[test]
fn pristine_transport_failure_chooses_fresh_session_and_persists_retry_plan() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 10).unwrap();
    machine.mark_waiting_for_network(&fence, 100).unwrap();

    let failure = Failure::transport(TransportFailure::Timeout, "provider timed out").unwrap();
    let result = machine
        .record_failure(failure.clone(), &fence, 100, Some(9))
        .unwrap();
    let plan = match result {
        RecoveryResult::RetryScheduled(plan) => plan,
        RecoveryResult::Terminal(outcome) => panic!("unexpected terminal outcome: {outcome:?}"),
    };
    assert_eq!(plan.failed_attempt.attempt, 1);
    assert_eq!(plan.source_session_id, "session-1");
    assert_eq!(plan.replacement_session_id, None);
    assert_eq!(plan.classification, FailureClassification::Transport);
    assert_eq!(plan.decision, RecoveryDecision::FreshIfPristine);
    assert_eq!(plan.backoff.base_seconds, 2);
    assert!(plan.backoff.jitter_millis <= 500);
    assert_eq!(machine.phase(), Phase::WaitingForRetry);
    assert_eq!(
        machine
            .record_failure(failure, &fence, 100, Some(9))
            .unwrap(),
        RecoveryResult::RetryScheduled(plan.clone())
    );

    let checkpoint = machine.checkpoint();
    assert_eq!(checkpoint.recovery.as_ref(), Some(&plan));
    let mut restored = AttemptMachine::from_checkpoint(checkpoint).unwrap();
    let next = restored
        .fresh_if_pristine(&fence, plan.next_attempt_at_millis, "session-2")
        .unwrap();
    assert_eq!(next.attempt, 2);
    assert_eq!(restored.session_id(), "session-2");
    assert_eq!(restored.phase(), Phase::Executing);
    let evidence = rudder_runtime_attempt_core::RecoveryEvidence::new(
        rudder_runtime_attempt_core::SubmissionPhase::Accepted,
        rudder_runtime_attempt_core::SideEffectRisk::Possible,
        true,
        false,
        false,
    )
    .unwrap();
    let checkpoint = restored
        .record_evidence(evidence, &fence, plan.next_attempt_at_millis)
        .unwrap();
    assert!(AttemptMachine::from_checkpoint(checkpoint).is_ok());
}

#[test]
fn checkpointed_progress_resumes_same_session_and_enforces_due_time_and_choice() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 10).unwrap();
    machine.checkpoint_progress(&fence, 20).unwrap();
    machine.mark_waiting_for_network(&fence, 30).unwrap();

    let failure = Failure::transport(TransportFailure::Timeout, "upstream unavailable").unwrap();
    let plan = match machine.record_failure(failure, &fence, 30, None).unwrap() {
        RecoveryResult::RetryScheduled(plan) => plan,
        RecoveryResult::Terminal(outcome) => panic!("unexpected terminal outcome: {outcome:?}"),
    };
    assert_eq!(plan.classification, FailureClassification::Transport);
    assert_eq!(plan.decision, RecoveryDecision::ResumeSameSession);
    assert_eq!(
        machine
            .resume_same_session(&fence, plan.next_attempt_at_millis - 1)
            .unwrap_err()
            .code(),
        "retry_not_due"
    );
    assert_eq!(
        machine
            .fresh_if_pristine(&fence, plan.next_attempt_at_millis, "session-2")
            .unwrap_err()
            .code(),
        "recovery_choice_mismatch"
    );

    let next = machine
        .resume_same_session(&fence, plan.next_attempt_at_millis)
        .unwrap();
    assert_eq!(next.attempt, 2);
    assert_eq!(machine.session_id(), "session-1");
    assert_eq!(
        machine
            .resume_same_session(&fence, plan.next_attempt_at_millis)
            .unwrap(),
        next
    );
}

#[test]
fn retryable_network_failures_stop_after_six_waits() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();

    let mut final_failure = None;
    for attempt in 1..=MAX_ATTEMPTS {
        machine.start(&fence, 0).unwrap();
        let failure =
            Failure::transport(TransportFailure::ConnectionReset, "connection reset").unwrap();
        let result = machine
            .record_failure(failure.clone(), &fence, 0, None)
            .unwrap();
        match result {
            RecoveryResult::RetryScheduled(plan) => {
                assert_eq!(attempt, plan.failed_attempt.attempt);
                assert!(attempt < MAX_ATTEMPTS);
                machine
                    .fresh_if_pristine(
                        &fence,
                        plan.next_attempt_at_millis,
                        format!("retry-session-{attempt}"),
                    )
                    .unwrap();
            }
            RecoveryResult::Terminal(outcome) => {
                assert_eq!(attempt, MAX_ATTEMPTS);
                assert_eq!(outcome.code(), "network_retry_exhausted");
                final_failure = Some(failure);
            }
        }
    }
    assert_eq!(machine.phase(), Phase::Terminal);
    let replay = machine
        .record_failure(final_failure.unwrap(), &fence, 0, None)
        .unwrap();
    assert!(
        matches!(replay, RecoveryResult::Terminal(outcome) if outcome.code() == "network_retry_exhausted")
    );
}

#[test]
fn credential_quota_and_ambiguous_failures_fail_closed_without_retry() {
    for (failure, expected_code) in [
        (
            Failure::credential("invalid_credential", "token rejected").unwrap(),
            "failed",
        ),
        (
            Failure::quota("quota_exhausted", "quota exhausted").unwrap(),
            "failed",
        ),
        (
            Failure::ambiguous("response_unknown", "request outcome is unknown").unwrap(),
            "network_resume_unsafe",
        ),
    ] {
        let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
        let fence = lease();
        let mut machine = AttemptMachine::new(
            identity,
            "session-1",
            fence.clone(),
            "heartbeat-1",
            "fingerprint-1",
        )
        .unwrap();
        machine.start(&fence, 10).unwrap();
        let result = machine
            .record_failure(failure, &fence, 10, Some(3))
            .unwrap();
        match result {
            RecoveryResult::Terminal(outcome) => assert_eq!(outcome.code(), expected_code),
            RecoveryResult::RetryScheduled(plan) => panic!("unexpected retry: {plan:?}"),
        }
        assert_eq!(machine.phase(), Phase::Terminal);
    }
}

#[test]
fn cancellation_and_lease_fences_block_late_recovery() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let stale = LeaseFence::new("worker-1", 2, 0, 100_000).unwrap();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 10).unwrap();

    assert_eq!(
        machine
            .mark_waiting_for_network(&stale, 10)
            .unwrap_err()
            .code(),
        "stale_lease_fence"
    );
    let expired_fence = LeaseFence::new("worker-1", 1, 0, 100).unwrap();
    let mut expired_machine = AttemptMachine::new(
        HeartbeatIdentity::new("org-1", "run-2", "agent-1").unwrap(),
        "session-1",
        expired_fence.clone(),
        "heartbeat-2",
        "fingerprint-2",
    )
    .unwrap();
    expired_machine.start(&expired_fence, 10).unwrap();
    assert_eq!(
        expired_machine
            .mark_waiting_for_network(&expired_fence, 100)
            .unwrap_err()
            .code(),
        "lease_expired"
    );
    assert_eq!(machine.phase(), Phase::Executing);

    let cancelled = machine
        .cancel(&fence, CancellationReason::Operator, 20)
        .unwrap();
    assert_eq!(cancelled.code(), "cancelled");
    assert_eq!(
        machine.cancellation(),
        CancellationState::Requested(CancellationReason::Operator)
    );
    assert_eq!(machine.phase(), Phase::Terminal);
    let failure = Failure::transport(TransportFailure::Timeout, "late timeout").unwrap();
    assert_eq!(
        machine
            .record_failure(failure, &fence, 20, None)
            .unwrap_err()
            .code(),
        "cancellation_requested"
    );
    assert_eq!(
        machine
            .cancel(&fence, CancellationReason::Operator, 20)
            .unwrap(),
        cancelled
    );
}

#[test]
fn fail_closed_is_an_explicit_terminal_recovery_choice() {
    assert_eq!(RecoveryDecision::FailClosed.code(), "fail_closed");
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 10).unwrap();
    machine.mark_waiting_for_network(&fence, 10).unwrap();
    let failure = Failure::transport(TransportFailure::Timeout, "timeout").unwrap();
    let plan = match machine
        .record_failure(failure.clone(), &fence, 10, None)
        .unwrap()
    {
        RecoveryResult::RetryScheduled(plan) => plan,
        RecoveryResult::Terminal(outcome) => panic!("unexpected terminal outcome: {outcome:?}"),
    };

    let outcome = machine.fail_closed(&fence, 10).unwrap();
    assert_eq!(outcome.code(), "network_resume_unsafe");
    assert_eq!(machine.phase(), Phase::Terminal);
    assert_eq!(
        machine
            .fail_closed(&fence, plan.next_attempt_at_millis)
            .unwrap(),
        outcome
    );
}

#[test]
fn idempotency_ledger_replays_same_fingerprint_and_rejects_conflicts() {
    let mut ledger = IdempotencyLedger::default();
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let key = IdempotencyKey::new("heartbeat-key").unwrap();
    assert_eq!(
        ledger
            .reserve_for_identity(identity.clone(), key.clone(), "fingerprint-a")
            .unwrap(),
        IdempotencyDecision::New
    );
    assert_eq!(
        ledger
            .reserve_for_identity(identity.clone(), key.clone(), "fingerprint-a")
            .unwrap(),
        IdempotencyDecision::Replay {
            run_id: "run-1".to_owned()
        }
    );
    assert_eq!(
        ledger
            .reserve_for_identity(identity.clone(), key.clone(), "fingerprint-b")
            .unwrap_err()
            .code(),
        "idempotency_conflict"
    );

    let outcome = rudder_runtime_attempt_core::TerminalOutcome::NetworkResumeUnsafe {
        attempt: identity.attempt(1).unwrap(),
        failure: Failure::ambiguous("response_unknown", "response not observed").unwrap(),
    };
    ledger
        .record_outcome_for_identity(&identity, &key, "fingerprint-a", outcome.clone())
        .unwrap();
    assert_eq!(
        ledger.outcome_for_identity(&identity, &key, "fingerprint-a"),
        Some(&outcome)
    );
    ledger
        .record_outcome_for_identity(&identity, &key, "fingerprint-a", outcome)
        .expect("recording the same terminal receipt is idempotent");
}

#[test]
fn success_is_terminal_and_duplicate_completion_replays_the_same_receipt() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 10).unwrap();

    let outcome = machine.succeed(&fence, 20).unwrap();
    assert_eq!(outcome.code(), "succeeded");
    assert_eq!(machine.phase(), Phase::Succeeded);
    assert_eq!(machine.succeed(&fence, 20).unwrap(), outcome);
    assert_eq!(
        machine
            .cancel(&fence, CancellationReason::Operator, 20)
            .unwrap_err()
            .code(),
        "already_terminal"
    );
}

#[test]
fn checkpoint_loading_rejects_nested_identity_and_attempt_tampering() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity.clone(),
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 10).unwrap();
    machine.mark_waiting_for_network(&fence, 10).unwrap();
    let failure = Failure::transport(TransportFailure::Timeout, "timeout").unwrap();
    machine.record_failure(failure, &fence, 10, None).unwrap();

    let mut nested_identity = machine.checkpoint();
    nested_identity
        .recovery
        .as_mut()
        .unwrap()
        .failed_attempt
        .organization_id = "other-org".to_owned();
    let error = AttemptMachine::from_checkpoint(nested_identity).unwrap_err();
    assert_eq!(
        error.kind(),
        rudder_runtime_attempt_core::ErrorKind::CheckpointInvalid
    );

    let mut out_of_range = machine.checkpoint();
    out_of_range.recovery.as_mut().unwrap().next_attempt.attempt = u8::MAX;
    assert!(AttemptMachine::from_checkpoint(out_of_range).is_err());

    let mut nested_next_identity = machine.checkpoint();
    nested_next_identity
        .recovery
        .as_mut()
        .unwrap()
        .next_attempt
        .agent_id = "other-agent".to_owned();
    assert!(AttemptMachine::from_checkpoint(nested_next_identity).is_err());

    let mut malformed_backoff = machine.checkpoint();
    malformed_backoff
        .recovery
        .as_mut()
        .unwrap()
        .backoff
        .delay_millis += 1;
    assert!(AttemptMachine::from_checkpoint(malformed_backoff).is_err());

    let mut oversized_fingerprint = machine.checkpoint();
    oversized_fingerprint.request_fingerprint =
        "x".repeat(rudder_runtime_attempt_core::MAX_REQUEST_FINGERPRINT_BYTES + 1);
    assert!(AttemptMachine::from_checkpoint(oversized_fingerprint).is_err());

    let mut completed = AttemptMachine::new(
        identity.clone(),
        "session-2",
        fence.clone(),
        "heartbeat-2",
        "fingerprint-2",
    )
    .unwrap();
    completed.start(&fence, 10).unwrap();
    completed.succeed(&fence, 20).unwrap();
    let mut terminal_identity = completed.checkpoint();
    if let Some(rudder_runtime_attempt_core::TerminalOutcome::Succeeded { attempt }) =
        terminal_identity.terminal_outcome.as_mut()
    {
        attempt.organization_id = "other-org".to_owned();
    }
    assert!(AttemptMachine::from_checkpoint(terminal_identity).is_err());
}

#[test]
fn public_deserialization_cannot_bypass_lease_or_machine_invariants() {
    let invalid_lease = serde_json::json!({
        "ownerId": "worker-1",
        "epoch": 0,
        "issuedAtMillis": 0,
        "expiresAtMillis": 100
    });
    assert!(serde_json::from_value::<LeaseFence>(invalid_lease).is_err());
    assert!(
        serde_json::from_value::<Failure>(serde_json::json!({
            "kind": "transport",
            "reason": "tls",
            "code": "transport_timeout",
            "summary": "certificate rejected"
        }))
        .is_err()
    );
    assert!(
        serde_json::from_value::<BackoffDelay>(serde_json::json!({
            "retryNumber": 6,
            "baseSeconds": 60,
            "jitterMillis": 0,
            "delayMillis": 1
        }))
        .is_err()
    );

    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let machine =
        AttemptMachine::new(identity, "session-1", fence, "heartbeat-1", "fingerprint-1").unwrap();
    let mut raw = serde_json::to_value(&machine).unwrap();
    raw["phase"] = serde_json::json!("terminal");
    raw["terminalOutcome"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<AttemptMachine>(raw).is_err());
}

#[test]
fn provider_server_and_tls_failures_are_terminal_not_retryable() {
    for failure in [
        Failure::server_5xx(503, "provider unavailable").unwrap(),
        Failure::transport(TransportFailure::Tls, "certificate rejected").unwrap(),
    ] {
        let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
        let fence = lease();
        let mut machine = AttemptMachine::new(
            identity,
            "session-1",
            fence.clone(),
            "heartbeat-1",
            "fingerprint-1",
        )
        .unwrap();
        machine.start(&fence, 10).unwrap();
        let result = machine.record_failure(failure, &fence, 10, None).unwrap();
        assert!(matches!(result, RecoveryResult::Terminal(outcome) if outcome.code() == "failed"));
    }
}

#[test]
fn submitted_evidence_requires_same_session_recovery_and_is_exposed() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 10).unwrap();
    machine.mark_waiting_for_network(&fence, 10).unwrap();

    let evidence = rudder_runtime_attempt_core::RecoveryEvidence::new(
        rudder_runtime_attempt_core::SubmissionPhase::Accepted,
        rudder_runtime_attempt_core::SideEffectRisk::Possible,
        true,
        false,
        false,
    )
    .unwrap();
    let failure = Failure::transport(TransportFailure::Timeout, "timeout").unwrap();
    let plan = match machine
        .record_failure_with_evidence(failure, evidence, &fence, 10, None)
        .unwrap()
    {
        RecoveryResult::RetryScheduled(plan) => plan,
        RecoveryResult::Terminal(outcome) => panic!("unexpected terminal outcome: {outcome:?}"),
    };
    assert_eq!(plan.decision, RecoveryDecision::ResumeSameSession);
    assert_eq!(
        plan.submission_phase,
        rudder_runtime_attempt_core::SubmissionPhase::Accepted
    );
    assert_eq!(
        plan.side_effect_risk,
        rudder_runtime_attempt_core::SideEffectRisk::Possible
    );
    assert!(plan.model_output_observed);
    assert!(!plan.tool_activity_observed);
    assert_eq!(machine.submission_phase(), plan.submission_phase);
    assert_eq!(machine.side_effect_risk(), plan.side_effect_risk);
    assert!(machine.model_output_observed());
}

#[test]
fn indeterminate_or_terminal_event_evidence_fails_closed() {
    for evidence in [
        rudder_runtime_attempt_core::RecoveryEvidence::new(
            rudder_runtime_attempt_core::SubmissionPhase::Indeterminate,
            rudder_runtime_attempt_core::SideEffectRisk::Possible,
            false,
            false,
            false,
        )
        .unwrap(),
        rudder_runtime_attempt_core::RecoveryEvidence::new(
            rudder_runtime_attempt_core::SubmissionPhase::Accepted,
            rudder_runtime_attempt_core::SideEffectRisk::Possible,
            false,
            false,
            true,
        )
        .unwrap(),
    ] {
        let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
        let fence = lease();
        let mut machine = AttemptMachine::new(
            identity,
            "session-1",
            fence.clone(),
            "heartbeat-1",
            "fingerprint-1",
        )
        .unwrap();
        machine.start(&fence, 10).unwrap();
        machine.mark_waiting_for_network(&fence, 10).unwrap();
        let result = machine
            .record_failure_with_evidence(
                Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
                evidence,
                &fence,
                10,
                None,
            )
            .unwrap();
        assert!(matches!(
            result,
            RecoveryResult::Terminal(outcome) if outcome.code() == "network_resume_unsafe"
        ));
    }
}

#[test]
fn six_network_waits_exhaust_without_starting_a_seventh_attempt() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 0).unwrap();
    machine.checkpoint_progress(&fence, 0).unwrap();

    for (index, expected_seconds) in NETWORK_BACKOFF_SECONDS
        .into_iter()
        .enumerate()
        .take((MAX_ATTEMPTS - 1) as usize)
    {
        let wait_number = index as u8 + 1;
        machine.start(&fence, 0).unwrap();
        machine.mark_waiting_for_network(&fence, 0).unwrap();
        let failure = Failure::transport(TransportFailure::Timeout, "timeout").unwrap();
        let plan = match machine.record_failure(failure, &fence, 0, None).unwrap() {
            RecoveryResult::RetryScheduled(plan) => plan,
            RecoveryResult::Terminal(outcome) => panic!("unexpected exhaustion: {outcome:?}"),
        };
        assert_eq!(plan.network_wait_number, wait_number);
        assert_eq!(plan.backoff.base_seconds, expected_seconds);
        machine
            .resume_same_session(&fence, plan.next_attempt_at_millis)
            .unwrap();
    }

    assert_eq!(machine.attempt_identity().attempt, MAX_ATTEMPTS);
    machine.start(&fence, 0).unwrap();
    machine.mark_waiting_for_network(&fence, 0).unwrap();
    let exhausted = machine
        .record_failure(
            Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
            &fence,
            0,
            None,
        )
        .unwrap();
    assert!(
        matches!(exhausted, RecoveryResult::Terminal(outcome) if outcome.code() == "network_retry_exhausted")
    );
    assert_eq!(machine.network_wait_count(), MAX_NETWORK_WAITS);
    assert_eq!(machine.attempt_identity().attempt, MAX_ATTEMPTS);
    assert!(AttemptMachine::from_checkpoint(machine.checkpoint()).is_ok());
}

#[test]
fn idempotency_rejects_cross_identity_and_fingerprint_outcomes_and_round_trips_json() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let other_identity = HeartbeatIdentity::new("org-1", "run-1", "agent-2").unwrap();
    let key = IdempotencyKey::new("heartbeat-key").unwrap();
    let mut ledger = IdempotencyLedger::default();
    ledger
        .reserve_for_identity(identity.clone(), key.clone(), "fingerprint-a")
        .unwrap();
    let outcome = rudder_runtime_attempt_core::TerminalOutcome::Failed {
        attempt: identity.attempt(1).unwrap(),
        failure: Failure::non_retryable("tool_failure", "tool failed").unwrap(),
    };
    assert_eq!(
        ledger
            .record_outcome_for_identity(&other_identity, &key, "fingerprint-a", outcome.clone(),)
            .unwrap_err()
            .code(),
        "idempotency_conflict"
    );
    assert_eq!(
        ledger
            .record_outcome_for_identity(&identity, &key, "fingerprint-b", outcome.clone())
            .unwrap_err()
            .code(),
        "idempotency_conflict"
    );
    ledger
        .record_outcome_for_identity(&identity, &key, "fingerprint-a", outcome.clone())
        .unwrap();

    let encoded = serde_json::to_string(&ledger).unwrap();
    assert!(encoded.starts_with("{\"records\":["));
    let restored: IdempotencyLedger = serde_json::from_str(&encoded).unwrap();
    assert_eq!(
        restored.outcome_for_identity(&identity, &key, "fingerprint-a"),
        Some(&outcome)
    );
}

#[test]
fn lease_rebind_requires_the_current_fence_and_accepts_a_new_valid_epoch_after_expiry() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let expired = LeaseFence::new("worker-1", 1, 0, 100).unwrap();
    let replacement = LeaseFence::new("worker-2", 2, 100, 300).unwrap();
    let stale = LeaseFence::new("worker-1", 3, 100, 300).unwrap();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        expired.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&expired, 10).unwrap();

    assert_eq!(
        machine
            .rebind_lease(&stale, replacement.clone(), 150)
            .unwrap_err()
            .code(),
        "stale_lease_fence"
    );
    machine
        .rebind_lease(&expired, replacement.clone(), 150)
        .unwrap();
    assert_eq!(machine.start(&replacement, 150).unwrap().attempt, 1);
    assert_eq!(
        machine.start(&expired, 150).unwrap_err().code(),
        "stale_lease_fence"
    );
}

#[test]
fn retry_budget_has_six_failure_boundaries_but_never_starts_attempt_seven() {
    assert_eq!(MAX_NETWORK_WAITS, 6);
    assert_eq!(MAX_ATTEMPTS, MAX_NETWORK_WAITS);

    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity.clone(),
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 0).unwrap();
    machine.checkpoint_progress(&fence, 0).unwrap();

    for expected_attempt in 1..=MAX_NETWORK_WAITS {
        assert_eq!(machine.attempt_identity().attempt, expected_attempt);
        machine.start(&fence, 0).unwrap();
        machine.mark_waiting_for_network(&fence, 0).unwrap();
        let failure =
            Failure::transport(TransportFailure::ConnectionReset, "connection reset").unwrap();
        match machine.record_failure(failure, &fence, 0, None).unwrap() {
            RecoveryResult::RetryScheduled(plan) if expected_attempt < MAX_NETWORK_WAITS => {
                assert_eq!(plan.failed_attempt.attempt, expected_attempt);
                assert!(plan.next_attempt.attempt <= MAX_ATTEMPTS);
                machine
                    .resume_same_session(&fence, plan.next_attempt_at_millis)
                    .unwrap();
            }
            RecoveryResult::Terminal(outcome) => {
                assert_eq!(expected_attempt, MAX_NETWORK_WAITS);
                assert_eq!(outcome.code(), "network_retry_exhausted");
            }
            RecoveryResult::RetryScheduled(plan) => {
                panic!("sixth wait created an additional provider attempt: {plan:?}");
            }
        }
    }

    assert_eq!(machine.attempt_identity().attempt, MAX_NETWORK_WAITS);
    assert_eq!(machine.network_wait_count(), MAX_NETWORK_WAITS);
    assert!(
        rudder_runtime_attempt_core::AttemptIdentity::new(
            identity.organization_id,
            identity.run_id,
            identity.agent_id,
            MAX_NETWORK_WAITS + 1,
        )
        .is_err()
    );
}

#[test]
fn unsafe_evidence_wins_at_the_retry_boundary() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 0).unwrap();
    machine.checkpoint_progress(&fence, 0).unwrap();
    let accepted = rudder_runtime_attempt_core::RecoveryEvidence::new(
        rudder_runtime_attempt_core::SubmissionPhase::Accepted,
        rudder_runtime_attempt_core::SideEffectRisk::Possible,
        true,
        false,
        false,
    )
    .unwrap();

    while machine.attempt_identity().attempt < MAX_ATTEMPTS {
        machine.start(&fence, 0).unwrap();
        machine.mark_waiting_for_network(&fence, 0).unwrap();
        let plan = match machine
            .record_failure_with_evidence(
                Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
                accepted,
                &fence,
                0,
                None,
            )
            .unwrap()
        {
            RecoveryResult::RetryScheduled(plan) => plan,
            RecoveryResult::Terminal(outcome) => {
                panic!("unexpected terminal outcome before the retry boundary: {outcome:?}")
            }
        };
        machine
            .resume_same_session(&fence, plan.next_attempt_at_millis)
            .unwrap();
    }

    machine.start(&fence, 0).unwrap();
    machine.mark_waiting_for_network(&fence, 0).unwrap();
    let indeterminate = rudder_runtime_attempt_core::RecoveryEvidence::new(
        rudder_runtime_attempt_core::SubmissionPhase::Indeterminate,
        rudder_runtime_attempt_core::SideEffectRisk::Possible,
        false,
        false,
        false,
    )
    .unwrap();
    let result = machine
        .record_failure_with_evidence(
            Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
            indeterminate,
            &fence,
            0,
            None,
        )
        .unwrap();
    assert!(matches!(
        result,
        RecoveryResult::Terminal(outcome) if outcome.code() == "network_resume_unsafe"
    ));
}

#[test]
fn active_recovery_plan_evidence_is_bound_and_cannot_be_downgraded() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 0).unwrap();
    machine.checkpoint_progress(&fence, 0).unwrap();
    machine.mark_waiting_for_network(&fence, 0).unwrap();
    let accepted = rudder_runtime_attempt_core::RecoveryEvidence::new(
        rudder_runtime_attempt_core::SubmissionPhase::Accepted,
        rudder_runtime_attempt_core::SideEffectRisk::Possible,
        true,
        false,
        false,
    )
    .unwrap();
    let plan = match machine
        .record_failure_with_evidence(
            Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
            accepted,
            &fence,
            0,
            None,
        )
        .unwrap()
    {
        RecoveryResult::RetryScheduled(plan) => plan,
        RecoveryResult::Terminal(outcome) => panic!("unexpected terminal outcome: {outcome:?}"),
    };
    machine
        .resume_same_session(&fence, plan.next_attempt_at_millis)
        .unwrap();

    let mut downgraded = machine.checkpoint();
    downgraded.submission_phase = rudder_runtime_attempt_core::SubmissionPhase::PreSubmission;
    downgraded.side_effect_risk = rudder_runtime_attempt_core::SideEffectRisk::None;
    downgraded.model_output_observed = false;
    downgraded.tool_activity_observed = false;
    downgraded.terminal_event_observed = false;
    assert!(AttemptMachine::from_checkpoint(downgraded).is_err());

    let mut pristine_resume = machine.checkpoint();
    pristine_resume.session.pristine = true;
    pristine_resume.submission_phase = rudder_runtime_attempt_core::SubmissionPhase::PreSubmission;
    pristine_resume.side_effect_risk = rudder_runtime_attempt_core::SideEffectRisk::None;
    pristine_resume.model_output_observed = false;
    pristine_resume.tool_activity_observed = false;
    pristine_resume.terminal_event_observed = false;
    if let Some(plan) = &mut pristine_resume.recovery {
        plan.submission_phase = rudder_runtime_attempt_core::SubmissionPhase::PreSubmission;
        plan.side_effect_risk = rudder_runtime_attempt_core::SideEffectRisk::None;
        plan.model_output_observed = false;
        plan.tool_activity_observed = false;
        plan.terminal_event_observed = false;
    }
    assert!(AttemptMachine::from_checkpoint(pristine_resume).is_err());
}

#[test]
fn terminal_event_evidence_is_only_valid_for_matching_unsafe_terminal_state() {
    let terminal_event = rudder_runtime_attempt_core::RecoveryEvidence::new(
        rudder_runtime_attempt_core::SubmissionPhase::Accepted,
        rudder_runtime_attempt_core::SideEffectRisk::Possible,
        false,
        false,
        true,
    )
    .unwrap();
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();

    let mut active = AttemptMachine::new(
        identity.clone(),
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    active.start(&fence, 10).unwrap();
    let before = active.checkpoint();
    assert_eq!(
        active
            .record_evidence(terminal_event, &fence, 10)
            .unwrap_err()
            .code(),
        "network_resume_unsafe"
    );
    assert_eq!(active.checkpoint(), before);

    let mut succeeded = AttemptMachine::new(
        identity.clone(),
        "session-2",
        fence.clone(),
        "heartbeat-2",
        "fingerprint-2",
    )
    .unwrap();
    succeeded.start(&fence, 10).unwrap();
    succeeded
        .record_evidence(
            rudder_runtime_attempt_core::RecoveryEvidence::new(
                rudder_runtime_attempt_core::SubmissionPhase::Accepted,
                rudder_runtime_attempt_core::SideEffectRisk::Possible,
                false,
                false,
                false,
            )
            .unwrap(),
            &fence,
            10,
        )
        .unwrap();
    succeeded.succeed(&fence, 10).unwrap();
    let mut invalid_succeeded = succeeded.checkpoint();
    invalid_succeeded.terminal_event_observed = true;
    assert!(AttemptMachine::from_checkpoint(invalid_succeeded).is_err());

    let mut unsafe_machine = AttemptMachine::new(
        identity,
        "session-3",
        fence.clone(),
        "heartbeat-3",
        "fingerprint-3",
    )
    .unwrap();
    unsafe_machine.start(&fence, 10).unwrap();
    unsafe_machine.mark_waiting_for_network(&fence, 10).unwrap();
    let result = unsafe_machine
        .record_failure_with_evidence(
            Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
            terminal_event,
            &fence,
            10,
            None,
        )
        .unwrap();
    assert!(matches!(
        result,
        RecoveryResult::Terminal(ref outcome)
            if outcome.code() == "network_resume_unsafe"
    ));
    assert!(AttemptMachine::from_checkpoint(unsafe_machine.checkpoint()).is_ok());
}

#[test]
fn fresh_replay_requires_the_persisted_replacement_session() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 0).unwrap();
    machine.mark_waiting_for_network(&fence, 0).unwrap();
    let plan = match machine
        .record_failure(
            Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
            &fence,
            0,
            None,
        )
        .unwrap()
    {
        RecoveryResult::RetryScheduled(plan) => plan,
        RecoveryResult::Terminal(outcome) => panic!("unexpected terminal outcome: {outcome:?}"),
    };

    let first = machine
        .fresh_if_pristine(&fence, plan.next_attempt_at_millis, "session-2")
        .unwrap();
    assert_eq!(machine.session_id(), "session-2");
    assert_eq!(
        machine
            .fresh_if_pristine(&fence, plan.next_attempt_at_millis, "session-2")
            .unwrap(),
        first
    );
    let before_rejected_replay = machine.checkpoint();
    assert_eq!(
        machine
            .fresh_if_pristine(&fence, plan.next_attempt_at_millis, "session-3")
            .unwrap_err()
            .code(),
        "recovery_choice_mismatch"
    );
    assert_eq!(machine.checkpoint(), before_rejected_replay);
    assert_eq!(
        machine
            .fresh_if_pristine(&fence, plan.next_attempt_at_millis, " ")
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    assert_eq!(machine.checkpoint(), before_rejected_replay);
}

#[test]
fn terminal_leases_are_immutable() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let replacement = LeaseFence::new("worker-2", 2, 10, 100_000).unwrap();

    let mut succeeded = AttemptMachine::new(
        identity.clone(),
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    succeeded.start(&fence, 10).unwrap();
    succeeded.succeed(&fence, 10).unwrap();
    let before_succeeded = succeeded.checkpoint();
    assert_eq!(
        succeeded
            .renew_lease(&fence, replacement.clone(), 10)
            .unwrap_err()
            .code(),
        "already_terminal"
    );
    assert_eq!(succeeded.checkpoint(), before_succeeded);

    let mut cancelled = AttemptMachine::new(
        identity,
        "session-2",
        fence.clone(),
        "heartbeat-2",
        "fingerprint-2",
    )
    .unwrap();
    cancelled.start(&fence, 10).unwrap();
    cancelled
        .cancel(&fence, CancellationReason::Operator, 10)
        .unwrap();
    let before_cancelled = cancelled.checkpoint();
    assert_eq!(
        cancelled
            .rebind_lease(&fence, replacement, 10)
            .unwrap_err()
            .code(),
        "already_terminal"
    );
    assert_eq!(cancelled.checkpoint(), before_cancelled);
}

#[test]
fn overflow_failures_leave_evidence_sessions_and_retry_state_unchanged() {
    let accepted = rudder_runtime_attempt_core::RecoveryEvidence::new(
        rudder_runtime_attempt_core::SubmissionPhase::Accepted,
        rudder_runtime_attempt_core::SideEffectRisk::Possible,
        true,
        false,
        false,
    )
    .unwrap();

    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut evidence_at_max = AttemptMachine::new(
        identity.clone(),
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    evidence_at_max.start(&fence, 10).unwrap();
    let mut checkpoint = evidence_at_max.checkpoint();
    checkpoint.revision = u64::MAX;
    let mut evidence_at_max = AttemptMachine::from_checkpoint(checkpoint).unwrap();
    let before = evidence_at_max.checkpoint();
    assert!(
        evidence_at_max
            .record_evidence(accepted, &fence, 10)
            .is_err()
    );
    assert_eq!(evidence_at_max.checkpoint(), before);

    let mut fresh_at_max = AttemptMachine::new(
        identity.clone(),
        "session-1",
        fence.clone(),
        "heartbeat-2",
        "fingerprint-2",
    )
    .unwrap();
    fresh_at_max.start(&fence, 0).unwrap();
    fresh_at_max.mark_waiting_for_network(&fence, 0).unwrap();
    let plan = match fresh_at_max
        .record_failure(
            Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
            &fence,
            0,
            None,
        )
        .unwrap()
    {
        RecoveryResult::RetryScheduled(plan) => plan,
        RecoveryResult::Terminal(outcome) => panic!("unexpected terminal outcome: {outcome:?}"),
    };
    let mut checkpoint = fresh_at_max.checkpoint();
    checkpoint.revision = u64::MAX;
    let mut fresh_at_max = AttemptMachine::from_checkpoint(checkpoint).unwrap();
    let before = fresh_at_max.checkpoint();
    assert!(
        fresh_at_max
            .fresh_if_pristine(&fence, plan.next_attempt_at_millis, "session-2")
            .is_err()
    );
    assert_eq!(fresh_at_max.checkpoint(), before);

    let mut retry_at_max_minus_one = AttemptMachine::new(
        identity.clone(),
        "session-1",
        fence.clone(),
        "heartbeat-3",
        "fingerprint-3",
    )
    .unwrap();
    retry_at_max_minus_one.start(&fence, 0).unwrap();
    let mut checkpoint = retry_at_max_minus_one.checkpoint();
    checkpoint.revision = u64::MAX - 1;
    let mut retry_at_max_minus_one = AttemptMachine::from_checkpoint(checkpoint).unwrap();
    let before = retry_at_max_minus_one.checkpoint();
    assert!(
        retry_at_max_minus_one
            .record_failure_with_evidence(
                Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
                accepted,
                &fence,
                0,
                None,
            )
            .is_err()
    );
    assert_eq!(retry_at_max_minus_one.checkpoint(), before);

    let near_max_fence = LeaseFence::new("worker-1", 1, 0, u64::MAX).unwrap();
    let mut timestamp_overflow = AttemptMachine::new(
        identity,
        "session-1",
        near_max_fence.clone(),
        "heartbeat-4",
        "fingerprint-4",
    )
    .unwrap();
    timestamp_overflow
        .start(&near_max_fence, u64::MAX - 1)
        .unwrap();
    let before = timestamp_overflow.checkpoint();
    assert!(
        timestamp_overflow
            .record_failure_with_evidence(
                Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
                accepted,
                &near_max_fence,
                u64::MAX - 1,
                None,
            )
            .is_err()
    );
    assert_eq!(timestamp_overflow.checkpoint(), before);
}

#[test]
fn indeterminate_evidence_is_monotonic_against_later_accepted_observations() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 10).unwrap();

    let indeterminate = rudder_runtime_attempt_core::RecoveryEvidence::new(
        rudder_runtime_attempt_core::SubmissionPhase::Indeterminate,
        rudder_runtime_attempt_core::SideEffectRisk::Possible,
        false,
        false,
        false,
    )
    .unwrap();
    machine.record_evidence(indeterminate, &fence, 10).unwrap();

    let accepted = rudder_runtime_attempt_core::RecoveryEvidence::new(
        rudder_runtime_attempt_core::SubmissionPhase::Accepted,
        rudder_runtime_attempt_core::SideEffectRisk::Possible,
        false,
        false,
        false,
    )
    .unwrap();
    machine.record_evidence(accepted, &fence, 10).unwrap();

    assert_eq!(
        machine.submission_phase(),
        rudder_runtime_attempt_core::SubmissionPhase::Indeterminate
    );
    assert_eq!(
        machine.side_effect_risk(),
        rudder_runtime_attempt_core::SideEffectRisk::Possible
    );
    assert!(!machine.model_output_observed());
}

#[test]
fn terminal_checkpoint_ordinals_are_specific_to_each_outcome() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut waiting = AttemptMachine::new(
        identity.clone(),
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    waiting.start(&fence, 0).unwrap();
    waiting.mark_waiting_for_network(&fence, 0).unwrap();
    let retry_failure = Failure::transport(TransportFailure::Timeout, "timeout").unwrap();
    waiting
        .record_failure(retry_failure, &fence, 0, None)
        .unwrap();

    let failed = Failure::non_retryable("provider_rejected", "provider rejected").unwrap();
    let mut forged_failed = waiting.checkpoint();
    forged_failed.phase = Phase::Terminal;
    forged_failed.last_failure = Some(failed.clone());
    forged_failed.recovery = None;
    forged_failed.terminal_outcome = Some(rudder_runtime_attempt_core::TerminalOutcome::Failed {
        attempt: identity.attempt(1).unwrap(),
        failure: failed,
    });
    let encoded = serde_json::to_value(&forged_failed).unwrap();
    assert!(serde_json::from_value::<rudder_runtime_attempt_core::Checkpoint>(encoded).is_err());
    assert!(AttemptMachine::from_checkpoint(forged_failed).is_err());

    let mut exhausted = AttemptMachine::new(
        identity.clone(),
        "session-2",
        fence.clone(),
        "heartbeat-2",
        "fingerprint-2",
    )
    .unwrap();
    exhausted.start(&fence, 0).unwrap();
    exhausted.checkpoint_progress(&fence, 0).unwrap();
    for _ in 0..MAX_ATTEMPTS {
        exhausted.mark_waiting_for_network(&fence, 0).unwrap();
        let result = exhausted
            .record_failure(
                Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
                &fence,
                0,
                None,
            )
            .unwrap();
        if let RecoveryResult::RetryScheduled(plan) = result {
            exhausted
                .resume_same_session(&fence, plan.next_attempt_at_millis)
                .unwrap();
        } else {
            break;
        }
    }
    let mut forged_exhaustion = exhausted.checkpoint();
    assert!(matches!(
        forged_exhaustion.terminal_outcome,
        Some(rudder_runtime_attempt_core::TerminalOutcome::NetworkRetryExhausted { .. })
    ));
    forged_exhaustion.network_wait_count = MAX_NETWORK_WAITS - 1;
    let encoded = serde_json::to_value(&forged_exhaustion).unwrap();
    assert!(serde_json::from_value::<rudder_runtime_attempt_core::Checkpoint>(encoded).is_err());
    assert!(AttemptMachine::from_checkpoint(forged_exhaustion).is_err());

    let mut cancelled = waiting;
    cancelled
        .cancel(&fence, CancellationReason::Operator, 0)
        .unwrap();
    assert!(AttemptMachine::from_checkpoint(cancelled.checkpoint()).is_ok());

    let mut fail_closed = AttemptMachine::new(
        identity,
        "session-3",
        fence.clone(),
        "heartbeat-3",
        "fingerprint-3",
    )
    .unwrap();
    fail_closed.start(&fence, 0).unwrap();
    fail_closed.mark_waiting_for_network(&fence, 0).unwrap();
    fail_closed
        .record_failure(
            Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
            &fence,
            0,
            None,
        )
        .unwrap();
    fail_closed.fail_closed(&fence, 0).unwrap();
    assert!(AttemptMachine::from_checkpoint(fail_closed.checkpoint()).is_ok());

    let mut unsupported_unsafe = fail_closed.checkpoint();
    let ambiguous = Failure::ambiguous("ambiguous", "ambiguous outcome").unwrap();
    unsupported_unsafe.last_failure = Some(ambiguous.clone());
    unsupported_unsafe.terminal_outcome = Some(
        rudder_runtime_attempt_core::TerminalOutcome::NetworkResumeUnsafe {
            attempt: unsupported_unsafe.attempt.clone(),
            failure: ambiguous,
        },
    );
    let encoded = serde_json::to_value(&unsupported_unsafe).unwrap();
    assert!(serde_json::from_value::<rudder_runtime_attempt_core::Checkpoint>(encoded).is_err());
    assert!(AttemptMachine::from_checkpoint(unsupported_unsafe).is_err());
}

#[test]
fn deserialized_resume_plan_rejects_indeterminate_evidence() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 0).unwrap();
    machine.checkpoint_progress(&fence, 0).unwrap();
    machine.mark_waiting_for_network(&fence, 0).unwrap();
    machine
        .record_failure(
            Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
            &fence,
            0,
            None,
        )
        .unwrap();

    let mut forged = machine.checkpoint();
    forged.submission_phase = rudder_runtime_attempt_core::SubmissionPhase::Indeterminate;
    forged.side_effect_risk = rudder_runtime_attempt_core::SideEffectRisk::Possible;
    forged.recovery.as_mut().unwrap().submission_phase =
        rudder_runtime_attempt_core::SubmissionPhase::Indeterminate;
    forged.recovery.as_mut().unwrap().side_effect_risk =
        rudder_runtime_attempt_core::SideEffectRisk::Possible;
    let raw_plan = serde_json::to_value(forged.recovery.as_ref().unwrap()).unwrap();
    assert!(serde_json::from_value::<rudder_runtime_attempt_core::RecoveryPlan>(raw_plan).is_err());
    let raw_checkpoint = serde_json::to_value(forged).unwrap();
    assert!(
        serde_json::from_value::<rudder_runtime_attempt_core::Checkpoint>(raw_checkpoint).is_err()
    );
}

#[test]
fn fresh_recovery_persists_source_and_replacement_binding() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity.clone(),
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 0).unwrap();
    machine.mark_waiting_for_network(&fence, 0).unwrap();
    let plan = match machine
        .record_failure(
            Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
            &fence,
            0,
            None,
        )
        .unwrap()
    {
        RecoveryResult::RetryScheduled(plan) => plan,
        RecoveryResult::Terminal(outcome) => panic!("unexpected terminal outcome: {outcome:?}"),
    };

    let mut forged_active = machine.checkpoint();
    forged_active.phase = Phase::Executing;
    forged_active.attempt = plan.next_attempt.clone();
    forged_active.recovery = Some(plan.clone());
    assert!(AttemptMachine::from_checkpoint(forged_active).is_err());

    machine
        .fresh_if_pristine(&fence, plan.next_attempt_at_millis, "session-2")
        .unwrap();
    let checkpoint = machine.checkpoint();
    let encoded = serde_json::to_string(&checkpoint).unwrap();
    let decoded: rudder_runtime_attempt_core::Checkpoint = serde_json::from_str(&encoded).unwrap();
    let mut restored = AttemptMachine::from_checkpoint(decoded).unwrap();
    assert_eq!(
        restored
            .fresh_if_pristine(&fence, plan.next_attempt_at_millis, "session-2")
            .unwrap()
            .attempt,
        2
    );
    assert_eq!(
        restored
            .fresh_if_pristine(&fence, plan.next_attempt_at_millis, "session-3")
            .unwrap_err()
            .code(),
        "recovery_choice_mismatch"
    );
}

#[test]
fn deserialized_recovery_plan_rejects_timestamp_before_its_backoff() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 100).unwrap();
    machine.mark_waiting_for_network(&fence, 100).unwrap();
    machine
        .record_failure(
            Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
            &fence,
            100,
            None,
        )
        .unwrap();

    let mut forged = machine.checkpoint();
    let plan = forged.recovery.as_mut().unwrap();
    plan.next_attempt_at_millis = plan.backoff.delay_millis - 1;
    let raw_plan = serde_json::to_value(plan).unwrap();
    assert!(serde_json::from_value::<rudder_runtime_attempt_core::RecoveryPlan>(raw_plan).is_err());
    assert!(AttemptMachine::from_checkpoint(forged).is_err());
}

#[test]
fn conflicting_unsafe_evidence_preserves_the_terminal_event_bit() {
    let identity = HeartbeatIdentity::new("org-1", "run-1", "agent-1").unwrap();
    let fence = lease();
    let mut machine = AttemptMachine::new(
        identity,
        "session-1",
        fence.clone(),
        "heartbeat-1",
        "fingerprint-1",
    )
    .unwrap();
    machine.start(&fence, 0).unwrap();
    machine
        .record_evidence(
            rudder_runtime_attempt_core::RecoveryEvidence::new(
                rudder_runtime_attempt_core::SubmissionPhase::Accepted,
                rudder_runtime_attempt_core::SideEffectRisk::Confirmed,
                false,
                true,
                false,
            )
            .unwrap(),
            &fence,
            0,
        )
        .unwrap();
    machine.mark_waiting_for_network(&fence, 0).unwrap();
    let result = machine
        .record_failure_with_evidence(
            Failure::transport(TransportFailure::Timeout, "timeout").unwrap(),
            rudder_runtime_attempt_core::RecoveryEvidence::new(
                rudder_runtime_attempt_core::SubmissionPhase::Indeterminate,
                rudder_runtime_attempt_core::SideEffectRisk::Possible,
                false,
                false,
                true,
            )
            .unwrap(),
            &fence,
            0,
            None,
        )
        .unwrap();
    assert!(matches!(
        result,
        RecoveryResult::Terminal(ref outcome) if outcome.code() == "network_resume_unsafe"
    ));
    assert!(machine.terminal_event_observed());
    assert!(AttemptMachine::from_checkpoint(machine.checkpoint()).is_ok());
}
