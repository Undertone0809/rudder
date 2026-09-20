use crate::{
    CommittedMutation, Outcome, Receipt, ResultState, StoreError, branding_kind, project_goal_kind,
};
use rudder_organization_mutation_core::{
    OrganizationBrandingCommand, OrganizationSettingsSnapshot,
};
use rudder_project_goal_link_core::{Operation, ProjectGoalLinkCommand};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};

pub(crate) type Tx<'a> = Transaction<'a, Postgres>;

pub(crate) const MAX_RESULT_BYTES: usize = 1024 * 1024;
const BRANDING_RECEIPT_FORMAT: i32 = 2;
const PROJECT_GOAL_RECEIPT_FORMAT: i32 = 2;
const MAX_COMMAND_BYTES: usize = MAX_RESULT_BYTES / 2;
pub(crate) const MAX_PROJECT_GOALS: usize = 1024;
const MAX_TEXT_BYTES: usize = 256;

#[derive(Clone, Debug)]
pub(crate) struct ActorMetadata {
    pub kind: &'static str,
    pub principal_id: String,
    pub agent_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) enum ExpectedReceipt {
    OrganizationBranding {
        name: Option<String>,
        description: Option<Option<String>>,
        brand_color: Option<Option<String>>,
        logo_asset_id: Option<Option<String>>,
    },
    ProjectGoalLink {
        operation: Operation,
        link_identifier: String,
        core_fingerprint: String,
        linked: bool,
        cancelled: bool,
        target_integrity: String,
        primary_goal_after: Option<String>,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct Metadata {
    pub org: String,
    pub key: String,
    pub kind: &'static str,
    pub fingerprint: String,
    pub expected_version: u64,
    pub fence_epoch: u64,
    pub actor: ActorMetadata,
    pub project_id: Option<String>,
    pub goal_id: Option<String>,
    pub link_identifier: Option<String>,
    pub expected_receipt: ExpectedReceipt,
    pub receipt_format: i32,
}

impl Metadata {
    pub fn branding(command: &OrganizationBrandingCommand) -> Result<Self, StoreError> {
        let view = command.as_integration_view()?;
        let actor = actor_metadata(view.actor().kind(), view.actor().principal_id())?;
        let org = uuid(view.organization_id())?.to_owned();
        let key = bounded_text(view.idempotency_key(), false)?;
        let fingerprint = adapter_fingerprint(branding_kind(), &view.fingerprint()?, None)?;
        if let Some(Some(asset_id)) = view.logo_asset_id() {
            uuid(asset_id)?;
        }
        let body = json!({
            "organization_id": org,
            "actor_kind": actor.kind,
            "actor_id": actor.principal_id,
            "idempotency_key": key,
            "expected_version": view.expected_version(),
            "fence_epoch": view.fence_epoch(),
            "name": view.name(),
            "description": view.description(),
            "brand_color": view.brand_color(),
            "logo_asset_id": view.logo_asset_id(),
        });
        ensure_json_size(&body, MAX_COMMAND_BYTES)?;
        signed(view.expected_version())?;
        signed(view.fence_epoch())?;
        Ok(Self {
            org,
            key,
            kind: branding_kind(),
            fingerprint,
            expected_version: view.expected_version(),
            fence_epoch: view.fence_epoch(),
            actor,
            project_id: None,
            goal_id: None,
            link_identifier: None,
            expected_receipt: ExpectedReceipt::OrganizationBranding {
                name: view.name().map(str::to_owned),
                description: view.description().map(|value| value.map(str::to_owned)),
                brand_color: view.brand_color().map(|value| value.map(str::to_owned)),
                logo_asset_id: view.logo_asset_id().map(|value| value.map(str::to_owned)),
            },
            receipt_format: BRANDING_RECEIPT_FORMAT,
        })
    }

    pub fn project_goal(
        command: &ProjectGoalLinkCommand,
        primary_goal_after: Option<String>,
    ) -> Result<Self, StoreError> {
        let view = command.as_integration_view()?;
        let context = view.context();
        let actor = actor_metadata(context.actor().kind(), context.actor().principal_id())?;
        let org = uuid(context.organization_id())?.to_owned();
        let project_id = uuid(context.project_id())?.to_owned();
        let goal_id = uuid(context.goal_id())?.to_owned();
        let project_org = uuid(context.project_organization_id())?;
        let goal_org = uuid(context.goal_organization_id())?;
        if project_org != org || goal_org != org {
            return Err(StoreError::Link(
                rudder_project_goal_link_core::LinkMutationError::CrossOrganization,
            ));
        }
        if let Some(primary) = primary_goal_after.as_deref() {
            uuid(primary)?;
        }
        let key = bounded_text(view.idempotency_key(), false)?;
        let core_fingerprint = view.fingerprint()?;
        let fingerprint = adapter_fingerprint(
            project_goal_kind(),
            &core_fingerprint,
            primary_goal_after.as_deref(),
        )?;
        let body = json!({
            "organization_id": org,
            "actor_kind": actor.kind,
            "actor_id": actor.principal_id,
            "project_id": project_id,
            "goal_id": goal_id,
            "operation": format!("{:?}", view.operation()).to_lowercase(),
            "idempotency_key": key,
            "expected_version": view.expected_version(),
            "fence_epoch": view.fence_epoch(),
            "primary_goal_after": primary_goal_after,
            "state_integrity": context.state_integrity(),
        });
        ensure_json_size(&body, MAX_COMMAND_BYTES)?;
        signed(view.expected_version())?;
        signed(view.fence_epoch())?;
        let link_identifier = view.link_identifier()?;
        Ok(Self {
            org,
            key,
            kind: project_goal_kind(),
            fingerprint,
            expected_version: view.expected_version(),
            fence_epoch: view.fence_epoch(),
            actor,
            project_id: Some(project_id),
            goal_id: Some(goal_id),
            link_identifier: Some(link_identifier.clone()),
            expected_receipt: ExpectedReceipt::ProjectGoalLink {
                operation: view.operation(),
                link_identifier: link_identifier.clone(),
                core_fingerprint: core_fingerprint.clone(),
                linked: context.linked(),
                cancelled: context.cancelled(),
                target_integrity: context.state_integrity().to_owned(),
                primary_goal_after: primary_goal_after.clone(),
            },
            receipt_format: PROJECT_GOAL_RECEIPT_FORMAT,
        })
    }

    pub fn check_fresh(&self, version: u64, fence_epoch: u64) -> Result<(), StoreError> {
        if self.expected_version != version {
            return Err(StoreError::StaleVersion);
        }
        if self.fence_epoch != fence_epoch {
            return Err(StoreError::StaleFence);
        }
        Ok(())
    }
}

pub(crate) struct Effect {
    pub version: u64,
    pub fence_epoch: u64,
    pub outcome: Outcome,
    pub result: ResultState,
    pub entity_id: String,
    pub details: Value,
}

pub(crate) async fn begin(pool: &PgPool) -> Result<Tx<'_>, StoreError> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "SELECT set_config('lock_timeout','5s',true), \
                set_config('statement_timeout','15s',true), \
                set_config('idle_in_transaction_session_timeout','30s',true)",
    )
    .execute(&mut *tx)
    .await?;
    Ok(tx)
}

