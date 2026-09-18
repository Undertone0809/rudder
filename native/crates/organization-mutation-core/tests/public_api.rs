use rudder_organization_mutation_core::{Actor, OrganizationBrandingCommand};

#[test]
fn downstream_adapter_can_consume_public_contract_helpers() {
    let actor = Actor::CeoAgent {
        organization_id: "org-a".to_owned(),
        principal_id: "agent-a".to_owned(),
    };
    assert_eq!(actor.organization_id(), "org-a");
    assert_eq!(actor.principal_id(), "agent-a");
    assert_eq!(actor.kind(), "ceo_agent");

    let command = OrganizationBrandingCommand::ceo_agent("org-a", "agent-a", "branding-1", 3, 7)
        .with_name(Some("Rudder".to_owned()));
    assert!(command.validate().is_ok());
    assert_eq!(command.fingerprint().unwrap().len(), 64);
}
