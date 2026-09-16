//! Private D1 transaction adapter; no routes, listener or ownership acquisition.

mod branding;
mod links;
mod transaction;

use rudder_organization_mutation_core::{
    OrganizationBrandingCommand, OrganizationSettingsSnapshot,
};
use rudder_project_goal_link_core::ProjectGoalLinkCommand;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use thiserror::Error;

/// Created only after the existing authority has authorized the principal.
/// It is deliberately not deserializable and is not an authentication service.
#[derive(Clone, Debug)]
pub struct AuthorizedActor {
    pub(crate) organization_id: String,
    pub(crate) principal_id: String,
    pub(crate) agent: bool,
    pub(crate) run_id: Option<String>,
}
impl AuthorizedActor {
    pub fn board_after_authorization(org: impl Into<String>, principal: impl Into<String>) -> Self {
        Self {
            organization_id: org.into(),
            principal_id: principal.into(),
            agent: false,
            run_id: None,
        }
    }
    /// Optional authenticated run provenance; database scope is still rechecked.
    pub fn with_run_after_authorization(mut self, run_id: impl Into<String>) -> Self {
        self.run_id = Some(run_id.into());
        self
    }
    pub fn agent_after_authorization(org: impl Into<String>, principal: impl Into<String>) -> Self {
        Self {
            organization_id: org.into(),
            principal_id: principal.into(),
            agent: true,
            run_id: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct LinkRequest {
    pub command: ProjectGoalLinkCommand,
    /// Explicit legacy projection, never inferred from an unordered SQL result.
    pub primary_goal_after: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Applied,
    Noop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ResultState {
    OrganizationBranding {
        state: OrganizationSettingsSnapshot,
    },
    ProjectGoalLink {
        project_id: String,
        goal_id: String,
        linked: bool,
        primary_goal_after: Option<String>,
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
    pub async fn branding(
        &self,
        actor: &AuthorizedActor,
        command: OrganizationBrandingCommand,
    ) -> Result<CommittedMutation, StoreError> {
        let meta = transaction::Metadata::branding(actor, &command)?;
        let mut tx = transaction::begin(&self.pool).await?;
        let result = branding::apply(&mut tx, actor, command, &meta).await;
        transaction::finish(tx, result).await
    }
    pub async fn project_goal(
        &self,
        actor: &AuthorizedActor,
        request: LinkRequest,
    ) -> Result<CommittedMutation, StoreError> {
        let meta = transaction::Metadata::link(actor, &request)?;
        let mut tx = transaction::begin(&self.pool).await?;
        let result = links::apply(&mut tx, actor, request, &meta).await;
        transaction::finish(tx, result).await
    }
}
