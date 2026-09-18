use rudder_organization_mutation_core::{Actor, OrganizationBrandingCommand};

fn board_command() -> OrganizationBrandingCommand {
    OrganizationBrandingCommand::board("org-a", "user-a", "branding-1", 3, 7)
        .with_name(Some("Rudder".to_owned()))
}

fn assert_nullable_patch_round_trip(
    field: &str,
    value: &str,
    absent: OrganizationBrandingCommand,
    cleared: OrganizationBrandingCommand,
    valued: OrganizationBrandingCommand,
) {
    let absent_fingerprint = absent.fingerprint().unwrap();
    let cleared_fingerprint = cleared.fingerprint().unwrap();
    let valued_fingerprint = valued.fingerprint().unwrap();
    assert_ne!(absent_fingerprint, cleared_fingerprint);
    assert_ne!(cleared_fingerprint, valued_fingerprint);
    assert_ne!(absent_fingerprint, valued_fingerprint);

    for (label, command) in [("absent", absent), ("cleared", cleared), ("valued", valued)] {
        let encoded = serde_json::to_value(&command).unwrap();
        let field_value = encoded.get(field);
        match label {
            "absent" => assert!(field_value.is_none()),
            "cleared" => assert!(field_value.is_some_and(serde_json::Value::is_null)),
            "valued" => assert_eq!(field_value.and_then(serde_json::Value::as_str), Some(value)),
            _ => unreachable!(),
        }

        let decoded: OrganizationBrandingCommand = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded, command);
        assert_eq!(
            decoded.fingerprint().unwrap(),
            command.fingerprint().unwrap()
        );
    }
}

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

#[test]
fn nullable_patch_fields_preserve_absent_null_and_value_public_api_round_trips() {
    assert_nullable_patch_round_trip(
        "description",
        "A description",
        board_command(),
        board_command().with_description(None),
        board_command().with_description(Some("A description".to_owned())),
    );
    assert_nullable_patch_round_trip(
        "brand_color",
        "#12aBcD",
        board_command(),
        board_command().with_brand_color(None),
        board_command().with_brand_color(Some("#12aBcD".to_owned())),
    );
    assert_nullable_patch_round_trip(
        "logo_asset_id",
        "123e4567-e89b-12d3-a456-426614174000",
        board_command(),
        board_command().with_logo_asset_id(None),
        board_command().with_logo_asset_id(Some("123e4567-e89b-12d3-a456-426614174000".to_owned())),
    );
}
