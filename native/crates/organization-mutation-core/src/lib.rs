//! Bounded organization branding/settings mutation contract core.
//!
//! This crate owns only deterministic validation and fenced state transitions.
//! A later SQLx adapter must bind the returned command fingerprint, organization
//! scope, version, and fence epoch in one transaction, then persist the activity
//! receipt. This crate intentionally performs no I/O, SQL, HTTP, filesystem, or
//! secret handling and is not a public writer by itself.

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    Board {
        organization_id: String,
        principal_id: String,
    },
    CeoAgent {
        organization_id: String,
        principal_id: String,
    },
    Agent {
        organization_id: String,
        principal_id: String,
    },
}

impl Actor {
    pub fn organization_id(&self) -> &str {
        match self {
            Self::Board {
                organization_id, ..
            }
            | Self::CeoAgent {
                organization_id, ..
            }
            | Self::Agent {
                organization_id, ..
            } => organization_id,
        }
    }

    pub fn principal_id(&self) -> &str {
        match self {
            Self::Board { principal_id, .. }
            | Self::CeoAgent { principal_id, .. }
            | Self::Agent { principal_id, .. } => principal_id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Board { .. } => "board",
            Self::CeoAgent { .. } => "ceo_agent",
            Self::Agent { .. } => "agent",
        }
    }

    fn can_update_branding(&self) -> bool {
        matches!(self, Self::Board { .. } | Self::CeoAgent { .. })
    }
}

fn deserialize_nullable_patch<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

fn deserialize_non_nullable_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

#[derive(Serialize)]
struct NullablePatchFingerprint<'a> {
    present: bool,
    value: Option<&'a str>,
}

impl<'a> From<&'a Option<Option<String>>> for NullablePatchFingerprint<'a> {
    fn from(value: &'a Option<Option<String>>) -> Self {
        match value {
            None => Self {
                present: false,
                value: None,
            },
            Some(value) => Self {
                present: true,
                value: value.as_deref(),
            },
        }
    }
}

/// The authenticated branding fields accepted by the Node organization route.
///
/// This is the only request-body-shaped type in this crate. It deliberately
/// contains no actor, organization, idempotency, version, or fence fields;
/// those values must be supplied by a trusted adapter through
/// [`OrganizationBrandingPatch::into_command`].
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OrganizationBrandingPatch {
    #[serde(
        default,
        deserialize_with = "deserialize_non_nullable_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_nullable_patch",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_nullable_patch",
        skip_serializing_if = "Option::is_none"
    )]
    pub brand_color: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "deserialize_nullable_patch",
        skip_serializing_if = "Option::is_none"
    )]
    pub logo_asset_id: Option<Option<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OrganizationBrandingPatchWire {
    #[serde(default, deserialize_with = "deserialize_non_nullable_string")]
    name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    brand_color: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable_patch")]
    logo_asset_id: Option<Option<String>>,
}

impl<'de> Deserialize<'de> for OrganizationBrandingPatch {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = OrganizationBrandingPatchWire::deserialize(deserializer)?;
        let patch = Self {
            name: wire.name,
            description: wire.description,
            brand_color: wire.brand_color,
            logo_asset_id: wire.logo_asset_id,
        };
        patch
            .validate()
            .map_err(|error| D::Error::custom(error.to_string()))?;
        Ok(patch)
    }
}

impl OrganizationBrandingPatch {
    pub fn validate(&self) -> Result<(), MutationError> {
        validate_patch_fields(
            &self.name,
            &self.description,
            &self.brand_color,
            &self.logo_asset_id,
        )
    }

    /// Bind this untrusted body to authenticated request context.
    #[allow(clippy::too_many_arguments)]
    pub fn into_command(
        self,
        organization_id: impl Into<String>,
        actor: Actor,
        idempotency_key: impl Into<String>,
        expected_version: u64,
        fence_epoch: u64,
    ) -> Result<OrganizationBrandingCommand, MutationError> {
        let command = OrganizationBrandingCommand {
            organization_id: organization_id.into(),
            actor,
            idempotency_key: idempotency_key.into(),
            expected_version,
            fence_epoch,
            name: self.name,
            description: self.description,
            brand_color: self.brand_color,
            logo_asset_id: self.logo_asset_id,
        };
        command.validate()?;
        Ok(command)
    }
}

