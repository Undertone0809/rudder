//! Automation definition/trigger management. Execution and scheduling retain
//! their existing owner; these seven commands never dispatch agent work.
mod definitions;
mod projection;
mod schedule;
mod secrets;
mod triggers;
mod validation;

use crate::{
    activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options},
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;
pub use validation::normalize_input;
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
    Secret(#[from] crate::secrets::SecretsError),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Create,
    Update,
    Delete,
    TriggerCreate,
    TriggerUpdate,
    TriggerDelete,
    RotateSecret,
}
impl Operation {
    pub fn is_definition(self) -> bool {
        matches!(
            self,
            Self::Create | Self::Update | Self::Delete | Self::TriggerCreate
        )
    }
}
pub struct Actor<'a> {
    pub kind: &'a str,
    pub id: &'a str,
    pub run_id: Option<&'a str>,
    pub local_implicit: bool,
}
pub struct Command<'a> {
    pub operation: Operation,
    pub organization_id: Option<&'a str>,
    pub id: Option<&'a str>,
    pub input: &'a Value,
    /// Trusted process configuration; never taken from the request Host.
    pub api_url: &'a str,
}
fn http(status: u16, message: impl Into<String>) -> Error {
    Error::Http(status, message.into())
}
fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}
fn uuid(raw: &str) -> Result<String> {
    Uuid::parse_str(raw)
        .map(|u| u.to_string())
        .map_err(|_| http(500, "Internal server error"))
}
fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}
fn random_hex(size: usize) -> Result<String> {
    let mut bytes = vec![0; size];
    getrandom::getrandom(&mut bytes).map_err(|_| http(503, "Secure randomness is unavailable"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub async fn execute(
    pool: &PgPool,
    authorizer: &dyn NativeAgentAuthorizer,
    actor: Actor<'_>,
    command: Command<'_>,
) -> Result<(u16, Value)> {
    if !matches!(actor.kind, "user" | "agent") || actor.id.is_empty() {
        return Err(http(401, "Unauthorized"));
    }
    let input = normalize_input(command.operation, command.input.clone())?;
    let mut tx = pool.begin().await?;
    // Match dispatch's Automation-first lock order; do not acquire an exclusive
    // organization lock behind Node's still-owned Automation dispatch lock.
    let (org, current, trigger) = if command.operation == Operation::Create {
        (
            uuid(
                command
                    .organization_id
                    .ok_or_else(|| http(422, "Invalid organization id"))?,
            )?,
            None,
            None,
        )
    } else {
        let id = uuid(
            command
                .id
                .ok_or_else(|| http(404, "Automation not found"))?,
        )?;
        if command.operation.is_definition() {
            let row = projection::automation(&mut tx, &id, true)
                .await?
                .ok_or_else(|| http(404, "Automation not found"))?;
            (
                text(&row, "orgId").unwrap_or_default().to_owned(),
                Some(row),
                None,
            )
        } else {
            let parent = sqlx::query_scalar::<_, String>(
                "SELECT automation_id::text FROM automation_triggers WHERE id=$1::uuid",
            )
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| http(404, "Automation trigger not found"))?;
            let row = projection::automation(&mut tx, &parent, true)
                .await?
                .ok_or_else(|| http(404, "Automation not found"))?;
            let trigger = projection::trigger(&mut tx, &id, true)
                .await?
                .ok_or_else(|| http(404, "Automation trigger not found"))?;
            if trigger["automationId"] != row["id"] {
                return Err(http(404, "Automation trigger not found"));
            }
            (
                text(&row, "orgId").unwrap_or_default().to_owned(),
                Some(row),
                Some(trigger),
            )
        }
    };
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
    let assignee = current
        .as_ref()
        .and_then(|v| text(v, "assigneeAgentId"))
        .or_else(|| text(&input, "assigneeAgentId"));
    if actor.kind == "agent" && assignee != Some(actor.id) {
        return Err(http(
            403,
            "Agents can only manage automations assigned to themselves",
        ));
    }
    if actor.kind == "agent" && text(&input, "assigneeAgentId").is_some_and(|id| id != actor.id) {
        return Err(http(
            403,
            "Agents can only assign automations to themselves",
        ));
    }
    let needs_assign = matches!(
        command.operation,
        Operation::Create | Operation::TriggerCreate | Operation::TriggerUpdate
    ) || command.operation == Operation::Update
        && current.as_ref().is_some_and(|old| {
            input
                .get("assigneeAgentId")
                .is_some_and(|v| v != &old["assigneeAgentId"])
                || input["status"] == "active" && old["status"] != "active"
        });
    if needs_assign {
        board_can_assign(&mut tx, &org, &actor).await?;
    }
    let result = match command.operation {
        Operation::Create => (
            201,
            definitions::create(&mut tx, &org, &actor, &input).await?,
        ),
        Operation::Update => (
            200,
            definitions::update(&mut tx, &org, &actor, current.as_ref().unwrap(), &input).await?,
        ),
        Operation::Delete => {
            definitions::delete(&mut tx, &org, &actor, current.as_ref().unwrap()).await?;
            (204, Value::Null)
        }
        Operation::TriggerCreate => (
            201,
            triggers::create(
                &mut tx,
                &org,
                &actor,
                current.as_ref().unwrap(),
                &input,
                command.api_url,
            )
            .await?,
        ),
        Operation::TriggerUpdate => (
            200,
            triggers::update(
                &mut tx,
                &org,
                &actor,
                current.as_ref().unwrap(),
                trigger.as_ref().unwrap(),
                &input,
            )
            .await?,
        ),
        Operation::TriggerDelete => {
            triggers::delete(
                &mut tx,
                &org,
                &actor,
                current.as_ref().unwrap(),
                trigger.as_ref().unwrap(),
            )
            .await?;
            (204, Value::Null)
        }
        Operation::RotateSecret => (
            200,
            triggers::rotate(
                &mut tx,
                &org,
                &actor,
                current.as_ref().unwrap(),
                trigger.as_ref().unwrap(),
                command.api_url,
            )
            .await?,
        ),
    };
    tx.commit().await?;
    Ok(result)
}
async fn board_can_assign(tx: &mut Tx<'_>, org: &str, actor: &Actor<'_>) -> Result<()> {
    if actor.kind != "user" || actor.local_implicit {
        return Ok(());
    }
    let allowed=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM instance_user_roles WHERE user_id=$2 AND role='instance_admin') OR (EXISTS(SELECT 1 FROM organization_memberships WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2 AND status='active') AND EXISTS(SELECT 1 FROM principal_permission_grants WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2 AND permission_key='tasks:assign'))").bind(org).bind(actor.id).fetch_one(&mut **tx).await?;
    if allowed {
        Ok(())
    } else {
        Err(http(403, "Missing permission: tasks:assign"))
    }
}
async fn audit(
    tx: &mut Tx<'_>,
    org: &str,
    actor: &Actor<'_>,
    action: &str,
    entity: &str,
    id: &str,
    details: Value,
) -> Result<()> {
    write_activity_options(
        tx,
        ActivityWrite {
            org,
            audit: &ActivityActor {
                actor_type: if actor.kind == "agent" {
                    "agent"
                } else {
                    "user"
                },
                actor_id: actor.id.to_owned(),
                run_id: actor.run_id.map(str::to_owned),
            },
            action,
            entity_type: entity,
            entity_id: id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: (actor.kind == "agent").then_some(actor.id),
                bind_run: true,
                ..ActivityOptions::default()
            },
        },
    )
    .await?;
    Ok(())
}
fn actor_fields(actor: &Actor<'_>, create: bool) -> Value {
    let mut value = json!({"updatedByAgentId":if actor.kind=="agent"{Some(actor.id)}else{None},"updatedByUserId":if actor.kind=="user"{Some(actor.id)}else{None}});
    if create {
        value["createdByAgentId"] = value["updatedByAgentId"].clone();
        value["createdByUserId"] = value["updatedByUserId"].clone();
    }
    value
}
