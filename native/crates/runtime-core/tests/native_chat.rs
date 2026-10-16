use rudder_runtime_core::ChatGenerationStatus;
use rudder_runtime_core::native_chat::{
    MAX_NATIVE_CHAT_REPLAY_EVENTS, NativeChatEventDisposition, NativeChatReconnectAction,
    NativeChatSubmissionPhase, NativeChatTurnEvent, NativeChatTurnEventKind,
    NativeChatTurnIdentity, NativeChatTurnReducer, NativeChatTurnRequest,
};
use serde_json::Value;

fn turn_identity(
    attempt_id: &str,
    generation_attempt_epoch: u64,
    run_attempt_epoch: u64,
    connection_epoch: u64,
) -> NativeChatTurnIdentity {
    NativeChatTurnIdentity::new(
        "org-1",
        "conversation-1",
        "segment-1",
        "generation-1",
        "binding-1",
        "run-1",
        attempt_id,
        generation_attempt_epoch,
        run_attempt_epoch,
        connection_epoch,
    )
    .unwrap()
}

#[test]
fn identity_keeps_generation_and_run_attempt_epochs_separate_on_the_wire() {
    let identity = turn_identity("attempt-1", 7, 12, 3);
    let wire = serde_json::to_value(&identity).unwrap();
    assert_eq!(wire["generationAttemptEpoch"], 7);
    assert_eq!(wire["runAttemptEpoch"], 12);
    assert_eq!(wire["connectionEpoch"], 3);
    assert!(wire.get("attemptEpoch").is_none());
    let mut ambiguous_legacy_wire = wire.clone();
    ambiguous_legacy_wire
        .as_object_mut()
        .unwrap()
        .remove("generationAttemptEpoch");
    ambiguous_legacy_wire
        .as_object_mut()
        .unwrap()
        .remove("runAttemptEpoch");
    ambiguous_legacy_wire["attemptEpoch"] = serde_json::json!(7);
    assert!(serde_json::from_value::<NativeChatTurnIdentity>(ambiguous_legacy_wire).is_err());

    let mut zero_generation_epoch = identity.clone();
    zero_generation_epoch.generation_attempt_epoch = 0;
    assert!(zero_generation_epoch.validate().is_err());

    let mut zero_run_epoch = identity;
    zero_run_epoch.run_attempt_epoch = 0;
    assert!(zero_run_epoch.validate().is_err());
}

fn reducer(phase: NativeChatSubmissionPhase) -> NativeChatTurnReducer {
    NativeChatTurnReducer::new(
        NativeChatTurnRequest::new(turn_identity("attempt-1", 1, 1, 1), phase).unwrap(),
    )
    .unwrap()
}

fn event(
    identity: &NativeChatTurnIdentity,
    sequence: u64,
    event: NativeChatTurnEventKind,
) -> NativeChatTurnEvent {
    NativeChatTurnEvent::new(identity.clone(), sequence, event).unwrap()
}

fn unknown(identity: &NativeChatTurnIdentity, sequence: u64) -> NativeChatTurnEvent {
    event(
        identity,
        sequence,
        NativeChatTurnEventKind::Unknown {
            event_type: "future.provider.event".to_owned(),
            safe_reference: Some(format!("event-{sequence}")),
        },
    )
}

#[test]
fn commentary_tool_and_unknown_events_are_metadata_only_and_never_terminal() {
    let mut reducer = reducer(NativeChatSubmissionPhase::PreSubmission);
    let identity = reducer.identity().clone();

    for event in [
        event(
            &identity,
            1,
            NativeChatTurnEventKind::Commentary {
                event_type: "assistant.delta".to_owned(),
                safe_reference: Some("evt-commentary-1".to_owned()),
            },
        ),
        event(
            &identity,
            2,
            NativeChatTurnEventKind::ToolActivity {
                event_type: "tool.started".to_owned(),
                safe_reference: Some("evt-tool-1".to_owned()),
            },
        ),
        unknown(&identity, 3),
    ] {
        assert_eq!(
            reducer.apply(event).unwrap(),
            NativeChatEventDisposition::Applied
        );
        assert_eq!(reducer.terminal_status(), None);
    }
    assert_eq!(
        reducer.submission_phase(),
        NativeChatSubmissionPhase::Accepted
    );

    let serialized = serde_json::to_value(reducer.checkpoint()).unwrap();
    let text = serialized.to_string();
    assert!(!text.contains("payload"));
    assert!(!text.contains("prompt"));
    assert!(!text.contains("tool arguments"));
    assert!(text.contains("future.provider.event"));
    assert!(text.contains("event-3"));
}

