use crate::{
    AuthorizedActor, CommittedMutation, LinkRequest, Outcome, Receipt, ResultState, StoreError,
};
use rudder_organization_mutation_core::{
    OrganizationBrandingCommand, OrganizationSettingsSnapshot,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};

pub(crate) type Tx<'a> = Transaction<'a, Postgres>;
const MAX_RESULT_BYTES: usize = 1024 * 1024;

enum ExpectedResult {
    Branding(OrganizationBrandingCommand),
    Link(LinkRequest),
}
pub(crate) struct Metadata {
    pub org: String,
    pub key: String,
    pub kind: &'static str,
    pub fingerprint: String,
    pub expected_version: u64,
    pub fence: u64,
    expected: ExpectedResult,
}
impl Metadata {
    pub fn branding(
        actor: &AuthorizedActor,
        cmd: &OrganizationBrandingCommand,
    ) -> Result<Self, StoreError> {
        bind_actor(
            actor,
            &cmd.organization_id,
            cmd.actor.organization_id(),
            cmd.actor.principal_id(),
            cmd.actor.kind(),
        )?;
        if let Some(Some(id)) = &cmd.logo_asset_id {
            uuid(id)?;
        }
        let body = serde_json::to_vec(cmd).map_err(|_| StoreError::InvalidInput)?;
        if body.len() > MAX_RESULT_BYTES / 2 {
            return Err(StoreError::InvalidInput);
        }
        Self::new(
            &cmd.organization_id,
            &cmd.idempotency_key,
            "organization_branding",
            // Run provenance belongs to the original activity, not logical command identity.
            json!([1, cmd.fingerprint()?]),
            cmd.expected_version,
            cmd.fence_epoch,
            ExpectedResult::Branding(cmd.clone()),
        )
    }
    pub fn link(actor: &AuthorizedActor, request: &LinkRequest) -> Result<Self, StoreError> {
        let cmd = &request.command;
        bind_actor(
            actor,
            &cmd.organization_id,
            cmd.actor.organization_id(),
            cmd.actor.principal_id(),
            cmd.actor.kind(),
        )?;
        uuid(&cmd.project_id)?;
        uuid(&cmd.goal_id)?;
        if let Some(primary) = &request.primary_goal_after {
            uuid(primary)?;
        }
        Self::new(
            &cmd.organization_id,
            &cmd.idempotency_key,
            "project_goal_link",
            json!([1, cmd.fingerprint()?, request.primary_goal_after]),
            cmd.expected_version,
            cmd.fence_epoch,
            ExpectedResult::Link(request.clone()),
        )
    }
    fn new(
        org: &str,
        key: &str,
        kind: &'static str,
        identity: Value,
        version: u64,
        fence: u64,
        expected: ExpectedResult,
    ) -> Result<Self, StoreError> {
        uuid(org)?;
        signed(version)?;
        signed(fence)?;
        if key.is_empty() || key.len() > 256 || key.contains('\0') {
            return Err(StoreError::InvalidInput);
        }
        Ok(Self {
            org: org.to_owned(),
            key: key.to_owned(),
            kind,
            fingerprint: format!("{:x}", Sha256::digest(identity.to_string().as_bytes())),
            expected_version: version,
            fence,
            expected,
        })
    }
    pub fn check_fresh(&self, version: u64, fence: u64) -> Result<(), StoreError> {
        if self.expected_version != version {
            return Err(StoreError::StaleVersion);
        }
        if self.fence != fence {
            return Err(StoreError::StaleFence);
        }
        Ok(())
    }
}

fn bind_actor(
    actor: &AuthorizedActor,
    org: &str,
    actor_org: &str,
    id: &str,
    kind: &str,
) -> Result<(), StoreError> {
    let expected_kind = if actor.agent { "ceo_agent" } else { "board" };
    if actor.organization_id != org
        || actor_org != org
        || actor.principal_id != id
        || kind != expected_kind
        || id.is_empty()
        || id.len() > 1024
        || id.contains('\0')
    {
        return Err(StoreError::Unauthorized);
    }
    if actor.agent {
        uuid(id)?;
    }
    if let Some(run) = &actor.run_id {
        if !actor.agent {
            return Err(StoreError::Unauthorized);
        }
        uuid(run)?;
    }
    Ok(())
}

