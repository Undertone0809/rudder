use super::{Actor, MutationError, deserialize_non_nullable_string, deserialize_nullable_patch};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_ISSUE_PREFIX_BYTES: usize = 12;

/// Closed set of organization fields that can appear in a settings audit.
///
/// The adapter derives this list from the patch instead of accepting an
/// arbitrary audit-field string from a bridge or caller. It is included in
/// the command fingerprint so a receipt cannot be replayed under a different
/// audit surface.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OrganizationSettingsAuditField {
    Name,
    Description,
    Status,
    BudgetMonthlyCents,
    SpentMonthlyCents,
    DefaultChatIssueCreationMode,
    RequireBoardApprovalForNewAgents,
    IssuePrefix,
    BrandColor,
    LogoAssetId,
}

impl OrganizationSettingsAuditField {
    const fn ceo_agent_allowed(self) -> bool {
        matches!(
            self,
            Self::Name | Self::Description | Self::BrandColor | Self::LogoAssetId
        )
    }
}

fn deserialize_optional_non_nullable_string<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)?
        .ok_or_else(|| {
            serde::de::Error::custom("null is not valid for a non-nullable organization setting")
        })
        .map(Some)
}

fn deserialize_optional_non_nullable_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<u64>::deserialize(deserializer)?
        .ok_or_else(|| {
            serde::de::Error::custom("null is not valid for a non-nullable organization setting")
        })
        .map(Some)
}

fn deserialize_optional_non_nullable_bool<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<bool>::deserialize(deserializer)?
        .ok_or_else(|| {
            serde::de::Error::custom("null is not valid for a non-nullable organization setting")
        })
        .map(Some)
}

/// The complete organization settings patch owned by the future Rust
/// organization-update adapter. Optional nullable values distinguish an
/// omitted field from an explicit clear, matching the existing Node route.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OrganizationSettingsPatch {
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
        deserialize_with = "deserialize_optional_non_nullable_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub status: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_nullable_u64",
        skip_serializing_if = "Option::is_none"
    )]
    pub budget_monthly_cents: Option<u64>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_nullable_u64",
        skip_serializing_if = "Option::is_none"
    )]
    pub spent_monthly_cents: Option<u64>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_nullable_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_chat_issue_creation_mode: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_nullable_bool",
        skip_serializing_if = "Option::is_none"
    )]
    pub require_board_approval_for_new_agents: Option<bool>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_nullable_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub issue_prefix: Option<String>,
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

impl Default for OrganizationSettingsPatch {
    fn default() -> Self {
        Self {
            name: None,
            description: None,
            status: None,
            budget_monthly_cents: None,
            spent_monthly_cents: None,
            default_chat_issue_creation_mode: None,
            require_board_approval_for_new_agents: None,
            issue_prefix: None,
            brand_color: None,
            logo_asset_id: None,
        }
    }
}

impl OrganizationSettingsPatch {
    pub fn audit_surface(&self) -> Vec<OrganizationSettingsAuditField> {
        let mut fields = Vec::new();
        if self.name.is_some() {
            fields.push(OrganizationSettingsAuditField::Name);
        }
        if self.description.is_some() {
            fields.push(OrganizationSettingsAuditField::Description);
        }
        if self.status.is_some() {
            fields.push(OrganizationSettingsAuditField::Status);
        }
        if self.budget_monthly_cents.is_some() {
            fields.push(OrganizationSettingsAuditField::BudgetMonthlyCents);
        }
        if self.spent_monthly_cents.is_some() {
            fields.push(OrganizationSettingsAuditField::SpentMonthlyCents);
        }
        if self.default_chat_issue_creation_mode.is_some() {
            fields.push(OrganizationSettingsAuditField::DefaultChatIssueCreationMode);
        }
        if self.require_board_approval_for_new_agents.is_some() {
            fields.push(OrganizationSettingsAuditField::RequireBoardApprovalForNewAgents);
        }
        if self.issue_prefix.is_some() {
            fields.push(OrganizationSettingsAuditField::IssuePrefix);
        }
        if self.brand_color.is_some() {
            fields.push(OrganizationSettingsAuditField::BrandColor);
        }
        if self.logo_asset_id.is_some() {
            fields.push(OrganizationSettingsAuditField::LogoAssetId);
        }
        fields
    }

