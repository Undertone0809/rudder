//! Private SQLx persistence for fenced D1 mutation contracts.
//!
//! This crate has no routes, listeners, or Node integration. A caller must
//! supply a command that crossed the trusted core boundary. Existing entities
//! require their durable Rust ownership fence; creation assigns ownership only
//! to the newly inserted Project under the shared organization mutex.

mod branding;
mod goal_sets;
mod links;
mod project_creations;
mod project_deletions;
pub mod project_library;
mod project_patches;
mod transaction;

use rudder_organization_mutation_core::{
    OrganizationBrandingCommand, OrganizationSettingsSnapshot,
};
use rudder_project_goal_link_core::{
    Operation, ProjectGoalLinkCommand, ProjectGoalLinkState, ProjectGoalSetState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{PgPool, Row};
use thiserror::Error;

pub use project_creations::{
    ProjectCreateCommand, ProjectCreateProvisionRequest, ProjectCreateProvisioned,
    ProjectCreateProvisioner,
};

const COMMAND_KIND_BRANDING: &str = "organization_branding";
const COMMAND_KIND_PROJECT_GOAL_LINK: &str = "project_goal_link";
const COMMAND_KIND_PROJECT_GOAL_SET: &str = "project_goal_set_replacement";
const COMMAND_KIND_PROJECT_DELETE: &str = "project_delete";
const COMMAND_KIND_PROJECT_CREATE: &str = "project_create";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Applied,
    Noop,
}