#[test]
fn unknown_provider_events_cannot_supply_final_or_attempt_terminal_evidence() {
    let mut reducer = reducer(NativeChatSubmissionPhase::Accepted);
    let identity = reducer.identity().clone();
    reducer
        .apply(event(
            &identity,
            1,
            NativeChatTurnEventKind::Unknown {
                event_type: "turn.final".to_owned(),
                safe_reference: Some("opaque-final-like-event".to_owned()),
            },
        ))
        .unwrap();
    reducer
        .record_attempt_terminal(&identity, 2, ChatGenerationStatus::Completed)
        .unwrap();
    assert_eq!(reducer.terminal_status(), None);
    assert_eq!(reducer.checkpoint().provider_final_sequence, None);

    let forged_terminal = serde_json::json!({
        "identity": identity.clone(),
        "sequence": 3,
        "event": {
            "kind": "execution_terminal",
            "status": "completed",
            "eventType": "execution.completed"
        }
    });
    assert!(serde_json::from_value::<NativeChatTurnEvent>(forged_terminal).is_err());

    let raw_unknown_payload = serde_json::json!({
        "identity": identity,
        "sequence": 3,
        "event": {
            "kind": "unknown",
            "eventType": "turn.completed",
            "safeReference": "opaque-event-3",
            "payload": { "claimedCompleted": true }
        }
    });
    assert!(serde_json::from_value::<NativeChatTurnEvent>(raw_unknown_payload).is_err());
    assert_eq!(reducer.checkpoint().last_sequence, Some(2));
}

#[test]
fn completed_execution_waits_for_provider_final_in_either_event_order() {
    let identity = turn_identity("attempt-1", 1, 1, 1);
    let final_event = |sequence| {
        event(
            &identity,
            sequence,
            NativeChatTurnEventKind::ProviderFinal {
                event_type: "turn.final".to_owned(),
                safe_reference: Some("turn-final-1".to_owned()),
            },
        )
    };
    let mut execution_first = NativeChatTurnReducer::new(
        NativeChatTurnRequest::new(identity.clone(), NativeChatSubmissionPhase::Accepted).unwrap(),
    )
    .unwrap();
    execution_first
        .record_attempt_terminal(&identity, 1, ChatGenerationStatus::Completed)
        .unwrap();
    let after_attempt_terminal = execution_first.checkpoint();
    assert_eq!(
        execution_first
            .record_attempt_terminal(&identity, 1, ChatGenerationStatus::Completed)
            .unwrap(),
        NativeChatEventDisposition::Duplicate
    );
    assert_eq!(
        execution_first
            .apply(unknown(&identity, 1))
            .unwrap_err()
            .code(),
        "native_chat_event_replay_conflict"
    );
    assert_eq!(execution_first.checkpoint(), after_attempt_terminal);
    assert_eq!(execution_first.terminal_status(), None);
    execution_first.apply(final_event(2)).unwrap();
    assert_eq!(
        execution_first.terminal_status(),
        Some(ChatGenerationStatus::Completed)
    );

    let mut final_first = NativeChatTurnReducer::new(
        NativeChatTurnRequest::new(identity.clone(), NativeChatSubmissionPhase::Accepted).unwrap(),
    )
    .unwrap();
    final_first.apply(final_event(1)).unwrap();
    assert_eq!(final_first.terminal_status(), None);
    final_first
        .record_attempt_terminal(&identity, 2, ChatGenerationStatus::Completed)
        .unwrap();
    assert_eq!(
        final_first.terminal_status(),
        Some(ChatGenerationStatus::Completed)
    );
}

