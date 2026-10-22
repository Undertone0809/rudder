//! Transactional Agent self-checkout authority.
//!
//! The public Express route remains responsible for selecting the self-checkout
//! branch and for the board/on-behalf compatibility branch. Once this command
//! crosses the signed actor boundary, Rust revalidates the Agent and owns the
//! Issue row, activity, and mutation outbox transaction.

use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use rudder_auth_core::VerifiedActor;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
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

pub async fn execute(
    pool: &PgPool,
    actor: &VerifiedActor,
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
    let run_id = request
        .actor_run_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| http(401, "Agent run id required"))?;
    if uuid::Uuid::parse_str(run_id).is_err() {
        return Err(http(403, "Run context is not valid for this issue"));
    }

    let mut tx = pool.begin().await?;
    let agent_id = resolve_agent_id(&mut tx, &request.org_id, &request.agent_id).await?;
    if actor.actor().kind != "agent" {
        return Err(http(403, "Agent authentication required"));
    }
    if actor.actor().id != agent_id {
        return Err(http(403, "Agent can only checkout as itself"));
    }
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
    let agent = sqlx::query_as::<_, (String, String)>(
        "SELECT org_id::text, status FROM agents WHERE id=$1::uuid",
    )
    .bind(&agent_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((agent_org, status)) = agent else {
        return Err(http(401, "Agent authentication required"));
    };
    if agent_org != request.org_id {
        return Err(http(403, "Agent key cannot access another organization"));
    }
    if matches!(status.as_str(), "terminated" | "pending_approval") {
        return Err(http(403, "Agent authentication required"));
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
    let same_run_retry = current.assignee_agent_id.as_deref() == Some(agent_id.as_str())
        && current.status == "in_progress"
        && current.checkout_run_id.as_deref() == Some(run_id);
    let null_checkout_adoption = current.assignee_agent_id.as_deref() == Some(agent_id.as_str())
        && current.status == "in_progress"
        && current.checkout_run_id.is_none()
        && current
            .execution_run_id
            .as_deref()
            .is_none_or(|id| id == run_id);
    let stale_checkout_adoption = current.assignee_agent_id.as_deref() == Some(agent_id.as_str())
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
    .bind(run_id)
    .bind(&request.expected_statuses)
    .fetch_optional(&mut *tx)
    .await?;

    let issue_json = if let Some(row) = updated {
        row
    } else if current.assignee_agent_id.as_deref() == Some(agent_id.as_str())
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
        .bind(run_id)
    .bind(&agent_id)
        .fetch_optional(&mut *tx)
        .await?
        .unwrap_or_else(|| current.raw.clone())
    } else if current.assignee_agent_id.as_deref() == Some(agent_id.as_str())
        && current.status == "in_progress"
        && current.checkout_run_id.as_deref() == Some(run_id)
    {
        current.raw.clone()
    } else if let Some(previous_run) = current.checkout_run_id.as_deref() {
        if stale_run(&mut tx, previous_run).await? {
            sqlx::query_scalar::<_, String>(
                "UPDATE issues SET checkout_run_id=$4::uuid, execution_run_id=$4::uuid, execution_locked_at=clock_timestamp(), updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND status='in_progress' AND assignee_agent_id=$3::uuid AND checkout_run_id=$5::uuid RETURNING to_jsonb(issues)::text",
            )
            .bind(&request.org_id)
            .bind(&request.issue_id)
            .bind(&agent_id)
            .bind(run_id)
            .bind(previous_run)
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or_else(|| current.raw.clone())
        } else {
            return Err(conflict(&current));
        }
    } else {
        return Err(conflict(&current));
    };

    let details = json!({"agentId": agent_id});
    let audit = ActivityActor {
        actor_type: "agent",
        actor_id: agent_id.clone(),
        run_id: Some(run_id.to_owned()),
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
                agent_id: Some(&agent_id),
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
        return sqlx::query_scalar::<_, String>(
            "SELECT id::text FROM agents WHERE org_id=$1::uuid AND id=$2::uuid AND status<>'terminated'",
        )
        .bind(org)
        .bind(raw)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| http(404, "Agent not found"));
    }
    if raw
        .get(..4)
        .is_some_and(|marker| marker.eq_ignore_ascii_case("agt_"))
    {
        let prefix = &raw[4..];
        let prefix = prefix.to_ascii_lowercase();
        if prefix.len() < 8 || !prefix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(http(422, "Invalid Agent ID"));
        }
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT id::text FROM agents WHERE org_id=$1::uuid AND status<>'terminated' AND replace(lower(id::text),'-','') LIKE $2 || '%' ORDER BY id",
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
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT id::text FROM agents WHERE org_id=$1::uuid AND status<>'terminated' AND lower(trim(name))=lower(trim($2)) ORDER BY id",
    )
    .bind(org)
    .bind(raw)
    .fetch_all(&mut **tx)
    .await?;
    match rows.as_slice() {
        [id] => Ok(id.clone()),
        [] => Err(http(404, "Agent not found")),
        _ => Err(http(
            409,
            "Agent shortname is ambiguous in this organization.",
        )),
    }
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

async fn stale_run(tx: &mut Tx<'_>, run_id: &str) -> Result<bool> {
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

async fn project_issue(tx: &mut Tx<'_>, raw: &str) -> Result<Value> {
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
}
