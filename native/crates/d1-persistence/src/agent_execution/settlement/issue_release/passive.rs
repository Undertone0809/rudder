//! Existing bounded Issue close-out and reviewer convergence effects.
use super::{Issue, TerminalRun, audit};
use crate::agent_execution::{
    AgentExecutionError, context,
    followups::{self, Followup},
};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};

/// True means a durable successor owns the Issue, or a reviewer wake was
/// durably deferred. False permits the caller to release/promote normally.
pub(super) async fn settle(
    tx: &mut Transaction<'_, Postgres>,
    run: &TerminalRun,
    issue: &Issue,
) -> Result<bool, AgentExecutionError> {
    if run.status != "succeeded"
        || context::nonempty(run.context.get("issueId")).as_deref() != Some(issue.id.as_str())
    {
        return Ok(false);
    }
    let deferred:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_wakeup_requests WHERE org_id=$1::uuid AND status='deferred_issue_execution' AND payload->>'issueId'=$2)")
        .bind(&run.org).bind(&issue.id).fetch_one(&mut **tx).await?;
    if deferred {
        return Ok(false);
    }
    let source = sqlx::query(
        "SELECT invocation_source FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&run.org)
    .bind(&run.id)
    .fetch_one(&mut **tx)
    .await?;
    let invocation_source: String = source.try_get("invocation_source")?;
    let reviewer = matches!(issue.status.as_str(), "in_review" | "blocked")
        && issue.reviewer.as_deref() == Some(run.agent_id.as_str())
        && (invocation_source == "review"
            || run.context["role"] == "reviewer"
            || run.context["wakeSource"] == "review");
    if reviewer {
        if activity_exists(tx, run, &issue.id, "issue.review_decision_recorded").await?
            || blocked_review_recorded(tx, run, issue).await?
        {
            return Ok(false);
        }
        let recorded:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_wakeup_requests WHERE org_id=$1::uuid AND idempotency_key=$2 AND status IN ('queued','claimed','deferred_agent_paused','deferred_issue_execution')) OR EXISTS(SELECT 1 FROM activity_log WHERE org_id=$1::uuid AND run_id=$3::uuid AND action='issue.review_closure_needs_operator_review')")
            .bind(&run.org).bind(format!("issue_review_closeout_missing:{}",run.id)).bind(&run.id).fetch_one(&mut **tx).await?;
        if recorded {
            return Ok(false);
        }
        let closeout = &run.context["reviewCloseout"];
        let attempt = count(closeout.get("attempt"), 0);
        let maximum = count(closeout.get("maxAttempts"), 3).max(1);
        let origin =
            context::nonempty(closeout.get("originRunId")).unwrap_or_else(|| run.id.clone());
        if attempt >= maximum {
            audit(tx,run,issue,"issue.review_closure_needs_operator_review","issue_review_followup","warn","Reviewer close-out attempts stopped and need operator review",json!({"issueId":issue.id,"issueTitle":issue.title,"originRunId":origin,"previousRunId":run.id,"attempts":attempt,"maxAttempts":maximum,"reason":"missing_review_decision"})).await?;
            return Ok(false);
        }
        return reviewer_wake(tx, run, issue, &origin, attempt + 1, maximum, false).await;
    }
    if !matches!(issue.status.as_str(), "todo" | "in_progress")
        || issue.assignee.as_deref() != Some(run.agent_id.as_str())
    {
        return Ok(false);
    }
    let pending_block:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM activity_log a WHERE a.org_id=$1::uuid AND a.action='issue.block_audit_attempted' AND a.entity_type='issue' AND a.entity_id=$2 AND a.run_id=$3::uuid AND COALESCE(a.details->>'blocked','false')='false' AND EXISTS(SELECT 1 FROM requests r WHERE r.id::text=a.details->>'requestId' AND r.status='open'))")
        .bind(&run.org).bind(&issue.id).bind(&run.id).fetch_one(&mut **tx).await?;
    if !pending_block
        && issue.reviewer.is_none()
        && issue.reviewer_user.is_none()
        && activity_exists(tx, run, &issue.id, "issue.comment_added").await?
    {
        return Ok(false);
    }
    let recorded:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_wakeup_requests WHERE org_id=$1::uuid AND idempotency_key=$2) OR EXISTS(SELECT 1 FROM activity_log WHERE org_id=$1::uuid AND run_id=$3::uuid AND action IN ('issue.closure_needs_operator_review','issue.convergence_review_requested'))")
        .bind(&run.org).bind(format!("issue_passive_followup:{}",run.id)).bind(&run.id).fetch_one(&mut **tx).await?;
    if recorded || credible_timer(tx, run).await? {
        return Ok(false);
    }
    let passive = &run.context["passiveFollowup"];
    let attempt = count(passive.get("attempt"), 0);
    let origin = context::nonempty(passive.get("originRunId")).unwrap_or_else(|| run.id.clone());
    if attempt >= 3 {
        if issue.reviewer.is_some() || issue.reviewer_user.is_some() {
            return reviewer_wake(tx, run, issue, &origin, attempt, 3, true).await;
        }
        audit(tx,run,issue,"issue.closure_needs_operator_review","issue_closure_governance","warn","Passive issue follow-up stopped and needs operator review",json!({"issueId":issue.id,"issueTitle":issue.title,"originRunId":origin,"previousRunId":run.id,"attempts":attempt,"maxAttempts":3,"reason":"missing_closure"})).await?;
        return Ok(false);
    }
    let next = attempt + 1;
    let timestamp:String=sqlx::query_scalar("SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')").fetch_one(&mut **tx).await?;
    let mut snapshot = run.context.clone();
    for key in ["recovery", "retryOfRunId", "retryReason"] {
        snapshot
            .as_object_mut()
            .expect("native wake context object")
            .remove(key);
    }
    snapshot["issueId"] = json!(issue.id);
    snapshot["taskId"] = json!(issue.id);
    snapshot["taskKey"] = json!(
        context::task_key(&snapshot, &json!({"issueId":issue.id}))
            .unwrap_or_else(|| issue.id.clone())
    );
    if context::nonempty(snapshot.get("projectId")).is_none()
        && let Some(project) = issue.project_id.as_ref()
    {
        snapshot["projectId"] = json!(project);
    }
    snapshot["wakeReason"] = json!("issue_passive_followup");
    snapshot["wakeSource"] = json!("passive_issue_followup");
    snapshot["wakeTriggerDetail"] = json!("system");
    snapshot["issue"] = issue_snapshot(issue);
    snapshot["passiveFollowup"] = json!({"originRunId":origin,"previousRunId":run.id,"attempt":next,"maxAttempts":3,"reason":"missing_closure","queuedAt":timestamp});
    if issue.reviewer.is_some() || issue.reviewer_user.is_some() {
        snapshot["reviewGate"] = json!({"reviewerAgentId":issue.reviewer,"reviewerUserId":issue.reviewer_user,"closeOutRequirement":"Move the issue to in_review when work is ready. If it still cannot proceed after bounded recovery, submit a blocker claim so Rudder can audit the Assistance Request; cancel only when cancellation is the true outcome."});
    }
    let payload = json!({"issueId":issue.id,"originRunId":origin,"previousRunId":run.id,"attempt":next,"reason":"missing_closure"});
    let delay = if next == 1 { 120 } else { 300 };
    let admission = followups::enqueue(
        tx,
        Followup {
            org: &run.org,
            agent_id: &run.agent_id,
            issue_id: Some(&issue.id),
            source: "automation",
            trigger_detail: Some("system"),
            reason: "issue_passive_followup",
            payload: &payload,
            context: &snapshot,
            idempotency_key: Some(&format!("issue_passive_followup:{}", run.id)),
            existing_wakeup_id: None,
            actor_id: Some("issue_closure_governance"),
            delay_seconds: delay,
            retry_of: None,
            process_loss_count: 0,
        },
    )
    .await?;
    let requested_at:String=sqlx::query_scalar("SELECT to_char(requested_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid").bind(&run.org).bind(&admission.wakeup_request_id).fetch_one(&mut **tx).await?;
    if let Some(followup) = admission.run_id.as_deref() {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(followup)
            .execute(&mut **tx)
            .await?;
        sqlx::query("INSERT INTO heartbeat_run_events(org_id,run_id,agent_id,seq,event_type,stream,level,message,payload,idempotency_key) SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE((SELECT max(seq) FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid),0)+1,'issue.passive_followup_queued','system','warn',$4,$5::jsonb,$6 ON CONFLICT(run_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING")
            .bind(&run.org).bind(followup).bind(&run.agent_id).bind(format!("Passive follow-up queued because run {} ended without issue close-out",run.id)).bind(json!({"issueId":issue.id,"originRunId":origin,"previousRunId":run.id,"attempt":next,"maxAttempts":3,"reason":"missing_closure","requestedAt":requested_at})).bind(format!("terminal-issue-effect:{}:issue.passive_followup_queued",run.id)).execute(&mut **tx).await?;
    }
    let details = json!({"issueId":issue.id,"issueTitle":issue.title,"followupRunId":admission.run_id,"originRunId":origin,"previousRunId":run.id,"attempt":next,"maxAttempts":3,"reason":"missing_closure","requestedAt":requested_at});
    audit(
        tx,
        run,
        issue,
        "issue.passive_followup_queued",
        "issue_closure_governance",
        "warn",
        &format!(
            "Queued passive issue follow-up {}",
            admission.run_id.as_deref().unwrap_or("deferred")
        ),
        details,
    )
    .await?;
    audit(tx,run,issue,"issue.execution_promoted","terminal_effects","info","Issue execution promoted after terminal run",json!({"issueId":issue.id,"sourceRunId":run.id,"promotedRunId":admission.run_id,"reason":"passive_followup"})).await?;
    Ok(true)
}