#[test]
fn exact_replays_deduplicate_but_conflicting_or_stale_attempt_events_reject_atomically() {
    let mut reducer = reducer(NativeChatSubmissionPhase::Unknown);
    let identity = reducer.identity().clone();
    let first = event(
        &identity,
        1,
        NativeChatTurnEventKind::Commentary {
            event_type: "assistant.delta".to_owned(),
            safe_reference: None,
        },
    );
    assert_eq!(
        reducer.apply(first.clone()).unwrap(),
        NativeChatEventDisposition::Applied
    );
    assert_eq!(
        reducer.apply(first).unwrap(),
        NativeChatEventDisposition::Duplicate
    );

    let checkpoint_before_conflict = reducer.checkpoint();
    let conflict = event(
        &identity,
        1,
        NativeChatTurnEventKind::ToolActivity {
            event_type: "tool.started".to_owned(),
            safe_reference: None,
        },
    );
    assert_eq!(
        reducer.apply(conflict).unwrap_err().code(),
        "native_chat_event_replay_conflict"
    );
    assert_eq!(reducer.checkpoint(), checkpoint_before_conflict);

    let stale_attempt = event(
        &turn_identity("attempt-old", 1, 1, 1),
        2,
        NativeChatTurnEventKind::Commentary {
            event_type: "assistant.delta".to_owned(),
            safe_reference: None,
        },
    );
    assert_eq!(
        reducer.apply(stale_attempt).unwrap_err().code(),
        "stale_native_chat_identity"
    );
    assert_eq!(reducer.checkpoint(), checkpoint_before_conflict);

    let stale_generation_attempt = event(
        &turn_identity("attempt-1", 2, 1, 1),
        2,
        NativeChatTurnEventKind::Commentary {
            event_type: "assistant.delta".to_owned(),
            safe_reference: None,
        },
    );
    assert_eq!(
        reducer.apply(stale_generation_attempt).unwrap_err().code(),
        "stale_native_chat_identity"
    );
    assert_eq!(reducer.checkpoint(), checkpoint_before_conflict);

    let stale_run_attempt = event(
        &turn_identity("attempt-1", 1, 2, 1),
        2,
        NativeChatTurnEventKind::Commentary {
            event_type: "assistant.delta".to_owned(),
            safe_reference: None,
        },
    );
    assert_eq!(
        reducer.apply(stale_run_attempt).unwrap_err().code(),
        "stale_native_chat_identity"
    );
    assert_eq!(reducer.checkpoint(), checkpoint_before_conflict);

    let stale_connection = event(
        &turn_identity("attempt-1", 1, 1, 2),
        2,
        NativeChatTurnEventKind::Commentary {
            event_type: "assistant.delta".to_owned(),
            safe_reference: None,
        },
    );
    assert_eq!(
        reducer.apply(stale_connection).unwrap_err().code(),
        "stale_native_chat_identity"
    );
    assert_eq!(reducer.checkpoint(), checkpoint_before_conflict);

    let stale_generation = NativeChatTurnIdentity::new(
        "org-1",
        "conversation-1",
        "segment-1",
        "generation-old",
        "binding-1",
        "run-1",
        "attempt-1",
        1,
        1,
        1,
    )
    .unwrap();
    assert_eq!(
        reducer
            .apply(event(
                &stale_generation,
                2,
                NativeChatTurnEventKind::Commentary {
                    event_type: "assistant.delta".to_owned(),
                    safe_reference: None,
                },
            ))
            .unwrap_err()
            .code(),
        "stale_native_chat_identity"
    );
    assert_eq!(reducer.checkpoint(), checkpoint_before_conflict);

    let stale_segment = NativeChatTurnIdentity::new(
        "org-1",
        "conversation-1",
        "segment-old",
        "generation-1",
        "binding-1",
        "run-1",
        "attempt-1",
        1,
        1,
        1,
    )
    .unwrap();
    assert_eq!(
        reducer
            .apply(event(
                &stale_segment,
                2,
                NativeChatTurnEventKind::Commentary {
                    event_type: "assistant.delta".to_owned(),
                    safe_reference: None,
                },
            ))
            .unwrap_err()
            .code(),
        "stale_native_chat_identity"
    );
    assert_eq!(reducer.checkpoint(), checkpoint_before_conflict);
}

