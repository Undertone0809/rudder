use rudder_runtime_core::native_chat::{
    MAX_NATIVE_CHAT_PROVIDER_ID_BYTES, NativeChatProtocolCheckpoint as Checkpoint,
    NativeChatProtocolPhase as Phase, NativeChatProtocolStart as Start, NativeChatProvider,
    PiSessionSelector,
};

fn restored(state: &Checkpoint) -> Checkpoint {
    let result: Checkpoint = serde_json::from_slice(&serde_json::to_vec(state).unwrap()).unwrap();
    result.validate().unwrap();
    result
}

#[test]
fn fresh_thread_and_two_turns_keep_exact_identity_without_replaying_input() {
    let thread = "  Thread/大小写:ABC  ";
    let first = Checkpoint::new(Start::FreshThread).unwrap();
    assert!(first.prepare_input(0).is_err());
    assert!(first.record_thread(0, thread.into()).is_err());
    let first = restored(&first.prepare_thread_start(0).unwrap());
    assert!(first.prepare_thread_start(1).is_err());
    let first = first.record_thread(1, thread.into()).unwrap();
    assert_eq!(first.thread_id(), Some(thread));
    let first = first.prepare_input(2).unwrap();
    let first = restored(&first.mark_input_indeterminate(3).unwrap());
    assert!(first.prepare_input(4).is_err());
    assert!(first.mark_input_indeterminate(4).is_err());
    assert!(
        first
            .record_turn(4, thread.trim(), "turn-1".into())
            .is_err()
    );
    let first = first.record_turn(4, thread, "  Turn/1  ".into()).unwrap();
    assert!(first.record_provider_terminal(5, thread, "Turn/1").is_err());
    let first = restored(
        &first
            .record_provider_terminal(5, thread, "  Turn/1  ")
            .unwrap(),
    );
    assert_eq!(first.phase(), Phase::ProviderTerminalObserved);
    assert!(first.prepare_input(6).is_err());

    // The next admitted Generation gets a separate protocol checkpoint. Its
    // exact Thread comes from persistence, never a replay of the first input.
    let second = Checkpoint::new(Start::ExistingThread {
        thread_id: first.thread_id().unwrap().into(),
    })
    .unwrap();
    assert!(second.prepare_thread_start(0).is_err());
    let second = second
        .prepare_input(0)
        .unwrap()
        .mark_input_indeterminate(1)
        .unwrap();
    let second = second.record_turn(2, thread, "turn-2".into()).unwrap();
    assert_eq!(second.thread_id(), first.thread_id());
    assert_ne!(second.turn_id(), first.turn_id());
}

#[test]
fn restart_at_ambiguous_effects_never_mints_another_send() {
    let starting = Checkpoint::new(Start::FreshThread)
        .unwrap()
        .prepare_thread_start(0)
        .unwrap();
    for state in [starting.clone(), restored(&starting)] {
        assert!(state.prepare_thread_start(state.revision()).is_err());
        assert!(state.prepare_input(state.revision()).is_err());
    }
    let pending = starting
        .record_thread(1, "thread".into())
        .unwrap()
        .prepare_input(2)
        .unwrap()
        .mark_input_indeterminate(3)
        .unwrap();
    for state in [pending.clone(), restored(&pending)] {
        assert!(state.prepare_thread_start(state.revision()).is_err());
        assert!(state.prepare_input(state.revision()).is_err());
        assert!(state.mark_input_indeterminate(state.revision()).is_err());
        assert_eq!(state.phase(), Phase::InputIndeterminate);
    }
}

#[test]
fn reattachment_observes_exact_existing_turn_without_any_submission_path() {
    let state = restored(
        &Checkpoint::new(Start::ObserveExistingTurn {
            thread_id: "thread".into(),
            turn_id: "turn".into(),
        })
        .unwrap(),
    );
    assert!(state.observation_only());
    assert!(state.prepare_thread_start(0).is_err());
    assert!(state.record_thread(0, "other".into()).is_err());
    assert!(state.prepare_input(0).is_err());
    assert!(state.mark_input_indeterminate(0).is_err());
    assert!(state.record_turn(0, "thread", "turn".into()).is_err());
    assert!(
        state
            .record_provider_terminal(0, "thread", "other")
            .is_err()
    );
    assert_eq!(
        state
            .record_provider_terminal(0, "thread", "turn")
            .unwrap()
            .phase(),
        Phase::ProviderTerminalObserved
    );
}

#[test]
fn revision_conflicts_and_exhaustion_leave_original_checkpoint_unchanged() {
    let state = Checkpoint::new(Start::FreshThread).unwrap();
    let before = serde_json::to_value(&state).unwrap();
    assert_eq!(
        state.prepare_thread_start(1).unwrap_err().code(),
        "stale_fence"
    );
    assert_eq!(serde_json::to_value(&state).unwrap(), before);
    let mut wire = before;
    wire["revision"] = u64::MAX.into();
    let state: Checkpoint = serde_json::from_value(wire).unwrap();
    assert!(state.prepare_thread_start(u64::MAX).is_err());
    assert_eq!(state.phase(), Phase::NoThreadRequest);
}

