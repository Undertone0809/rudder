use rudder_project_goal_link_core::{
    Actor, ActorAuthority, ActorBinding, LinkMutationError, LinkMutationOutcome, Operation,
    ProjectGoalLinkCommand, ProjectGoalLinkState, SHA256_HEX_LENGTH, TargetVerifier,
};
use serde_json::json;

struct ExistingTarget;

impl TargetVerifier for ExistingTarget {
    fn target_exists_in_organization(
        &self,
        organization_id: &str,
        project_org_id: &str,
        goal_org_id: &str,
        project_id: &str,
        goal_id: &str,
    ) -> bool {
        organization_id == "org-a"
            && project_org_id == "org-a"
            && goal_org_id == "org-a"
            && project_id == "project-a"
            && goal_id == "goal-a"
    }
}

fn state() -> ProjectGoalLinkState {
    ProjectGoalLinkState::new(
        "org-a",
        "org-a",
        "org-a",
        "project-a",
        "goal-a",
        2,
        4,
        false,
    )
}

fn authority() -> ActorAuthority {
    ActorAuthority::new("external-consumer-authority").unwrap()
}

fn board_binding(authority: &ActorAuthority) -> ActorBinding {
    authority
        .issue(Actor::Board {
            organization_id: "org-a".to_owned(),
            principal_id: "board-a".to_owned(),
        })
        .unwrap()
}

fn board_command(
    state: &ProjectGoalLinkState,
    authority: &ActorAuthority,
    operation: Operation,
    expected_version: u64,
    fence_epoch: u64,
    idempotency_key: &str,
) -> ProjectGoalLinkCommand {
    let context = state
        .validated_context(&board_binding(authority), authority, &ExistingTarget)
        .unwrap();
    ProjectGoalLinkCommand::from_validated_context(
        context,
        operation,
        expected_version,
        fence_epoch,
        idempotency_key,
    )
}

#[test]
fn downstream_adapter_can_bind_validated_public_fingerprint() {
    let authority = authority();
    let command = board_command(&state(), &authority, Operation::Attach, 2, 4, "link-1");

    let fingerprint = command.fingerprint().unwrap();
    assert_eq!(fingerprint.len(), SHA256_HEX_LENGTH);
    assert!(
        fingerprint
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    );
}

#[test]
fn public_actor_variant_and_serde_payload_cannot_forge_authorization() {
    let authority = authority();
    let forged = ActorBinding {
        actor: Actor::CeoAgent {
            organization_id: "org-a".to_owned(),
            principal_id: "ceo-a".to_owned(),
        },
        proof: "0".repeat(SHA256_HEX_LENGTH),
    };
    let round_tripped: ActorBinding =
        serde_json::from_value(serde_json::to_value(&forged).unwrap()).unwrap();

    assert_eq!(
        state().validated_context(&round_tripped, &authority, &ExistingTarget),
        Err(LinkMutationError::InvalidActorBinding)
    );
}

#[test]
fn verified_ceo_agent_binding_can_create_a_mutation_command() {
    let authority = authority();
    let binding = authority
        .issue(Actor::CeoAgent {
            organization_id: "org-a".to_owned(),
            principal_id: "ceo-a".to_owned(),
        })
        .unwrap();
    let context = state()
        .validated_context(&binding, &authority, &ExistingTarget)
        .unwrap();
    let mut state = state();
    let command = ProjectGoalLinkCommand::from_validated_context(
        context,
        Operation::Attach,
        2,
        4,
        "ceo-attach",
    );

    assert!(matches!(
        state.apply(command),
        Ok(LinkMutationOutcome::Applied {
            version: 3,
            linked: true,
            cancelled: false,
            ..
        })
    ));
}

#[test]
fn cross_organization_and_nonexistent_targets_are_rejected_before_commands() {
    let authority = authority();
    let cross_org_state = ProjectGoalLinkState::new(
        "org-a",
        "org-b",
        "org-a",
        "project-a",
        "goal-a",
        2,
        4,
        false,
    );
    assert_eq!(
        cross_org_state.validated_context(&board_binding(&authority), &authority, &ExistingTarget,),
        Err(LinkMutationError::CrossOrganization)
    );

    let missing_target = ProjectGoalLinkState::new(
        "org-a",
        "org-a",
        "org-a",
        "project-missing",
        "goal-a",
        2,
        4,
        false,
    );
    assert_eq!(
        missing_target.validated_context(&board_binding(&authority), &authority, &ExistingTarget,),
        Err(LinkMutationError::TargetNotFound)
    );
}