impl Outcome {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Noop => "noop",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResultState {
    OrganizationBranding {
        state: OrganizationSettingsSnapshot,
        state_integrity: String,
    },
    ProjectGoalLink {
        state: Box<ProjectGoalLinkState>,
        project_id: String,
        goal_id: String,
        operation: Operation,
        link_identifier: String,
        core_fingerprint: String,
        target_version: u64,
        target_fence_epoch: u64,
        linked: bool,
        cancelled: bool,
        primary_goal_after: Option<String>,
        state_integrity: String,
        target_integrity: String,
    },
    ProjectGoalSetReplacement {
        state: Box<ProjectGoalSetState>,
        project_id: String,
        goal_ids: Vec<String>,
        primary_goal_after: Option<String>,
        state_integrity: String,
    },
    ProjectPatch {
        project_id: String,
        patch_fingerprint: String,
        goal_ids: Vec<String>,
        primary_goal_after: Option<String>,
        state_integrity: String,
    },
    ProjectDeleted {
        project_id: String,
        response: Value,
    },
    ProjectCreated {
        project_id: String,
        response: Value,
    },
}

#[derive(Clone, Debug)]
pub struct ProjectPatchCommand {
    pub organization_id: String,
    pub project_id: String,
    pub actor_kind: String,
    pub actor_id: String,
    pub run_id: Option<String>,
    pub idempotency_key: String,
    pub expected_version: u64,
    pub fence_epoch: u64,
    pub patch: Value,
}

#[derive(Clone, Debug)]
pub struct ProjectDeleteCommand {
    pub organization_id: String,
    pub project_id: String,
    pub actor_kind: String,
    pub actor_id: String,
    pub run_id: Option<String>,
    pub idempotency_key: String,
    pub expected_version: u64,
    pub fence_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectDeleteContext {
    pub expected_version: u64,
    pub fence_epoch: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub organization_id: String,
    pub version: u64,
    pub fence_epoch: u64,
    pub fingerprint: String,
    pub activity_id: String,
    pub outcome: Outcome,
    pub result: ResultState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedMutation {
    pub replayed: bool,
    pub receipt: Receipt,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MutationScope {
    pub organization_id: String,
    pub owner: String,
    pub version: u64,
    pub fence_epoch: u64,
    pub fence_token: String,
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("organization or scoped entity was not found")]
    NotFound,
    #[error("Rust does not own this organization mutation boundary")]
    NotOwned,
    #[error("actor binding or current CEO authority is invalid")]
    Unauthorized,
    #[error("invalid bounded command input")]
    InvalidInput,
    #[error("invalid project resource input")]
    InvalidResource,
    #[error("project Library provisioning failed: {0}")]
    Provisioning(String),
    #[error("project Library create intent conflicts with its original binding")]
    ProvisioningConflict,
    #[error("legacy primary-goal projection is inconsistent")]
    InvalidProjection,
    #[error("organization mutation version is stale")]
    StaleVersion,
    #[error("organization ownership fence is stale")]
    StaleFence,
    #[error("version exceeds the PostgreSQL BIGINT range")]
    VersionRange,
    #[error("organization idempotency key conflicts with its original command")]
    IdempotencyConflict,
    #[error("unsupported or inconsistent durable receipt")]
    InvalidReceipt,
    #[error("branding contract rejected the command: {0}")]
    Branding(#[from] rudder_organization_mutation_core::MutationError),
    #[error("link contract rejected the command: {0}")]
    Link(#[from] rudder_project_goal_link_core::LinkMutationError),
    #[error("database transaction failed")]
    Database(#[from] sqlx::Error),
}

#[derive(Clone)]
pub struct MutationStore {
    pool: PgPool,
}

impl MutationStore {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Create a Rust-owned Project and its complete response atomically. The
    /// required hook establishes synchronous Library readiness before commit;
    /// durable receipt replay never invokes it again.
    pub async fn project_create(
        &self,
        command: ProjectCreateCommand,
        provisioner: &dyn ProjectCreateProvisioner,
    ) -> Result<CommittedMutation, StoreError> {
        let input = project_creations::Input::parse(&command.data)?;
        let metadata = transaction::Metadata::project_create(&command)?;
        let mut tx = transaction::begin(&self.pool).await?;
        let result =
            project_creations::apply(&mut tx, command, input, &metadata, provisioner).await;
        transaction::finish(tx, result).await
    }

    /// Read the current organization fence before constructing an opaque
    /// command. The SQLx mutation transaction repeats this check while
    /// holding the organization row lock; this read only supplies the
    /// optimistic version/fence expected by the command.
    pub async fn organization_scope(
        &self,
        organization_id: &str,
    ) -> Result<MutationScope, StoreError> {
        let organization_id = transaction::uuid(organization_id)?.to_owned();
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1::uuid)",
        )
        .bind(&organization_id)
        .fetch_one(&self.pool)
        .await?;
        if !exists {
            return Err(StoreError::NotFound);
        }

        let row = sqlx::query(
            "SELECT owner, mutation_version, fence_epoch, fence_token::text AS fence_token
             FROM organization_mutation_state
             WHERE org_id=$1::uuid",
        )
        .bind(&organization_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotOwned)?;
        Ok(MutationScope {
            organization_id,
            owner: row.try_get("owner")?,
            version: transaction::unsigned(row.try_get("mutation_version")?)?,
            fence_epoch: transaction::unsigned(row.try_get("fence_epoch")?)?,
            fence_token: transaction::uuid(&row.try_get::<String, _>("fence_token")?)?.to_owned(),
        })
    }

    pub async fn organization_branding_scope(
        &self,
        organization_id: &str,
    ) -> Result<MutationScope, StoreError> {
        let organization_id = transaction::uuid(organization_id)?.to_owned();
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM organizations WHERE id=$1::uuid)",
        )
        .bind(&organization_id)
        .fetch_one(&self.pool)
        .await?;
        if !exists {
            return Err(StoreError::NotFound);
        }

        let row = sqlx::query(
            "SELECT owner, mutation_version, fence_epoch, fence_token::text AS fence_token
             FROM organization_branding_mutation_state
             WHERE org_id=$1::uuid",
        )
        .bind(&organization_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotOwned)?;
        Ok(MutationScope {
            organization_id,
            owner: row.try_get("owner")?,
            version: transaction::unsigned(row.try_get("mutation_version")?)?,
            fence_epoch: transaction::unsigned(row.try_get("fence_epoch")?)?,
            fence_token: transaction::uuid(&row.try_get::<String, _>("fence_token")?)?.to_owned(),
        })
    }

    /// Return the server-owned optimistic context for one mutation key.
    ///
    /// A replay must reconstruct the original command fingerprint, including
    /// its original version/fence, without allowing the request to provide
    /// either value. New keys use the current scope; existing keys use the
    /// receipt's predecessor version and recorded fence.
    pub async fn organization_scope_for_idempotency(
        &self,
        organization_id: &str,
        idempotency_key: &str,
    ) -> Result<MutationScope, StoreError> {
        let mut scope = self.organization_scope(organization_id).await?;
        let row = sqlx::query(
            "SELECT resulting_version, fence_epoch
             FROM organization_mutation_receipts
             WHERE org_id=$1::uuid AND idempotency_key=$2",
        )
        .bind(&scope.organization_id)
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(row) = row {
            let resulting_version: i64 = row.try_get("resulting_version")?;
            scope.version = transaction::unsigned(resulting_version)?
                .checked_sub(1)
                .ok_or(StoreError::InvalidReceipt)?;
            scope.fence_epoch = transaction::unsigned(row.try_get("fence_epoch")?)?;
        }
        Ok(scope)
    }

    pub async fn organization_branding_scope_for_idempotency(
        &self,
        organization_id: &str,
        idempotency_key: &str,
    ) -> Result<MutationScope, StoreError> {
        let mut scope = self.organization_branding_scope(organization_id).await?;
        let row = sqlx::query(
            "SELECT resulting_version, fence_epoch
             FROM organization_branding_mutation_receipts
             WHERE org_id=$1::uuid AND idempotency_key=$2",
        )
        .bind(&scope.organization_id)
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(row) = row {
            let resulting_version: i64 = row.try_get("resulting_version")?;
            scope.version = transaction::unsigned(resulting_version)?
                .checked_sub(1)
                .ok_or(StoreError::InvalidReceipt)?;
            scope.fence_epoch = transaction::unsigned(row.try_get("fence_epoch")?)?;
        }
        Ok(scope)
    }

    pub async fn project_scope(&self, project_id: &str) -> Result<MutationScope, StoreError> {
        let project_id = transaction::uuid(project_id)?.to_owned();
        let organization_id =
            sqlx::query_scalar::<_, String>("SELECT org_id::text FROM projects WHERE id=$1::uuid")
                .bind(&project_id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or(StoreError::NotFound)?;
        let row = sqlx::query(
            "SELECT owner, mutation_version, fence_epoch, fence_token::text AS fence_token
             FROM project_goal_mutation_state
             WHERE project_id=$1::uuid AND org_id=$2::uuid",
        )
        .bind(&project_id)
        .bind(&organization_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(StoreError::NotOwned)?;
        Ok(MutationScope {
            organization_id,
            owner: row.try_get("owner")?,
            version: transaction::unsigned(row.try_get("mutation_version")?)?,
            fence_epoch: transaction::unsigned(row.try_get("fence_epoch")?)?,
            fence_token: transaction::uuid(&row.try_get::<String, _>("fence_token")?)?.to_owned(),
        })
    }

    /// Return the server-owned optimistic context for a Project mutation key.
    ///
    /// Resolving the organization through the Project keeps the HTTP route
    /// organization-scoped while allowing replay to recover the original
    /// receipt version and fence without trusting client-supplied values.
    pub async fn project_scope_for_idempotency(
        &self,
        project_id: &str,
        idempotency_key: &str,
    ) -> Result<MutationScope, StoreError> {
        let project_id = transaction::uuid(project_id)?.to_owned();
        let mut scope = self.project_scope(&project_id).await?;
        let row = sqlx::query(
            "SELECT resulting_version, fence_epoch
             FROM organization_mutation_receipts
             WHERE org_id=$1::uuid
               AND idempotency_key=$2
               AND command_kind IN ('project_goal_link', 'project_goal_set_replacement')",
        )
        .bind(&scope.organization_id)
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(row) = row {
            let resulting_version: i64 = row.try_get("resulting_version")?;
            scope.version = transaction::unsigned(resulting_version)?
                .checked_sub(1)
                .ok_or(StoreError::InvalidReceipt)?;
            scope.fence_epoch = transaction::unsigned(row.try_get("fence_epoch")?)?;
        }
        Ok(scope)
    }

    /// Apply an already validated organization branding command privately.
    pub async fn branding(
        &self,
        command: OrganizationBrandingCommand,
    ) -> Result<CommittedMutation, StoreError> {
        let metadata = transaction::Metadata::branding(&command)?;
        let mut tx = transaction::begin(&self.pool).await?;
        let result = branding::apply(&mut tx, command, &metadata).await;
        transaction::finish(tx, result).await
    }

    /// Apply an already validated Project↔Goal command and its explicit legacy
    /// `projects.goal_id` projection in one private transaction.
    pub async fn project_goal(
        &self,
        command: ProjectGoalLinkCommand,
        primary_goal_after: Option<String>,
    ) -> Result<CommittedMutation, StoreError> {
        let metadata = transaction::Metadata::project_goal(&command, primary_goal_after.clone())?;
        let mut tx = transaction::begin(&self.pool).await?;
        let result = links::apply(&mut tx, command, primary_goal_after, &metadata).await;
        transaction::finish(tx, result).await
    }

    /// Apply an atomic complete Project goal-set replacement privately.
    ///
    /// This is the behavior-equivalent command for the existing Project
    /// update contract: it replaces every join row and the legacy primary
    /// projection in one transaction before recording activity and receipt.
    pub async fn project_goal_set(
        &self,
        command: rudder_project_goal_link_core::ProjectGoalSetReplacementCommand,
    ) -> Result<CommittedMutation, StoreError> {
        let metadata = transaction::Metadata::project_goal_set(&command)?;
        let mut tx = transaction::begin(&self.pool).await?;
        let result = goal_sets::apply(&mut tx, command, &metadata).await;
        transaction::finish(tx, result).await
    }

    /// Apply a complete Project PATCH and its optional Goal replacement under
    /// the already-owned per-Project Goal fence and one PostgreSQL transaction.
    pub async fn project_patch(
        &self,
        command: ProjectPatchCommand,
    ) -> Result<CommittedMutation, StoreError> {
        let patch = project_patches::Patch::parse(&command.patch)?;
        let metadata = transaction::Metadata::project_patch(&command, &patch)?;
        let mut tx = transaction::begin(&self.pool).await?;
        let result = project_patches::apply(&mut tx, command, patch, &metadata).await;
        transaction::finish(tx, result).await
    }

    /// Read the optimistic component context for deletion or a durable replay.
    /// A matching receipt survives the Project fence cascade and takes
    /// precedence over any Project row recreated with the same UUID.
    pub async fn project_delete_context_for_idempotency(
        &self,
        organization_id: &str,
        project_id: &str,
        idempotency_key: &str,
    ) -> Result<ProjectDeleteContext, StoreError> {
        let organization_id = transaction::uuid(organization_id)?.to_owned();
        let project_id = transaction::uuid(project_id)?.to_owned();
        if idempotency_key.is_empty() || idempotency_key.len() > 256 {
            return Err(StoreError::InvalidInput);
        }

        let receipt = sqlx::query(
            "SELECT command_kind, resulting_version, fence_epoch
             FROM organization_mutation_receipts
             WHERE org_id=$1::uuid AND idempotency_key=$2",
        )
        .bind(&organization_id)
        .bind(idempotency_key)
        .fetch_optional(&self.pool)
        .await?;
        if let Some(receipt) = receipt {
            if receipt.try_get::<String, _>("command_kind")? != COMMAND_KIND_PROJECT_DELETE {
                return Ok(ProjectDeleteContext {
                    expected_version: 0,
                    fence_epoch: 0,
                });
            }
            let resulting_version =
                transaction::unsigned(receipt.try_get::<i64, _>("resulting_version")?)?;
            return Ok(ProjectDeleteContext {
                expected_version: resulting_version
                    .checked_sub(1)
                    .ok_or(StoreError::InvalidReceipt)?,
                fence_epoch: transaction::unsigned(receipt.try_get("fence_epoch")?)?,
            });
        }

        let scope = self.project_scope(&project_id).await?;
        if scope.organization_id != organization_id {
            return Err(StoreError::NotFound);
        }
        Ok(ProjectDeleteContext {
            expected_version: scope.version,
            fence_epoch: scope.fence_epoch,
        })
    }

    /// Delete one Project only while Rust owns its Project component fence.
    pub async fn project_delete(
        &self,
        command: ProjectDeleteCommand,
    ) -> Result<CommittedMutation, StoreError> {
        let metadata = transaction::Metadata::project_delete(&command)?;
        let mut tx = transaction::begin(&self.pool).await?;
        let result = project_deletions::apply(&mut tx, command, &metadata).await;
        transaction::finish(tx, result).await
    }
}

pub(crate) const fn branding_kind() -> &'static str {
    COMMAND_KIND_BRANDING
}

pub(crate) const fn project_goal_kind() -> &'static str {
    COMMAND_KIND_PROJECT_GOAL_LINK
}

pub(crate) const fn project_goal_set_kind() -> &'static str {
    COMMAND_KIND_PROJECT_GOAL_SET
}

pub(crate) const fn project_delete_kind() -> &'static str {
    COMMAND_KIND_PROJECT_DELETE
}

pub(crate) const fn project_create_kind() -> &'static str {
    COMMAND_KIND_PROJECT_CREATE
}