#[test]
fn malformed_checkpoint_and_unknown_wire_fields_fail_closed() {
    let state = Checkpoint::new(Start::ExistingThread {
        thread_id: "thread".into(),
    })
    .unwrap();
    let wire = serde_json::to_value(state).unwrap();
    for (field, value) in [
        ("threadId", serde_json::Value::Null),
        ("threadId", " \n\t".into()),
        (
            "threadId",
            "x".repeat(MAX_NATIVE_CHAT_PROVIDER_ID_BYTES + 1).into(),
        ),
        ("turnId", "unexpected-turn".into()),
        ("observationOnly", true.into()),
    ] {
        let mut invalid = wire.clone();
        invalid[field] = value;
        let parsed: Checkpoint = serde_json::from_value(invalid).unwrap();
        assert!(parsed.validate().is_err(), "{field}");
    }
    let mut invalid = wire;
    invalid["permit"] = "must-not-be-on-wire".into();
    assert!(serde_json::from_value::<Checkpoint>(invalid).is_err());
}

#[test]
fn phase_graph_allows_only_forward_edges_and_execution_authority_terminal_edges() {
    use Phase::*;
    let phases = [
        NoThreadRequest,
        ThreadStartIndeterminate,
        ThreadKnown,
        InputPreSubmission,
        InputIndeterminate,
        TurnKnown,
        ProviderTerminalObserved,
        ExecutionTerminalCommitted,
    ];
    for (i, from) in phases.iter().enumerate() {
        assert_eq!(serde_json::to_value(from).unwrap(), from.as_str());
        for (j, to) in phases.iter().enumerate() {
            let expected = i < 7 && (j == i + 1 || j == 7);
            assert_eq!(from.permits_transition(*to), expected, "{from:?} -> {to:?}");
        }
    }
}

fn pi_selector(leaf_id: Option<&str>) -> PiSessionSelector {
    PiSessionSelector {
        session_id: "71a7e431-289c-4cd8-987e-2bf46c517c30".into(),
        session_file: "/managed/pi/sessions/chat.jsonl".into(),
        leaf_id: leaf_id.map(str::to_owned),
    }
}

#[test]
fn pi_checkpoint_tracks_exact_session_tree_without_codex_identity() {
    let fresh = Checkpoint::new_pi_fresh_session().unwrap();
    assert_eq!(fresh.provider(), NativeChatProvider::PiLocal);
    assert!(fresh.pi_session().is_none());
    assert!(fresh.prepare_input(0).is_err());

    let starting = restored(&fresh.prepare_thread_start(0).unwrap());
    assert!(starting.record_pi_session(0, pi_selector(Some("a1b2c3d4"))).is_err());
    let known = restored(
        &starting
            .record_pi_session(1, pi_selector(Some("a1b2c3d4")))
            .unwrap(),
    );
    assert_eq!(known.phase(), Phase::ThreadKnown);
    assert_eq!(known.thread_id(), None);
    assert_eq!(known.turn_id(), None);
    assert_eq!(known.pi_session().unwrap().session_id, pi_selector(None).session_id);
    assert_eq!(known.pi_session().unwrap().leaf_id.as_deref(), Some("a1b2c3d4"));

    let pending = known
        .prepare_input(2)
        .unwrap()
        .mark_input_indeterminate(3)
        .unwrap();
    assert!(pending.prepare_input(4).is_err());
    let turn = restored(
        &pending
            .record_pi_turn_entry(4, "71a7e431-289c-4cd8-987e-2bf46c517c30", "a1b2c3d5".into())
            .unwrap(),
    );
    assert_eq!(turn.phase(), Phase::TurnKnown);
    assert_eq!(turn.thread_id(), None);
    assert_eq!(turn.turn_id(), None);
    assert_eq!(turn.pi_turn_entry_id(), Some("a1b2c3d5"));
    assert!(turn
        .record_pi_turn_entry(5, "another-session", "a1b2c3d6".into())
        .is_err());

    let terminal = restored(
        &turn
            .record_pi_provider_terminal(
                5,
                "71a7e431-289c-4cd8-987e-2bf46c517c30",
                "a1b2c3d5",
                "a1b2c3d6".into(),
            )
            .unwrap(),
    );
    assert_eq!(terminal.phase(), Phase::ProviderTerminalObserved);
    assert_eq!(terminal.pi_session().unwrap().leaf_id.as_deref(), Some("a1b2c3d6"));
    assert_eq!(terminal.pi_turn_entry_id(), Some("a1b2c3d5"));
}

#[test]
fn pi_resume_starts_from_exact_persisted_leaf_and_malformed_selectors_fail_closed() {
    let resumed = Checkpoint::new_pi_existing_session(pi_selector(Some("cafef00d"))).unwrap();
    assert_eq!(resumed.phase(), Phase::ThreadKnown);
    assert_eq!(resumed.revision(), 0);
    assert!(resumed.prepare_thread_start(0).is_err());
    assert_eq!(restored(&resumed).pi_session().unwrap().leaf_id.as_deref(), Some("cafef00d"));
    assert!(Checkpoint::new_pi_existing_session(pi_selector(None)).is_err());

    for bad_leaf in ["", "not-hex!", "1234567", "123456789"] {
        assert!(PiSessionSelector {
            leaf_id: Some(bad_leaf.into()),
            ..pi_selector(None)
        }
        .validate()
        .is_err());
    }

    let mut wrong_provider = serde_json::to_value(&resumed).unwrap();
    wrong_provider["provider"] = serde_json::to_value(NativeChatProvider::CodexLocal).unwrap();
    assert!(serde_json::from_value::<Checkpoint>(wrong_provider)
        .unwrap()
        .validate()
        .is_err());
    let mut wrong_phase = serde_json::to_value(&resumed).unwrap();
    wrong_phase["phase"] = serde_json::to_value(Phase::TurnKnown).unwrap();
    assert!(serde_json::from_value::<Checkpoint>(wrong_phase)
        .unwrap()
        .validate()
        .is_err());
}
