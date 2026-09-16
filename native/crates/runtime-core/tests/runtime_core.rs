use rudder_runtime_core::*;
use serde_json::json;

fn identity() -> RuntimeIdentity {
    RuntimeIdentity::new(
        "org-1",
        "run-1",
        ActorIdentity::new(ActorType::Agent, "agent-1").unwrap(),
    )
    .unwrap()
}

fn lease(epoch: u64, now: u64, ttl: u64) -> Lease {
    Lease::new(
        "worker-1",
        FenceToken::new(epoch, format!("fence-{epoch}")).unwrap(),
        now,
        ttl,
    )
    .unwrap()
}

fn request() -> RunRequest {
    RunRequest::new(
        identity(),
        RunContext::manual(),
        RetryPolicy::default(),
        OutputLimits::default(),
        Some(IdempotencyKey::new("request-1").unwrap()),
        Some(1_000),
    )
    .unwrap()
}

fn request_with_timeout(timeout_millis: u64) -> RunRequest {
    let mut request = request();
    request.timeout_millis = Some(timeout_millis);
    request
}

#[test]
fn runtime_identity_rejects_empty_parts_and_preserves_actor_scope() {
    assert!(
        RuntimeIdentity::new(
            "",
            "run-1",
            ActorIdentity::new(ActorType::Agent, "agent-1").unwrap(),
        )
        .is_err()
    );

    let identity = identity();
    assert_eq!(identity.org_id, "org-1");
    assert_eq!(identity.run_id, "run-1");
    assert_eq!(identity.actor.actor_type, ActorType::Agent);
}

#[test]
fn leases_expire_and_renew_only_with_the_current_fence() {
    let first = lease(1, 100, 50);
    assert!(first.valid_at(149));
    assert!(!first.valid_at(150));
    assert!(first.matches(&FenceToken::new(1, "fence-1").unwrap(), 149));
    assert!(!first.matches(&FenceToken::new(2, "fence-2").unwrap(), 149));

    let renewed = first.renew(120, 100).unwrap();
    assert_eq!(renewed.fence, first.fence);
    assert_eq!(renewed.expires_at_millis, 220);
    assert!(first.renew(150, 100).is_err());
}

#[test]
fn run_admission_execution_and_cancellation_are_fenced() {
    let mut run = RunMachine::new(request(), 0).unwrap();
    assert_eq!(run.admission().state(), AdmissionState::Requested);
    assert_eq!(run.status(), RunStatus::Queued);

    run.queue().unwrap();
    run.admit(lease(1, 10, 100), 10).unwrap();
    run.start(&FenceToken::new(1, "fence-1").unwrap(), 20)
        .unwrap();
    assert_eq!(run.status(), RunStatus::Running);
    assert_eq!(run.execution_phase(), Some(ExecutionPhase::Executing));

    run.wait_for_network(&FenceToken::new(1, "fence-1").unwrap(), 30)
        .unwrap();
    assert_eq!(
        run.execution_phase(),
        Some(ExecutionPhase::WaitingForNetwork)
    );
    run.resume_network(&FenceToken::new(1, "fence-1").unwrap(), 40)
        .unwrap();

    assert!(run.request_cancel(CancellationReason::OperatorStop).is_ok());
    assert!(
        run.cancel(&FenceToken::new(2, "fence-2").unwrap(), 50)
            .is_err()
    );
    run.cancel(&FenceToken::new(1, "fence-1").unwrap(), 50)
        .unwrap();
    assert_eq!(run.status(), RunStatus::Cancelled);
    assert_eq!(run.failure().unwrap().code, "cancelled");
}

#[test]
fn timeout_and_lease_loss_are_terminal_and_cannot_be_replayed() {
    let mut run = RunMachine::new(request_with_timeout(100), 0).unwrap();
    run.admit(lease(1, 0, 100), 0).unwrap();
    run.start(&FenceToken::new(1, "fence-1").unwrap(), 1)
        .unwrap();
    run.timeout(&FenceToken::new(1, "fence-1").unwrap(), 101)
        .unwrap();
    assert_eq!(run.status(), RunStatus::TimedOut);
    assert_eq!(run.failure().unwrap().category, FailureCategory::TimedOut);
    assert!(
        run.succeed(
            &FenceToken::new(1, "fence-1").unwrap(),
            ResultEnvelope::success("late", "", None, OutputLimits::default()).unwrap(),
        )
        .is_err()
    );
}