/// A trusted mutation command after an adapter has bound authentication and
/// concurrency context. HTTP/Node request bodies must not deserialize into
/// this type directly.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct OrganizationBrandingCommand {
    pub organization_id: String,
    pub actor: Actor,
    pub idempotency_key: String,
    pub expected_version: u64,
    pub fence_epoch: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brand_color: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo_asset_id: Option<Option<String>>,
}

impl OrganizationBrandingCommand {
    pub fn board(
        organization_id: impl Into<String>,
        principal_id: impl Into<String>,
        idempotency_key: impl Into<String>,
        expected_version: u64,
        fence_epoch: u64,
    ) -> Self {
        Self::with_actor(
            Actor::Board {
                organization_id: organization_id.into(),
                principal_id: principal_id.into(),
            },
            idempotency_key,
            expected_version,
            fence_epoch,
        )
    }

    pub fn ceo_agent(
        organization_id: impl Into<String>,
        principal_id: impl Into<String>,
        idempotency_key: impl Into<String>,
        expected_version: u64,
        fence_epoch: u64,
    ) -> Self {
        Self::with_actor(
            Actor::CeoAgent {
                organization_id: organization_id.into(),
                principal_id: principal_id.into(),
            },
            idempotency_key,
            expected_version,
            fence_epoch,
        )
    }

    pub fn agent(
        organization_id: impl Into<String>,
        principal_id: impl Into<String>,
        idempotency_key: impl Into<String>,
        expected_version: u64,
        fence_epoch: u64,
    ) -> Self {
        Self::with_actor(
            Actor::Agent {
                organization_id: organization_id.into(),
                principal_id: principal_id.into(),
            },
            idempotency_key,
            expected_version,
            fence_epoch,
        )
    }

    fn with_actor(
        actor: Actor,
        idempotency_key: impl Into<String>,
        expected_version: u64,
        fence_epoch: u64,
    ) -> Self {
        let organization_id = actor.organization_id().to_owned();
        Self {
            organization_id,
            actor,
            idempotency_key: idempotency_key.into(),
            expected_version,
            fence_epoch,
            name: None,
            description: None,
            brand_color: None,
            logo_asset_id: None,
        }
    }

    pub fn with_name(mut self, value: Option<String>) -> Self {
        self.name = value;
        self
    }

    pub fn with_description(mut self, value: Option<String>) -> Self {
        self.description = Some(value);
        self
    }

    pub fn with_brand_color(mut self, value: Option<String>) -> Self {
        self.brand_color = Some(value);
        self
    }

    pub fn with_logo_asset_id(mut self, value: Option<String>) -> Self {
        self.logo_asset_id = Some(value);
        self
    }

    pub fn validate(&self) -> Result<(), MutationError> {
        if self.organization_id.is_empty() || self.idempotency_key.is_empty() {
            return Err(MutationError::InvalidIdempotencyKey);
        }
        if self.actor.organization_id() != self.organization_id {
            return Err(MutationError::CrossOrganization);
        }
        if self.actor.principal_id().is_empty() || !self.actor.can_update_branding() {
            return Err(MutationError::Unauthorized);
        }
        validate_patch_fields(
            &self.name,
            &self.description,
            &self.brand_color,
            &self.logo_asset_id,
        )
    }

    pub fn fingerprint(&self) -> Result<String, MutationError> {
        #[derive(Serialize)]
        struct Fingerprint<'a> {
            organization_id: &'a str,
            actor_kind: &'static str,
            actor_id: &'a str,
            name: &'a Option<String>,
            description: NullablePatchFingerprint<'a>,
            brand_color: NullablePatchFingerprint<'a>,
            logo_asset_id: NullablePatchFingerprint<'a>,
            expected_version: u64,
            fence_epoch: u64,
        }
        let payload = Fingerprint {
            organization_id: &self.organization_id,
            actor_kind: self.actor.kind(),
            actor_id: self.actor.principal_id(),
            name: &self.name,
            description: NullablePatchFingerprint::from(&self.description),
            brand_color: NullablePatchFingerprint::from(&self.brand_color),
            logo_asset_id: NullablePatchFingerprint::from(&self.logo_asset_id),
            expected_version: self.expected_version,
            fence_epoch: self.fence_epoch,
        };
        let encoded = serde_json::to_vec(&payload).map_err(|_| MutationError::FingerprintFailed)?;
        let digest = Sha256::digest(encoded);
        Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
    }
}