#[test]
fn checkpoint_restore_keeps_replay_history_and_evicted_replays_require_reconciliation() {
    let mut reducer = reducer(NativeChatSubmissionPhase::Unknown);
    let identity = reducer.identity().clone();
    let provider_final = event(
        &identity,
        1,
        NativeChatTurnEventKind::ProviderFinal {
            event_type: "turn.final".to_owned(),
            safe_reference: Some("turn-final-1".to_owned()),
        },
    );
    reducer.apply(provider_final.clone()).unwrap();
    for sequence in 2..=(MAX_NATIVE_CHAT_REPLAY_EVENTS as u64 + 1) {
        reducer.apply(unknown(&identity, sequence)).unwrap();
    }

    let checkpoint = reducer.checkpoint();
    assert_eq!(
        checkpoint.retained_events.len(),
        MAX_NATIVE_CHAT_REPLAY_EVENTS
    );
    assert_eq!(checkpoint.replay_floor, 1);
    let mut lossy_checkpoint = checkpoint.clone();
    lossy_checkpoint.retained_events.remove(0);
    assert_eq!(
        NativeChatTurnReducer::restore(&identity, lossy_checkpoint)
            .unwrap_err()
            .code(),
        "invalid_input"
    );
    let encoded = serde_json::to_string(&checkpoint).unwrap();
    let decoded = serde_json::from_str::<Value>(&encoded).unwrap();
    let decoded: rudder_runtime_core::native_chat::NativeChatTurnCheckpoint =
        serde_json::from_value(decoded).unwrap();
    let mut restored = NativeChatTurnReducer::restore(&identity, decoded).unwrap();
    assert_eq!(
        restored
            .apply(unknown(&identity, MAX_NATIVE_CHAT_REPLAY_EVENTS as u64 + 1))
            .unwrap(),
        NativeChatEventDisposition::Duplicate
    );
    assert_eq!(
        restored.apply(provider_final).unwrap_err().code(),
        "native_chat_reconciliation_required"
    );
    restored
        .record_attempt_terminal(
            &identity,
            MAX_NATIVE_CHAT_REPLAY_EVENTS as u64 + 2,
            ChatGenerationStatus::Completed,
        )
        .unwrap();
    assert_eq!(
        restored.terminal_status(),
        Some(ChatGenerationStatus::Completed),
        "evicting replay bytes must not erase terminal evidence"
    );

    let wrong_identity = turn_identity("attempt-2", 2, 2, 1);
    let checkpoint = restored.checkpoint();
    assert_eq!(
        NativeChatTurnReducer::restore(&wrong_identity, checkpoint)
            .unwrap_err()
            .code(),
        "stale_native_chat_identity"
    );
}

