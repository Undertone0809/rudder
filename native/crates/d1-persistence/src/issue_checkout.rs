//! Transactional Agent and Board Issue checkout authority.

mod native_wakeup;
use native_wakeup::IssueWakeupAdmission;
pub(crate) use native_wakeup::{NativeIssueWakeup, enqueue_native_agent_issue_wakeup};

use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use crate::agent_core::{NativeAgentAccess, NativeAgentAuthorizer};
use rudder_auth_core::VerifiedActor;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::{OffsetDateTime, UtcOffset, format_description::well_known::Rfc3339};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueCheckoutRequest {
    pub org_id: String,
    pub issue_id: String,
    pub agent_id: String,
    pub expected_statuses: Vec<String>,
    pub actor_run_id: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum IssueCheckoutError {
    #[error("{1}")]
    Http(u16, String, Option<Value>),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

type Result<T> = std::result::Result<T, IssueCheckoutError>;
type Tx<'a> = Transaction<'a, Postgres>;

pub(crate) struct IssueWakeupIntent {
    pub(crate) agent_id: String,
    pub(crate) source: &'static str,
    pub(crate) reason: &'static str,
    pub(crate) mutation: String,
    pub(crate) context_source: &'static str,
    pub(crate) wake_source: &'static str,
    pub(crate) role: Option<&'static str>,
    pub(crate) comment: Option<Value>,
    pub(crate) relationship: Option<&'static str>,
    pub(crate) expected_issue_execution_run_id: Option<String>,
    pub(crate) payload_extra: Option<Value>,
    pub(crate) context_extra: Option<Value>,
}

pub(crate) struct IssueWakeupActor<'a> {
    pub(crate) kind: &'a str,
    pub(crate) id: &'a str,
}

struct WakeupAgent<'a> {
    id: &'a str,
    name: &'a str,
    status: &'a str,
    pause_reason: Option<&'a str>,
    runtime_config: &'a Value,
    runtime_type: &'a str,
}

pub async fn execute(
    pool: &PgPool,
    actor: &VerifiedActor,
    request: &IssueCheckoutRequest,
) -> Result<(u16, String)> {
    execute_inner(
        pool,
        actor.actor().kind.as_str(),
        actor.actor().id.as_str(),
        Some(actor.organization_id()),
        None,
        request,
    )
    .await
}

/// Execute the same checkout transaction for an actor authenticated by the
/// public Rust identity boundary. The credential is revalidated on this
/// transaction after the Issue and organization mutation locks are acquired.
pub async fn execute_with_native_auth(
    pool: &PgPool,
    actor_kind: &str,
    actor_id: &str,
    authorizer: &dyn NativeAgentAuthorizer,
    request: &IssueCheckoutRequest,
) -> Result<(u16, String)> {
    execute_inner(pool, actor_kind, actor_id, None, Some(authorizer), request).await
}

