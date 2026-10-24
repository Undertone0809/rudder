//! Public Project writes reuse the existing D1 mutation operations. The
//! public credential check and any legacy fence adoption happen in the same
//! transaction as the command receipt and its effects.

use crate::agent_core::{NativeAgentAccess, NativeAgentAuthorizer};
use crate::{
    CommittedMutation, ProjectCreateCommand, ProjectCreateProvisioner, ProjectDeleteCommand,
    ProjectPatchCommand, StoreError, project_creations, project_deletions, project_patches,
    transaction,
};
use serde_json::Value;
use sqlx::{PgPool, Row};

pub(crate) async fn create(
    pool: &PgPool,
    command: ProjectCreateCommand,
    provisioner: &dyn ProjectCreateProvisioner,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<CommittedMutation, StoreError> {
    let input = project_creations::Input::parse(&command.data)?;
    let metadata = transaction::Metadata::project_create(&command)?;
    let mut tx = transaction::begin(pool).await?;
    let result = async {
        transaction::lock_organization_boundary(&mut tx, &metadata).await?;
        authorize_public(&mut tx, &metadata.org, authorizer).await?;
        project_creations::apply(&mut tx, command, input, &metadata, provisioner).await
    }
    .await;
    transaction::finish(tx, result).await
}

pub(crate) async fn patch(
    pool: &PgPool,
    mut command: ProjectPatchCommand,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<CommittedMutation, StoreError> {
    let patch = project_patches::Patch::parse(&command.patch)?;
    // The command fingerprint is independent of the optimistic scope values.
    // Start with valid placeholders so a matching receipt can be checked
    // before touching the current Project row.
    command.expected_version = 0;
    command.fence_epoch = 0;
    let initial_metadata = transaction::Metadata::project_patch(&command, &patch)?;
    let mut tx = transaction::begin(pool).await?;
    let result = async {
        transaction::lock_organization_boundary(&mut tx, &initial_metadata).await?;
        authorize_public(&mut tx, &initial_metadata.org, authorizer).await?;
        if let Some(receipt) = transaction::replay(&mut tx, &initial_metadata).await? {
            return Ok(receipt);
        }

        let project_id = initial_metadata
            .project_id
            .as_deref()
            .ok_or(StoreError::InvalidInput)?;
        let (version, fence_epoch) =
            adopt_legacy_project(&mut tx, &initial_metadata.org, project_id).await?;
        command.expected_version = version;
        command.fence_epoch = fence_epoch;
        let metadata = transaction::Metadata::project_patch(&command, &patch)?;
        project_patches::apply(&mut tx, command, patch, &metadata).await
    }
    .await;
    transaction::finish(tx, result).await
}

pub(crate) async fn delete(
    pool: &PgPool,
    mut command: ProjectDeleteCommand,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<CommittedMutation, StoreError> {
    command.expected_version = 0;
    command.fence_epoch = 0;
    let initial_metadata = transaction::Metadata::project_delete(&command)?;
    let mut tx = transaction::begin(pool).await?;
    let result = async {
        transaction::lock_organization_boundary(&mut tx, &initial_metadata).await?;
        authorize_public(&mut tx, &initial_metadata.org, authorizer).await?;
        // A completed delete removes its component row, but the durable
        // receipt remains. Check it before attempting current-row adoption.
        if let Some(receipt) = transaction::replay(&mut tx, &initial_metadata).await? {
            return Ok(receipt);
        }

        let (version, fence_epoch) = adopt_legacy_project(
            &mut tx,
            &initial_metadata.org,
            initial_metadata
                .project_id
                .as_deref()
                .ok_or(StoreError::InvalidInput)?,
        )
        .await?;
        command.expected_version = version;
        command.fence_epoch = fence_epoch;
        let metadata = transaction::Metadata::project_delete(&command)?;
        project_deletions::apply(&mut tx, command, &metadata).await
    }
    .await;
    transaction::finish(tx, result).await
}

pub(crate) async fn attachment_response(
    pool: &PgPool,
    organization_id: &str,
    idempotency_key: &str,
) -> Result<Option<Value>, StoreError> {
    let organization_id = transaction::uuid(organization_id)?.to_ascii_lowercase();
    if idempotency_key.is_empty()
        || idempotency_key.len() > 256
        || idempotency_key
            .bytes()
            .any(|byte| byte == 0 || byte.is_ascii_control())
    {
        return Err(StoreError::InvalidInput);
    }
    let response = sqlx::query_scalar::<_, Option<Value>>(
        "SELECT result->'resource_attachment_response'
         FROM organization_mutation_receipts
         WHERE org_id=$1::uuid AND idempotency_key=$2
           AND command_kind='project_goal_set_replacement'
         LIMIT 1",
    )
    .bind(organization_id)
    .bind(idempotency_key)
    .fetch_optional(pool)
    .await?;
    Ok(response.flatten())
}

async fn authorize_public(
    tx: &mut transaction::Tx<'_>,
    organization_id: &str,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<(), StoreError> {
    match authorizer.revalidate(tx, organization_id).await? {
        NativeAgentAccess::Authorized => Ok(()),
        NativeAgentAccess::Unauthorized => Err(StoreError::PublicIdentityUnauthorized),
        NativeAgentAccess::Forbidden => Err(StoreError::PublicIdentityForbidden),
    }
}

/// Adopt one legacy Project under the organization lock already held by the
/// caller. This mirrors the existing handoff token/epoch transition without
/// changing the mutation version; the existing Project command then performs
/// the write and receipt in this same transaction.
async fn adopt_legacy_project(
    tx: &mut transaction::Tx<'_>,
    organization_id: &str,
    project_id: &str,
) -> Result<(u64, u64), StoreError> {
    let project_id = transaction::uuid(project_id)?.to_ascii_lowercase();
    let state = sqlx::query(
        "SELECT owner, mutation_version, fence_epoch, fence_token::text AS fence_token
         FROM project_goal_mutation_state
         WHERE org_id=$1::uuid AND project_id=$2::uuid
         FOR UPDATE",
    )
    .bind(organization_id)
    .bind(&project_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(StoreError::NotOwned)?;
    let owner: String = state.try_get("owner")?;
    if owner != "node" && owner != "rust" {
        return Err(StoreError::NotOwned);
    }
    let version = transaction::unsigned(state.try_get("mutation_version")?)?;
    let epoch = transaction::unsigned(state.try_get("fence_epoch")?)?;
    let token: String = state.try_get("fence_token")?;
    transaction::uuid(&token)?;

    let project = sqlx::query(
        "SELECT id::text FROM projects WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    )
    .bind(organization_id)
    .bind(&project_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(StoreError::NotFound)?;
    let _: String = project.try_get("id")?;

    if owner == "node" {
        let next_epoch = epoch.checked_add(1).ok_or(StoreError::VersionRange)?;
        let updated = sqlx::query(
            "UPDATE project_goal_mutation_state
             SET owner='rust', fence_epoch=$5, fence_token=gen_random_uuid(), updated_at=now()
             WHERE org_id=$1::uuid AND project_id=$2::uuid AND owner='node'
               AND mutation_version=$3 AND fence_epoch=$4 AND fence_token=$6::uuid",
        )
        .bind(organization_id)
        .bind(&project_id)
        .bind(transaction::signed(version)?)
        .bind(transaction::signed(epoch)?)
        .bind(transaction::signed(next_epoch)?)
        .bind(&token)
        .execute(&mut **tx)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(StoreError::StaleFence);
        }
        Ok((version, next_epoch))
    } else {
        Ok((version, epoch))
    }
}
