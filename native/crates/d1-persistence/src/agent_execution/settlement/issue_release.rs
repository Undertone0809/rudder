//! Release/promote the exact Issue execution pointer after terminal effects.
mod passive;

use super::TerminalRun;
use crate::{
    activity::{self, ActivityActor, ActivityOptions, ActivityWrite},
    agent_execution::{
        AgentExecutionError, context,
        followups::{self, Followup},
        http,
    },
};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};

pub(super) struct Issue {
    pub id: String,
    pub status: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: String,
    pub project_id: Option<String>,
    pub assignee: Option<String>,
    pub reviewer: Option<String>,
    pub reviewer_user: Option<String>,
    pub origin_kind: Option<String>,
    pub origin_run: Option<String>,
    pub identifier: Option<String>,
}

pub(super) async fn settle(
    tx: &mut Transaction<'_, Postgres>,
    run: &TerminalRun,
) -> Result<(), AgentExecutionError> {
    let row=sqlx::query("SELECT id::text AS id,status,title,description,priority,project_id::text AS project_id,assignee_agent_id::text AS assignee,reviewer_agent_id::text AS reviewer,reviewer_user_id,origin_kind,origin_run_id,identifier FROM issues WHERE org_id=$1::uuid AND execution_run_id=$2::uuid ORDER BY id LIMIT 1 FOR UPDATE")
        .bind(&run.org).bind(&run.id).fetch_optional(&mut **tx).await?;
    let Some(row) = row else {
        return Ok(());
    };
    let mut issue = Issue {
        id: row.try_get("id")?,
        status: row.try_get("status")?,
        title: row.try_get("title")?,
        description: row.try_get("description")?,
        priority: row.try_get("priority")?,
        project_id: row.try_get("project_id")?,
        assignee: row.try_get("assignee")?,
        reviewer: row.try_get("reviewer")?,
        reviewer_user: row.try_get("reviewer_user_id")?,
        origin_kind: row.try_get("origin_kind")?,
        origin_run: row.try_get("origin_run_id")?,
        identifier: row.try_get("identifier")?,
    };
    let chat_output = complete_chat_output(tx, run, &issue).await?;
    if chat_output {
        issue.status = "done".into();
    }
    if !chat_output && passive::settle(tx, run, &issue).await? {
        return Ok(());
    }
    sqlx::query("UPDATE issues SET execution_run_id=NULL,execution_agent_name_key=NULL,execution_locked_at=NULL,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND execution_run_id=$3::uuid")
        .bind(&run.org).bind(&issue.id).bind(&run.id).execute(&mut **tx).await?;
    loop {
        // Legacy intents keep their existing owner during the drain. This
        // consumer never changes execution_authority to seize an old request.
        let wake=sqlx::query("SELECT w.id::text AS id,w.agent_id::text AS agent_id,w.source,w.trigger_detail,w.reason,w.payload,COALESCE(w.requested_at<=i.execution_cancellation_at,false) AS fenced FROM agent_wakeup_requests w JOIN issues i ON i.org_id=w.org_id AND i.id=$2::uuid WHERE w.org_id=$1::uuid AND w.execution_authority='native_rust' AND w.status='deferred_issue_execution' AND w.run_id IS NULL AND w.payload->>'issueId'=$2 ORDER BY w.requested_at,w.id LIMIT 1 FOR UPDATE OF w")
            .bind(&run.org).bind(&issue.id).fetch_optional(&mut **tx).await?;
        let Some(wake) = wake else {
            audit(
                tx,
                run,
                &issue,
                "issue.execution_released",
                "terminal_effects",
                "info",
                "Issue execution released after terminal run",
                json!({"issueId":issue.id,"sourceRunId":run.id}),
            )
            .await?;
            return Ok(());
        };
        let wake_id: String = wake.try_get("id")?;
        let payload = wake
            .try_get::<Option<Value>, _>("payload")?
            .unwrap_or_else(|| json!({}));
        let seed = payload
            .get("_paperclipWakeContext")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let reason: Option<String> = wake.try_get("reason")?;
        if wake.try_get::<bool, _>("fenced")?
            || (matches!(issue.status.as_str(), "done" | "cancelled")
                && !context::comment_mention(reason.as_deref(), &seed, &payload))
        {
            sqlx::query("UPDATE agent_wakeup_requests SET status='cancelled',finished_at=statement_timestamp(),error='Cancelled because the linked Issue is no longer actionable',updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
                .bind(&run.org).bind(&wake_id).execute(&mut **tx).await?;
            continue;
        }
        let agent_id: String = wake.try_get("agent_id")?;
        let status: Option<String> = sqlx::query_scalar(
            "SELECT status FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
        )
        .bind(&run.org)
        .bind(&agent_id)
        .fetch_optional(&mut **tx)
        .await?;
        if status
            .as_deref()
            .is_none_or(|value| matches!(value, "paused" | "terminated" | "pending_approval"))
        {
            sqlx::query("UPDATE agent_wakeup_requests SET status='failed',finished_at=statement_timestamp(),error='Deferred wake could not be promoted: agent is not invokable',updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
                .bind(&run.org).bind(&wake_id).execute(&mut **tx).await?;
            continue;
        }
        let source: String = wake.try_get("source")?;
        let detail: Option<String> = wake.try_get("trigger_detail")?;
        let mut payload = payload;
        payload
            .as_object_mut()
            .expect("deferred payload normalized")
            .remove("_paperclipWakeContext");
        let snapshot = context::enrich_wake_context(
            seed,
            &payload,
            &source,
            detail.as_deref(),
            reason.as_deref(),
        );
        let admission = followups::enqueue(
            tx,
            Followup {
                org: &run.org,
                agent_id: &agent_id,
                issue_id: Some(&issue.id),
                source: &source,
                trigger_detail: detail.as_deref(),
                reason: "issue_execution_promoted",
                payload: &payload,
                context: &snapshot,
                idempotency_key: None,
                existing_wakeup_id: Some(&wake_id),
                actor_id: None,
                delay_seconds: 0,
                retry_of: None,
                process_loss_count: 0,
            },
        )
        .await?;
        audit(tx,run,&issue,"issue.execution_promoted","terminal_effects","info","Issue execution promoted after terminal run",json!({"issueId":issue.id,"sourceRunId":run.id,"promotedRunId":admission.run_id,"wakeupRequestId":wake_id})).await?;
        return Ok(());
    }
}

async fn complete_chat_output(
    tx: &mut Transaction<'_, Postgres>,
    run: &TerminalRun,
    issue: &Issue,
) -> Result<bool, AgentExecutionError> {
    if run.status != "succeeded"
        || issue.origin_kind.as_deref() != Some("automation_execution")
        || !matches!(issue.status.as_str(), "todo" | "in_progress")
    {
        return Ok(false);
    }
    let row=sqlx::query("SELECT a.id::text AS automation_id,a.title,r.id::text AS automation_run_id FROM automation_runs r JOIN automations a ON a.org_id=r.org_id AND a.id=r.automation_id WHERE r.org_id=$1::uuid AND r.id::text=$2 AND a.output_mode='chat_output'")
        .bind(&run.org).bind(issue.origin_run.as_deref()).fetch_optional(&mut **tx).await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let automation: String = row.try_get("automation_id")?;
    let automation_run: String = row.try_get("automation_run_id")?;
    let title: String = row.try_get("title")?;
    sqlx::query("UPDATE issues SET status='done',completed_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&run.org).bind(&issue.id).execute(&mut **tx).await?;
    sqlx::query("UPDATE automation_runs SET status='completed',completed_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&run.org).bind(&automation_run).execute(&mut **tx).await?;
    activity::write_activity_options(tx,ActivityWrite{org:&run.org,audit:&ActivityActor{actor_type:"system",actor_id:"automation_chat_output".into(),run_id:Some(run.id.clone())},action:"issue.updated",entity_type:"issue",entity_id:&issue.id,details:Some(&json!({"status":"done","identifier":issue.identifier,"automationId":automation,"automationTitle":title,"automationRunId":automation_run,"closeoutReason":"chat_output_run_succeeded","_previous":{"status":issue.status}})),options:ActivityOptions{agent_id:Some(&run.agent_id),..ActivityOptions::default()}}).await?;
    Ok(true)
}

#[allow(clippy::too_many_arguments)] // Keep the transaction-bound audit identity and payload together.
pub(super) async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    run: &TerminalRun,
    issue: &Issue,
    action: &str,
    actor_id: &str,
    level: &str,
    message: &str,
    details: Value,
) -> Result<(), AgentExecutionError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(&run.id)
        .execute(&mut **tx)
        .await?;
    let key = format!("{action}:{}", run.id);
    sqlx::query("INSERT INTO heartbeat_run_events(org_id,run_id,agent_id,seq,event_type,stream,level,message,payload,idempotency_key) SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE((SELECT max(seq) FROM heartbeat_run_events WHERE run_id=$2::uuid),0)+1,$4,'system',$5,$6,$7::jsonb,$8 ON CONFLICT(run_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING")
        .bind(&run.org).bind(&run.id).bind(&run.agent_id).bind(action).bind(level).bind(message).bind(&details).bind(&key).execute(&mut **tx).await?;
    activity::write_activity_idempotent(
        tx,
        ActivityWrite {
            org: &run.org,
            audit: &ActivityActor {
                actor_type: "system",
                actor_id: actor_id.into(),
                run_id: Some(run.id.clone()),
            },
            action,
            entity_type: "issue",
            entity_id: &issue.id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: Some(&run.agent_id),
                ..ActivityOptions::default()
            },
        },
        &format!("{}:{key}", run.id),
    )
    .await?;
    Ok(())
}

pub(super) async fn process_loss_retry(
    tx: &mut Transaction<'_, Postgres>,
    run: &TerminalRun,
) -> Result<(), AgentExecutionError> {
    if run.error_code.as_deref() != Some("process_lost")
        || !matches!(
            run.runtime_type.as_str(),
            "claude_local" | "codex_local" | "cursor" | "opencode_local" | "pi_local"
        )
    {
        return Ok(());
    }
    let row=sqlx::query("SELECT process_pid,process_loss_retry_count,source_run_id::text AS source_run_id FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&run.org).bind(&run.id).fetch_one(&mut **tx).await?;
    if row.try_get::<Option<i32>, _>("process_pid")?.is_none()
        || row.try_get::<i32, _>("process_loss_retry_count")? >= 1
    {
        return Ok(());
    }
    let issue_id = context::nonempty(run.context.get("issueId"));
    if let Some(issue_id) = issue_id.as_deref() {
        let issue=sqlx::query("SELECT i.status,i.execution_run_id::text AS execution_run_id,COALESCE(r.created_at<=i.execution_cancellation_at,false) AS fenced,i.execution_cancellation_at IS NOT NULL AS has_fence FROM issues i JOIN heartbeat_runs r ON r.org_id=i.org_id AND r.id=$3::uuid WHERE i.org_id=$1::uuid AND i.id=$2::uuid FOR UPDATE OF i")
            .bind(&run.org).bind(issue_id).bind(&run.id).fetch_optional(&mut **tx).await?;
        if let Some(issue) = issue {
            if issue.try_get::<bool, _>("fenced")?
                || (issue.try_get::<String, _>("status")? == "cancelled"
                    && !issue.try_get::<bool, _>("has_fence")?)
            {
                return Ok(());
            }
            if let Some(active) = issue.try_get::<Option<String>, _>("execution_run_id")?
                && active != run.id
            {
                return Err(http(409, "Issue already has an active execution run"));
            }
        }
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("heartbeat-run-retry:{}", run.id))
        .execute(&mut **tx)
        .await?;
    let existing:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid AND retry_of_run_id=$3::uuid AND (status IN ('queued','running') OR terminal_effects_pending=true))")
        .bind(&run.org).bind(&run.agent_id).bind(&run.id).fetch_one(&mut **tx).await?;
    if existing {
        return Ok(());
    }
    let mut snapshot = run.context.clone();
    snapshot["wakeReason"] = json!("process_lost_retry");
    snapshot["wakeSource"] = json!("recovery.automatic");
    snapshot["wakeTriggerDetail"] = json!("system");
    snapshot["retryOfRunId"] = json!(run.id);
    snapshot["retryReason"] = json!("process_lost");
    snapshot["recovery"] = json!({"originalRunId":run.id,"failureKind":"process_lost","failureSummary":run.error.as_deref().unwrap_or("The previous run failed before it completed."),"recoveryTrigger":"automatic","recoveryMode":"continue_preferred"});
    let payload = json!({"originalRunId":run.id,"failureKind":"process_lost","recoveryTrigger":"automatic","resumeFromRunId":run.id,"issueId":issue_id});
    crate::agent_execution::resume::hydrate_explicit_resume(
        tx,
        &run.org,
        &run.agent_id,
        &run.runtime_type,
        &payload,
        &mut snapshot,
    )
    .await?;
    let admission = followups::enqueue(
        tx,
        Followup {
            org: &run.org,
            agent_id: &run.agent_id,
            issue_id: issue_id.as_deref(),
            source: "automation",
            trigger_detail: Some("system"),
            reason: "process_lost_retry",
            payload: &payload,
            context: &snapshot,
            idempotency_key: Some(&format!("process-loss-retry:{}", run.id)),
            existing_wakeup_id: None,
            actor_id: None,
            delay_seconds: 0,
            retry_of: Some(&run.id),
            process_loss_count: 1,
        },
    )
    .await?;
    if let Some(id) = admission.run_id {
        crate::agent_execution::claim::append_event(
            tx,
            &run.org,
            &id,
            &run.agent_id,
            &format!("Recovery queued from run {}", run.id),
            "warn",
            &format!("recovery-queued:{}", run.id),
        )
        .await?;
    }
    Ok(())
}
