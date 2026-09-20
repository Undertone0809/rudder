use rudder_organization_mutation_core::{Actor, OrganizationBrandingPatch};

fn patch(raw: serde_json::Value) -> OrganizationBrandingPatch {
    serde_json::from_value(raw).unwrap()
}

fn assert_nullable_patch_round_trip(
    field: &str,
    value: &str,
    absent: serde_json::Value,
    cleared: serde_json::Value,
    valued: serde_json::Value,
) {
    let absent = patch(absent);
    let cleared = patch(cleared);
    let valued = patch(valued);
    let absent_fingerprint = absent
        .clone()
        .into_command(
            "org-a",
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "user-a".to_owned(),
            },
            "absent",
            3,
            7,
        )
        .unwrap()
        .fingerprint()
        .unwrap();
    let cleared_fingerprint = cleared
        .clone()
        .into_command(
            "org-a",
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "user-a".to_owned(),
            },
            "cleared",
            3,
            7,
        )
        .unwrap()
        .fingerprint()
        .unwrap();
    let valued_fingerprint = valued
        .clone()
        .into_command(
            "org-a",
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "user-a".to_owned(),
            },
            "valued",
            3,
            7,
        )
        .unwrap()
        .fingerprint()
        .unwrap();
    assert_ne!(absent_fingerprint, cleared_fingerprint);
    assert_ne!(cleared_fingerprint, valued_fingerprint);
    assert_ne!(absent_fingerprint, valued_fingerprint);

    for (label, patch) in [("absent", absent), ("cleared", cleared), ("valued", valued)] {
        let encoded = serde_json::to_value(&patch).unwrap();
        let field_value = encoded.get(field);
        match label {
            "absent" => assert!(field_value.is_none()),
            "cleared" => assert!(field_value.is_some_and(serde_json::Value::is_null)),
            "valued" => assert_eq!(field_value.and_then(serde_json::Value::as_str), Some(value)),
            _ => unreachable!(),
        }

        let decoded: OrganizationBrandingPatch = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded, patch);
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

    let command = patch(serde_json::json!({"name": "Rudder"}))
        .into_command("org-a", actor, "branding-1", 3, 7)
        .unwrap();
    assert!(command.validate().is_ok());
    assert_eq!(command.fingerprint().unwrap().len(), 64);
}

#[test]
fn trusted_integration_view_exposes_bound_values_without_a_second_json_path() {
    let command = patch(serde_json::json!({
        "name": "Rudder",
        "description": null,
        "brandColor": "#123456"
    }))
    .into_command(
        "org-a",
        Actor::CeoAgent {
            organization_id: "org-a".to_owned(),
            principal_id: "agent-a".to_owned(),
        },
        "branding-1",
        3,
        7,
    )
    .unwrap();

    let view = command.as_integration_view().unwrap();
    assert_eq!(view.organization_id(), "org-a");
    assert_eq!(view.actor().kind(), "ceo_agent");
    assert_eq!(view.actor().principal_id(), "agent-a");
    assert_eq!(view.idempotency_key(), "branding-1");
    assert_eq!(view.expected_version(), 3);
    assert_eq!(view.fence_epoch(), 7);
    assert_eq!(view.name(), Some("Rudder"));
    assert_eq!(view.description(), Some(None));
    assert_eq!(view.brand_color(), Some(Some("#123456")));
    assert_eq!(view.fingerprint().unwrap(), command.fingerprint().unwrap());
}

#[test]
fn integration_view_revalidates_commands_before_adapter_consumption() {
    let mut command = patch(serde_json::json!({"name": "Rudder"}))
        .into_command(
            "org-a",
            Actor::Board {
                organization_id: "org-a".to_owned(),
                principal_id: "board-a".to_owned(),
            },
            "branding-1",
            3,
            7,
        )
        .unwrap();
    command.organization_id = "org-b".to_owned();

    assert_eq!(
        command.as_integration_view(),
        Err(rudder_organization_mutation_core::MutationError::CrossOrganization)
    );
}

#[test]
fn nullable_patch_fields_preserve_absent_null_and_value_public_api_round_trips() {
    assert_nullable_patch_round_trip(
        "description",
        "A description",
        serde_json::json!({"name": "Rudder"}),
        serde_json::json!({"name": "Rudder", "description": null}),
        serde_json::json!({"name": "Rudder", "description": "A description"}),
    );
    assert_nullable_patch_round_trip(
        "brandColor",
        "#12aBcD",
        serde_json::json!({"name": "Rudder"}),
        serde_json::json!({"name": "Rudder", "brandColor": null}),
        serde_json::json!({"name": "Rudder", "brandColor": "#12aBcD"}),
    );
    assert_nullable_patch_round_trip(
        "logoAssetId",
        "123e4567-e89b-12d3-a456-426614174000",
        serde_json::json!({"name": "Rudder"}),
        serde_json::json!({"name": "Rudder", "logoAssetId": null}),
        serde_json::json!({"name": "Rudder", "logoAssetId": "123e4567-e89b-12d3-a456-426614174000"}),
    );
}

#[test]
fn request_body_cannot_supply_the_actor_or_use_snake_case_fields() {
    for raw in [
        serde_json::json!({"name": null}),
        serde_json::json!({"name": "Rudder", "actor": {"board": {}}}),
        serde_json::json!({"name": "Rudder", "brand_color": "#123456"}),
    ] {
        assert!(serde_json::from_value::<OrganizationBrandingPatch>(raw).is_err());
    }
}

#[test]
fn patch_binding_rejects_a_target_organization_different_from_the_actor() {
    let result = patch(serde_json::json!({"name": "Rudder"})).into_command(
        "org-b",
        Actor::Board {
            organization_id: "org-a".to_owned(),
            principal_id: "user-a".to_owned(),
        },
        "branding-1",
        3,
        7,
    );
    assert_eq!(
        result,
        Err(rudder_organization_mutation_core::MutationError::CrossOrganization)
    );
}