#[test]
fn cancellation_cutoff_preserves_evidence_and_late_events_cannot_resurrect_success() {
    let mut reducer = reducer(NativeChatSubmissionPhase::Accepted);
    let identity = reducer.identity().clone();
    reducer
        .apply(event(
            &identity,
            1,
            NativeChatTurnEventKind::Commentary {
                event_type: "assistant.delta".to_owned(),
                safe_reference: Some("evt-commentary-1".to_owned()),
            },
        ))
        .unwrap();
    let before_bad_cutoff = reducer.checkpoint();
    assert_eq!(
        reducer.cancel(&identity, 0).unwrap_err().code(),
        "native_chat_cancellation_cutoff_conflict"
    );
    assert_eq!(reducer.checkpoint(), before_bad_cutoff);
    reducer.cancel(&identity, 1).unwrap();
    let checkpoint_after_cancel = reducer.checkpoint();
    assert_eq!(
        reducer.terminal_status(),
        Some(ChatGenerationStatus::Stopped)
    );
    assert_eq!(checkpoint_after_cancel.retained_events.len(), 1);
    assert_eq!(
        checkpoint_after_cancel.retained_events[0].event,
        NativeChatTurnEventKind::Commentary {
            event_type: "assistant.delta".to_owned(),
            safe_reference: Some("evt-commentary-1".to_owned()),
        }
    );
    let mut regressed_checkpoint = checkpoint_after_cancel.clone();
    regressed_checkpoint.execution_terminal = Some(
        rudder_runtime_core::native_chat::NativeChatExecutionTerminal {
            status: ChatGenerationStatus::Completed,
            sequence: 2,
        },
    );
    regressed_checkpoint.last_sequence = Some(2);
    regressed_checkpoint.cancellation_cutoff = Some(2);
    assert_eq!(
        NativeChatTurnReducer::restore(&identity, regressed_checkpoint)
            .unwrap_err()
            .code(),
        "invalid_input"
    );

    let late_final = event(
        &identity,
        2,
        NativeChatTurnEventKind::ProviderFinal {
            event_type: "turn.final".to_owned(),
            safe_reference: Some("turn-final-late".to_owned()),
        },
    );
    assert_eq!(
        reducer.apply(late_final).unwrap_err().code(),
        "native_event_after_cancellation"
    );
    assert_eq!(
        reducer
            .record_attempt_terminal(&identity, 2, ChatGenerationStatus::Completed)
            .unwrap_err()
            .code(),
        "native_event_after_cancellation"
    );
    assert_eq!(reducer.checkpoint(), checkpoint_after_cancel);
    reducer.cancel(&identity, 1).unwrap();
    assert_eq!(reducer.checkpoint(), checkpoint_after_cancel);

    let mut restored =
        NativeChatTurnReducer::restore(&identity, checkpoint_after_cancel.clone()).unwrap();
    assert_eq!(
        restored.terminal_status(),
        Some(ChatGenerationStatus::Stopped)
    );
    assert_eq!(
        restored.apply(unknown(&identity, 2)).unwrap_err().code(),
        "native_event_after_cancellation"
    );
    assert_eq!(restored.checkpoint(), checkpoint_after_cancel);
}

#[test]
fn cancellation_after_attempt_completion_waits_for_provider_final_instead_of_rewriting_it() {
    let mut reducer = reducer(NativeChatSubmissionPhase::Accepted);
    let identity = reducer.identity().clone();
    reducer
        .record_attempt_terminal(&identity, 1, ChatGenerationStatus::Completed)
        .unwrap();
    assert_eq!(reducer.terminal_status(), None);
    let before_cancel = reducer.checkpoint();

    assert_eq!(
        reducer.cancel(&identity, 1).unwrap_err().code(),
        "already_terminal"
    );
    assert_eq!(reducer.checkpoint(), before_cancel);

    reducer
        .apply(event(
            &identity,
            2,
            NativeChatTurnEventKind::ProviderFinal {
                event_type: "turn.final".to_owned(),
                safe_reference: Some("turn-final-1".to_owned()),
            },
        ))
        .unwrap();
    assert_eq!(
        reducer.terminal_status(),
        Some(ChatGenerationStatus::Completed)
    );
}