#[test]
fn output_and_result_envelopes_are_byte_bounded_without_breaking_utf8() {
    let limits = OutputLimits::new(5, 4, 64, 512).unwrap();
    let output = BoundedOutput::new("héllo", 5).unwrap();
    assert_eq!(output.text(), "héll");
    assert!(output.truncated());
    assert_eq!(output.original_bytes(), 6);

    let result = ResultEnvelope::success(
        "héllo",
        "error-output",
        Some(json!({"ok": true})),
        limits.clone(),
    )
    .unwrap();
    assert!(result.stdout().truncated());
    assert_eq!(result.stderr().text(), "erro");
    assert!(result.encoded_len() <= limits.max_envelope_bytes());
}

#[test]
fn oversized_result_payload_is_rejected_before_crossing_the_protocol_boundary() {
    let limits = OutputLimits::new(32, 32, 8, 512).unwrap();
    let error = ResultEnvelope::success("", "", Some(json!({"too": "large"})), limits).unwrap_err();
    assert_eq!(error.code(), "result_limit_exceeded");
}

#[test]
fn retry_policy_requires_retryable_failure_and_enforces_attempt_budget() {
    let policy = RetryPolicy::new(
        3,
        100,
        1_000,
        vec![FailureCategory::Provider, FailureCategory::TimedOut],
    )
    .unwrap();
    let mut run = RunMachine::new(
        RunRequest::new(
            identity(),
            RunContext::manual(),
            policy,
            OutputLimits::default(),
            None,
            None,
        )
        .unwrap(),
        0,
    )
    .unwrap();
    run.admit(lease(1, 0, 1_000), 0).unwrap();
    run.start(&FenceToken::new(1, "fence-1").unwrap(), 1)
        .unwrap();
    run.fail(
        &FenceToken::new(1, "fence-1").unwrap(),
        Failure::provider("provider_unavailable", "provider unavailable", true),
    )
    .unwrap();

    let retry = run.schedule_retry(40).unwrap();
    assert_eq!(retry.attempt, 2);
    assert_eq!(retry.delay_millis, 100);
    assert_eq!(retry.next_attempt_at_millis, 140);
    assert_eq!(run.status(), RunStatus::Queued);

    run.admit(lease(2, 140, 1_000), 140).unwrap();
    run.start(&FenceToken::new(2, "fence-2").unwrap(), 141)
        .unwrap();
    run.fail(
        &FenceToken::new(2, "fence-2").unwrap(),
        Failure::provider("provider_unavailable", "provider unavailable", true),
    )
    .unwrap();
    run.schedule_retry(200).unwrap();
    run.admit(lease(3, 300, 1_000), 300).unwrap();
    run.start(&FenceToken::new(3, "fence-3").unwrap(), 301)
        .unwrap();
    run.fail(
        &FenceToken::new(3, "fence-3").unwrap(),
        Failure::provider("provider_unavailable", "provider unavailable", true),
    )
    .unwrap();
    assert_eq!(
        run.schedule_retry(400).unwrap_err().code(),
        "retry_exhausted"
    );
}

#[test]
fn idempotency_replays_same_fingerprint_but_rejects_conflicts() {
    let mut ledger = IdempotencyLedger::default();
    let key = IdempotencyKey::new("same-key").unwrap();
    assert_eq!(
        ledger
            .reserve("org-1", key.clone(), "fingerprint-a", "run-1")
            .unwrap(),
        IdempotencyDecision::New
    );
    assert_eq!(
        ledger
            .reserve("org-1", key.clone(), "fingerprint-a", "run-1b")
            .unwrap(),
        IdempotencyDecision::Replay {
            run_id: "run-1".to_owned()
        }
    );
    assert_eq!(
        ledger
            .reserve("org-1", key, "fingerprint-b", "run-2")
            .unwrap_err()
            .code(),
        "idempotency_conflict"
    );
}