async fn execute_inner(
    pool: &PgPool,
    actor_kind: &str,
    actor_id: &str,
    verified_org: Option<&str>,
    native_authorizer: Option<&dyn NativeAgentAuthorizer>,
    request: &IssueCheckoutRequest,
) -> Result<(u16, String)> {
    if uuid::Uuid::parse_str(&request.org_id).is_err()
        || uuid::Uuid::parse_str(&request.issue_id).is_err()
        || request.expected_statuses.is_empty()
        || request.expected_statuses.iter().any(|status| {
            !matches!(
                status.as_str(),
                "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled"
            )
        })
    {
        return Err(http(422, "Invalid issue checkout request"));
    }
    if !matches!(actor_kind, "agent" | "user") {
        return Err(http(403, "Agent or Board authentication required"));
    }
    if verified_org.is_some_and(|org| org != request.org_id) {
        return Err(http(403, "Agent key cannot access another organization"));
    }

    let mut tx = pool.begin().await?;
    let agent_id = resolve_agent_id(&mut tx, &request.org_id, &request.agent_id).await?;
    if actor_kind == "agent" && actor_id != agent_id {
        return Err(http(403, "Agent can only checkout as itself"));
    }
    // Match the public route's authorization ordering: reject an Agent trying
    // to assign another Agent before requiring its own run context.
    let actor_run_id = if actor_kind == "agent" {
        let run_id = request
            .actor_run_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| http(401, "Agent run id required"))?;
        if uuid::Uuid::parse_str(run_id).is_err() {
            return Err(http(403, "Run context is not valid for this issue"));
        }
        Some(run_id)
    } else {
        None
    };
    // Keep the same stable organization mutation order used by AgentCore and
    // the existing Node writers: project -> issue -> agent -> org fence. Agent
    // status is checked only after this ordered lock acquisition so a prior
    // key-share read cannot deadlock with an issue-first writer.
    sqlx::query(
        "SELECT p.id FROM projects p JOIN issues i ON i.project_id=p.id WHERE i.org_id=$1::uuid AND i.id=$2::uuid FOR KEY SHARE",
    )
    .bind(&request.org_id)
    .bind(&request.issue_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("SELECT id FROM issues WHERE org_id=$1::uuid ORDER BY id FOR UPDATE")
        .bind(&request.org_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM agents WHERE org_id=$1::uuid ORDER BY id FOR UPDATE")
        .bind(&request.org_id)
        .execute(&mut *tx)
        .await?;
    if let Some(authorizer) = native_authorizer {
        match authorizer.revalidate(&mut tx, &request.org_id).await? {
            NativeAgentAccess::Authorized => (),
            NativeAgentAccess::Unauthorized => {
                return Err(http(401, "Agent authentication required"));
            }
            NativeAgentAccess::Forbidden => {
                return Err(http(403, "Agent key cannot access another organization"));
            }
        }
    }
    let agent = sqlx::query(
        "SELECT org_id::text, status, pause_reason, name, runtime_config, agent_runtime_type FROM agents WHERE id=$1::uuid",
    )
    .bind(&agent_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(agent) = agent else {
        return Err(if actor_kind == "user" {
            http(404, "Assignee agent not found")
        } else {
            http(401, "Agent authentication required")
        });
    };
    let agent_org: String = agent.try_get("org_id")?;
    let status: String = agent.try_get("status")?;
    let pause_reason: Option<String> = agent.try_get("pause_reason")?;
    if agent_org != request.org_id {
        return Err(if actor_kind == "user" {
            http(422, "Assignee must belong to same organization")
        } else {
            http(403, "Agent key cannot access another organization")
        });
    }
    if actor_kind == "agent" && matches!(status.as_str(), "terminated" | "pending_approval") {
        return Err(http(403, "Agent authentication required"));
    }
    if actor_kind == "user" && status == "pending_approval" {
        return Err(http(409, "Cannot assign work to pending approval agents"));
    }
    if actor_kind == "user" && status == "terminated" {
        return Err(http(409, "Cannot assign work to terminated agents"));
    }
    if sqlx::query_scalar::<_, Option<i64>>(
        "SELECT mutation_version FROM organization_mutation_state WHERE org_id=$1::uuid FOR UPDATE",
    )
    .bind(&request.org_id)
    .fetch_one(&mut *tx)
    .await?
    .is_none()
    {
        return Err(http(
            409,
            "Organization mutation authority is not provisioned",
        ));
    }

    let project_paused = sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE((SELECT p.paused_at IS NOT NULL FROM issues i JOIN projects p ON p.id=i.project_id WHERE i.org_id=$1::uuid AND i.id=$2::uuid), false)",
    )
    .bind(&request.org_id)
    .bind(&request.issue_id)
    .fetch_one(&mut *tx)
    .await?;
    if project_paused {
        return Err(http(409, "Project is paused"));
    }

    let current = current_issue(&mut tx, &request.org_id, &request.issue_id).await?;
    let Some(current) = current else {
        let other_org = sqlx::query_scalar::<_, Option<String>>(
            "SELECT org_id::text FROM issues WHERE id=$1::uuid",
        )
        .bind(&request.issue_id)
        .fetch_one(&mut *tx)
        .await?;
        return Err(if other_org.is_some() {
            http(403, "Issue belongs to another organization")
        } else {
            http(404, "Issue not found")
        });
    };
    let expected = request
        .expected_statuses
        .iter()
        .any(|status| status == &current.status);
    let run_id = actor_run_id.unwrap_or_default();
    let same_run_retry = actor_run_id.is_some()
        && current.assignee_agent_id.as_deref() == Some(agent_id.as_str())
        && current.status == "in_progress"
        && current.checkout_run_id.as_deref() == Some(run_id);
    let null_checkout_adoption = actor_run_id.is_some()
        && current.assignee_agent_id.as_deref() == Some(agent_id.as_str())
        && current.status == "in_progress"
        && current.checkout_run_id.is_none()
        && current
            .execution_run_id
            .as_deref()
            .is_none_or(|id| id == run_id);
    let stale_checkout_adoption = actor_run_id.is_some()
        && current.assignee_agent_id.as_deref() == Some(agent_id.as_str())
        && current.status == "in_progress"
        && current.checkout_run_id.is_some()
        && current.checkout_run_id.as_deref() != Some(run_id);
    if !expected && !same_run_retry && !null_checkout_adoption && !stale_checkout_adoption {
        return Err(conflict(&current));
    }

    let updated = sqlx::query_scalar::<_, String>(
        "UPDATE issues SET assignee_agent_id=$3::uuid, assignee_user_id=NULL, checkout_run_id=$4::uuid, execution_run_id=$4::uuid, status='in_progress', started_at=clock_timestamp(), updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND status = ANY($5::text[]) AND (assignee_agent_id IS NULL OR (assignee_agent_id=$3::uuid AND (checkout_run_id IS NULL OR checkout_run_id=$4::uuid))) AND (execution_run_id IS NULL OR execution_run_id=$4::uuid) RETURNING to_jsonb(issues)::text",
    )
    .bind(&request.org_id)
    .bind(&request.issue_id)
    .bind(&agent_id)
    .bind(actor_run_id)
    .bind(&request.expected_statuses)
    .fetch_optional(&mut *tx)
    .await?;

    let issue_json = if let Some(row) = updated {
        row
    } else if actor_run_id.is_some()
        && current.assignee_agent_id.as_deref() == Some(agent_id.as_str())
        && current.status == "in_progress"
        && current.checkout_run_id.is_none()
        && current
            .execution_run_id
            .as_deref()
            .is_none_or(|id| id == run_id)
    {
        sqlx::query_scalar::<_, String>(
            "UPDATE issues SET checkout_run_id=$3::uuid, execution_run_id=$3::uuid, updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND status='in_progress' AND assignee_agent_id=$4::uuid AND checkout_run_id IS NULL AND (execution_run_id IS NULL OR execution_run_id=$3::uuid) RETURNING to_jsonb(issues)::text",
        )
        .bind(&request.org_id)
        .bind(&request.issue_id)
        .bind(actor_run_id)
    .bind(&agent_id)
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or_else(|| current.raw.clone())
    } else if actor_run_id.is_some()
        && current.assignee_agent_id.as_deref() == Some(agent_id.as_str())
        && current.status == "in_progress"
        && current.checkout_run_id.as_deref() == Some(run_id)
    {
        current.raw.clone()
    } else if actor_run_id.is_some() {
        if let Some(previous_run) = current.checkout_run_id.as_deref() {
            if stale_run(&mut tx, previous_run).await? {
                sqlx::query_scalar::<_, String>(
                "UPDATE issues SET checkout_run_id=$4::uuid, execution_run_id=$4::uuid, execution_locked_at=clock_timestamp(), updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND status='in_progress' AND assignee_agent_id=$3::uuid AND checkout_run_id=$5::uuid RETURNING to_jsonb(issues)::text",
            )
            .bind(&request.org_id)
            .bind(&request.issue_id)
            .bind(&agent_id)
            .bind(actor_run_id)
            .bind(previous_run)
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or_else(|| current.raw.clone())
            } else {
                return Err(conflict(&current));
            }
        } else {
            return Err(conflict(&current));
        }
    } else if actor_run_id.is_none()
        && current.assignee_agent_id.as_deref() == Some(agent_id.as_str())
        && current.status == "in_progress"
        && current.checkout_run_id.is_none()
        && current.execution_run_id.is_none()
    {
        current.raw.clone()
    } else {
        return Err(conflict(&current));
    };
    let checkout_response_issue = issue_json.clone();

    if actor_kind == "user" {
        let name = agent.try_get::<String, _>("name")?;
        let runtime_config = agent.try_get::<Value, _>("runtime_config")?;
        let runtime_type = agent.try_get::<String, _>("agent_runtime_type")?;
        let wakeup_agent = WakeupAgent {
            id: &agent_id,
            name: &name,
            status: &status,
            pause_reason: pause_reason.as_deref(),
            runtime_config: &runtime_config,
            runtime_type: &runtime_type,
        };
        enqueue_board_checkout_wakeup(
            &mut tx,
            &request.org_id,
            &request.issue_id,
            &wakeup_agent,
            actor_id,
        )
        .await?;
    }

    let issue_json = if actor_kind == "user" {
        // The legacy Board endpoint serializes the Issue returned by checkout
        // before its asynchronous wakeup updates execution_run_id.
        checkout_response_issue
    } else {
        sqlx::query_scalar::<_, String>(
            "SELECT to_jsonb(i)::text FROM issues i WHERE i.org_id=$1::uuid AND i.id=$2::uuid",
        )
        .bind(&request.org_id)
        .bind(&request.issue_id)
        .fetch_one(&mut *tx)
        .await?
    };

    let details = json!({"agentId": agent_id});
    let audit = ActivityActor {
        actor_type: if actor_kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor_id.to_owned(),
        run_id: actor_run_id.map(ToOwned::to_owned),
    };
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: &request.org_id,
            audit: &audit,
            action: "issue.checked_out",
            entity_type: "issue",
            entity_id: &request.issue_id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: (actor_kind == "agent").then_some(agent_id.as_str()),
                effects: None,
                bind_run: true,
            },
        },
    )
    .await?;

    let issue = project_issue(&mut tx, &issue_json).await?;
    tx.commit().await?;
    Ok((200, issue.to_string()))
}

