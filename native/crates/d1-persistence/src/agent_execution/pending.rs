//! Resume durable native wake intents without changing their execution owner.
use super::{
    AgentExecutionError, context,
    followups::{self, Followup},
    mark_native_write,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

pub async fn resume_pending(pool: &PgPool) -> Result<usize, AgentExecutionError> {
    let due=sqlx::query("SELECT org_id::text AS org,id::text AS id FROM agent_wakeup_requests WHERE execution_authority='native_rust' AND run_id IS NULL AND status IN('queued','deferred_agent_paused','deferred_goal_focus','deferred_goal_blocked','deferred_issue_execution') AND requested_at<=statement_timestamp() AND NOT COALESCE((reason='goal_started' AND payload->>'event'='goal_started' AND payload->>'taskKey' LIKE 'goal:%:goal_started:%' AND payload->>'_rudderExecutionProducer' IS NULL),false) ORDER BY requested_at,id LIMIT 32").fetch_all(pool).await?;
    let mut resumed = 0;
    for row in due {
        let org: String = row.try_get("org")?;
        let id: String = row.try_get("id")?;
        match resume_one(pool, &org, &id).await {
            Ok(true) => resumed += 1,
            Ok(false) => {}
            Err(error) => {
                let message = match &error {
                    AgentExecutionError::Http(_, message, _) => message.as_str(),
                    _ => "Deferred wake could not be resumed",
                };
                let mut tx = pool.begin().await?;
                mark_native_write(&mut tx).await?;
                sqlx::query("UPDATE agent_wakeup_requests SET status='failed',error=$3,claimed_at=NULL,finished_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND run_id IS NULL AND status IN('queued','deferred_agent_paused','deferred_goal_focus','deferred_goal_blocked','deferred_issue_execution')").bind(&org).bind(&id).bind(message).execute(&mut *tx).await?;
                tx.commit().await?;
            }
        }
    }
    Ok(resumed)
}
pub(crate) async fn resume_one(
    pool: &PgPool,
    org: &str,
    wake_id: &str,
) -> Result<bool, AgentExecutionError> {
    let initial=sqlx::query("SELECT agent_id::text AS agent_id,payload FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND run_id IS NULL").bind(org).bind(wake_id).fetch_optional(pool).await?;
    let Some(initial) = initial else {
        return Ok(false);
    };
    let initial_payload = initial
        .try_get::<Option<Value>, _>("payload")?
        .unwrap_or_else(|| json!({}));
    let seed = initial_payload
        .get("_paperclipWakeContext")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let issue_id = context::nonempty(initial_payload.get("issueId"))
        .or_else(|| context::nonempty(seed.get("issueId")))
        .filter(|id| uuid::Uuid::parse_str(id).is_ok());
    let agent_id: String = initial.try_get("agent_id")?;
    let mut tx = pool.begin().await?;
    let issue = if let Some(id) = issue_id.as_deref() {
        sqlx::query("SELECT status,assignee_agent_id::text AS assignee,execution_run_id::text AS execution_run_id,execution_cancellation_at FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE").bind(org).bind(id).fetch_optional(&mut *tx).await?
    } else {
        None
    };
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("agent-run-state:{agent_id}"))
        .execute(&mut *tx)
        .await?;
    let agent=sqlx::query("SELECT status,pause_reason,runtime_config FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE").bind(org).bind(&agent_id).fetch_optional(&mut *tx).await?;
    let wake=sqlx::query("SELECT source,trigger_detail,reason,payload,status,idempotency_key,requested_by_actor_id FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid AND agent_id=$3::uuid AND execution_authority='native_rust' AND run_id IS NULL AND status IN('queued','deferred_agent_paused','deferred_goal_focus','deferred_goal_blocked','deferred_issue_execution') AND requested_at<=statement_timestamp() FOR UPDATE").bind(org).bind(wake_id).bind(&agent_id).fetch_optional(&mut *tx).await?;
    let Some(wake) = wake else { return Ok(false) };
    let source: String = wake.try_get("source")?;
    let detail: Option<String> = wake.try_get("trigger_detail")?;
    let reason: Option<String> = wake.try_get("reason")?;
    let mut payload = wake
        .try_get::<Option<Value>, _>("payload")?
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    if reason.as_deref() == Some("goal_started")
        && payload["event"] == "goal_started"
        && payload
            .get("taskKey")
            .and_then(Value::as_str)
            .is_some_and(|task| task.starts_with("goal:") && task.contains(":goal_started:"))
        && !super::has_generic_producer(&payload)
    {
        return Ok(false);
    }
    let seed = payload
        .as_object_mut()
        .expect("normalized payload")
        .remove("_paperclipWakeContext")
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let snapshot = context::enrich_wake_context(
        seed,
        &payload,
        &source,
        detail.as_deref(),
        reason.as_deref(),
    );
    let goal = context::nonempty(snapshot.get("goalId"))
        .or_else(|| context::nonempty(payload.get("goalId")))
        .filter(|id| uuid::Uuid::parse_str(id).is_ok());
    let goal_wake = goal.is_some()
        && matches!(
            reason.as_deref(),
            Some("goal_started" | "goal_feedback" | "goal_change_decided" | "goal_continuation")
        );
    let mut deferred = None;
    let mut terminal = None;
    if !super::goal_producer_is_current(&mut tx, org, &agent_id, &payload).await? {
        deferred = Some(("deferred_goal_blocked", "goal.owner_or_lifecycle_changed"));
    }
    if let Some(goal) = goal.as_deref().filter(|_| goal_wake) {
        let other:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM goals WHERE org_id=$1::uuid AND lifecycle='active' AND focus=true AND id<>$2::uuid)").bind(org).bind(goal).fetch_one(&mut *tx).await?;
        if other {
            deferred = Some(("deferred_goal_focus", "goal.focused_elsewhere"));
        }
    }
    let status = agent
        .as_ref()
        .and_then(|a| a.try_get::<String, _>("status").ok());
    if status
        .as_deref()
        .is_none_or(|s| matches!(s, "terminated" | "pending_approval"))
    {
        if goal_wake {
            deferred = Some(("deferred_goal_blocked", "agent.unavailable"));
        } else {
            terminal = Some(("skipped", "agent.unavailable"));
        }
    }
    if let Some(agent) = agent.as_ref() {
        let status = agent.try_get::<String, _>("status")?;
        let pause: Option<String> = agent.try_get("pause_reason")?;
        let config: Value = agent.try_get("runtime_config")?;
        if super::budget::invocation_block(&mut tx, org, &agent_id, &status, pause.as_deref())
            .await?
            .is_some()
        {
            if goal_wake {
                deferred = Some(("deferred_goal_blocked", "budget.blocked"));
            } else {
                terminal = Some(("skipped", "budget.blocked"));
            }
        } else if status == "paused" {
            deferred = Some(("deferred_agent_paused", "agent.paused"));
        }
        if status != "paused" && source == "timer" && config["heartbeat"]["enabled"] == false {
            terminal = Some(("skipped", "heartbeat.disabled"));
        }
        if status != "paused"
            && source != "timer"
            && !super::admission::wake_on_demand_enabled(&config)
        {
            if goal_wake {
                deferred = Some(("deferred_goal_blocked", "heartbeat.wakeOnDemand.disabled"));
            } else {
                terminal = Some(("skipped", "heartbeat.wakeOnDemand.disabled"));
            }
        }
    }
    if let Some(issue_id) = issue_id.as_deref() {
        if let Some(issue) = issue.as_ref() {
            let fenced:bool=sqlx::query_scalar("SELECT COALESCE(w.requested_at<=i.execution_cancellation_at,false) FROM agent_wakeup_requests w JOIN issues i ON i.org_id=w.org_id AND i.id=$3::uuid WHERE w.org_id=$1::uuid AND w.id=$2::uuid").bind(org).bind(wake_id).bind(issue_id).fetch_one(&mut *tx).await?;
            let issue_status: String = issue.try_get("status")?;
            if fenced
                || (matches!(issue_status.as_str(), "done" | "cancelled")
                    && !context::comment_mention(reason.as_deref(), &snapshot, &payload))
            {
                terminal = Some(("cancelled", "issue_execution_issue_not_actionable"));
            } else if context::nonempty(payload.get("expectedAssigneeAgentId")).is_some_and(
                |expected| {
                    issue
                        .try_get::<Option<String>, _>("assignee")
                        .ok()
                        .flatten()
                        .as_deref()
                        != Some(&expected)
                },
            ) {
                terminal = Some(("skipped", "issue_assignee_changed"));
            } else if context::nonempty(payload.get("expectedIssueStatus"))
                .is_some_and(|expected| expected != issue_status)
            {
                terminal = Some(("skipped", "issue_status_changed"));
            } else if let Some(active) = issue.try_get::<Option<String>, _>("execution_run_id")? {
                let busy:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid AND (status IN('queued','running') OR terminal_effects_pending=true))").bind(org).bind(active).fetch_one(&mut *tx).await?;
                if busy {
                    deferred = Some(("deferred_issue_execution", "issue_execution_deferred"));
                }
            }
        } else {
            terminal = Some(("skipped", "issue_execution_issue_not_found"));
        }
    }
    mark_native_write(&mut tx).await?;
    if let Some((status, why)) = terminal {
        sqlx::query("UPDATE agent_wakeup_requests SET status=$3,reason=$4,finished_at=statement_timestamp(),claimed_at=NULL,error=NULL,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND run_id IS NULL").bind(org).bind(wake_id).bind(status).bind(why).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(false);
    }
    if let Some((status, why)) = deferred {
        sqlx::query("UPDATE agent_wakeup_requests SET status=$3,error=$4,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND run_id IS NULL").bind(org).bind(wake_id).bind(status).bind(why).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(false);
    }
    let task = context::task_key(&snapshot, &payload);
    let active=sqlx::query("SELECT id::text AS id,status,goal_id::text AS goal_id,context_snapshot,invocation_source FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid AND status IN('queued','running') ORDER BY CASE WHEN status='queued' THEN 0 ELSE 1 END,created_at DESC").bind(org).bind(&agent_id).fetch_all(&mut *tx).await?;
    for active in active {
        let old = active
            .try_get::<Option<Value>, _>("context_snapshot")?
            .unwrap_or_else(|| json!({}));
        let old_task = context::task_key(&old, &Value::Null);
        let old_source: String = active.try_get("invocation_source")?;
        if task != old_task
            || (task.is_none() && old_source != source)
            || (active.try_get::<String, _>("status")? == "running"
                && context::nonempty(snapshot.get("wakeCommentId")).is_some())
        {
            continue;
        }
        let old_goal: Option<String> = active.try_get("goal_id")?;
        if old_goal.is_some() && goal.is_some() && old_goal != goal {
            return Err(super::http(
                409,
                "An active run cannot be coalesced across Goals",
            ));
        }
        let target: String = active.try_get("id")?;
        let merged = context::merge_coalesced_context(&old, &snapshot);
        sqlx::query("UPDATE heartbeat_runs SET context_snapshot=$3::jsonb,goal_id=COALESCE(goal_id,$4::uuid),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND status IN('queued','running')").bind(org).bind(&target).bind(merged).bind(goal.as_deref()).execute(&mut *tx).await?;
        sqlx::query("UPDATE agent_wakeup_requests SET status='coalesced',run_id=$3::uuid,payload=$4::jsonb,coalesced_count=coalesced_count+1,error=NULL,claimed_at=NULL,finished_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND run_id IS NULL").bind(org).bind(wake_id).bind(target).bind(&payload).execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(true);
    }
    let actor: Option<String> = wake.try_get("requested_by_actor_id")?;
    let key: Option<String> = wake.try_get("idempotency_key")?;
    let result = followups::enqueue(
        &mut tx,
        Followup {
            org,
            agent_id: &agent_id,
            issue_id: issue_id.as_deref(),
            source: &source,
            trigger_detail: detail.as_deref(),
            reason: reason.as_deref().unwrap_or("agent_wakeup"),
            payload: &payload,
            context: &snapshot,
            idempotency_key: key.as_deref(),
            existing_wakeup_id: Some(wake_id),
            actor_id: actor.as_deref(),
            delay_seconds: 0,
            retry_of: None,
            process_loss_count: 0,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(result.run_id.is_some())
}

/// Timer recovery runs before admission takes the Agent lock. Each materializer
/// reacquires the existing Issue -> Agent order and revalidates the native wake.
pub(crate) async fn recover_for_timer(
    pool: &PgPool,
    org: &str,
    agent_id: &str,
) -> Result<Option<super::AgentRunAdmission>, AgentExecutionError> {
    use super::timer_preflight::TimerRecoveryDisposition as Disposition;
    let mut tx = pool.begin().await?;
    let candidates = super::timer_preflight::recovery_candidates(&mut tx, org, agent_id).await?;
    tx.commit().await?;
    for candidate in candidates {
        match &candidate.disposition {
            Disposition::WaitForIssueExecution => continue,
            Disposition::Resume => {
                match resume_one(pool, org, &candidate.wakeup_request_id).await {
                    Ok(true) => {
                        let row=sqlx::query("SELECT run_id::text AS run_id,status FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid AND agent_id=$3::uuid AND execution_authority='native_rust'").bind(org).bind(&candidate.wakeup_request_id).bind(agent_id).fetch_optional(pool).await?;
                        if let Some(row) = row {
                            let run_id: Option<String> = row.try_get("run_id")?;
                            if run_id.is_some() {
                                return Ok(Some(super::AgentRunAdmission {
                                    wakeup_request_id: candidate.wakeup_request_id,
                                    run_id,
                                    status: row.try_get("status")?,
                                    replayed: false,
                                    invocation_block: None,
                                }));
                            }
                        }
                    }
                    Ok(false) => {}
                    Err(_) => {
                        let mut tx = pool.begin().await?;
                        mark_native_write(&mut tx).await?;
                        sqlx::query("UPDATE agent_wakeup_requests SET status='failed',error='Pending wake could not be recovered',finished_at=statement_timestamp(),claimed_at=NULL,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND agent_id=$3::uuid AND execution_authority='native_rust' AND run_id IS NULL AND status=$4").bind(org).bind(&candidate.wakeup_request_id).bind(agent_id).bind(&candidate.original_status).execute(&mut *tx).await?;
                        tx.commit().await?;
                    }
                }
            }
            Disposition::Relink { run_id } => {
                let mut tx = pool.begin().await?;
                mark_native_write(&mut tx).await?;
                sqlx::query("UPDATE agent_wakeup_requests w SET status='queued',run_id=$4::uuid,claimed_at=NULL,finished_at=NULL,error=NULL,updated_at=statement_timestamp() WHERE w.org_id=$1::uuid AND w.id=$2::uuid AND w.agent_id=$3::uuid AND w.execution_authority='native_rust' AND w.status=$5 AND w.run_id IS NULL AND EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.org_id=w.org_id AND r.agent_id=w.agent_id AND r.wakeup_request_id=w.id AND r.id=$4::uuid AND r.execution_authority='native_rust' AND r.status IN('queued','running'))").bind(org).bind(&candidate.wakeup_request_id).bind(agent_id).bind(run_id).bind(&candidate.original_status).execute(&mut *tx).await?;
                tx.commit().await?;
            }
            Disposition::Fail { .. } | Disposition::Skip { .. } => {
                let (status, reason, error) = match &candidate.disposition {
                    Disposition::Fail { error } => {
                        ("failed", candidate.reason.as_deref(), Some(error.as_str()))
                    }
                    Disposition::Skip { reason } => ("skipped", Some(reason.as_str()), None),
                    _ => unreachable!(),
                };
                let mut tx = pool.begin().await?;
                mark_native_write(&mut tx).await?;
                sqlx::query("UPDATE agent_wakeup_requests SET status=$5,reason=$6,error=$7,run_id=NULL,claimed_at=NULL,finished_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND agent_id=$3::uuid AND execution_authority='native_rust' AND run_id IS NULL AND status=$4").bind(org).bind(&candidate.wakeup_request_id).bind(agent_id).bind(&candidate.original_status).bind(status).bind(reason).bind(error).execute(&mut *tx).await?;
                tx.commit().await?;
            }
        }
    }
    Ok(None)
}