async fn reviewer_wake(
    tx: &mut Transaction<'_, Postgres>,
    run: &TerminalRun,
    issue: &Issue,
    origin: &str,
    attempt: i32,
    maximum: i32,
    convergence: bool,
) -> Result<bool, AgentExecutionError> {
    let reason = if convergence {
        "issue_convergence_review_requested"
    } else {
        "issue_review_closeout_missing"
    };
    let event = if convergence {
        "issue.convergence_review_requested"
    } else {
        "issue.review_closeout_missing"
    };
    let actor = if convergence {
        "issue_closure_governance"
    } else {
        "issue_review_followup"
    };
    let details = json!({"issueId":issue.id,"issueTitle":issue.title,"reviewerAgentId":issue.reviewer,"reviewerUserId":issue.reviewer_user,"originRunId":origin,"previousRunId":run.id,"attempts":attempt,"maxAttempts":maximum,"reason":if convergence{"missing_closure"}else{"missing_review_decision"}});
    if let Some(reviewer) = issue.reviewer.as_deref() {
        let payload = json!({"issueId":issue.id,"mutation":if convergence{"convergence_escalation"}else{"review_outcome_missing"},"originRunId":origin,"previousRunId":run.id,"attempts":attempt,"maxAttempts":maximum});
        let mut snapshot = json!({"issueId":issue.id,"taskId":issue.id,"taskKey":issue.id,"source":if convergence{"issue.passive_followup_exhausted"}else{"issue.review_closeout_missing"},"wakeSource":"review","wakeReason":reason,"wakeTriggerDetail":"system","role":"reviewer","issue":issue_snapshot(issue),"reviewInstructions":if convergence{"The assignee did not converge this issue after passive follow-up. Review the thread and decide the next step: request changes, mark blocked, escalate or reassign, or mark done only if the evidence is sufficient."}else{"Your previous reviewer run ended without a structured decision. Inspect the current issue state and record exactly one outcome with `rudder issue review --decision approve|request_changes|needs_followup|blocked --comment-file <path>`."}});
        if let Some(project) = issue.project_id.as_ref() {
            snapshot["projectId"] = json!(project);
        }
        if let Some(goal) = run.goal_id.as_ref() {
            snapshot["goalId"] = json!(goal);
        }
        if convergence {
            snapshot["convergenceReview"] = json!({"originRunId":origin,"previousRunId":run.id,"attempts":attempt,"maxAttempts":maximum});
        } else {
            snapshot["reviewCloseout"] = json!({"originRunId":origin,"previousRunId":run.id,"attempt":attempt,"maxAttempts":maximum});
        }
        let idempotency = if convergence {
            format!("issue_convergence_review_requested:{origin}")
        } else {
            format!("issue_review_closeout_missing:{}", run.id)
        };
        followups::enqueue(
            tx,
            Followup {
                org: &run.org,
                agent_id: reviewer,
                issue_id: Some(&issue.id),
                source: "review",
                trigger_detail: Some("system"),
                reason,
                payload: &payload,
                context: &snapshot,
                idempotency_key: Some(&idempotency),
                existing_wakeup_id: None,
                actor_id: Some(actor),
                delay_seconds: 0,
                retry_of: None,
                process_loss_count: 0,
            },
        )
        .await?;
    }
    audit(
        tx,
        run,
        issue,
        event,
        actor,
        "warn",
        if convergence {
            "Passive issue follow-up stopped and needs reviewer convergence"
        } else {
            "Reviewer run finished without a structured review decision"
        },
        details,
    )
    .await?;
    Ok(issue.reviewer.is_some())
}

