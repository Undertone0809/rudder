//! Agent-created Issue request lineage, settlement, and the existing notification.
//! Request scheduling remains a separate owner; public Issue creation calls these
//! operations inside its already-authorized transaction.
use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_idempotent};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};

#[derive(Debug, thiserror::Error)]
pub enum AgentIssueCreationError {
    #[error("{0}")]
    Forbidden(&'static str),
    #[error("{0}")]
    Conflict(&'static str),
    #[error("database transaction failed")]
    Database(#[from] sqlx::Error),
}

fn request_ids(context: &Value) -> Vec<&str> {
    let mut ids = Vec::new();
    if let Some(object) = context.as_object() {
        for value in [
            object.get("agentIssueCreationRequestId"),
            object
                .get("agentIssueCreationRequest")
                .and_then(Value::as_object)
                .and_then(|nested| nested.get("id")),
        ] {
            if let Some(id) = value.and_then(Value::as_str).map(str::trim)
                && !id.is_empty()
                && !ids.contains(&id)
            {
                ids.push(id);
            }
        }
    }
    ids
}

fn terminal_run(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "cancelled" | "timed_out")
}

/// Preserve the public route's ambiguous-context 403 and the service's
/// mismatched/terminal-request 409 before an Issue row or counter is written.
pub async fn resolve_for_run(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    agent_id: &str,
    run_id: &str,
) -> Result<Option<String>, AgentIssueCreationError> {
    let Some(run) = sqlx::query(
        "SELECT org_id::text, agent_id::text, status, context_snapshot
         FROM heartbeat_runs WHERE id=$1::uuid",
    )
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?
    else {
        return Ok(None);
    };
    let context: Option<Value> = run.try_get("context_snapshot")?;
    let context = context.unwrap_or(Value::Null);
    let ids = request_ids(&context);
    if ids.len() > 1 {
        return Err(AgentIssueCreationError::Forbidden(
            "Agent Issue creation run context is ambiguous",
        ));
    }
    let run_org: String = run.try_get("org_id")?;
    let run_agent: String = run.try_get("agent_id")?;
    if run_org != org_id || run_agent != agent_id {
        return if ids.is_empty() {
            Ok(None)
        } else {
            Err(AgentIssueCreationError::Forbidden(
                "Agent Issue creation run context does not belong to this organization and Agent",
            ))
        };
    }
    let persisted: Option<String> = sqlx::query_scalar(
        "SELECT id::text FROM agent_issue_creation_requests
         WHERE org_id=$1::uuid AND agent_id=$2::uuid AND run_id=$3::uuid
           AND status IN ('queued','running','deferred') LIMIT 1 FOR UPDATE",
    )
    .bind(org_id)
    .bind(agent_id)
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?;
    if ids.is_empty() && persisted.is_none() {
        return Ok(None);
    }
    if terminal_run(&run.try_get::<String, _>("status")?) {
        return Err(AgentIssueCreationError::Conflict(
            "Agent Issue creation run is already terminal",
        ));
    }
    if let Some(persisted) = persisted {
        if ids.first().is_some_and(|id| *id != persisted) {
            return Err(AgentIssueCreationError::Conflict(
                "Agent Issue creation request does not match the active run",
            ));
        }
        return Ok(Some(persisted));
    }
    let Some(request_id) = ids.first() else {
        return Ok(None);
    };
    let matched: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM agent_issue_creation_requests
         WHERE id=$1::uuid AND org_id=$2::uuid AND agent_id=$3::uuid
           AND (run_id IS NULL OR run_id=$4::uuid)
           AND status IN ('queued','running','deferred'))",
    )
    .bind(request_id)
    .bind(org_id)
    .bind(agent_id)
    .bind(run_id)
    .fetch_one(&mut **tx)
    .await?;
    if !matched {
        return Err(AgentIssueCreationError::Conflict(
            "Agent Issue creation request does not match the active run",
        ));
    }
    Ok(Some((*request_id).to_owned()))
}