async fn resolve_agent_id(tx: &mut Tx<'_>, org: &str, raw: &str) -> Result<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(http(422, "Agent ID is required"));
    }
    if uuid::Uuid::parse_str(raw).is_ok() {
        return Ok(raw.to_owned());
    }
    if raw
        .get(..4)
        .is_some_and(|marker| marker.eq_ignore_ascii_case("agt_"))
    {
        let prefix = &raw[4..];
        let prefix = prefix.to_ascii_lowercase();
        if !(8..=32).contains(&prefix.len()) || !prefix.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(http(
                422,
                "Agent ID must be a UUID or typed agt_<prefix> reference",
            ));
        }
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT id::text FROM agents WHERE org_id=$1::uuid AND replace(lower(id::text),'-','') LIKE $2 || '%' ORDER BY id",
        )
        .bind(org)
        .bind(prefix)
        .fetch_all(&mut **tx)
        .await?;
        return match rows.as_slice() {
            [id] => Ok(id.clone()),
            [] => Err(http(404, "Agent not found")),
            _ => Err(http(
                409,
                "Agent shortname is ambiguous in this organization.",
            )),
        };
    }
    Err(http(
        422,
        "Agent ID must be a UUID or typed agt_<prefix> reference",
    ))
}

/// Preserve the legacy Board checkout wake contract in the same transaction
/// as the Issue assignment. The existing Node heartbeat owner remains the
/// consumer of already persisted `legacy_ts` runs; new wakes use the native owner.
async fn enqueue_board_checkout_wakeup(
    tx: &mut Tx<'_>,
    org: &str,
    issue_id: &str,
    agent: &WakeupAgent<'_>,
    requested_by_user_id: &str,
) -> Result<()> {
    let wakeup = IssueWakeupIntent {
        agent_id: agent.id.to_owned(),
        source: "assignment",
        reason: "issue_checked_out",
        mutation: "checkout".to_owned(),
        context_source: "issue.checkout",
        wake_source: "assignment",
        role: None,
        comment: None,
        relationship: None,
        expected_issue_execution_run_id: None,
        payload_extra: None,
        context_extra: None,
    };
    let requested_by = IssueWakeupActor {
        kind: "user",
        id: requested_by_user_id,
    };
    enqueue_issue_wakeup_with_agent(tx, org, issue_id, agent, &wakeup, &requested_by, None, true)
        .await
        .map(|_| ())
}