    pub fn validate(&self) -> Result<(), MutationError> {
        if self.name.is_none()
            && self.description.is_none()
            && self.status.is_none()
            && self.budget_monthly_cents.is_none()
            && self.spent_monthly_cents.is_none()
            && self.default_chat_issue_creation_mode.is_none()
            && self.require_board_approval_for_new_agents.is_none()
            && self.issue_prefix.is_none()
            && self.brand_color.is_none()
            && self.logo_asset_id.is_none()
        {
            return Err(MutationError::NoFields);
        }
        if self.name.as_deref().is_some_and(str::is_empty) {
            return Err(MutationError::InvalidName);
        }
        if self
            .brand_color
            .as_ref()
            .and_then(Option::as_ref)
            .is_some_and(|value| !valid_brand_color(value))
        {
            return Err(MutationError::InvalidBrandColor);
        }
        if self
            .logo_asset_id
            .as_ref()
            .and_then(Option::as_ref)
            .is_some_and(|value| !valid_uuid_shape(value))
        {
            return Err(MutationError::InvalidLogoAssetId);
        }
        if self
            .status
            .as_deref()
            .is_some_and(|value| !matches!(value, "active" | "paused" | "archived"))
        {
            return Err(MutationError::InvalidOrganizationStatus);
        }
        if self
            .default_chat_issue_creation_mode
            .as_deref()
            .is_some_and(|value| !matches!(value, "manual_approval" | "auto_create"))
        {
            return Err(MutationError::InvalidChatIssueCreationMode);
        }
        if self
            .budget_monthly_cents
            .is_some_and(|value| value > i32::MAX as u64)
            || self
                .spent_monthly_cents
                .is_some_and(|value| value > i32::MAX as u64)
        {
            return Err(MutationError::InvalidBudget);
        }
        if self
            .issue_prefix
            .as_deref()
            .is_some_and(|value| normalize_issue_prefix(value).is_err())
        {
            return Err(MutationError::InvalidIssuePrefix);
        }
        Ok(())
    }

    fn validate_permissions(&self, actor: &Actor) -> Result<(), MutationError> {
        match actor {
            Actor::Board { .. } => Ok(()),
            Actor::CeoAgent { .. } => {
                if self
                    .audit_surface()
                    .into_iter()
                    .all(OrganizationSettingsAuditField::ceo_agent_allowed)
                {
                    Ok(())
                } else {
                    Err(MutationError::Unauthorized)
                }
            }
            Actor::Agent { .. } => Err(MutationError::Unauthorized),
        }
    }

    pub fn normalized(&self) -> Result<Self, MutationError> {
        self.validate()?;
        let mut normalized = self.clone();
        if let Some(prefix) = normalized.issue_prefix.as_mut() {
            *prefix = normalize_issue_prefix(prefix)?;
        }
        Ok(normalized)
    }
}

/// The public distinction is retained in the fingerprint so a future bridge
/// cannot replay an organization update as a different organization surface.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OrganizationSettingsIntentSourceKind {
    ChatLightweight,
    ChatApproval,
}

/// Trusted, immutable intent identity. The rotating claim token is used only
/// for the transaction's stale-claim check and is deliberately excluded from
/// the command fingerprint.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OrganizationSettingsIntentContext {
    pub intent_id: String,
    pub organization_id: String,
    pub source_kind: OrganizationSettingsIntentSourceKind,
    pub source_id: String,
    pub approval_id: Option<String>,
    pub conversation_id: Option<String>,
    pub proposal_message_id: Option<String>,
    pub actor_user_id: Option<String>,
    pub actor_principal: String,
    pub generation: u64,
    pub patch_fingerprint: String,
    pub intent_fingerprint: String,
    pub rust_idempotency_key: String,
    pub claim_token: Option<String>,
}