/// Settle only the exact source Issue and publish its existing idempotent
/// activity/outbox notification. No second request history or queue is created.
pub async fn complete_for_created_issue(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    agent_id: &str,
    run_id: &str,
    request_id: &str,
    issue_id: &str,
) -> Result<(), AgentIssueCreationError> {
    sqlx::query(
        "UPDATE agent_issue_creation_requests request
         SET status='succeeded', run_id=$3::uuid, created_issue_id=$5::uuid,
             finished_at=clock_timestamp(), error=NULL, updated_at=clock_timestamp()
         WHERE request.org_id=$1::uuid AND request.agent_id=$2::uuid
           AND request.id=$4::uuid AND (request.run_id IS NULL OR request.run_id=$3::uuid)
           AND request.created_issue_id IS NULL
           AND request.status IN ('queued','running','deferred')
           AND EXISTS (SELECT 1 FROM issues i WHERE i.id=$5::uuid AND i.org_id=$1::uuid
             AND i.origin_kind='agent_issue_creation' AND i.origin_id=$4::text
             AND i.origin_run_id=$3::text AND i.created_by_agent_id=$2::uuid)",
    )
    .bind(org_id)
    .bind(agent_id)
    .bind(run_id)
    .bind(request_id)
    .bind(issue_id)
    .execute(&mut **tx)
    .await?;
    let Some(row) = sqlx::query(
        "SELECT request.requested_by_user_id, i.identifier, i.title, a.name AS agent_name
         FROM agent_issue_creation_requests request
         JOIN issues i ON i.id=request.created_issue_id AND i.org_id=request.org_id
         JOIN agents a ON a.id=request.agent_id AND a.org_id=request.org_id
         WHERE request.org_id=$1::uuid AND request.agent_id=$2::uuid
           AND request.run_id=$3::uuid AND request.id=$4::uuid
           AND request.created_issue_id=$5::uuid AND request.status='succeeded'
           AND i.origin_kind='agent_issue_creation' AND i.origin_id=$4::text
           AND i.origin_run_id=$3::text AND i.created_by_agent_id=$2::uuid",
    )
    .bind(org_id)
    .bind(agent_id)
    .bind(run_id)
    .bind(request_id)
    .bind(issue_id)
    .fetch_optional(&mut **tx)
    .await?
    else {
        return Ok(());
    };
    let audit = ActivityActor {
        actor_type: "agent",
        actor_id: agent_id.to_owned(),
        run_id: Some(run_id.to_owned()),
    };
    let details = json!({
        "issueId":issue_id,
        "identifier":row.try_get::<Option<String>, _>("identifier")?,
        "title":row.try_get::<Option<String>, _>("title")?,
        "agentId":agent_id,
        "agentName":row.try_get::<Option<String>, _>("agent_name")?,
        "requestId":request_id,
        "userId":row.try_get::<String, _>("requested_by_user_id")?,
        "source":"agent.issue_created_notification"
    });
    write_activity_idempotent(
        tx,
        ActivityWrite {
            org: org_id,
            audit: &audit,
            action: "agent.issue_created_notification",
            entity_type: "issue",
            entity_id: issue_id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: Some(agent_id),
                ..Default::default()
            },
        },
        &format!("agent-issue-created-notification:{request_id}"),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_context_ignores_non_objects_and_deduplicates_trimmed_request_ids() {
        assert!(request_ids(&json!([{"agentIssueCreationRequestId":"wrong"}])).is_empty());
        assert_eq!(
            request_ids(&json!({"agentIssueCreationRequestId":" request ",
            "agentIssueCreationRequest":{"id":"request"}})),
            vec!["request"]
        );
        assert_eq!(
            request_ids(&json!({"agentIssueCreationRequestId":"first",
            "agentIssueCreationRequest":{"id":"second"}})),
            vec!["first", "second"]
        );
        assert!(!terminal_run("running"));
        assert!(terminal_run("timed_out"));
    }
}