fn issue_snapshot(issue: &Issue) -> Value {
    json!({"id":issue.id,"title":issue.title,"description":issue.description,"status":issue.status,"priority":issue.priority})
}
fn count(value: Option<&Value>, fallback: i32) -> i32 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.floor().clamp(0.0, i32::MAX as f64) as i32)
        .unwrap_or(fallback)
}
async fn activity_exists(
    tx: &mut Transaction<'_, Postgres>,
    run: &TerminalRun,
    issue: &str,
    action: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM activity_log WHERE org_id=$1::uuid AND entity_type='issue' AND entity_id=$2 AND run_id=$3::uuid AND action=$4)")
    .bind(&run.org).bind(issue).bind(&run.id).bind(action).fetch_one(&mut **tx).await
}
async fn credible_timer(
    tx: &mut Transaction<'_, Postgres>,
    run: &TerminalRun,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT a.status NOT IN ('paused','terminated','pending_approval') AND COALESCE(a.runtime_config#>>'{heartbeat,enabled}','true')<>'false' AND CASE WHEN jsonb_typeof(a.runtime_config#>'{heartbeat,intervalSec}')='number' THEN (a.runtime_config#>>'{heartbeat,intervalSec}')::double precision ELSE 0 END>0 AND GREATEST(COALESCE(a.last_heartbeat_at,a.created_at),COALESCE(r.finished_at,statement_timestamp()))+make_interval(secs=>CASE WHEN jsonb_typeof(a.runtime_config#>'{heartbeat,intervalSec}')='number' THEN (a.runtime_config#>>'{heartbeat,intervalSec}')::double precision ELSE 0 END)<=statement_timestamp()+make_interval(secs=>LEAST(900,CASE WHEN jsonb_typeof(a.runtime_config#>'{heartbeat,intervalSec}')='number' THEN (a.runtime_config#>>'{heartbeat,intervalSec}')::double precision ELSE 0 END)) FROM agents a JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.agent_id=a.id AND r.id=$3::uuid WHERE a.org_id=$1::uuid AND a.id=$2::uuid")
        .bind(&run.org).bind(&run.agent_id).bind(&run.id).fetch_one(&mut **tx).await
}
async fn blocked_review_recorded(
    tx: &mut Transaction<'_, Postgres>,
    run: &TerminalRun,
    issue: &Issue,
) -> Result<bool, sqlx::Error> {
    if issue.status != "blocked" {
        return Ok(false);
    }
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM activity_log decision WHERE decision.org_id=$1::uuid AND decision.entity_type='issue' AND decision.entity_id=$2 AND decision.action='issue.review_decision_recorded' AND decision.actor_type='agent' AND decision.actor_id=$3 AND decision.details->>'decision'='blocked' AND decision.created_at>=COALESCE((SELECT max(material.created_at) FROM activity_log material WHERE material.org_id=$1::uuid AND material.entity_type='issue' AND material.entity_id=$2 AND ((material.action='issue.updated' AND jsonb_typeof(material.details)='object' AND EXISTS(SELECT 1 FROM jsonb_object_keys(material.details)key WHERE key NOT IN ('identifier','issueIdentifier','_previous','_references','source','reopened','reopenedFrom','normalizedFromStatus','normalizedReason','description','title'))) OR (material.action='issue.comment_added' AND NOT(material.actor_type='agent' AND material.actor_id=$3)))),to_timestamp(0)))")
        .bind(&run.org).bind(&issue.id).bind(&run.agent_id).fetch_one(&mut **tx).await
}