/// Trusted organization-wide settings command. It is intentionally separate
/// from [`super::OrganizationBrandingCommand`], whose fingerprint and receipt
/// contract are already persisted in production migrations.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct OrganizationSettingsCommand {
    pub organization_id: String,
    pub actor: Actor,
    pub idempotency_key: String,
    pub expected_version: u64,
    pub fence_epoch: u64,
    pub patch: OrganizationSettingsPatch,
    pub intent: Option<OrganizationSettingsIntentContext>,
}

impl OrganizationSettingsCommand {
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

    fn with_actor(
        actor: Actor,
        idempotency_key: impl Into<String>,
        expected_version: u64,
        fence_epoch: u64,
    ) -> Self {
        Self {
            organization_id: actor.organization_id().to_owned(),
            actor,
            idempotency_key: idempotency_key.into(),
            expected_version,
            fence_epoch,
            patch: OrganizationSettingsPatch::default(),
            intent: None,
        }
    }

    pub fn with_patch(mut self, patch: OrganizationSettingsPatch) -> Self {
        self.patch = patch;
        self
    }

    pub fn with_intent_context(mut self, context: OrganizationSettingsIntentContext) -> Self {
        self.intent = Some(context);
        self
    }

    pub fn with_name(mut self, value: impl Into<String>) -> Self {
        self.patch.name = Some(value.into());
        self
    }

    pub fn with_description(mut self, value: Option<String>) -> Self {
        self.patch.description = Some(value);
        self
    }

    pub fn with_status(mut self, value: impl Into<String>) -> Self {
        self.patch.status = Some(value.into());
        self
    }

    pub fn with_budget_monthly_cents(mut self, value: u64) -> Self {
        self.patch.budget_monthly_cents = Some(value);
        self
    }

    pub fn with_spent_monthly_cents(mut self, value: u64) -> Self {
        self.patch.spent_monthly_cents = Some(value);
        self
    }

    pub fn with_default_chat_issue_creation_mode(mut self, value: impl Into<String>) -> Self {
        self.patch.default_chat_issue_creation_mode = Some(value.into());
        self
    }

    pub fn with_require_board_approval_for_new_agents(mut self, value: bool) -> Self {
        self.patch.require_board_approval_for_new_agents = Some(value);
        self
    }

    pub fn with_issue_prefix(mut self, value: impl Into<String>) -> Self {
        self.patch.issue_prefix = Some(value.into());
        self
    }

    pub fn with_brand_color(mut self, value: Option<String>) -> Self {
        self.patch.brand_color = Some(value);
        self
    }

    pub fn with_logo_asset_id(mut self, value: Option<String>) -> Self {
        self.patch.logo_asset_id = Some(value);
        self
    }

    pub fn normalized(&self) -> Result<Self, MutationError> {
        self.validate()?;
        let mut normalized = self.clone();
        normalized.patch = self.patch.normalized()?;
        Ok(normalized)
    }

