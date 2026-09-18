use rudder_project_goal_link_core::{
    LinkMutationError, Operation, ProjectGoalLinkCommand, SHA256_HEX_LENGTH,
};

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