pub(crate) async fn finish(
    tx: Tx<'_>,
    result: Result<CommittedMutation, StoreError>,
) -> Result<CommittedMutation, StoreError> {
    match result {
        Ok(value) => {
            tx.commit().await?;
            Ok(value)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

pub(crate) async fn lock_scope(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
) -> Result<(u64, u64), StoreError> {
    let organization = sqlx::query("SELECT id FROM organizations WHERE id=$1::uuid FOR UPDATE")
        .bind(&metadata.org)
        .fetch_optional(&mut **tx)
        .await?;
    if organization.is_none() {
        return Err(StoreError::NotFound);
    }

    let state = sqlx::query(
        "SELECT owner, mutation_version, fence_epoch
         FROM organization_mutation_state
         WHERE org_id=$1::uuid
         FOR UPDATE",
    )
    .bind(&metadata.org)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(StoreError::NotOwned)?;
    if state.try_get::<String, _>("owner")? != "rust" {
        return Err(StoreError::NotOwned);
    }

    if metadata.actor.kind == "ceo_agent" || metadata.actor.kind == "agent" {
        let agent = sqlx::query(
            "SELECT role, status
             FROM agents
             WHERE id=$1::uuid AND org_id=$2::uuid
             FOR UPDATE",
        )
        .bind(&metadata.actor.principal_id)
        .bind(&metadata.org)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(StoreError::Unauthorized)?;
        if agent.try_get::<String, _>("role")? != "ceo"
            || matches!(
                agent.try_get::<String, _>("status")?.as_str(),
                "terminated" | "pending_approval"
            )
        {
            return Err(StoreError::Unauthorized);
        }
    } else if metadata.actor.kind != "board" {
        return Err(StoreError::Unauthorized);
    }

    Ok((
        unsigned(state.try_get::<i64, _>("mutation_version")?)?,
        unsigned(state.try_get::<i64, _>("fence_epoch")?)?,
    ))
}

pub(crate) async fn replay(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
) -> Result<Option<CommittedMutation>, StoreError> {
    let row = sqlx::query(
        "SELECT command_kind, command_fingerprint, receipt_format, outcome,
                resulting_version, fence_epoch, activity_id::text,
                CASE WHEN octet_length(result::text) <= $3
                     THEN result::text ELSE NULL END AS result_text
         FROM organization_mutation_receipts
         WHERE org_id=$1::uuid AND idempotency_key=$2",
    )
    .bind(&metadata.org)
    .bind(&metadata.key)
    .bind(i64::try_from(MAX_RESULT_BYTES).expect("result bound fits BIGINT"))
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };

    if row.try_get::<String, _>("command_kind")? != metadata.kind
        || row.try_get::<String, _>("command_fingerprint")? != metadata.fingerprint
    {
        return Err(StoreError::IdempotencyConflict);
    }
    if row.try_get::<i32, _>("receipt_format")? != metadata.receipt_format {
        return Err(StoreError::InvalidReceipt);
    }
    let result_text: Option<String> = row.try_get("result_text")?;
    let Some(result_text) = result_text else {
        return Err(StoreError::InvalidReceipt);
    };
    let stored_value: Value =
        serde_json::from_str(&result_text).map_err(|_| StoreError::InvalidReceipt)?;
    let receipt: Receipt =
        serde_json::from_value(stored_value.clone()).map_err(|_| StoreError::InvalidReceipt)?;
    let canonical_value = serde_json::to_value(&receipt).map_err(|_| StoreError::InvalidReceipt)?;
    if canonical_value != stored_value {
        return Err(StoreError::InvalidReceipt);
    }
    let resulting_version = unsigned(row.try_get::<i64, _>("resulting_version")?)?;
    let fence_epoch = unsigned(row.try_get::<i64, _>("fence_epoch")?)?;
    let row_outcome = row.try_get::<String, _>("outcome")?;
    if receipt.organization_id != metadata.org
        || receipt.fingerprint != metadata.fingerprint
        || receipt.version != resulting_version
        || receipt.fence_epoch != fence_epoch
        || receipt.activity_id != row.try_get::<String, _>("activity_id")?
        || receipt.outcome.as_str() != row_outcome
    {
        return Err(StoreError::InvalidReceipt);
    }
    validate_receipt_result(metadata, &receipt)?;
    Ok(Some(CommittedMutation {
        replayed: true,
        receipt,
    }))
}

pub(crate) async fn persist(
    tx: &mut Tx<'_>,
    metadata: &Metadata,
    effect: Effect,
) -> Result<CommittedMutation, StoreError> {
    signed(effect.version)?;
    signed(effect.fence_epoch)?;
    ensure_json_size(&effect.details, MAX_RESULT_BYTES)?;
    let receipt = Receipt {
        organization_id: metadata.org.clone(),
        version: effect.version,
        fence_epoch: effect.fence_epoch,
        fingerprint: metadata.fingerprint.clone(),
        activity_id: String::new(),
        outcome: effect.outcome,
        result: effect.result,
    };
    validate_receipt_result(metadata, &receipt)?;

    let result_without_activity =
        serde_json::to_value(&receipt).map_err(|_| StoreError::InvalidReceipt)?;
    ensure_json_size(&result_without_activity, MAX_RESULT_BYTES)?;

    let updated = sqlx::query(
        "UPDATE organization_mutation_state
         SET mutation_version=$2, fence_epoch=$3, updated_at=now()
         WHERE org_id=$1::uuid
           AND owner='rust'
           AND mutation_version=$4
           AND fence_epoch=$5",
    )
    .bind(&metadata.org)
    .bind(signed(effect.version)?)
    .bind(signed(effect.fence_epoch)?)
    .bind(signed(metadata.expected_version)?)
    .bind(signed(metadata.fence_epoch)?)
    .execute(&mut **tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(StoreError::StaleFence);
    }

    let details = serde_json::to_string(&effect.details).map_err(|_| StoreError::InvalidReceipt)?;
    let activity_id: String = sqlx::query_scalar(
        "INSERT INTO activity_log
          (org_id, actor_type, actor_id, action, entity_type, entity_id,
           agent_id, details, idempotency_key)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::jsonb, $9)
         RETURNING id::text",
    )
    .bind(&metadata.org)
    .bind(if metadata.actor.kind == "board" {
        "user"
    } else {
        "agent"
    })
    .bind(&metadata.actor.principal_id)
    .bind(if metadata.kind == branding_kind() {
        "organization.branding_updated"
    } else {
        "project.updated"
    })
    .bind(if metadata.kind == branding_kind() {
        "organization"
    } else {
        "project"
    })
    .bind(&effect.entity_id)
    .bind(metadata.actor.agent_id.as_deref())
    .bind(details)
    .bind(activity_idempotency_key(&metadata.key))
    .fetch_one(&mut **tx)
    .await?;

    let mut receipt = receipt;
    receipt.activity_id = activity_id;
    let receipt_json = serde_json::to_string(&receipt).map_err(|_| StoreError::InvalidReceipt)?;
    if receipt_json.len() > MAX_RESULT_BYTES {
        return Err(StoreError::InvalidInput);
    }
    sqlx::query(
        "INSERT INTO organization_mutation_receipts
          (org_id, idempotency_key, command_kind, command_fingerprint,
           receipt_format, outcome, resulting_version, fence_epoch,
           activity_id, result)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10::jsonb)",
    )
    .bind(&metadata.org)
    .bind(&metadata.key)
    .bind(metadata.kind)
    .bind(&metadata.fingerprint)
    .bind(metadata.receipt_format)
    .bind(receipt.outcome.as_str())
    .bind(signed(receipt.version)?)
    .bind(signed(receipt.fence_epoch)?)
    .bind(&receipt.activity_id)
    .bind(receipt_json)
    .execute(&mut **tx)
    .await?;

    Ok(CommittedMutation {
        replayed: false,
        receipt,
    })
}