    pub fn validate(&self) -> Result<(), MutationError> {
        if self.organization_id.is_empty() || self.idempotency_key.is_empty() {
            return Err(MutationError::InvalidIdempotencyKey);
        }
        if self.actor.organization_id() != self.organization_id {
            return Err(MutationError::CrossOrganization);
        }
        if self.actor.principal_id().is_empty()
            || !matches!(self.actor, Actor::Board { .. } | Actor::CeoAgent { .. })
        {
            return Err(MutationError::Unauthorized);
        }
        self.patch.validate()?;
        self.patch.validate_permissions(&self.actor)?;
        if let Some(intent) = &self.intent {
            if !valid_uuid_shape(&intent.intent_id)
                || intent.organization_id != self.organization_id
                || !valid_uuid_shape(&intent.organization_id)
                || !valid_uuid_shape(&intent.source_id)
                || intent
                    .conversation_id
                    .as_deref()
                    .is_none_or(|value| !valid_uuid_shape(value))
                || intent.rust_idempotency_key != self.idempotency_key
                || intent.patch_fingerprint != self.patch_fingerprint()?
            {
                return Err(MutationError::InvalidIntentContext);
            }
            if intent.generation == 0 || !is_sha256_hex(&intent.patch_fingerprint) {
                return Err(MutationError::InvalidIntentContext);
            }
            if !is_sha256_hex(&intent.intent_fingerprint)
                || intent.actor_principal.is_empty()
                || intent.actor_user_id.as_deref().is_some_and(str::is_empty)
            {
                return Err(MutationError::InvalidIntentContext);
            }
            let expected_actor_principal = match &self.actor {
                Actor::Board { .. } => "board",
                Actor::CeoAgent { principal_id, .. } => principal_id.as_str(),
                Actor::Agent { .. } => return Err(MutationError::Unauthorized),
            };
            if intent.actor_principal != expected_actor_principal
                || intent.intent_fingerprint != self.intent_fingerprint()?
            {
                return Err(MutationError::InvalidIntentContext);
            }
            match intent.source_kind {
                OrganizationSettingsIntentSourceKind::ChatLightweight => {
                    if intent.approval_id.is_some()
                        || intent.proposal_message_id.as_deref() != Some(intent.source_id.as_str())
                    {
                        return Err(MutationError::InvalidIntentContext);
                    }
                }
                OrganizationSettingsIntentSourceKind::ChatApproval => {
                    if intent.approval_id.as_deref() != Some(intent.source_id.as_str()) {
                        return Err(MutationError::InvalidIntentContext);
                    }
                    if let Some(proposal_message_id) = &intent.proposal_message_id {
                        if !valid_uuid_shape(proposal_message_id) {
                            return Err(MutationError::InvalidIntentContext);
                        }
                    }
                }
            }
            if let Some(claim_token) = &intent.claim_token {
                if !valid_uuid_shape(claim_token) {
                    return Err(MutationError::InvalidIntentContext);
                }
            }
        }
        Ok(())
    }

    pub fn patch_fingerprint(&self) -> Result<String, MutationError> {
        let patch = self.patch.normalized()?;
        let encoded = serde_json::to_vec(&patch).map_err(|_| MutationError::FingerprintFailed)?;
        Ok(hex_digest(Sha256::digest(encoded)))
    }

