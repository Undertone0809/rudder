use rudder_runtime_attempt_core::{
    ATTEMPT_PROTOCOL_VERSION, AttemptMachine, BackoffDelay, CancellationReason, CancellationState,
    Failure, FailureClassification, HeartbeatIdentity, IdempotencyDecision, IdempotencyKey,
    IdempotencyLedger, LeaseFence, MAX_ATTEMPTS, NETWORK_BACKOFF_SECONDS, Phase, RecoveryDecision,
    RecoveryResult, TransportFailure,
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

    let failure = Failure::server_5xx(503, "upstream unavailable").unwrap();
    let plan = match machine.record_failure(failure, &fence, 30, None).unwrap() {
        RecoveryResult::RetryScheduled(plan) => plan,
        RecoveryResult::Terminal(outcome) => panic!("unexpected terminal outcome: {outcome:?}"),
    };
    assert_eq!(plan.classification, FailureClassification::Server5xx);
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
fn retryable_network_failures_stop_at_the_sixth_attempt() {
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
                        format!("session-{attempt}"),
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
    let key = IdempotencyKey::new("heartbeat-key").unwrap();
    assert_eq!(
        ledger
            .reserve("org-1", key.clone(), "fingerprint-a", "run-1")
            .unwrap(),
        IdempotencyDecision::New
    );
    assert_eq!(
        ledger
            .reserve("org-1", key.clone(), "fingerprint-a", "run-2")
            .unwrap(),
        IdempotencyDecision::Replay {
            run_id: "run-1".to_owned()
        }
    );
    assert_eq!(
        ledger
            .reserve("org-1", key.clone(), "fingerprint-b", "run-3")
            .unwrap_err()
            .code(),
        "idempotency_conflict"
    );

    let outcome = rudder_runtime_attempt_core::TerminalOutcome::NetworkResumeUnsafe {
        attempt: HeartbeatIdentity::new("org-1", "run-1", "agent-1")
            .unwrap()
            .attempt(1)
            .unwrap(),
        failure: Failure::ambiguous("response_unknown", "response not observed").unwrap(),
    };
    ledger
        .record_outcome("org-1", key.clone(), outcome.clone())
        .unwrap();
    assert_eq!(ledger.outcome("org-1", &key), Some(&outcome));
    ledger
        .record_outcome("org-1", key, outcome)
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