/// Admit an assignment or reviewer wakeup in the same transaction as an Issue
/// mutation. New intents use native execution; existing legacy rows retain their owner.
pub(crate) async fn enqueue_issue_core_wakeup(
    tx: &mut Tx<'_>,
    org: &str,
    issue_id: &str,
    wakeup: &IssueWakeupIntent,
    requested_by: &IssueWakeupActor<'_>,
) -> std::result::Result<Option<String>, IssueCheckoutError> {
    let agent = sqlx::query(
        "SELECT name,status,pause_reason,runtime_config,agent_runtime_type FROM agents WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(org)
    .bind(&wakeup.agent_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Agent not found"))?;
    let name = agent.try_get::<String, _>("name")?;
    let status = agent.try_get::<String, _>("status")?;
    let pause_reason = agent.try_get::<Option<String>, _>("pause_reason")?;
    let runtime_config = agent.try_get::<Value, _>("runtime_config")?;
    let runtime_type = agent.try_get::<String, _>("agent_runtime_type")?;
    let wakeup_agent = WakeupAgent {
        id: &wakeup.agent_id,
        name: &name,
        status: &status,
        pause_reason: pause_reason.as_deref(),
        runtime_config: &runtime_config,
        runtime_type: &runtime_type,
    };
    enqueue_issue_wakeup_with_agent(
        tx,
        org,
        issue_id,
        &wakeup_agent,
        wakeup,
        requested_by,
        None,
        true,
    )
    .await
    .map(|admission| admission.run_id)
}

#[allow(clippy::too_many_arguments)] // Preserve the shared Issue admission and native producer transaction boundary.
async fn enqueue_issue_wakeup_with_agent(
    tx: &mut Tx<'_>,
    org: &str,
    issue_id: &str,
    agent: &WakeupAgent<'_>,
    wakeup: &IssueWakeupIntent,
    requested_by: &IssueWakeupActor<'_>,
    native: Option<&NativeIssueWakeup<'_>>,
    native_producer: bool,
) -> std::result::Result<IssueWakeupAdmission, IssueCheckoutError> {
    let native_execution = native_producer || native.is_some();
    if native_execution {
        crate::agent_execution::mark_native_write(tx).await?;
    }
    let source = native.map(|input| input.source).unwrap_or(wakeup.source);
    let wake_reason = native
        .map(|input| input.reason.unwrap_or(""))
        .unwrap_or(wakeup.reason);
    let trigger_detail = native
        .map(|input| input.trigger_detail)
        .unwrap_or(Some("system"));
    let authority = if native_execution {
        "native_rust"
    } else {
        "legacy_ts"
    };
    let wake_on_demand = wake_on_demand_enabled(agent.runtime_config);
    let issue_context = sqlx::query(
        "SELECT i.id::text AS id, i.identifier, i.title, i.description, i.status, i.priority,
                i.goal_id::text AS goal_id, i.project_id::text AS project_id,
                i.execution_run_id::text AS execution_run_id,
                i.assignee_agent_id::text AS assignee_agent_id,
                i.assignee_user_id, i.reviewer_agent_id::text AS reviewer_agent_id,
                i.reviewer_user_id, i.created_at::text AS created_at,
                i.updated_at::text AS updated_at,
                assignee.name AS assignee_name, reviewer.name AS reviewer_name
         FROM issues i
         LEFT JOIN agents assignee ON assignee.org_id=i.org_id AND assignee.id=i.assignee_agent_id
         LEFT JOIN agents reviewer ON reviewer.org_id=i.org_id AND reviewer.id=i.reviewer_agent_id
         WHERE i.org_id=$1::uuid AND i.id=$2::uuid",
    )
    .bind(org)
    .bind(issue_id)
    .fetch_one(&mut **tx)
    .await?;
    let id: String = issue_context.try_get("id")?;
    let identifier: String = issue_context.try_get("identifier")?;
    let title: String = issue_context.try_get("title")?;
    let description: Option<String> = issue_context.try_get("description")?;
    let status: String = issue_context.try_get("status")?;
    let priority: String = issue_context.try_get("priority")?;
    let goal_id: Option<String> = issue_context.try_get("goal_id")?;
    let project_id: Option<String> = issue_context.try_get("project_id")?;
    let execution_run_id: Option<String> = issue_context.try_get("execution_run_id")?;
    let assignee_user_id: Option<String> = issue_context.try_get("assignee_user_id")?;
    let reviewer_agent_id: Option<String> = issue_context.try_get("reviewer_agent_id")?;
    let reviewer_user_id: Option<String> = issue_context.try_get("reviewer_user_id")?;
    let created_at: String = issue_context.try_get("created_at")?;
    let updated_at: String = issue_context.try_get("updated_at")?;
    let assignee_name: Option<String> = issue_context.try_get("assignee_name")?;
    let reviewer_name: Option<String> = issue_context.try_get("reviewer_name")?;
    let assignee_agent_id: Option<String> = issue_context.try_get("assignee_agent_id")?;
    let assignee_label = principal_label(
        "agent",
        assignee_agent_id.as_deref(),
        assignee_name.as_deref(),
    )
    .or_else(|| principal_label("user", assignee_user_id.as_deref(), None))
    .unwrap_or_else(|| "none".to_owned());
    let reviewer_label = principal_label(
        "agent",
        reviewer_agent_id.as_deref(),
        reviewer_name.as_deref(),
    )
    .or_else(|| principal_label("user", reviewer_user_id.as_deref(), None))
    .unwrap_or_else(|| "none".to_owned());
    let issue = json!({
        "id": id,
        "identifier": identifier,
        "title": title,
        "description": description,
        "status": status,
        "priority": priority,
        "assigneeAgentId": assignee_agent_id,
        "assigneeUserId": assignee_user_id,
        "assigneeLabel": assignee_label,
        "reviewerAgentId": reviewer_agent_id,
        "reviewerUserId": reviewer_user_id,
        "reviewerLabel": reviewer_label,
        "createdAt": created_at,
        "updatedAt": updated_at,
    });
    if let Some(expected_run_id) = wakeup.expected_issue_execution_run_id.as_deref() {
        let active_matches = execution_run_id.as_deref() == Some(expected_run_id)
            && (assignee_agent_id.as_deref() == Some(wakeup.agent_id.as_str())
                || reviewer_agent_id.as_deref() == Some(wakeup.agent_id.as_str()))
            && sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid AND agent_id=$3::uuid AND status='running')",
            )
            .bind(org)
            .bind(expected_run_id)
            .bind(&wakeup.agent_id)
            .fetch_one(&mut **tx)
            .await?;
        if !active_matches {
            return Err(http(
                409,
                "The active issue run changed before Steer was accepted",
            ));
        }
    }
    let mut context = json!({
        "issueId": issue_id,
        "taskId": issue_id,
        "taskKey": issue_id,
        "source": wakeup.context_source,
        "wakeSource": wakeup.wake_source,
        "wakeReason": wake_reason,
        "wakeTriggerDetail": "system",
        "issue": issue,
    });
    if let Some(role) = wakeup.role {
        context["role"] = Value::String(role.to_owned());
        if role == "reviewer" {
            let blocked_instructions = if status == "blocked" {
                "The issue is blocked and has been routed to you as reviewer. Decide whether to confirm this as a human/external blocker, request changes, approve, or keep a specific follow-up open. If you confirm the blocker with `blocked`, write the next human action clearly in the review comment; Rudder will record the blocked reviewer decision and remove it from repeated reviewer pickup until the board changes the issue."
            } else {
                "The issue is ready for review."
            };
            context["reviewInstructions"] = Value::String(format!(
                "{blocked_instructions} Record one structured reviewer decision before exiting: approve, request_changes, needs_followup, or blocked. Use `rudder issue review`; do not rely on a free-form comment as the durable outcome. Do not take over implementation unless explicitly asked."
            ));
        }
    }
    if let Some(comment) = wakeup.comment.as_ref() {
        context["commentId"] = comment["id"].clone();
        context["wakeCommentId"] = comment["id"].clone();
        context["comment"] = comment.clone();
    }
    if let Some(relationship) = wakeup.relationship {
        context["relationship"] = Value::String(relationship.to_owned());
    }
    if let Some(project_id) = project_id {
        context["projectId"] = Value::String(project_id);
    }
    if let Some(goal_id) = goal_id.as_ref() {
        context["goalId"] = Value::String(goal_id.clone());
    }
    if let Some(extra) = wakeup.context_extra.as_ref().and_then(Value::as_object) {
        context
            .as_object_mut()
            .expect("context is an object")
            .extend(extra.clone());
    }
    let mut payload = json!({"issueId": issue_id, "mutation": &wakeup.mutation});
    if let Some(comment) = wakeup.comment.as_ref() {
        payload["commentId"] = comment["id"].clone();
    }
    if let Some(extra) = wakeup.payload_extra.as_ref().and_then(Value::as_object) {
        payload
            .as_object_mut()
            .expect("payload is an object")
            .extend(extra.clone());
    }
    if let Some(input) = native {
        let hydrated_issue = context["issue"].clone();
        let project_id = context.get("projectId").cloned();
        let goal_id = context.get("goalId").cloned();
        context = input.context.clone();
        context["issue"] = hydrated_issue;
        context["issueId"] = json!(issue_id);
        context["taskId"] = json!(issue_id);
        if let Some(project_id) = project_id
            && context
                .get("projectId")
                .and_then(Value::as_str)
                .is_none_or(|value| value.trim().is_empty())
        {
            context["projectId"] = project_id;
        }
        if let Some(goal_id) = goal_id
            && context
                .get("goalId")
                .and_then(Value::as_str)
                .is_none_or(|value| value.trim().is_empty())
        {
            context["goalId"] = goal_id;
        }
        payload = input.payload.clone();
    }
    let goal_id = if native_execution {
        context
            .get("goalId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or(goal_id)
    } else {
        goal_id
    };
    let deferred_payload = deferred_wakeup_payload(&payload, &context);

    // Match the legacy heartbeat's invocation preflight before creating a
    // runnable Run or setting the Issue execution pointer. Its policy check is
    // also shared with native Goal admission; blocked Issue wakes are durable
    // terminal `skipped` requests with no Run link.
    let budget_blocked = crate::goal_runs::goal_invocation_budget_blocked(
        tx,
        org,
        &wakeup.agent_id,
        agent.status,
        agent.pause_reason,
    )
    .await?;
    let (mut status, mut reason, mut payload) = if budget_blocked {
        ("skipped", "budget.blocked", payload.clone())
    } else if agent.status == "paused" {
        (
            "deferred_agent_paused",
            wake_reason,
            deferred_payload.clone(),
        )
    } else if !wake_on_demand {
        (
            "skipped",
            "heartbeat.wakeOnDemand.disabled",
            payload.clone(),
        )
    } else {
        ("queued", wake_reason, payload.clone())
    };
    let mut linked_run_id: Option<String> = None;
    let mut expected_response_run_id: Option<String> = None;
    let mut finished = matches!(status, "skipped");

    if status == "queued" {
        let active = sqlx::query(
            "SELECT r.id::text AS id, r.agent_id::text AS agent_id, r.status,
                    r.terminal_effects_pending,r.context_snapshot,r.goal_id::text AS goal_id, COALESCE(r.context_snapshot->>'issueId','') AS issue_id,
                    a.name AS agent_name
             FROM heartbeat_runs r
             JOIN agents a ON a.org_id=r.org_id AND a.id=r.agent_id
             JOIN issues i ON i.org_id=r.org_id AND i.id=$2::uuid
             WHERE r.org_id=$1::uuid
               AND (r.status IN ('queued','running') OR r.terminal_effects_pending=true)
               AND (r.context_snapshot->>'issueId'=$2 OR r.id=i.execution_run_id)
               AND (i.execution_cancellation_at IS NULL OR r.created_at>i.execution_cancellation_at)
             ORDER BY CASE WHEN r.id=i.execution_run_id THEN 0 ELSE 1 END,
                      CASE WHEN r.status='running' THEN 0 ELSE 1 END, r.created_at
             LIMIT 1",
        )
        .bind(org)
        .bind(issue_id)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(active) = active {
            let active_run_id: String = active.try_get("id")?;
            let active_agent_id: String = active.try_get("agent_id")?;
            let active_agent_name: String = active.try_get("agent_name")?;
            let terminal_effects_pending: bool = active.try_get("terminal_effects_pending")?;
            if let Some(expected_run_id) = wakeup.expected_issue_execution_run_id.as_deref() {
                if active_run_id != expected_run_id
                    || active_agent_id != wakeup.agent_id
                    || active.try_get::<String, _>("status")? != "running"
                {
                    return Err(http(
                        409,
                        "The active issue run changed before Steer was accepted",
                    ));
                }
                status = "deferred_issue_execution";
                reason = "issue_execution_deferred";
                payload = deferred_payload.clone();
                expected_response_run_id = Some(active_run_id);
            } else if active_agent_name
                .trim()
                .eq_ignore_ascii_case(agent.name.trim())
                && !terminal_effects_pending
                && !(native_execution
                    && active.try_get::<String, _>("status")? == "running"
                    && context
                        .get("wakeCommentId")
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty()))
            {
                let merged_context = if native_execution {
                    let previous = active
                        .try_get::<Option<Value>, _>("context_snapshot")?
                        .unwrap_or_else(|| json!({}));
                    let previous_goal: Option<String> = active.try_get("goal_id")?;
                    if previous_goal.is_some() && goal_id.is_some() && previous_goal != goal_id {
                        return Err(http(409, "An active run cannot be coalesced across Goals"));
                    }
                    crate::agent_execution::merge_coalesced_context(&previous, &context)
                } else {
                    context.clone()
                };
                sqlx::query(
                    "UPDATE heartbeat_runs SET context_snapshot=COALESCE(context_snapshot,'{}'::jsonb)||$3::jsonb,
                         goal_id=COALESCE(goal_id,$4::uuid),updated_at=clock_timestamp()
                     WHERE org_id=$1::uuid AND id=$2::uuid AND status IN ('queued','running')",
                )
                .bind(org)
                .bind(&active_run_id)
                .bind(merged_context.to_string())
                .bind(&goal_id)
                .execute(&mut **tx)
                .await?;
                status = "coalesced";
                reason = "issue_execution_same_name";
                linked_run_id = Some(active_run_id);
                sqlx::query(
                    "UPDATE issues SET execution_run_id=$3::uuid, execution_agent_name_key=$4,
                         execution_locked_at=COALESCE(execution_locked_at,clock_timestamp()),
                         updated_at=clock_timestamp()
                     WHERE org_id=$1::uuid AND id=$2::uuid",
                )
                .bind(org)
                .bind(issue_id)
                .bind(linked_run_id.as_deref())
                .bind(agent.name.trim().to_lowercase())
                .execute(&mut **tx)
                .await?;
                finished = true;
            } else {
                status = "deferred_issue_execution";
                reason = "issue_execution_deferred";
                payload = deferred_payload.clone();
            }
        }
    }

    if status == "queued" && !native_execution {
        let native_goal_run = sqlx::query_scalar::<_, String>(
            "SELECT id::text FROM heartbeat_runs
             WHERE org_id=$1::uuid AND agent_id=$2::uuid
               AND execution_authority='native_rust' AND goal_id IS NOT NULL
               AND (status IN ('queued','running') OR terminal_effects_pending=true)
             ORDER BY CASE WHEN status='running' THEN 0 ELSE 1 END, created_at
             LIMIT 1",
        )
        .bind(org)
        .bind(&wakeup.agent_id)
        .fetch_optional(&mut **tx)
        .await?;
        if native_goal_run.is_some() {
            status = "deferred_goal_blocked";
            payload = deferred_payload.clone();
        }
    }

    if matches!(status, "deferred_agent_paused" | "deferred_issue_execution") {
        let existing = sqlx::query(
            "SELECT id::text AS id, payload, coalesced_count
             FROM agent_wakeup_requests
             WHERE org_id=$1::uuid AND agent_id=$2::uuid AND status=$3
               AND run_id IS NULL AND payload->>'issueId'=$4 AND execution_authority=$5
             ORDER BY requested_at LIMIT 1
             FOR UPDATE",
        )
        .bind(org)
        .bind(&wakeup.agent_id)
        .bind(status)
        .bind(issue_id)
        .bind(authority)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(existing) = existing {
            let existing_id: String = existing.try_get("id")?;
            let existing_payload: Option<Value> = existing.try_get("payload")?;
            let mut merged_payload =
                merge_deferred_wakeup_payload(existing_payload.as_ref(), &payload);
            if native_execution {
                let old_context = existing_payload
                    .as_ref()
                    .and_then(|value| value.get("_paperclipWakeContext"))
                    .unwrap_or(&Value::Null);
                let incoming_context = payload.get("_paperclipWakeContext").unwrap_or(&Value::Null);
                merged_payload["_paperclipWakeContext"] =
                    crate::agent_execution::merge_coalesced_context(old_context, incoming_context);
            }
            sqlx::query(
                "UPDATE agent_wakeup_requests SET payload=$3::jsonb,
                   coalesced_count=coalesced_count+1,reason=$4,
                   run_id=NULL,claimed_at=NULL,finished_at=NULL,error=NULL,
                   requested_at=CASE WHEN $5='deferred_issue_execution'
                     THEN clock_timestamp() ELSE requested_at END,
                   updated_at=clock_timestamp()
                 WHERE org_id=$1::uuid AND id=$2::uuid",
            )
            .bind(org)
            .bind(&existing_id)
            .bind(merged_payload)
            .bind(reason)
            .bind(status)
            .execute(&mut **tx)
            .await?;
            let run_id = sqlx::query_scalar::<_, Option<String>>(
                "SELECT run_id::text FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid",
            )
            .bind(org)
            .bind(&existing_id)
            .fetch_one(&mut **tx)
            .await?;
            return Ok(IssueWakeupAdmission {
                wakeup_id: existing_id,
                run_id: expected_response_run_id.or(run_id),
                status: status.into(),
            });
        }
    }

    let wakeup_id = sqlx::query_scalar::<_, String>(
        "INSERT INTO agent_wakeup_requests
           (org_id,agent_id,source,trigger_detail,reason,payload,status,execution_authority,
            requested_by_actor_type,requested_by_actor_id,run_id,finished_at,idempotency_key)
         VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7,$12,
            $8,$9,$10::uuid,CASE WHEN $11 THEN clock_timestamp() ELSE NULL END,$13)
         RETURNING id::text",
    )
    .bind(org)
    .bind(&wakeup.agent_id)
    .bind(source)
    .bind(trigger_detail)
    .bind((!reason.is_empty()).then_some(reason))
    .bind(payload.to_string())
    .bind(status)
    .bind(requested_by.kind)
    .bind(requested_by.id)
    .bind(linked_run_id.as_deref())
    .bind(finished)
    .bind(authority)
    .bind(native.and_then(|input| input.idempotency_key))
    .fetch_one(&mut **tx)
    .await?;

    let mut admitted_run_id = linked_run_id.clone();
    if status == "queued" {
        let task_session = sqlx::query(
            "SELECT session_params_json::text AS session_params_json, session_display_id
             FROM agent_task_sessions
             WHERE org_id=$1::uuid AND agent_id=$2::uuid
               AND agent_runtime_type=$3 AND task_key=$4",
        )
        .bind(org)
        .bind(&wakeup.agent_id)
        .bind(agent.runtime_type)
        .bind(issue_id)
        .fetch_optional(&mut **tx)
        .await?;
        let session_params_before = task_session
            .as_ref()
            .and_then(|row| {
                row.try_get::<Option<String>, _>("session_params_json")
                    .ok()
                    .flatten()
            })
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .filter(|value| value.is_object());
        let session_id_before = task_session.as_ref().and_then(|row| {
            row.try_get::<Option<String>, _>("session_display_id")
                .ok()
                .flatten()
                .or_else(|| {
                    session_params_before
                        .as_ref()
                        .and_then(|params| params.get("sessionId"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
                .map(|value| value.chars().take(240).collect::<String>())
        });
        let session_reuse_scope = if session_params_before.is_some() || session_id_before.is_some()
        {
            "task"
        } else {
            "none"
        };
        let (session_params_before, session_id_before, session_reuse_scope) = if native_execution {
            let selected = crate::agent_execution::select_claim_session(
                tx,
                org,
                &wakeup.agent_id,
                agent.runtime_type,
                &context,
            )
            .await?;
            let display = selected.display_id.or_else(|| {
                selected
                    .params
                    .as_ref()
                    .and_then(|value| value.get("sessionId"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            });
            (selected.params, display, selected.reuse_scope)
        } else {
            (
                session_params_before,
                session_id_before,
                session_reuse_scope,
            )
        };
        let run_id = sqlx::query_scalar::<_, String>(
            "INSERT INTO heartbeat_runs
               (org_id,agent_id,invocation_source,trigger_detail,status,wakeup_request_id,
                execution_authority,goal_id,context_snapshot,session_reuse_scope,
                session_id_before,session_params_before_json,scene,target_type,target_id,idempotency_key,session_intent_json)
             VALUES($1::uuid,$2::uuid,$4,$5,'queued',$3::uuid,
                $11,$6::uuid,$7::jsonb,$8,$9,$10::jsonb,
                CASE WHEN $11='native_rust' THEN 'heartbeat' ELSE NULL END,
                CASE WHEN $11='native_rust' THEN 'wakeup_request' ELSE NULL END,
                CASE WHEN $11='native_rust' THEN $3::text ELSE NULL END,
                CASE WHEN $11='native_rust' THEN 'agent-wakeup:'||$3::text ELSE NULL END,$12::jsonb)
             RETURNING id::text",
        )
        .bind(org)
        .bind(&wakeup.agent_id)
        .bind(&wakeup_id)
        .bind(source)
        .bind(trigger_detail)
        .bind(&goal_id)
        .bind(context.to_string())
        .bind(session_reuse_scope)
        .bind(&session_id_before)
        .bind(session_params_before.as_ref().map(Value::to_string))
        .bind(authority)
        .bind(if native_execution {Some(json!({"kind":if session_reuse_scope=="none" {"fresh"} else {"resume"},"reuseScope":session_reuse_scope,"sourceRunId":null,"sessionId":session_id_before,"sessionParams":session_params_before}))} else {None})
        .fetch_one(&mut **tx)
        .await?;
        admitted_run_id = Some(run_id.clone());
        sqlx::query(
            "UPDATE agent_wakeup_requests SET run_id=$3::uuid,updated_at=clock_timestamp()
             WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(org)
        .bind(&wakeup_id)
        .bind(&run_id)
        .execute(&mut **tx)
        .await?;
        sqlx::query(
            "UPDATE issues SET execution_run_id=$3::uuid,execution_agent_name_key=$4,
                 execution_locked_at=clock_timestamp(),updated_at=clock_timestamp()
             WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(org)
        .bind(issue_id)
        .bind(run_id)
        .bind(agent.name.trim().to_lowercase())
        .execute(&mut **tx)
        .await?;
    }
    Ok(IssueWakeupAdmission {
        wakeup_id,
        run_id: expected_response_run_id.or(admitted_run_id),
        status: status.into(),
    })
}

fn wake_on_demand_enabled(runtime_config: &Value) -> bool {
    let heartbeat = runtime_config.get("heartbeat").and_then(Value::as_object);
    [
        "wakeOnDemand",
        "wakeOnAssignment",
        "wakeOnOnDemand",
        "wakeOnAutomation",
    ]
    .into_iter()
    .find_map(|key| heartbeat?.get(key).and_then(Value::as_bool))
    .unwrap_or(true)
}

fn deferred_wakeup_payload(payload: &Value, context: &Value) -> Value {
    let mut payload = payload.as_object().cloned().unwrap_or_default();
    payload.insert("_paperclipWakeContext".to_owned(), context.clone());
    Value::Object(payload)
}

fn merge_deferred_wakeup_payload(existing: Option<&Value>, incoming: &Value) -> Value {
    let mut merged = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut context = merged
        .remove("_paperclipWakeContext")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(incoming) = incoming.as_object() {
        for (key, value) in incoming {
            if key == "_paperclipWakeContext" {
                if let Some(fields) = value.as_object() {
                    context.extend(fields.clone());
                }
            } else {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    merged.insert("_paperclipWakeContext".to_owned(), Value::Object(context));
    Value::Object(merged)
}

fn principal_label(kind: &str, id: Option<&str>, name: Option<&str>) -> Option<String> {
    let id = id?;
    let short = id.replace('-', "");
    let short = short.get(..8).unwrap_or(&short);
    Some(format!(
        "{} ({kind})",
        name.map(str::trim)
            .filter(|name| !name.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!(
                "{} {}",
                if kind == "agent" { "Agent" } else { "User" },
                short
            ))
    ))
}

#[derive(Clone, Debug)]
struct CurrentIssue {
    id: String,
    raw: String,
    status: String,
    assignee_agent_id: Option<String>,
    checkout_run_id: Option<String>,
    execution_run_id: Option<String>,
}

async fn current_issue(tx: &mut Tx<'_>, org: &str, id: &str) -> Result<Option<CurrentIssue>> {
    Ok(sqlx::query_as::<_, (String, String, String, Option<String>, Option<String>, Option<String>)>(
        "SELECT i.id::text, to_jsonb(i)::text, i.status, i.assignee_agent_id::text, i.checkout_run_id::text, i.execution_run_id::text FROM issues i WHERE i.org_id=$1::uuid AND i.id=$2::uuid",
    )
    .bind(org)
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?
    .map(|(id, raw, status, assignee_agent_id, checkout_run_id, execution_run_id)| CurrentIssue {
        id,
        raw,
        status,
        assignee_agent_id,
        checkout_run_id,
        execution_run_id,
    }))
}

pub(crate) async fn stale_run(
    tx: &mut Tx<'_>,
    run_id: &str,
) -> std::result::Result<bool, IssueCheckoutError> {
    let run = sqlx::query_as::<_, (Option<String>, Option<bool>)>(
        "SELECT status, terminal_effects_pending FROM heartbeat_runs WHERE id=$1::uuid",
    )
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(run.is_none_or(|(status, terminal_effects_pending)| {
        is_stale_run(status.as_deref(), terminal_effects_pending)
    }))
}

fn is_stale_run(status: Option<&str>, terminal_effects_pending: Option<bool>) -> bool {
    matches!(
        status,
        Some("succeeded" | "failed" | "cancelled" | "timed_out")
    ) && !terminal_effects_pending.unwrap_or(false)
}

pub(crate) async fn project_issue(tx: &mut Tx<'_>, raw: &str) -> Result<Value> {
    let parsed = crate::legacy_read_json::parse_legacy_read_json(raw)?;
    let mut issue = camelize_issue(parsed);
    let labels = sqlx::query_scalar::<_, Option<String>>(
        "SELECT json_agg(jsonb_build_object('id',l.id,'name',l.name,'color',l.color) ORDER BY l.name,l.id)::text FROM issue_labels il JOIN labels l ON l.id=il.label_id WHERE il.issue_id=(($1::jsonb)->>'id')::uuid",
    )
    .bind(raw)
    .fetch_one(&mut **tx)
    .await?
    .and_then(|value| serde_json::from_str::<Value>(&value).ok())
    .unwrap_or_else(|| json!([]));
    issue["labels"] = labels;
    issue["labelIds"] = issue["labels"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| row["id"].as_str().map(ToOwned::to_owned))
                .map(Value::String)
                .collect::<Vec<_>>()
                .into()
        })
        .unwrap_or_else(|| json!([]));
    Ok(issue)
}

fn camelize_issue(value: Value) -> Value {
    let Value::Object(object) = value else {
        return value;
    };
    let mut output = serde_json::Map::new();
    for (key, value) in object {
        let mut camel = String::new();
        let mut upper = false;
        for character in key.chars() {
            if character == '_' {
                upper = true;
            } else if upper {
                camel.extend(character.to_uppercase());
                upper = false;
            } else {
                camel.push(character);
            }
        }
        let value = if camel.ends_with("At") {
            value
                .as_str()
                .and_then(normalize_timestamp)
                .map(Value::String)
                .unwrap_or(value)
        } else {
            value
        };
        output.insert(camel, value);
    }
    Value::Object(output)
}

fn normalize_timestamp(text: &str) -> Option<String> {
    let utc = OffsetDateTime::parse(text, &Rfc3339)
        .ok()?
        .to_offset(UtcOffset::UTC);
    let rendered = utc.format(&Rfc3339).ok()?;
    let rendered = rendered.trim_end_matches('Z');
    let base = rendered.split('.').next().unwrap_or(rendered);
    Some(format!("{base}.{:03}Z", utc.nanosecond() / 1_000_000))
}

fn conflict(current: &CurrentIssue) -> IssueCheckoutError {
    IssueCheckoutError::Http(
        409,
        "Issue checkout conflict".to_owned(),
        Some(json!({
            "issueId": current.id,
            "status": current.status,
            "assigneeAgentId": current.assignee_agent_id,
            "checkoutRunId": current.checkout_run_id,
            "executionRunId": current.execution_run_id,
        })),
    )
}

fn http(status: u16, message: &'static str) -> IssueCheckoutError {
    IssueCheckoutError::Http(status, message.to_owned(), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_parser_rejects_unknown_fields() {
        let error = serde_json::from_str::<IssueCheckoutRequest>(
            r#"{"orgId":"00000000-0000-4000-8000-000000000001","issueId":"00000000-0000-4000-8000-000000000002","agentId":"agt_00000000","expectedStatuses":["todo"],"actorRunId":null,"unexpected":true}"#,
        )
        .expect_err("unknown fields must not be accepted");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn request_parser_requires_camel_case_contract() {
        let error = serde_json::from_str::<IssueCheckoutRequest>(
            r#"{"org_id":"00000000-0000-4000-8000-000000000001","issueId":"00000000-0000-4000-8000-000000000002","agentId":"agt_00000000","expectedStatuses":["todo"],"actorRunId":null}"#,
        )
        .expect_err("snake_case transport fields must not be accepted");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn same_run_retry_bypasses_expected_statuses() {
        let current = CurrentIssue {
            id: "issue".to_owned(),
            raw: "{}".to_owned(),
            status: "in_progress".to_owned(),
            assignee_agent_id: Some("agent".to_owned()),
            checkout_run_id: Some("run".to_owned()),
            execution_run_id: Some("run".to_owned()),
        };
        let run_id = "run";
        let expected = ["todo"];
        let same_run = current.assignee_agent_id.as_deref() == Some("agent")
            && current.status == "in_progress"
            && current.checkout_run_id.as_deref() == Some(run_id);
        assert!(!expected.contains(&current.status.as_str()));
        assert!(same_run);
    }

    #[test]
    fn timestamp_projection_matches_date_to_json_precision() {
        assert_eq!(
            normalize_timestamp("2026-10-18T03:04:05.123456+00:00"),
            Some("2026-10-18T03:04:05.123Z".to_owned()),
        );
        assert_eq!(
            normalize_timestamp("2026-10-18T03:04:05+00:00"),
            Some("2026-10-18T03:04:05.000Z".to_owned()),
        );
    }

    #[test]
    fn stale_run_requires_terminal_status_without_pending_effects() {
        assert!(is_stale_run(Some("failed"), Some(false)));
        assert!(!is_stale_run(Some("failed"), Some(true)));
        assert!(!is_stale_run(Some("running"), Some(true)));
        assert!(!is_stale_run(Some("unknown"), Some(false)));
    }

    #[test]
    fn deferred_issue_checkout_wakeup_merges_payload_and_latest_context() {
        let existing = json!({
            "issueId": "issue-1",
            "mutation": "checkout",
            "_paperclipWakeContext": {
                "issueId": "issue-1",
                "source": "issue.checkout",
                "previous": true
            }
        });
        let incoming = json!({
            "issueId": "issue-1",
            "mutation": "checkout",
            "_paperclipWakeContext": {
                "issueId": "issue-1",
                "source": "issue.checkout",
                "latest": true
            }
        });

        let merged = merge_deferred_wakeup_payload(Some(&existing), &incoming);
        assert_eq!(merged["issueId"], "issue-1");
        assert_eq!(merged["_paperclipWakeContext"]["previous"], true);
        assert_eq!(merged["_paperclipWakeContext"]["latest"], true);
        assert_eq!(merged["_paperclipWakeContext"]["source"], "issue.checkout");
    }
}
