use rudder_project_goal_link_core::{
    LinkMutationError, LinkMutationOutcome, Operation, ProjectGoalLinkCommand, ProjectGoalLinkState,
};

fn command(key: &str, version: u64, operation: Operation) -> ProjectGoalLinkCommand {
    ProjectGoalLinkCommand::board(
        "org-a",
        "board-a",
        "project-a",
        "goal-a",
        operation,
        version,
        7,
        key,
    )
}

#[test]
fn overflow_rejects_without_changing_the_link_or_receipts() {
    for linked in [false, true] {
        let mut state = ProjectGoalLinkState::new("org-a", "org-a", "org-a", u64::MAX, 7, linked);
        let before = state.clone();
        let operation = if linked {
            Operation::Detach
        } else {
            Operation::Attach
        };
        assert_eq!(
            state.apply(command("overflow", u64::MAX, operation)),
            Err(LinkMutationError::VersionOverflow)
        );
        assert_eq!(state, before);
    }
}

#[test]
fn replay_uses_the_original_link_receipt_after_an_opposite_mutation() {
    let mut state = ProjectGoalLinkState::new("org-a", "org-a", "org-a", 3, 7, false);
    state.apply(command("first", 3, Operation::Attach)).unwrap();
    state
        .apply(command("second", 4, Operation::Detach))
        .unwrap();
    state.fence_epoch = 8;
    let before = state.clone();
    assert!(matches!(
        state.apply(command("first", 3, Operation::Attach)).unwrap(),
        LinkMutationOutcome::AlreadyApplied {
            version: 4,
            linked: true,
            ..
        }
    ));
    assert_eq!(state, before);
}

#[test]
fn replay_preserves_an_original_noop_instead_of_a_later_link_state() {
    let mut state = ProjectGoalLinkState::new("org-a", "org-a", "org-a", 3, 7, false);
    state.apply(command("noop", 3, Operation::Detach)).unwrap();
    state
        .apply(command("attach", 3, Operation::Attach))
        .unwrap();
    assert!(matches!(
        state.apply(command("noop", 3, Operation::Detach)).unwrap(),
        LinkMutationOutcome::AlreadyApplied {
            version: 3,
            linked: false,
            ..
        }
    ));
}

#[test]
fn serialized_link_state_restores_the_original_replay_result() {
    let mut state = ProjectGoalLinkState::new("org-a", "org-a", "org-a", 3, 7, false);
    state
        .apply(command("attach", 3, Operation::Attach))
        .unwrap();
    state
        .apply(command("detach", 4, Operation::Detach))
        .unwrap();
    let mut restored: ProjectGoalLinkState =
        serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
    assert!(matches!(
        restored
            .apply(command("attach", 3, Operation::Attach))
            .unwrap(),
        LinkMutationOutcome::AlreadyApplied {
            version: 4,
            linked: true,
            ..
        }
    ));
}

#[test]
fn a_noop_at_the_version_limit_does_not_overflow() {
    let mut state = ProjectGoalLinkState::new("org-a", "org-a", "org-a", u64::MAX, 7, true);
    assert!(matches!(
        state
            .apply(command("noop", u64::MAX, Operation::Attach))
            .unwrap(),
        LinkMutationOutcome::Noop {
            version: u64::MAX,
            ..
        }
    ));
}