fn validate_patch_fields(
    name: &Option<String>,
    description: &Option<Option<String>>,
    brand_color: &Option<Option<String>>,
    logo_asset_id: &Option<Option<String>>,
) -> Result<(), MutationError> {
    if name.is_none() && description.is_none() && brand_color.is_none() && logo_asset_id.is_none() {
        return Err(MutationError::NoFields);
    }
    if name.as_deref().is_some_and(str::is_empty) {
        return Err(MutationError::InvalidName);
    }
    if brand_color
        .as_ref()
        .and_then(Option::as_ref)
        .is_some_and(|value| !valid_brand_color(value))
    {
        return Err(MutationError::InvalidBrandColor);
    }
    if logo_asset_id
        .as_ref()
        .and_then(Option::as_ref)
        .is_some_and(|value| !valid_uuid_shape(value))
    {
        return Err(MutationError::InvalidLogoAssetId);
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OrganizationSettingsSnapshot {
    pub organization_id: String,
    pub version: u64,
    pub fence_epoch: u64,
    pub name: String,
    pub description: Option<String>,
    pub brand_color: Option<String>,
    pub logo_asset_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct AppliedReceipt {
    fingerprint: String,
    state: OrganizationSettingsSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OrganizationSettingsState {
    pub organization_id: String,
    pub version: u64,
    pub fence_epoch: u64,
    pub name: String,
    pub description: Option<String>,
    pub brand_color: Option<String>,
    pub logo_asset_id: Option<String>,
    applied_idempotency: BTreeMap<String, AppliedReceipt>,
}

impl OrganizationSettingsState {
    pub fn new(
        organization_id: impl Into<String>,
        version: u64,
        fence_epoch: u64,
        name: impl Into<String>,
    ) -> Self {
        Self {
            organization_id: organization_id.into(),
            version,
            fence_epoch,
            name: name.into(),
            description: None,
            brand_color: None,
            logo_asset_id: None,
            applied_idempotency: BTreeMap::new(),
        }
    }

    fn snapshot(&self) -> OrganizationSettingsSnapshot {
        OrganizationSettingsSnapshot {
            organization_id: self.organization_id.clone(),
            version: self.version,
            fence_epoch: self.fence_epoch,
            name: self.name.clone(),
            description: self.description.clone(),
            brand_color: self.brand_color.clone(),
            logo_asset_id: self.logo_asset_id.clone(),
        }
    }

    pub fn apply(
        &mut self,
        command: OrganizationBrandingCommand,
    ) -> Result<MutationOutcome, MutationError> {
        command.validate()?;
        if command.organization_id != self.organization_id {
            return Err(MutationError::CrossOrganization);
        }
        let fingerprint = command.fingerprint()?;
        if let Some(previous) = self.applied_idempotency.get(&command.idempotency_key) {
            if previous.fingerprint == fingerprint {
                return Ok(MutationOutcome::AlreadyApplied {
                    version: previous.state.version,
                    fingerprint,
                    state: previous.state.clone(),
                });
            }
            return Err(MutationError::IdempotencyConflict);
        }
        if command.expected_version != self.version {
            return Err(MutationError::StaleVersion);
        }
        if command.fence_epoch != self.fence_epoch {
            return Err(MutationError::StaleFence);
        }

        let next_version = self
            .version
            .checked_add(1)
            .ok_or(MutationError::VersionOverflow)?;

        if let Some(value) = command.name {
            self.name = value;
        }
        if let Some(value) = command.description {
            self.description = value;
        }
        if let Some(value) = command.brand_color {
            self.brand_color = value;
        }
        if let Some(value) = command.logo_asset_id {
            self.logo_asset_id = value;
        }
        self.version = next_version;
        let state = self.snapshot();
        self.applied_idempotency.insert(
            command.idempotency_key,
            AppliedReceipt {
                fingerprint: fingerprint.clone(),
                state: state.clone(),
            },
        );
        Ok(MutationOutcome::Applied {
            version: self.version,
            fingerprint,
            state,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MutationOutcome {
    Applied {
        version: u64,
        fingerprint: String,
        state: OrganizationSettingsSnapshot,
    },
    AlreadyApplied {
        version: u64,
        fingerprint: String,
        state: OrganizationSettingsSnapshot,
    },
}

impl MutationOutcome {
    pub fn version(&self) -> u64 {
        match self {
            Self::Applied { version, .. } | Self::AlreadyApplied { version, .. } => *version,
        }
    }

    pub fn state(&self) -> &OrganizationSettingsSnapshot {
        match self {
            Self::Applied { state, .. } | Self::AlreadyApplied { state, .. } => state,
        }
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum MutationError {
    #[error("organization scope does not match the mutation actor")]
    CrossOrganization,
    #[error("actor is not authorized to update organization branding")]
    Unauthorized,
    #[error("mutation must provide an idempotency key")]
    InvalidIdempotencyKey,
    #[error("mutation must provide at least one branding field")]
    NoFields,
    #[error("organization name must not be empty")]
    InvalidName,
    #[error("brand color must match #RRGGBB")]
    InvalidBrandColor,
    #[error("logo asset id must be UUID-shaped")]
    InvalidLogoAssetId,
    #[error("organization version is stale")]
    StaleVersion,
    #[error("organization fence epoch is stale")]
    StaleFence,
    #[error("idempotency key was already used for a different mutation")]
    IdempotencyConflict,
    #[error("organization version overflowed")]
    VersionOverflow,
    #[error("mutation fingerprint could not be encoded")]
    FingerprintFailed,
}

fn valid_brand_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

fn valid_uuid_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> OrganizationSettingsState {
        OrganizationSettingsState::new("org-a", 3, 7, "Rudder")
    }

    fn board_command(key: &str) -> OrganizationBrandingCommand {
        OrganizationBrandingCommand::board("org-a", "user-a", key, 3, 7)
            .with_brand_color(Some("#12aBcD".to_owned()))
    }

    fn state_with_description(value: &str) -> OrganizationSettingsState {
        let mut state = state();
        state.description = Some(value.to_owned());
        state
    }

    fn command_from_patch(key: &str, raw: serde_json::Value) -> OrganizationBrandingCommand {
        let patch: OrganizationBrandingPatch = serde_json::from_value(raw).unwrap();
        patch
            .into_command(
                "org-a",
                Actor::Board {
                    organization_id: "org-a".to_owned(),
                    principal_id: "user-a".to_owned(),
                },
                key,
                3,
                7,
            )
            .unwrap()
    }

    #[test]
    fn nullable_patch_deserializer_distinguishes_absent_from_json_null() {
        let absent = command_from_patch("absent", serde_json::json!({"name": "Rudder"}));
        assert_eq!(absent.description, None);

        let clear = command_from_patch(
            "clear",
            serde_json::json!({"name": "Rudder", "description": null}),
        );
        assert_eq!(clear.description, Some(None));

        assert_ne!(absent.fingerprint().unwrap(), clear.fingerprint().unwrap());
    }

    #[test]
    fn json_null_enters_the_explicit_clear_branch() {
        let mut state = state_with_description("Original");
        let command = command_from_patch("clear", serde_json::json!({"description": null}));

        let outcome = state.apply(command).unwrap();
        assert_eq!(outcome.state().description, None);
        assert_eq!(outcome.version(), 4);
    }

    #[test]
    fn node_patch_contract_rejects_null_name_unknown_fields_and_snake_case() {
        for raw in [
            serde_json::json!({"name": null}),
            serde_json::json!({"name": "Rudder", "actor": {"board": {}}}),
            serde_json::json!({"name": "Rudder", "organizationId": "org-a"}),
            serde_json::json!({"name": "Rudder", "brand_color": "#123456"}),
        ] {
            assert!(serde_json::from_value::<OrganizationBrandingPatch>(raw).is_err());
        }
    }

    #[test]
    fn node_patch_contract_uses_camel_case_and_validates_fields() {
        let raw = serde_json::json!({
            "name": "Rudder",
            "description": null,
            "brandColor": "#12aBcD",
            "logoAssetId": "123e4567-e89b-12d3-a456-426614174000"
        });
        let patch: OrganizationBrandingPatch = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(serde_json::to_value(&patch).unwrap(), raw);

        for raw in [
            serde_json::json!({}),
            serde_json::json!({"name": ""}),
            serde_json::json!({"brandColor": "red"}),
            serde_json::json!({"logoAssetId": "not-a-uuid"}),
        ] {
            assert!(serde_json::from_value::<OrganizationBrandingPatch>(raw).is_err());
        }
    }

    #[test]
    fn patch_binding_requires_adapter_supplied_actor_and_target_scope() {
        let raw = serde_json::json!({"name": "Rudder"});
        let patch: OrganizationBrandingPatch = serde_json::from_value(raw.clone()).unwrap();
        let command = patch
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
        assert_eq!(command.organization_id, "org-a");
        assert_eq!(command.actor.kind(), "ceo_agent");

        let patch: OrganizationBrandingPatch = serde_json::from_value(raw).unwrap();
        assert_eq!(
            patch.into_command(
                "org-b",
                Actor::CeoAgent {
                    organization_id: "org-a".to_owned(),
                    principal_id: "agent-a".to_owned(),
                },
                "branding-1",
                3,
                7,
            ),
            Err(MutationError::CrossOrganization)
        );
    }

    #[test]
    fn same_key_conflicts_after_an_absent_patch_and_replays_its_original_snapshot() {
        let mut state = state_with_description("Original");
        let absent = board_command("branding-1").with_name(Some("Rudder 2".to_owned()));
        let first = state.apply(absent.clone()).unwrap();

        let later = OrganizationBrandingCommand::board("org-a", "user-a", "branding-2", 4, 7)
            .with_description(Some("Later".to_owned()));
        let later = state.apply(later).unwrap();
        assert_eq!(later.state().description.as_deref(), Some("Later"));

        let replay = state.apply(absent.clone()).unwrap();
        assert!(matches!(
            replay,
            MutationOutcome::AlreadyApplied { version: 4, .. }
        ));
        assert_eq!(replay.state(), first.state());
        assert_eq!(state.description.as_deref(), Some("Later"));
        assert_eq!(state.version, 5);

        let explicit_clear = absent.with_description(None);
        assert_eq!(
            state.apply(explicit_clear),
            Err(MutationError::IdempotencyConflict)
        );
    }

    #[test]
    fn applies_allowed_branding_and_advances_version() {
        let outcome = state().apply(board_command("branding-1")).unwrap();
        assert!(matches!(
            &outcome,
            MutationOutcome::Applied { version: 4, .. }
        ));
        assert_eq!(outcome.state().brand_color.as_deref(), Some("#12aBcD"));
        assert_eq!(outcome.state().version, 4);
        assert_eq!(outcome.state().fence_epoch, 7);
    }

    #[test]
    fn same_idempotency_fingerprint_replays_without_advancing_again() {
        let mut state = state();
        let first = state.apply(board_command("branding-1")).unwrap();
        let replay = state.apply(board_command("branding-1")).unwrap();
        assert!(matches!(first, MutationOutcome::Applied { version: 4, .. }));
        assert!(matches!(
            replay,
            MutationOutcome::AlreadyApplied { version: 4, .. }
        ));
        assert_eq!(state.version, 4);
    }

    #[test]
    fn replay_returns_original_state_after_a_later_mutation() {
        let mut state = state();
        let attached = board_command("asset-attach")
            .with_logo_asset_id(Some("123e4567-e89b-12d3-a456-426614174000".to_owned()));
        let first = state.apply(attached.clone()).unwrap();

        let detached = OrganizationBrandingCommand::board("org-a", "user-a", "asset-detach", 4, 7)
            .with_logo_asset_id(None);
        let later = state.apply(detached).unwrap();
        assert_eq!(later.state().logo_asset_id, None);
        assert_eq!(state.version, 5);

        let replay = state.apply(attached).unwrap();
        assert!(matches!(
            &replay,
            MutationOutcome::AlreadyApplied { version: 4, .. }
        ));
        assert_eq!(replay.state(), first.state());
        assert_eq!(
            replay.state().logo_asset_id.as_deref(),
            first.state().logo_asset_id.as_deref()
        );
        assert_eq!(state.version, 5);
    }

    #[test]
    fn conflicting_idempotency_key_is_rejected() {
        let mut state = state();
        state.apply(board_command("branding-1")).unwrap();
        let conflicting = board_command("branding-1").with_name(Some("Different".to_owned()));
        assert_eq!(
            state.apply(conflicting),
            Err(MutationError::IdempotencyConflict)
        );
    }

    #[test]
    fn ceo_agent_must_be_bound_to_the_target_organization() {
        let command =
            OrganizationBrandingCommand::ceo_agent("org-b", "agent-a", "branding-1", 3, 7)
                .with_name(Some("Nope".to_owned()));
        assert_eq!(
            state().apply(command),
            Err(MutationError::CrossOrganization)
        );
    }

    #[test]
    fn actor_organization_must_match_command_scope() {
        let command = OrganizationBrandingCommand {
            organization_id: "org-a".to_owned(),
            actor: Actor::CeoAgent {
                organization_id: "org-b".to_owned(),
                principal_id: "agent-a".to_owned(),
            },
            idempotency_key: "branding-1".to_owned(),
            expected_version: 3,
            fence_epoch: 7,
            name: Some("Nope".to_owned()),
            description: None,
            brand_color: None,
            logo_asset_id: None,
        };

        assert_eq!(
            state().apply(command),
            Err(MutationError::CrossOrganization)
        );
    }

    #[test]
    fn non_ceo_agent_is_rejected_without_mutating_state() {
        let command = OrganizationBrandingCommand::agent("org-a", "agent-a", "branding-1", 3, 7)
            .with_name(Some("Nope".to_owned()));
        let mut state = state();
        assert_eq!(state.apply(command), Err(MutationError::Unauthorized));
        assert_eq!(state.version, 3);
    }

    #[test]
    fn empty_principal_id_is_rejected_without_mutating_state() {
        let command = OrganizationBrandingCommand::board("org-a", "", "branding-1", 3, 7)
            .with_name(Some("Nope".to_owned()));
        let mut state = state();
        assert_eq!(state.apply(command), Err(MutationError::Unauthorized));
        assert_eq!(state.version, 3);
    }

    #[test]
    fn stale_version_and_fence_fail_closed() {
        let stale_version = OrganizationBrandingCommand::board("org-a", "user-a", "k", 2, 7)
            .with_name(Some("Rudder 2".to_owned()));
        assert_eq!(
            state().apply(stale_version),
            Err(MutationError::StaleVersion)
        );

        let stale_fence = OrganizationBrandingCommand::board("org-a", "user-a", "k", 3, 6)
            .with_name(Some("Rudder 2".to_owned()));
        assert_eq!(state().apply(stale_fence), Err(MutationError::StaleFence));
    }

    #[test]
    fn validation_rejects_empty_commands_and_invalid_brand_colors() {
        let empty = OrganizationBrandingCommand::board("org-a", "user-a", "empty", 3, 7);
        assert_eq!(state().apply(empty), Err(MutationError::NoFields));

        let invalid = OrganizationBrandingCommand::board("org-a", "user-a", "bad", 3, 7)
            .with_brand_color(Some("red".to_owned()));
        assert_eq!(
            state().apply(invalid),
            Err(MutationError::InvalidBrandColor)
        );
    }

    #[test]
    fn version_overflow_rejects_without_mutating_state() {
        let mut state = OrganizationSettingsState::new("org-a", u64::MAX, 7, "Rudder");
        let before = state.clone();
        let command =
            OrganizationBrandingCommand::board("org-a", "user-a", "overflow", u64::MAX, 7)
                .with_name(Some("Changed".to_owned()));

        assert_eq!(state.apply(command), Err(MutationError::VersionOverflow));
        assert_eq!(state, before);
    }
}
