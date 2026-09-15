use rudder_organization_mutation_core::{
    MutationError, MutationOutcome, OrganizationBrandingCommand, OrganizationSettingsState,
};
use serde_json::json;

fn command(key: &str, version: u64) -> OrganizationBrandingCommand {
    OrganizationBrandingCommand::board("org-a", "board-a", key, version, 7)
        .with_name(Some("Updated".to_owned()))
}

fn state() -> OrganizationSettingsState {
    let mut state = OrganizationSettingsState::new("org-a", 3, 7, "Original");
    state.description = Some("Keep description".to_owned());
    state.brand_color = Some("#123456".to_owned());
    state.logo_asset_id = Some("00000000-0000-4000-8000-000000000001".to_owned());
    state
}

#[test]
fn every_nullable_patch_round_trips_omission_clear_and_value_distinctly() {
    for field in ["description", "brand_color", "logo_asset_id"] {
        let omitted = serde_json::to_value(command("roundtrip", 3)).unwrap();
        assert!(omitted.get(field).is_none(), "{field} must be absent");
        let mut cleared = omitted.clone();
        cleared[field] = json!(null);
        let parsed: OrganizationBrandingCommand = serde_json::from_value(cleared.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), cleared);
        let mut target = state();
        let outcome = target.apply(parsed).unwrap();
        let encoded_state = serde_json::to_value(outcome.state()).unwrap();
        assert_eq!(encoded_state[field], json!(null), "{field} was not cleared");
        let mut provided = omitted.clone();
        provided[field] = json!(match field {
            "brand_color" => "#abcdef",
            "logo_asset_id" => "00000000-0000-4000-8000-000000000002",
            _ => "New description",
        });
        let parsed: OrganizationBrandingCommand = serde_json::from_value(provided.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), provided);
    }
}

#[test]
fn clearing_a_field_cannot_replay_an_omitted_field_fingerprint() {
    for field in ["description", "brand_color", "logo_asset_id"] {
        let first = command("same-key", 3);
        let mut clear = first.clone();
        match field {
            "description" => clear.description = Some(None),
            "brand_color" => clear.brand_color = Some(None),
            _ => clear.logo_asset_id = Some(None),
        }
        let mut target = state();
        target.apply(first).unwrap();
        let before = target.clone();
        assert_eq!(target.apply(clear), Err(MutationError::IdempotencyConflict));
        assert_eq!(target, before);
    }
}

#[test]
fn overflow_rejects_without_changing_any_business_field_or_receipt() {
    let mut target = state();
    target.version = u64::MAX;
    let before = target.clone();
    let change = command("overflow", u64::MAX)
        .with_description(None)
        .with_brand_color(None)
        .with_logo_asset_id(None);
    assert_eq!(target.apply(change), Err(MutationError::VersionOverflow));
    assert_eq!(target, before);
}

#[test]
fn replay_returns_the_original_snapshot_after_later_mutations_and_a_fence_change() {
    let mut target = state();
    let first = target.apply(command("first", 3)).unwrap();
    target
        .apply(command("second", 4).with_name(Some("Later".to_owned())))
        .unwrap();
    target.fence_epoch = 8;
    let before = target.clone();
    let replay = target.apply(command("first", 3)).unwrap();
    assert!(matches!(replay, MutationOutcome::AlreadyApplied { .. }));
    assert_eq!(replay.version(), first.version());
    assert_eq!(replay.state(), first.state());
    assert_eq!(target, before);
}

#[test]
fn serialized_state_restores_original_receipts_without_recursive_history() {
    let mut target = state();
    let first = target.apply(command("first", 3)).unwrap();
    target.apply(command("second", 4)).unwrap();
    let encoded = serde_json::to_string(&target).unwrap();
    let mut restored: OrganizationSettingsState = serde_json::from_str(&encoded).unwrap();
    assert_eq!(
        restored.apply(command("first", 3)).unwrap().state(),
        first.state()
    );
    // Receipt snapshots must not recursively embed the growing receipt ledger.
    assert_eq!(encoded.matches("applied_idempotency").count(), 1);
}

#[test]
fn non_nullable_name_and_unknown_branding_fields_fail_closed() {
    let mut payload = serde_json::to_value(command("invalid", 3)).unwrap();
    payload["name"] = json!(null);
    assert!(serde_json::from_value::<OrganizationBrandingCommand>(payload).is_err());
    let mut payload = serde_json::to_value(command("invalid", 3)).unwrap();
    payload["budgetMonthlyCents"] = json!(999);
    assert!(serde_json::from_value::<OrganizationBrandingCommand>(payload).is_err());
}

#[test]
fn empty_principal_never_creates_a_receipt() {
    let mut target = state();
    let before = target.clone();
    let change = OrganizationBrandingCommand::board("org-a", "", "empty-actor", 3, 7)
        .with_name(Some("No".to_owned()));
    assert_eq!(target.apply(change), Err(MutationError::Unauthorized));
    assert_eq!(target, before);
}