#[test]
fn fingerprint_is_bound_to_verified_target_state_and_context() {
    let authority = authority();
    let initial = state();
    let changed_target_state =
        ProjectGoalLinkState::new("org-a", "org-a", "org-a", "project-a", "goal-a", 2, 4, true);
    let first = board_command(&initial, &authority, Operation::Attach, 2, 4, "same-key");
    let second = board_command(
        &changed_target_state,
        &authority,
        Operation::Attach,
        2,
        4,
        "same-key",
    );
    assert_ne!(first.fingerprint(), second.fingerprint());

    let original_context = initial
        .validated_context(&board_binding(&authority), &authority, &ExistingTarget)
        .unwrap();
    let mut state_after_mutation = initial;
    state_after_mutation.apply(first).unwrap();
    let stale_state_command = ProjectGoalLinkCommand::from_validated_context(
        original_context,
        Operation::Detach,
        3,
        4,
        "new-key-2",
    );
    assert_eq!(
        state_after_mutation.apply(stale_state_command),
        Err(LinkMutationError::TargetStateMismatch)
    );
}

#[test]
fn valid_json_round_trip_preserves_replay_and_cancel_receipts() {
    let authority = authority();
    let mut state = state();
    let attach = board_command(&state, &authority, Operation::Attach, 2, 4, "attach-key");
    state.apply(attach.clone()).unwrap();

    let encoded = serde_json::to_string(&state).unwrap();
    let mut restored: ProjectGoalLinkState = serde_json::from_str(&encoded).unwrap();
    assert!(matches!(
        restored.apply(attach),
        Ok(LinkMutationOutcome::AlreadyApplied {
            version: 3,
            fence_epoch: 4,
            linked: true,
            cancelled: false,
            ..
        })
    ));

    let cancel = board_command(&restored, &authority, Operation::Cancel, 3, 4, "cancel-key");
    restored.apply(cancel.clone()).unwrap();
    let cancel_json = serde_json::to_string(&restored).unwrap();
    let mut restored_again: ProjectGoalLinkState = serde_json::from_str(&cancel_json).unwrap();
    assert!(matches!(
        restored_again.apply(cancel),
        Ok(LinkMutationOutcome::AlreadyApplied {
            version: 4,
            fence_epoch: 5,
            linked: true,
            cancelled: true,
            ..
        })
    ));
}

#[test]
fn target_integrity_tampering_invalidates_replay_receipt() {
    let authority = authority();
    let mut state = state();
    let attach = board_command(&state, &authority, Operation::Attach, 2, 4, "target-key");
    state.apply(attach.clone()).unwrap();

    let mut encoded = serde_json::to_value(&state).unwrap();
    encoded["appliedIdempotency"]["target-key"]["targetIntegrity"] =
        json!("0".repeat(SHA256_HEX_LENGTH));
    let mut restored: ProjectGoalLinkState = serde_json::from_value(encoded).unwrap();
    assert_eq!(
        restored.apply(attach),
        Err(LinkMutationError::InvalidReceipt)
    );
}

#[test]
fn public_error_priority_keeps_fence_before_version_and_state_integrity_first() {
    let authority = authority();
    let mut state = state();
    let both_stale = board_command(&state, &authority, Operation::Attach, 1, 3, "priority");
    assert_eq!(state.apply(both_stale), Err(LinkMutationError::StaleFence));

    let cancel = board_command(&state, &authority, Operation::Cancel, 2, 4, "cancel");
    state.apply(cancel).unwrap();
    let mut encoded = serde_json::to_value(&state).unwrap();
    encoded["cancelled"] = json!(false);
    let mut tampered: ProjectGoalLinkState = serde_json::from_value(encoded).unwrap();
    let stale = board_command(&state, &authority, Operation::Attach, 4, 6, "stale");
    assert_eq!(
        tampered.apply(stale),
        Err(LinkMutationError::InvalidReceipt)
    );
}