    pub fn fingerprint(&self) -> Result<String, MutationError> {
        let normalized = self.normalized()?;
        #[derive(Serialize)]
        struct Fingerprint<'a> {
            schema: &'static str,
            kind: &'static str,
            format: u8,
            organization_id: &'a str,
            actor_kind: &'static str,
            actor_id: &'a str,
            idempotency_key: &'a str,
            expected_version: u64,
            fence_epoch: u64,
            patch: &'a OrganizationSettingsPatch,
            audit_surface: Vec<OrganizationSettingsAuditField>,
            intent: Option<IntentFingerprint<'a>>,
        }
        #[derive(Serialize)]
        struct IntentFingerprint<'a> {
            intent_id: &'a str,
            organization_id: &'a str,
            source_kind: OrganizationSettingsIntentSourceKind,
            source_id: &'a str,
            approval_id: &'a Option<String>,
            conversation_id: &'a Option<String>,
            proposal_message_id: &'a Option<String>,
            generation: u64,
            patch_fingerprint: &'a str,
            intent_fingerprint: &'a str,
            rust_idempotency_key: &'a str,
            actor_user_id: &'a Option<String>,
            actor_principal: &'a str,
        }
        let payload = Fingerprint {
            schema: "rudder.organization-settings-command.v1",
            kind: "organization_settings",
            format: 1,
            organization_id: &normalized.organization_id,
            actor_kind: normalized.actor.kind(),
            actor_id: normalized.actor.principal_id(),
            idempotency_key: &normalized.idempotency_key,
            expected_version: normalized.expected_version,
            fence_epoch: normalized.fence_epoch,
            patch: &normalized.patch,
            audit_surface: normalized.patch.audit_surface(),
            intent: normalized.intent.as_ref().map(|intent| IntentFingerprint {
                intent_id: &intent.intent_id,
                organization_id: &intent.organization_id,
                source_kind: intent.source_kind,
                source_id: &intent.source_id,
                approval_id: &intent.approval_id,
                conversation_id: &intent.conversation_id,
                proposal_message_id: &intent.proposal_message_id,
                generation: intent.generation,
                patch_fingerprint: &intent.patch_fingerprint,
                intent_fingerprint: &intent.intent_fingerprint,
                rust_idempotency_key: &intent.rust_idempotency_key,
                actor_user_id: &intent.actor_user_id,
                actor_principal: &intent.actor_principal,
            }),
        };
        let encoded = serde_json::to_vec(&payload).map_err(|_| MutationError::FingerprintFailed)?;
        let digest = Sha256::digest(encoded);
        Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    pub fn intent_fingerprint(&self) -> Result<String, MutationError> {
        let intent = self
            .intent
            .as_ref()
            .ok_or(MutationError::InvalidIntentContext)?;
        #[derive(Serialize)]
        struct IntentIdentity<'a> {
            schema: &'static str,
            organization_id: &'a str,
            source_kind: OrganizationSettingsIntentSourceKind,
            source_id: &'a str,
            approval_id: &'a Option<String>,
            conversation_id: &'a Option<String>,
            proposal_message_id: &'a Option<String>,
            actor_user_id: &'a Option<String>,
            actor_principal: &'a str,
            generation: u64,
            patch_fingerprint: &'a str,
            rust_idempotency_key: &'a str,
        }
        let identity = IntentIdentity {
            schema: "rudder.organization-settings-intent.v1",
            organization_id: &intent.organization_id,
            source_kind: intent.source_kind,
            source_id: &intent.source_id,
            approval_id: &intent.approval_id,
            conversation_id: &intent.conversation_id,
            proposal_message_id: &intent.proposal_message_id,
            actor_user_id: &intent.actor_user_id,
            actor_principal: &intent.actor_principal,
            generation: intent.generation,
            patch_fingerprint: &intent.patch_fingerprint,
            rust_idempotency_key: &intent.rust_idempotency_key,
        };
        let encoded =
            serde_json::to_vec(&identity).map_err(|_| MutationError::FingerprintFailed)?;
        Ok(hex_digest(Sha256::digest(encoded)))
    }
}

/// Durable result snapshot for the organization-wide settings receipt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OrganizationSettingsMutationSnapshot {
    pub organization_id: String,
    pub version: u64,
    pub fence_epoch: u64,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub budget_monthly_cents: u64,
    pub spent_monthly_cents: u64,
    pub default_chat_issue_creation_mode: String,
    pub require_board_approval_for_new_agents: bool,
    pub issue_prefix: String,
    pub issue_prefix_aliases: Vec<String>,
    pub brand_color: Option<String>,
    pub logo_asset_id: Option<String>,
    pub issue_identifier_rewrites: u64,
}

