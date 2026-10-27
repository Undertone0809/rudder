//! Agent Issue-creation request settlement and idempotent existing notification.
use super::TerminalRun;
use crate::{
    activity::{self, ActivityActor, ActivityOptions, ActivityWrite},
    agent_execution::{AgentExecutionError, http},
};
use serde_json::json;
use sqlx::{Postgres, Row, Transaction};

pub(super) async fn settle(
    tx: &mut Transaction<'_, Postgres>,
    run: &TerminalRun,
) -> Result<(), AgentExecutionError> {
    let mut ids = Vec::new();
    for value in [
        run.context.get("agentIssueCreationRequestId"),
        run.context
            .get("agentIssueCreationRequest")
            .and_then(|value| value.get("id")),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(id) = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    if ids.len() > 1 {
        return Err(http(409, "Agent Issue creation run context is ambiguous"));
    }
    let request=sqlx::query("SELECT id::text AS id,status,created_issue_id::text AS created_issue_id,requested_by_user_id FROM agent_issue_creation_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid AND (($4::text IS NOT NULL AND id::text=$4 AND (run_id IS NULL OR run_id=$3::uuid)) OR ($4::text IS NULL AND run_id=$3::uuid)) AND (status IN ('queued','running','deferred') OR (status='succeeded' AND created_issue_id IS NOT NULL)) ORDER BY created_at LIMIT 1 FOR UPDATE")
        .bind(&run.org).bind(&run.agent_id).bind(&run.id).bind(ids.first().copied()).fetch_optional(&mut **tx).await?;
    let Some(request) = request else {
        return Ok(());
    };
    let request_id: String = request.try_get("id")?;
    let created=sqlx::query_scalar::<_,String>("SELECT id::text FROM issues WHERE org_id=$1::uuid AND origin_kind='agent_issue_creation' AND origin_id=$2 AND origin_run_id=$3 AND created_by_agent_id=$4::uuid ORDER BY created_at LIMIT 1")
        .bind(&run.org).bind(&request_id).bind(&run.id).bind(&run.agent_id).fetch_optional(&mut **tx).await?;
    if let Some(issue_id) = created {
        crate::agent_issue_creation::complete_for_created_issue(
            tx,
            &run.org,
            &run.agent_id,
            &run.id,
            &request_id,
            &issue_id,
        )
        .await
        .map_err(|error| match error {
            crate::agent_issue_creation::AgentIssueCreationError::Database(error) => error.into(),
            _ => http(409, "Agent Issue creation terminal lineage changed"),
        })?;
        return Ok(());
    }
    let mismatched:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM issues WHERE org_id=$1::uuid AND origin_kind='agent_issue_creation' AND origin_id=$2)")
        .bind(&run.org).bind(&request_id).fetch_one(&mut **tx).await?;
    if mismatched {
        return Err(http(
            409,
            "Agent Issue creation request remained active after terminal settlement",
        ));
    }
    let next = if run.status == "cancelled" {
        "cancelled"
    } else {
        "failed"
    };
    let error = run
        .error
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if run.status == "succeeded" {
                "Agent run completed without creating an Issue".into()
            } else {
                format!("Agent run {}", run.status)
            }
        });
    let changed=sqlx::query("UPDATE agent_issue_creation_requests SET status=$4,run_id=$3::uuid,error=$5,finished_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND (run_id IS NULL OR run_id=$3::uuid) AND created_issue_id IS NULL AND status IN ('queued','running','deferred')")
        .bind(&run.org).bind(&request_id).bind(&run.id).bind(next).bind(&error).execute(&mut **tx).await?.rows_affected()==1;
    if changed {
        let user: String = request.try_get("requested_by_user_id")?;
        activity::write_activity_idempotent(tx,ActivityWrite{org:&run.org,audit:&ActivityActor{actor_type:"agent",actor_id:run.agent_id.clone(),run_id:Some(run.id.clone())},action:"agent.issue_creation_failed",entity_type:"agent_issue_creation_request",entity_id:&request_id,details:Some(&json!({"requestId":request_id,"requestedByUserId":user,"userId":user,"agentId":run.agent_id,"runId":run.id,"status":next,"error":error,"source":"agent.issue_creation_failed"})),options:ActivityOptions{agent_id:Some(&run.agent_id),..ActivityOptions::default()}},&format!("agent-issue-creation-failed:{request_id}:{}",run.id)).await?;
    }
    Ok(())
}
