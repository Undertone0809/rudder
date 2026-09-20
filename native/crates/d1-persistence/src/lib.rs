//! Private SQLx persistence for fenced D1 mutation contracts.
//!
//! This crate is deliberately inert: it has no routes, listeners, ownership
//! acquisition, or Node integration. A caller must supply a command that has
//! already crossed the corresponding trusted core boundary. The adapter only
//! persists that command when PostgreSQL says Rust owns the organization fence.

mod branding;
mod links;
mod transaction;

use rudder_organization_mutation_core::{
    OrganizationBrandingCommand, OrganizationSettingsSnapshot,
};
use rudder_project_goal_link_core::{Operation, ProjectGoalLinkCommand, ProjectGoalLinkState};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use thiserror::Error;

const COMMAND_KIND_BRANDING: &str = "organization_branding";
const COMMAND_KIND_PROJECT_GOAL_LINK: &str = "project_goal_link";

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
}

pub(crate) const fn branding_kind() -> &'static str {
    COMMAND_KIND_BRANDING
}

pub(crate) const fn project_goal_kind() -> &'static str {
    COMMAND_KIND_PROJECT_GOAL_LINK
}