#[test]
fn automation_dispatch_applies_idempotency_and_concurrency_policy() {
    let definition = AutomationDefinition::new(
        "org-1",
        "automation-1",
        AutomationStatus::Active,
        AutomationConcurrencyPolicy::CoalesceIfActive,
        AutomationCatchUpPolicy::SkipMissed,
        AutomationOutputMode::ChatOutput,
    )
    .unwrap();
    let mut scheduler = AutomationScheduler::new(definition);
    let first = scheduler
        .dispatch(AutomationRunRequest::new(
            "run-1",
            None,
            AutomationRunSource::Api,
            Some("key-1"),
            Some(json!({"input": 1})),
            10,
        ))
        .unwrap();
    assert_eq!(first.status(), AutomationRunStatus::Received);
    scheduler.start("run-1").unwrap();

    let replay = scheduler
        .dispatch(AutomationRunRequest::new(
            "run-2",
            None,
            AutomationRunSource::Api,
            Some("key-1"),
            Some(json!({"input": 1})),
            20,
        ))
        .unwrap();
    assert_eq!(
        replay,
        AutomationDispatch::Replay {
            run_id: "run-1".into()
        }
    );

    let coalesced = scheduler
        .dispatch(AutomationRunRequest::new(
            "run-3",
            None,
            AutomationRunSource::Api,
            Some("key-2"),
            Some(json!({"input": 2})),
            30,
        ))
        .unwrap();
    assert_eq!(
        coalesced,
        AutomationDispatch::Coalesced {
            run_id: "run-3".into(),
            coalesced_into_run_id: "run-1".into(),
        }
    );
    assert_eq!(
        scheduler.run("run-3").unwrap().status,
        AutomationRunStatus::Coalesced
    );
}

#[test]
fn automation_skip_always_enqueue_and_catch_up_are_explicit() {
    let skip_definition = AutomationDefinition::new(
        "org-1",
        "automation-skip",
        AutomationStatus::Active,
        AutomationConcurrencyPolicy::SkipIfActive,
        AutomationCatchUpPolicy::SkipMissed,
        AutomationOutputMode::TrackIssue,
    )
    .unwrap();
    let mut skip = AutomationScheduler::new(skip_definition);
    skip.dispatch(AutomationRunRequest::new(
        "run-1",
        None,
        AutomationRunSource::Schedule,
        None,
        None,
        0,
    ))
    .unwrap();
    skip.start("run-1").unwrap();
    let skipped = skip
        .dispatch(AutomationRunRequest::new(
            "run-2",
            None,
            AutomationRunSource::Schedule,
            None,
            None,
            1,
        ))
        .unwrap();
    assert_eq!(
        skipped,
        AutomationDispatch::Skipped {
            run_id: "run-2".into(),
            active_run_id: "run-1".into(),
        }
    );

    let always_definition = AutomationDefinition::new(
        "org-1",
        "automation-always",
        AutomationStatus::Active,
        AutomationConcurrencyPolicy::AlwaysEnqueue,
        AutomationCatchUpPolicy::EnqueueMissedWithCap,
        AutomationOutputMode::TrackIssue,
    )
    .unwrap();
    let always = AutomationScheduler::new(always_definition);
    let catch_up = always.catch_up(30);
    assert_eq!(catch_up.enqueued, 25);
    assert_eq!(catch_up.skipped, 5);
}

#[test]
fn paused_automation_is_rejected_without_creating_a_run() {
    let definition = AutomationDefinition::new(
        "org-1",
        "automation-paused",
        AutomationStatus::Paused,
        AutomationConcurrencyPolicy::AlwaysEnqueue,
        AutomationCatchUpPolicy::SkipMissed,
        AutomationOutputMode::TrackIssue,
    )
    .unwrap();
    let mut scheduler = AutomationScheduler::new(definition);
    let error = scheduler
        .dispatch(AutomationRunRequest::new(
            "run-1",
            None,
            AutomationRunSource::Manual,
            None,
            None,
            0,
        ))
        .unwrap_err();
    assert_eq!(error.code(), "automation_not_active");
    assert!(scheduler.run("run-1").is_none());
}