#[test]
fn cancellation_after_success_conflicts_without_rewriting_success_evidence() {
    let mut reducer = reducer(NativeChatSubmissionPhase::Accepted);
    let identity = reducer.identity().clone();
    reducer
        .apply(event(
            &identity,
            1,
            NativeChatTurnEventKind::ProviderFinal {
                event_type: "turn.final".to_owned(),
                safe_reference: Some("turn-final-1".to_owned()),
            },
        ))
        .unwrap();
    reducer
        .record_attempt_terminal(&identity, 2, ChatGenerationStatus::Completed)
        .unwrap();
    let before_cancel = reducer.checkpoint();
    assert_eq!(
        reducer.terminal_status(),
        Some(ChatGenerationStatus::Completed)
    );
    assert_eq!(
        reducer.cancel(&identity, 2).unwrap_err().code(),
        "already_terminal"
    );
    assert_eq!(reducer.checkpoint(), before_cancel);

    let mut restored = NativeChatTurnReducer::restore(&identity, before_cancel.clone()).unwrap();
    assert_eq!(
        restored.terminal_status(),
        Some(ChatGenerationStatus::Completed)
    );
    assert_eq!(
        restored.prepare_provider_submission().unwrap_err().code(),
        "already_terminal"
    );
    assert_eq!(
        restored.cancel(&identity, 2).unwrap_err().code(),
        "already_terminal"
    );
    assert_eq!(restored.checkpoint(), before_cancel);
}

#[test]
fn unknown_submission_and_indeterminate_reconnect_never_resubmit_input() {
    let unknown_reducer = reducer(NativeChatSubmissionPhase::Unknown);
    assert_eq!(
        unknown_reducer.reconnect_action(),
        NativeChatReconnectAction::ReattachEventsOnly
    );

    let mut pre_submission = reducer(NativeChatSubmissionPhase::PreSubmission);
    assert_eq!(
        pre_submission.reconnect_action(),
        NativeChatReconnectAction::PrepareSubmission
    );
    let identity = pre_submission.identity().clone();
    let prepared_checkpoint = pre_submission.prepare_provider_submission().unwrap();
    assert_eq!(
        prepared_checkpoint.submission_phase,
        NativeChatSubmissionPhase::Indeterminate
    );
    assert_eq!(
        pre_submission.submission_phase(),
        NativeChatSubmissionPhase::Indeterminate
    );
    assert_eq!(
        pre_submission.reconnect_action(),
        NativeChatReconnectAction::ReattachEventsOnly
    );
    let before_second_prepare = pre_submission.checkpoint();
    assert_eq!(
        pre_submission
            .prepare_provider_submission()
            .unwrap_err()
            .code(),
        "invalid_transition"
    );
    assert_eq!(pre_submission.checkpoint(), before_second_prepare);

    let encoded_checkpoint = serde_json::to_string(&prepared_checkpoint).unwrap();
    let restored_checkpoint = serde_json::from_str(&encoded_checkpoint).unwrap();
    let mut restored = NativeChatTurnReducer::restore(&identity, restored_checkpoint).unwrap();
    assert_eq!(
        restored.reconnect_action(),
        NativeChatReconnectAction::ReattachEventsOnly
    );
    assert_eq!(
        restored.prepare_provider_submission().unwrap_err().code(),
        "invalid_transition"
    );
    assert_eq!(restored.checkpoint(), prepared_checkpoint);

    let mut unknown_event = reducer(NativeChatSubmissionPhase::Unknown);
    let identity = unknown_event.identity().clone();
    unknown_event.apply(unknown(&identity, 1)).unwrap();
    assert_eq!(
        unknown_event.submission_phase(),
        NativeChatSubmissionPhase::Indeterminate
    );
    assert_eq!(
        unknown_event.reconnect_action(),
        NativeChatReconnectAction::ReattachEventsOnly
    );
}

#[test]
fn malformed_event_is_rejected_without_advancing_sequence() {
    let mut reducer = reducer(NativeChatSubmissionPhase::Unknown);
    let identity = reducer.identity().clone();
    let invalid = NativeChatTurnEvent {
        identity: identity.clone(),
        sequence: 1,
        event: NativeChatTurnEventKind::Unknown {
            event_type: "event with raw secret".to_owned(),
            safe_reference: Some("opaque-secret=value".to_owned()),
        },
    };
    assert_eq!(reducer.apply(invalid).unwrap_err().code(), "invalid_input");
    assert_eq!(reducer.checkpoint().last_sequence, None);

    reducer.apply(unknown(&identity, 1)).unwrap();
    assert_eq!(reducer.checkpoint().last_sequence, Some(1));
}