fn validate_receipt_result(metadata: &Metadata, receipt: &Receipt) -> Result<(), StoreError> {
    if receipt.organization_id != metadata.org
        || !is_sha256_hex(&receipt.fingerprint)
        || receipt.fingerprint != metadata.fingerprint
    {
        return Err(StoreError::InvalidReceipt);
    }
    match (&receipt.result, metadata.kind) {
        (
            ResultState::OrganizationBranding {
                state,
                state_integrity,
            },
            kind,
        ) if *kind == *branding_kind() => {
            if state.organization_id != metadata.org
                || state.version != receipt.version
                || state.fence_epoch != receipt.fence_epoch
                || !is_sha256_hex(state_integrity)
                || branding_state_integrity(state)? != *state_integrity
            {
                return Err(StoreError::InvalidReceipt);
            }
            bounded_text(&state.organization_id, false)?;
            bounded_text(&state.name, false)?;
            if let Some(value) = &state.description {
                bounded_text(value, true)?;
            }
            if let Some(value) = &state.brand_color {
                bounded_text(value, true)?;
                if !valid_brand_color(value) {
                    return Err(StoreError::InvalidReceipt);
                }
            }
            if let Some(value) = &state.logo_asset_id {
                uuid(value)?;
            }
            let ExpectedReceipt::OrganizationBranding {
                name,
                description,
                brand_color,
                logo_asset_id,
            } = &metadata.expected_receipt
            else {
                return Err(StoreError::InvalidReceipt);
            };
            let expected_version = metadata
                .expected_version
                .checked_add(1)
                .ok_or(StoreError::InvalidReceipt)?;
            if receipt.outcome != Outcome::Applied
                || receipt.version != expected_version
                || receipt.fence_epoch != metadata.fence_epoch
                || name
                    .as_deref()
                    .is_some_and(|value| value != state.name.as_str())
                || description
                    .as_ref()
                    .is_some_and(|value| value.as_deref() != state.description.as_deref())
                || brand_color
                    .as_ref()
                    .is_some_and(|value| value.as_deref() != state.brand_color.as_deref())
                || logo_asset_id
                    .as_ref()
                    .is_some_and(|value| value.as_deref() != state.logo_asset_id.as_deref())
            {
                return Err(StoreError::InvalidReceipt);
            }
        }
        (
            ResultState::ProjectGoalLink {
                state,
                project_id,
                goal_id,
                operation: result_operation,
                link_identifier,
                core_fingerprint,
                target_version,
                target_fence_epoch,
                linked,
                cancelled,
                primary_goal_after,
                state_integrity,
                target_integrity,
                ..
            },
            kind,
        ) if *kind == *project_goal_kind() => {
            if Some(project_id) != metadata.project_id.as_ref()
                || Some(goal_id) != metadata.goal_id.as_ref()
                || !is_sha256_hex(state_integrity)
                || state.project_id != *project_id
                || state.goal_id != *goal_id
                || state.organization_id != metadata.org
                || state.project_org_id != metadata.org
                || state.goal_org_id != metadata.org
                || state.link_identifier().ok().as_deref() != Some(link_identifier.as_str())
                || state.linked != *linked
                || state.cancelled != *cancelled
                || state.state_integrity() != state_integrity
                || !is_sha256_hex(target_integrity)
                || !is_sha256_hex(core_fingerprint)
                || state.version != receipt.version
                || state.fence_epoch != receipt.fence_epoch
                || *target_version != metadata.expected_version
                || *target_fence_epoch != metadata.fence_epoch
            {
                return Err(StoreError::InvalidReceipt);
            }
            uuid(project_id)?;
            uuid(goal_id)?;
            if let Some(primary) = primary_goal_after {
                uuid(primary)?;
            }
            let ExpectedReceipt::ProjectGoalLink {
                operation,
                link_identifier: expected_link_identifier,
                core_fingerprint: expected_core_fingerprint,
                linked: target_linked,
                cancelled: target_cancelled,
                target_integrity: expected_integrity,
                primary_goal_after: expected_primary,
            } = &metadata.expected_receipt
            else {
                return Err(StoreError::InvalidReceipt);
            };
            if *target_cancelled
                || *operation != *result_operation
                || expected_link_identifier != link_identifier
                || expected_core_fingerprint != core_fingerprint
                || expected_integrity != target_integrity
                || expected_primary.as_deref() != primary_goal_after.as_deref()
            {
                return Err(StoreError::InvalidReceipt);
            }
            let transition_valid = match (*operation, receipt.outcome) {
                (Operation::Attach, Outcome::Applied) => !*target_linked && *linked && !*cancelled,
                (Operation::Attach, Outcome::Noop) => *target_linked && *linked && !*cancelled,
                (Operation::Detach, Outcome::Applied) => *target_linked && !*linked && !*cancelled,
                (Operation::Detach, Outcome::Noop) => !*target_linked && !*linked && !*cancelled,
                (Operation::Cancel, Outcome::Applied) => *target_linked == *linked && *cancelled,
                (Operation::Cancel, Outcome::Noop) => false,
            };
            let expected_version = match receipt.outcome {
                Outcome::Applied => metadata
                    .expected_version
                    .checked_add(1)
                    .ok_or(StoreError::InvalidReceipt)?,
                Outcome::Noop => metadata.expected_version,
            };
            let expected_fence = if *operation == Operation::Cancel {
                metadata
                    .fence_epoch
                    .checked_add(1)
                    .ok_or(StoreError::InvalidReceipt)?
            } else {
                metadata.fence_epoch
            };
            if !transition_valid
                || state.version != expected_version
                || state.fence_epoch != expected_fence
            {
                return Err(StoreError::InvalidReceipt);
            }
            state.validate_persisted()?;
            state.validate_persisted_receipt(
                &metadata.key,
                core_fingerprint,
                *result_operation,
                *target_version,
                *target_fence_epoch,
                receipt.version,
                receipt.fence_epoch,
                *linked,
                *cancelled,
                target_integrity,
                receipt.outcome.as_str(),
            )?;
        }
        _ => return Err(StoreError::InvalidReceipt),
    }
    Ok(())
}

