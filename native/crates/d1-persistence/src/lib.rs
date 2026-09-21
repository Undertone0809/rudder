//! Private SQLx persistence for fenced D1 mutation contracts.
//!
//! This crate is deliberately inert: it has no routes, listeners, ownership
//! acquisition, or Node integration. A caller must supply a command that has
//! already crossed the corresponding trusted core boundary. The adapter only
//! persists that command when PostgreSQL says Rust owns the organization fence.

mod branding;
mod goal_sets;
mod links;
mod transaction;

use rudder_organization_mutation_core::{
    OrganizationBrandingCommand, OrganizationSettingsSnapshot,
};
use rudder_project_goal_link_core::{
    Operation, ProjectGoalLinkCommand, ProjectGoalLinkState, ProjectGoalSetState,
};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use thiserror::Error;

const COMMAND_KIND_BRANDING: &str = "organization_branding";
const COMMAND_KIND_PROJECT_GOAL_LINK: &str = "project_goal_link";
const COMMAND_KIND_PROJECT_GOAL_SET: &str = "project_goal_set_replacement";

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

    pub async fn project_scope(&self, project_id: &str) -> Result<MutationScope, StoreError> {
        let project_id = transaction::uuid(project_id)?.to_owned();
        let organization_id =
            sqlx::query_scalar::<_, String>("SELECT org_id::text FROM projects WHERE id=$1::uuid")
                .bind(&project_id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or(StoreError::NotFound)?;
        self.organization_scope(&organization_id).await
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
        let organization_id =
            sqlx::query_scalar::<_, String>("SELECT org_id::text FROM projects WHERE id=$1::uuid")
                .bind(&project_id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or(StoreError::NotFound)?;
        self.organization_scope_for_idempotency(&organization_id, idempotency_key)
            .await
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