pub(crate) fn uuid(id: &str) -> Result<(), StoreError> {
    // Canonical UUID text avoids aliasing database identities in fingerprints.
    if id.len() != 36
        || !id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}
pub(crate) fn signed(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| StoreError::VersionRange)
}
fn unsigned(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| StoreError::InvalidReceipt)
}

pub(crate) async fn begin(pool: &PgPool) -> Result<Tx<'static>, StoreError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('lock_timeout','5s',true),set_config('statement_timeout','15s',true),set_config('idle_in_transaction_session_timeout','30s',true)")
        .execute(&mut *tx).await?;
    Ok(tx)
}
pub(crate) async fn finish(
    tx: Tx<'_>,
    result: Result<CommittedMutation, StoreError>,
) -> Result<CommittedMutation, StoreError> {
    match result {
        Ok(receipt) => {
            tx.commit().await?;
            Ok(receipt)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

pub(crate) async fn lock(
    tx: &mut Tx<'_>,
    actor: &AuthorizedActor,
    meta: &Metadata,
) -> Result<(u64, u64), StoreError> {
    let exists = sqlx::query("SELECT id FROM organizations WHERE id=$1::uuid FOR UPDATE")
        .bind(&meta.org)
        .fetch_optional(&mut **tx)
        .await?;
    if exists.is_none() {
        return Err(StoreError::NotFound);
    }
    let state = sqlx::query("SELECT owner, mutation_version, fence_epoch FROM organization_mutation_state WHERE org_id=$1::uuid FOR UPDATE")
        .bind(&meta.org).fetch_optional(&mut **tx).await?.ok_or(StoreError::NotOwned)?;
    if state.try_get::<String, _>("owner")? != "rust" {
        return Err(StoreError::NotOwned);
    }
    if actor.agent {
        let agent = sqlx::query(
            "SELECT role,status FROM agents WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE",
        )
        .bind(&actor.principal_id)
        .bind(&meta.org)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(StoreError::Unauthorized)?;
        // Match Node authentication even when authorization preceded a status change.
        // Pausing work does not revoke an otherwise valid Agent identity.
        if agent.try_get::<String, _>("role")? != "ceo"
            || matches!(
                agent.try_get::<String, _>("status")?.as_str(),
                "terminated" | "pending_approval"
            )
        {
            return Err(StoreError::Unauthorized);
        }
    }
    if let Some(run) = &actor.run_id {
        let found = sqlx::query("SELECT id FROM heartbeat_runs WHERE id=$1::uuid AND org_id=$2::uuid AND agent_id=$3::uuid FOR KEY SHARE")
            .bind(run).bind(&meta.org).bind(&actor.principal_id).fetch_optional(&mut **tx).await?;
        if found.is_none() {
            return Err(StoreError::Unauthorized);
        }
    }
    Ok((
        unsigned(state.try_get("mutation_version")?)?,
        unsigned(state.try_get("fence_epoch")?)?,
    ))
}

pub(crate) async fn replay(
    tx: &mut Tx<'_>,
    meta: &Metadata,
) -> Result<Option<CommittedMutation>, StoreError> {
    let row = sqlx::query("SELECT command_kind,command_fingerprint,receipt_format,outcome,resulting_version,fence_epoch,activity_id::text,result::text FROM organization_mutation_receipts WHERE org_id=$1::uuid AND idempotency_key=$2")
        .bind(&meta.org).bind(&meta.key).fetch_optional(&mut **tx).await?;
    let Some(row) = row else {
        return Ok(None);
    };
    if row.try_get::<String, _>("command_kind")? != meta.kind
        || row.try_get::<String, _>("command_fingerprint")? != meta.fingerprint
    {
        return Err(StoreError::IdempotencyConflict);
    }
    let text: String = row.try_get("result")?;
    if row.try_get::<i32, _>("receipt_format")? != 1 || text.len() > MAX_RESULT_BYTES {
        return Err(StoreError::InvalidReceipt);
    }
    let stored: Value = serde_json::from_str(&text).map_err(|_| StoreError::InvalidReceipt)?;
    let receipt: Receipt =
        serde_json::from_value(stored.clone()).map_err(|_| StoreError::InvalidReceipt)?;
    // A full receipt must not silently default omitted snapshot members.
    if serde_json::to_value(&receipt).map_err(|_| StoreError::InvalidReceipt)? != stored {
        return Err(StoreError::InvalidReceipt);
    }
    let outcome = if receipt.outcome == Outcome::Applied {
        "applied"
    } else {
        "noop"
    };
    if receipt.organization_id != meta.org
        || receipt.fingerprint != meta.fingerprint
        || receipt.version != unsigned(row.try_get("resulting_version")?)?
        || receipt.fence_epoch != unsigned(row.try_get("fence_epoch")?)?
        || receipt.activity_id != row.try_get::<String, _>("activity_id")?
        || outcome != row.try_get::<String, _>("outcome")?
    {
        return Err(StoreError::InvalidReceipt);
    }
    match &receipt.result {
        ResultState::OrganizationBranding { state }
            if meta.kind == "organization_branding"
                && state.organization_id == receipt.organization_id
                && state.version == receipt.version
                && state.fence_epoch == receipt.fence_epoch => {}
        ResultState::ProjectGoalLink {
            project_id,
            goal_id,
            ..
        } if meta.kind == "project_goal_link" => {
            uuid(project_id).map_err(|_| StoreError::InvalidReceipt)?;
            uuid(goal_id).map_err(|_| StoreError::InvalidReceipt)?;
        }
        _ => return Err(StoreError::InvalidReceipt),
    }
    validate_original_result(meta, &receipt)?;
    Ok(Some(CommittedMutation {
        replayed: true,
        receipt,
    }))
}

pub(crate) struct Effect {
    pub version: u64,
    pub fence: u64,
    pub outcome: Outcome,
    pub result: ResultState,
    pub entity_id: String,
    pub details: Value,
}
pub(crate) async fn persist(
    tx: &mut Tx<'_>,
    actor: &AuthorizedActor,
    meta: &Metadata,
    effect: Effect,
) -> Result<CommittedMutation, StoreError> {
    let version = signed(effect.version)?;
    let fence = signed(effect.fence)?;
    let updated = sqlx::query("UPDATE organization_mutation_state SET mutation_version=$2,updated_at=now() WHERE org_id=$1::uuid AND owner='rust' AND mutation_version=$3 AND fence_epoch=$4")
        .bind(&meta.org).bind(version).bind(signed(meta.expected_version)?).bind(fence).execute(&mut **tx).await?;
    if updated.rows_affected() != 1 {
        return Err(StoreError::StaleFence);
    }
    let (action, entity_type) = if meta.kind == "organization_branding" {
        ("organization.branding_updated", "organization")
    } else {
        ("project.updated", "project")
    };
    let activity_key = format!("rust-d1:{:x}", Sha256::digest(meta.key.as_bytes()));
    let activity_id: String = sqlx::query_scalar("INSERT INTO activity_log (org_id,actor_type,actor_id,action,entity_type,entity_id,agent_id,run_id,details,idempotency_key) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::uuid,$8::uuid,$9::jsonb,$10) RETURNING id::text")
        .bind(&meta.org).bind(if actor.agent { "agent" } else { "user" }).bind(&actor.principal_id)
        .bind(action).bind(entity_type).bind(&effect.entity_id)
        .bind(actor.agent.then_some(&actor.principal_id)).bind(&actor.run_id).bind(effect.details.to_string()).bind(activity_key)
        .fetch_one(&mut **tx).await?;
    let receipt = Receipt {
        organization_id: meta.org.clone(),
        version: effect.version,
        fence_epoch: effect.fence,
        fingerprint: meta.fingerprint.clone(),
        activity_id,
        outcome: effect.outcome,
        result: effect.result,
    };
    let result = serde_json::to_string(&receipt).map_err(|_| StoreError::InvalidReceipt)?;
    if result.len() > MAX_RESULT_BYTES {
        return Err(StoreError::InvalidInput);
    }
    sqlx::query("INSERT INTO organization_mutation_receipts (org_id,idempotency_key,command_kind,command_fingerprint,receipt_format,outcome,resulting_version,fence_epoch,activity_id,result) VALUES ($1::uuid,$2,$3,$4,1,$5,$6,$7,$8::uuid,$9::jsonb)")
        .bind(&meta.org).bind(&meta.key).bind(meta.kind).bind(&meta.fingerprint)
        .bind(if effect.outcome == Outcome::Applied { "applied" } else { "noop" }).bind(version).bind(fence)
        .bind(&receipt.activity_id).bind(result).execute(&mut **tx).await?;
    Ok(CommittedMutation {
        replayed: false,
        receipt,
    })
}

fn validate_original_result(meta: &Metadata, receipt: &Receipt) -> Result<(), StoreError> {
    let version = match receipt.outcome {
        Outcome::Applied => meta.expected_version.checked_add(1),
        Outcome::Noop => Some(meta.expected_version),
    };
    if version != Some(receipt.version) || receipt.fence_epoch != meta.fence {
        return Err(StoreError::InvalidReceipt);
    }
    let valid = match (&meta.expected, &receipt.result) {
        (ExpectedResult::Branding(cmd), ResultState::OrganizationBranding { state }) => {
            validate_branding_snapshot(state)?;
            receipt.outcome == Outcome::Applied
                && cmd.name.as_ref().is_none_or(|name| *name == state.name)
                && cmd
                    .description
                    .as_ref()
                    .is_none_or(|v| *v == state.description)
                && cmd
                    .brand_color
                    .as_ref()
                    .is_none_or(|v| *v == state.brand_color)
                && cmd
                    .logo_asset_id
                    .as_ref()
                    .is_none_or(|v| *v == state.logo_asset_id)
        }
        (
            ExpectedResult::Link(request),
            ResultState::ProjectGoalLink {
                project_id,
                goal_id,
                linked,
                primary_goal_after,
            },
        ) => {
            *project_id == request.command.project_id
                && *goal_id == request.command.goal_id
                && *linked
                    == matches!(
                        request.command.operation,
                        rudder_project_goal_link_core::Operation::Attach
                    )
                && *primary_goal_after == request.primary_goal_after
        }
        _ => false,
    };
    if !valid {
        return Err(StoreError::InvalidReceipt);
    }
    Ok(())
}

/// Validate the complete immutable snapshot, including fields the patch omitted.
/// Historical asset references are syntax-checked, never resolved against live state.
pub(crate) fn validate_branding_snapshot(
    state: &OrganizationSettingsSnapshot,
) -> Result<(), StoreError> {
    uuid(&state.organization_id).map_err(|_| StoreError::InvalidReceipt)?;
    signed(state.version).map_err(|_| StoreError::InvalidReceipt)?;
    signed(state.fence_epoch).map_err(|_| StoreError::InvalidReceipt)?;
    if let Some(asset) = &state.logo_asset_id {
        uuid(asset).map_err(|_| StoreError::InvalidReceipt)?;
    }
    OrganizationBrandingCommand::board(
        &state.organization_id,
        "snapshot-validation",
        "snapshot-validation",
        state.version,
        state.fence_epoch,
    )
    .with_name(Some(state.name.clone()))
    .with_description(state.description.clone())
    .with_brand_color(state.brand_color.clone())
    .with_logo_asset_id(state.logo_asset_id.clone())
    .validate()
    .map_err(|_| StoreError::InvalidReceipt)
}