fn actor_metadata(kind: &'static str, principal_id: &str) -> Result<ActorMetadata, StoreError> {
    let principal_id = bounded_text(principal_id, false)?;
    let agent_id = match kind {
        "board" => None,
        "ceo_agent" | "agent" => Some(uuid(&principal_id)?.to_owned()),
        _ => return Err(StoreError::Unauthorized),
    };
    Ok(ActorMetadata {
        kind,
        principal_id,
        agent_id,
    })
}

pub(crate) fn adapter_fingerprint(
    kind: &str,
    core_fingerprint: &str,
    primary_goal_after: Option<&str>,
) -> Result<String, StoreError> {
    if !is_sha256_hex(core_fingerprint) {
        return Err(StoreError::InvalidInput);
    }
    let identity = json!({
        "adapter_format": 1,
        "kind": kind,
        "core_fingerprint": core_fingerprint,
        "primary_goal_after": primary_goal_after,
    });
    ensure_json_size(&identity, MAX_COMMAND_BYTES)?;
    Ok(hex_digest(Sha256::digest(
        serde_json::to_vec(&identity).map_err(|_| StoreError::InvalidInput)?,
    )))
}

pub(crate) fn branding_state_integrity(
    state: &OrganizationSettingsSnapshot,
) -> Result<String, StoreError> {
    let value = json!({
        "schema": "rudder.d1.organization-branding-state.v1",
        "state": state,
    });
    ensure_json_size(&value, MAX_RESULT_BYTES)?;
    Ok(hex_digest(Sha256::digest(
        serde_json::to_vec(&value).map_err(|_| StoreError::InvalidReceipt)?,
    )))
}

fn activity_idempotency_key(key: &str) -> String {
    format!("rust-d1:{}", hex_digest(Sha256::digest(key.as_bytes())))
}

pub(crate) fn uuid(value: &str) -> Result<&str, StoreError> {
    if value.len() != 36
        || !value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(value)
}

pub(crate) fn signed(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| StoreError::VersionRange)
}

fn unsigned(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| StoreError::InvalidReceipt)
}

fn bounded_text(value: &str, allow_empty: bool) -> Result<String, StoreError> {
    if (!allow_empty && value.is_empty())
        || value.len() > MAX_TEXT_BYTES
        || value
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(value.to_owned())
}

fn ensure_json_size(value: &Value, max_bytes: usize) -> Result<(), StoreError> {
    let encoded = serde_json::to_vec(value).map_err(|_| StoreError::InvalidInput)?;
    if encoded.len() > max_bytes {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}

pub(crate) fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_brand_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

fn hex_digest(digest: impl IntoIterator<Item = u8>) -> String {
    digest
        .into_iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