#[test]
fn chat_steer_requires_current_generation_and_fence_then_records_provider_ack() {
    let mut chat = ChatScheduler::new("org-1", "conversation-1").unwrap();
    let owner = lease(1, 0, 1_000);
    chat.register_generation(ChatGenerationRequest::new(
        "generation-1",
        1,
        owner.clone(),
        0,
    ))
    .unwrap();
    chat.mark_generation_ready(&owner.fence, 1).unwrap();
    chat.mark_generation_running(&owner.fence, 2).unwrap();

    let decision = chat
        .request_steer(ChatSteerRequest::new(
            "queue-1",
            "client-1",
            "please continue",
            "generation-1",
            1,
        ))
        .unwrap();
    assert_eq!(
        decision,
        ChatSteerDecision::ProviderDispatchRequired {
            item_id: "queue-1".into()
        }
    );
    chat.record_steer_provider_sent("queue-1", &owner.fence, "provider-client-1")
        .unwrap();
    let result = chat
        .record_steer_acknowledged("queue-1", &owner.fence, 3)
        .unwrap();
    assert_eq!(result, ChatSteerResult::DeliveredCurrent);
    assert_eq!(
        chat.item("queue-1").unwrap().status,
        ChatQueueStatus::Delivered
    );
}

#[test]
fn chat_stale_generation_and_owner_changes_require_continuation_or_fail_closed() {
    let mut chat = ChatScheduler::new("org-1", "conversation-1").unwrap();
    let owner = lease(1, 0, 1_000);
    chat.register_generation(ChatGenerationRequest::new(
        "generation-1",
        1,
        owner.clone(),
        0,
    ))
    .unwrap();
    chat.mark_generation_ready(&owner.fence, 1).unwrap();
    chat.mark_generation_running(&owner.fence, 2).unwrap();

    let stale = chat
        .request_steer(ChatSteerRequest::new(
            "queue-stale",
            "client-stale",
            "stale",
            "generation-old",
            1,
        ))
        .unwrap();
    assert_eq!(
        stale,
        ChatSteerDecision::StaleGeneration {
            active_generation_id: Some("generation-1".into())
        }
    );
    assert!(chat.item("queue-stale").is_none());

    assert!(
        chat.request_stop(&FenceToken::new(9, "wrong").unwrap(), 3)
            .is_err()
    );
    chat.request_stop(&owner.fence, 3).unwrap();
    let continuation = chat
        .request_steer(ChatSteerRequest::new(
            "queue-next",
            "client-next",
            "next",
            "generation-1",
            1,
        ))
        .unwrap();
    assert_eq!(
        continuation,
        ChatSteerDecision::ContinuationRequired {
            item_id: "queue-next".into(),
            reason: ChatContinuationReason::Closing,
        }
    );
    assert_eq!(
        chat.item("queue-next").unwrap().status,
        ChatQueueStatus::ContinuationPending
    );
}

#[test]
fn chat_queue_client_mutation_is_idempotent_and_delivery_lease_is_fenced() {
    let mut chat = ChatScheduler::new("org-1", "conversation-1").unwrap();
    let first = chat
        .enqueue(ChatQueueRequest::new(
            "queue-1",
            "client-1",
            "queued body",
            0,
        ))
        .unwrap();
    let duplicate = chat
        .enqueue(ChatQueueRequest::new(
            "queue-2",
            "client-1",
            "same mutation",
            1,
        ))
        .unwrap();
    assert_eq!(duplicate.item_id, first.item_id);
    assert!(duplicate.duplicate);

    let delivery_lease = lease(3, 10, 50);
    let claim = chat
        .claim_next(delivery_lease.clone(), 10)
        .unwrap()
        .unwrap();
    assert_eq!(claim.item_id, "queue-1");
    assert!(
        chat.acknowledge_delivery("queue-1", &FenceToken::new(4, "wrong").unwrap(), 20)
            .is_err()
    );
    chat.acknowledge_delivery("queue-1", &delivery_lease.fence, 20)
        .unwrap();
    assert_eq!(
        chat.item("queue-1").unwrap().status,
        ChatQueueStatus::Delivered
    );
}
