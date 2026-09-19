use rudder_project_goal_link_core::{
    LinkMutationError, Operation, ProjectGoalLinkCommand, ProjectGoalLinkState, SHA256_HEX_LENGTH,
};
use serde_json::json;

#[test]
fn downstream_adapter_can_bind_validated_public_fingerprint() {
    let command = ProjectGoalLinkCommand::board(
        "org-a",
        "board-a",
        "project-a",
        "goal-a",
        Operation::Attach,
        2,
        4,
        "link-1",
    );

    let fingerprint = command.fingerprint().unwrap();
    assert_eq!(fingerprint.len(), SHA256_HEX_LENGTH);
    assert!(
        fingerprint
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    );
}

#[test]
fn public_fingerprint_rejects_cross_organization_actor() {
    let command = ProjectGoalLinkCommand::board(
        "org-a",
        "board-a",
        "project-a",
        "goal-a",
        Operation::Attach,
        2,
        4,
        "link-1",
    );
    let mut tampered = command;
    tampered.actor = rudder_project_goal_link_core::Actor::Board {
        organization_id: "org-b".to_owned(),
        principal_id: "board-a".to_owned(),
    };

    assert_eq!(
        tampered.fingerprint(),
        Err(LinkMutationError::CrossOrganization)
    );
}

#[test]
fn public_fingerprint_rejects_unauthorized_agent_actor() {
    let command = ProjectGoalLinkCommand::agent(
        "org-a",
        "agent-a",
        "project-a",
        "goal-a",
        Operation::Attach,
        2,
        4,
        "agent-key",
    );

    assert_eq!(command.fingerprint(), Err(LinkMutationError::Unauthorized));
}

#[test]
fn external_consumer_can_detect_idempotency_key_fingerprint_binding() {
    let first = ProjectGoalLinkCommand::board(
        "org-a",
        "board-a",
        "project-a",
        "goal-a",
        Operation::Attach,
        2,
        4,
        "key-a",
    );
    let second = ProjectGoalLinkCommand::board(
        "org-a",
        "board-a",
        "project-a",
        "goal-a",
        Operation::Attach,
        2,
        4,
        "key-b",
    );

    assert_ne!(first.fingerprint(), second.fingerprint());
}

#[test]
fn external_consumer_rejects_serialized_terminal_state_tampering() {
    let mut state = ProjectGoalLinkState::new(
        "org-a",
        "org-a",
        "org-a",
        "project-a",
        "goal-a",
        2,
        4,
        false,
    );
    let cancel = ProjectGoalLinkCommand::board(
        "org-a",
        "board-a",
        "project-a",
        "goal-a",
        Operation::Cancel,
        2,
        4,
        "cancel-key",
    );
    state.apply(cancel).unwrap();

    let mut encoded = serde_json::to_value(&state).unwrap();
    encoded["cancelled"] = json!(false);
    let mut restored: ProjectGoalLinkState = serde_json::from_value(encoded).unwrap();
    let reopen = ProjectGoalLinkCommand::board(
        "org-a",
        "board-a",
        "project-a",
        "goal-a",
        Operation::Attach,
        3,
        5,
        "reopen-key",
    );

    assert_eq!(
        restored.apply(reopen),
        Err(LinkMutationError::InvalidReceipt)
    );
}