fn normalize_issue_prefix(value: &str) -> Result<String, MutationError> {
    let normalized = value.trim().to_ascii_uppercase();
    let mut chars = normalized.chars();
    let Some(first) = chars.next() else {
        return Err(MutationError::InvalidIssuePrefix);
    };
    if normalized.len() > MAX_ISSUE_PREFIX_BYTES
        || !first.is_ascii_uppercase()
        || !chars.all(|character| character.is_ascii_uppercase() || character.is_ascii_digit())
    {
        return Err(MutationError::InvalidIssuePrefix);
    }
    Ok(normalized)
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

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hex_digest(digest: impl IntoIterator<Item = u8>) -> String {
    digest
        .into_iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(key: &str) -> OrganizationSettingsCommand {
        OrganizationSettingsCommand::board("org-a", "user-a", key, 3, 7)
            .with_name("Rudder Cloud")
            .with_issue_prefix(" rud ")
            .with_brand_color(Some("#336699".to_owned()))
    }

    fn agent_command(key: &str) -> OrganizationSettingsCommand {
        OrganizationSettingsCommand::with_actor(
            Actor::Agent {
                organization_id: "org-a".to_owned(),
                principal_id: "agent-a".to_owned(),
            },
            key,
            3,
            7,
        )
        .with_name("Rudder Cloud")
    }

    #[test]
    fn normalizes_issue_prefix_without_changing_other_patch_values() {
        let command = command("settings-normalize").normalized().unwrap();
        assert_eq!(command.patch.issue_prefix.as_deref(), Some("RUD"));
        assert_eq!(command.patch.name.as_deref(), Some("Rudder Cloud"));
    }

    #[test]
    fn fingerprint_distinguishes_omitted_and_explicitly_cleared_nullable_fields() {
        let omitted = command("settings-fingerprint");
        let cleared = omitted.clone().with_description(None);
        assert_ne!(
            omitted.fingerprint().unwrap(),
            cleared.fingerprint().unwrap()
        );
    }

    #[test]
    fn rejects_unsupported_status_mode_prefix_and_budget_values() {
        assert_eq!(
            command("invalid-status").with_status("unknown").validate(),
            Err(MutationError::InvalidOrganizationStatus)
        );
        assert_eq!(
            command("invalid-mode")
                .with_default_chat_issue_creation_mode("automatic")
                .validate(),
            Err(MutationError::InvalidChatIssueCreationMode)
        );
        assert_eq!(
            command("invalid-prefix")
                .with_issue_prefix("1BAD")
                .validate(),
            Err(MutationError::InvalidIssuePrefix)
        );
        assert_eq!(
            command("invalid-budget")
                .with_budget_monthly_cents(u64::MAX)
                .validate(),
            Err(MutationError::InvalidBudget)
        );
    }

    #[test]
    fn rejects_json_null_for_every_non_nullable_optional_setting() {
        for (field, raw) in [
            ("name", serde_json::json!({"name": null})),
            (
                "status",
                serde_json::json!({"name": "Rudder", "status": null}),
            ),
            (
                "budgetMonthlyCents",
                serde_json::json!({"name": "Rudder", "budgetMonthlyCents": null}),
            ),
            (
                "spentMonthlyCents",
                serde_json::json!({"name": "Rudder", "spentMonthlyCents": null}),
            ),
            (
                "defaultChatIssueCreationMode",
                serde_json::json!({
                    "name": "Rudder",
                    "defaultChatIssueCreationMode": null
                }),
            ),
            (
                "requireBoardApprovalForNewAgents",
                serde_json::json!({
                    "name": "Rudder",
                    "requireBoardApprovalForNewAgents": null
                }),
            ),
            (
                "issuePrefix",
                serde_json::json!({"name": "Rudder", "issuePrefix": null}),
            ),
        ] {
            assert!(
                serde_json::from_value::<OrganizationSettingsPatch>(raw).is_err(),
                "{field} must reject explicit JSON null"
            );
        }

        assert!(
            serde_json::from_value::<OrganizationSettingsPatch>(serde_json::json!({
                "description": null,
                "brandColor": null,
                "logoAssetId": null
            }))
            .is_ok()
        );
    }

    #[test]
    fn ceo_agent_is_limited_to_branding_fields_at_the_core_boundary() {
        let cases = [
            ("status", command("ceo-status").with_status("paused")),
            (
                "budgetMonthlyCents",
                command("ceo-budget").with_budget_monthly_cents(100),
            ),
            (
                "spentMonthlyCents",
                command("ceo-spent").with_spent_monthly_cents(100),
            ),
            (
                "defaultChatIssueCreationMode",
                command("ceo-mode").with_default_chat_issue_creation_mode("auto_create"),
            ),
            (
                "requireBoardApprovalForNewAgents",
                command("ceo-approval").with_require_board_approval_for_new_agents(false),
            ),
            (
                "issuePrefix",
                command("ceo-prefix").with_issue_prefix("RUD"),
            ),
        ];

        for (field, command) in cases {
            let ceo = OrganizationSettingsCommand::ceo_agent(
                "org-a",
                "agent-a",
                command.idempotency_key.clone(),
                3,
                7,
            )
            .with_patch(command.patch);
            assert_eq!(
                ceo.validate(),
                Err(MutationError::Unauthorized),
                "CEO agent must not update {field}"
            );
        }

        assert!(
            OrganizationSettingsCommand::ceo_agent("org-a", "agent-a", "ceo-branding", 3, 7)
                .with_name("Rudder Cloud")
                .with_description(None)
                .with_brand_color(Some("#336699".to_owned()))
                .with_logo_asset_id(None)
                .validate()
                .is_ok()
        );
    }

    #[test]
    fn normal_agent_is_rejected_even_for_branding_fields() {
        assert_eq!(
            agent_command("agent-branding").validate(),
            Err(MutationError::Unauthorized)
        );
    }

    #[test]
    fn fingerprint_contains_the_closed_audit_surface_and_excludes_claim_rotation() {
        let patch = command("audit-surface")
            .with_description(None)
            .with_logo_asset_id(None)
            .patch;
        assert_eq!(
            patch.audit_surface(),
            vec![
                OrganizationSettingsAuditField::Name,
                OrganizationSettingsAuditField::Description,
                OrganizationSettingsAuditField::IssuePrefix,
                OrganizationSettingsAuditField::BrandColor,
                OrganizationSettingsAuditField::LogoAssetId,
            ]
        );

        let mut without_claim = OrganizationSettingsCommand::board(
            "70000000-0000-4000-8000-000000000005",
            "user-a",
            "audit-intent",
            3,
            7,
        )
        .with_name("Rudder Cloud")
        .with_issue_prefix("RUD")
        .with_brand_color(Some("#336699".to_owned()));
        let mut intent = OrganizationSettingsIntentContext {
            intent_id: "70000000-0000-4000-8000-000000000001".to_owned(),
            organization_id: "70000000-0000-4000-8000-000000000005".to_owned(),
            source_kind: OrganizationSettingsIntentSourceKind::ChatLightweight,
            source_id: "70000000-0000-4000-8000-000000000002".to_owned(),
            approval_id: None,
            conversation_id: Some("70000000-0000-4000-8000-000000000003".to_owned()),
            proposal_message_id: Some("70000000-0000-4000-8000-000000000002".to_owned()),
            actor_user_id: None,
            actor_principal: "board".to_owned(),
            generation: 1,
            patch_fingerprint: without_claim.patch_fingerprint().unwrap(),
            intent_fingerprint: String::new(),
            rust_idempotency_key: without_claim.idempotency_key.clone(),
            claim_token: None,
        };
        without_claim.intent = Some(intent.clone());
        intent.intent_fingerprint = without_claim.intent_fingerprint().unwrap();
        without_claim.intent = Some(intent.clone());
        let mut with_claim = without_claim.clone();
        intent.claim_token = Some("70000000-0000-4000-8000-000000000004".to_owned());
        with_claim.intent = Some(intent);
        assert_eq!(
            without_claim.fingerprint().unwrap(),
            with_claim.fingerprint().unwrap()
        );
    }
}
