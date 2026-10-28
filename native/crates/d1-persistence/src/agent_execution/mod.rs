//! Durable generic Agent execution; public cutover is a separate admission.
//!
//! Existing Goal execution shares its owner primitives with this module. New
//! generic admissions must not become native-owned until their runtime and
//! terminal-effect consumer are installed together.

mod admission;
mod analytics;
mod approvals;
pub use admission::{AgentExecutionActor, AgentRunAdmission, AgentWakeRequest, admit};
pub(crate) use approvals::insert_runtime_approval;
pub use approvals::{RuntimeApproval, create_runtime_approval, read_runtime_approval};
pub mod attempts;
mod budget;
mod claim;
mod context;
mod followups;
pub mod settlement;
pub(crate) use context::merge_coalesced_context;
mod controls;
pub(crate) mod costs;
pub(crate) use controls::cancel_heartbeat_in_transaction;
pub use controls::{cancel, retry};
pub mod lifecycle;
pub(crate) use claim::select_claim_session;
pub use claim::{
    AgentRunClaim, DueAgentRun, claim_network_waiting_run, claim_queued_run, list_due_runs,
};
pub mod model_attempts;
pub mod network;
pub mod output;
mod owner;
mod pending;
pub use pending::resume_pending;
pub mod recovery;
mod request;
mod resume;
mod timer_preflight;
mod usage;
pub(crate) use owner::Settlement;
pub use owner::{AgentRunObserver, OwnedAgentRun};
pub use request::{OwnedRequestExecution, SettledRequestProof, record_request_started};

use sqlx::{Postgres, Transaction};

pub(crate) async fn mark_native_write(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:agent_execution',true)")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum AgentExecutionError {
    #[error("{1}")]
    Http(u16, String, Option<serde_json::Value>),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Goal(#[from] crate::goal_runs::GoalRunError),
    #[error(transparent)]
    Cost(#[from] crate::goal_costs::GoalCostError),
    #[error(transparent)]
    Budget(#[from] crate::goal_budget::GoalBudgetError),
}

pub(crate) fn http(status: u16, message: &str) -> AgentExecutionError {
    AgentExecutionError::Http(status, message.to_owned(), None)
}

// Constructed only by the transactional Goal producer. Public wake input cannot
// select the old Goal owner or impersonate this producer.
pub(crate) const GOAL_PRODUCER_KEY: &str = "_rudderExecutionProducer";
pub(crate) const GOAL_PRODUCER_VERSION: &str = "goal_start_v1";
pub(crate) fn has_generic_producer(payload: &serde_json::Value) -> bool {
    payload.get(GOAL_PRODUCER_KEY).is_some()
}

pub(crate) async fn goal_producer_is_current(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    agent: &str,
    payload: &serde_json::Value,
) -> Result<bool, sqlx::Error> {
    if payload
        .get(GOAL_PRODUCER_KEY)
        .and_then(serde_json::Value::as_str)
        != Some(GOAL_PRODUCER_VERSION)
    {
        return Ok(true);
    }
    let goal = payload.get("goalId").and_then(serde_json::Value::as_str);
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM goals WHERE org_id=$1::uuid AND id=$2::uuid AND owner_agent_id=$3::uuid AND status='active' AND lifecycle='active')")
        .bind(org).bind(goal).bind(agent).fetch_one(&mut **tx).await
}
