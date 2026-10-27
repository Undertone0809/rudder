//! Durable generic Agent execution; public cutover is a separate admission.
//!
//! Existing Goal execution shares its owner primitives with this module. New
//! generic admissions must not become native-owned until their runtime and
//! terminal-effect consumer are installed together.

mod admission;
pub use admission::{AgentExecutionActor, AgentRunAdmission, AgentWakeRequest, admit};
mod budget;
mod claim;
mod context;
pub(crate) use context::merge_coalesced_context;
mod controls;
pub(crate) mod costs;
pub(crate) use controls::cancel_heartbeat_in_transaction;
pub use controls::{cancel, retry};
pub mod lifecycle;
pub(crate) use claim::select_claim_session;
pub use claim::{AgentRunClaim, DueAgentRun, claim_queued_run, list_due_runs};
mod owner;
mod request;
mod resume;
pub use owner::OwnedAgentRun;
pub(crate) use owner::Settlement;
pub use request::{OwnedRequestExecution, SettledRequestProof};

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
}

pub(crate) fn http(status: u16, message: &str) -> AgentExecutionError {
    AgentExecutionError::Http(status, message.to_owned(), None)
}
