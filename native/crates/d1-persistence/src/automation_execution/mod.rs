//! Native Automation trigger admission and execution production. These rows
//! retain their existing public contracts; Agent and Chat workers own execution.
mod chat_output;
pub use chat_output::reconcile_chat_outputs;
mod dispatch;
mod schedule;
mod terminal;
mod webhook;
pub use terminal::reconcile_chat_runs;
pub(crate) use terminal::sync_chat_run;

use crate::{
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    automation_management,
};
pub use schedule::tick;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
pub use webhook::{PublicFireInput, fire_public};
type Tx<'a> = Transaction<'a, Postgres>;
type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{1}")]
    Http(u16, String),
    #[error("Validation error")]
    Validation(Value),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Management(#[from] automation_management::Error),
    #[error(transparent)]
    Secret(#[from] crate::secrets::SecretsError),
}
fn http(status: u16, message: impl Into<String>) -> Error {
    Error::Http(status, message.into())
}
fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn id(raw: &str) -> Result<String> {
    Uuid::parse_str(raw)
        .map(|id| id.to_string())
        .map_err(|_| http(500, "Internal server error"))
}

pub struct Host<'a> {
    pub chat: Option<&'a crate::native_chat::config::LocalHostContext>,
}

/// No constructor outside this module: only a locked Automation and a run
/// created after its caller/trigger authorization can reach internal producers.
pub(crate) struct LockedAutomationDispatch {
    automation: Value,
    run_id: String,
    source: String,
    payload: Value,
    trigger_id: Option<String>,
}
impl LockedAutomationDispatch {
    pub(crate) fn automation(&self) -> &Value {
        &self.automation
    }
    pub(crate) fn org(&self) -> &str {
        text(&self.automation, "orgId").expect("persisted Automation organization")
    }
    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }
    pub(crate) fn source(&self) -> &str {
        &self.source
    }
    pub(crate) fn trigger_id(&self) -> Option<&str> {
        self.trigger_id.as_deref()
    }
    pub(crate) fn payload(&self) -> &Value {
        &self.payload
    }
}

pub async fn run_manual(
    pool: &PgPool,
    authorizer: &dyn NativeAgentAuthorizer,
    actor: automation_management::Actor<'_>,
    automation_id: &str,
    input: &Value,
    host: &Host<'_>,
) -> Result<Value> {
    if !matches!(actor.kind, "user" | "agent") || actor.id.is_empty() {
        return Err(http(401, "Unauthorized"));
    }
    let input = normalize_run(input)?;
    let automation_id = id(automation_id)?;
    let mut tx = pool.begin().await?;
    let automation = automation_management::projection::automation(&mut tx, &automation_id, true)
        .await?
        .ok_or_else(|| http(404, "Automation not found"))?;
    let org = text(&automation, "orgId").unwrap_or_default().to_owned();
    match authorizer.revalidate(&mut tx, &org).await? {
        NativeAgentAccess::Authorized => (),
        NativeAgentAccess::Unauthorized => return Err(http(401, "Unauthorized")),
        NativeAgentAccess::Forbidden => {
            return Err(http(
                403,
                if actor.kind == "agent" {
                    "Agent cannot access this organization"
                } else {
                    "User does not have access to this organization"
                },
            ));
        }
    }
    if actor.kind == "agent" && text(&automation, "assigneeAgentId") != Some(actor.id) {
        return Err(http(
            403,
            "Agents can only manage automations assigned to themselves",
        ));
    }
    automation_management::board_can_assign(&mut tx, &org, &actor).await?;
    if automation["status"] != "active" {
        return Err(http(409, "Automation is not active"));
    }
    let trigger = if let Some(trigger_id) = text(&input, "triggerId") {
        let trigger = automation_management::projection::trigger(&mut tx, trigger_id, true).await?;
        if let Some(trigger) = &trigger {
            if trigger["automationId"] != automation["id"] {
                return Err(http(403, "Trigger does not belong to automation"));
            }
            if trigger["enabled"] != true {
                return Err(http(409, "Automation trigger is not active"));
            }
        }
        trigger
    } else {
        None
    };
    let value = dispatch::dispatch(
        &mut tx,
        automation,
        trigger.as_ref(),
        text(&input, "source").unwrap(),
        input.get("payload"),
        text(&input, "idempotencyKey"),
        host,
    )
    .await?;
    dispatch::audit(&mut tx, &org, &actor.kind, actor.id, actor.run_id, &value).await?;
    tx.commit().await?;
    Ok(value)
}

pub fn normalize_run_input(input: Value) -> Result<Value> {
    automation_management::normalize_run_input(input).map_err(Error::from)
}
fn normalize_run(input: &Value) -> Result<Value> {
    normalize_run_input(input.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manual_run_shape_matches_current_node_schema_goldens() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("run-validation-cases.json")).unwrap();
        assert_eq!(cases.len(), 15);
        for case in cases {
            let result = normalize_run(&case["input"]);
            if let Some(expected) = case.get("output") {
                assert_eq!(result.unwrap(), *expected);
            } else {
                match result {
                    Err(Error::Management(automation_management::Error::Validation(issues))) => {
                        assert_eq!(issues, case["issues"])
                    }
                    other => panic!("unexpected validation result: {other:?}"),
                }
            }
        }
    }
}
