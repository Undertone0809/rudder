//! Publicly authorized native heartbeat Stop and Retry authority. Running Stop
//! is cooperative; only the execution owner can finalize the cleanup receipt.

use super::{
    AgentExecutionActor, AgentExecutionError, AgentRunAdmission, admission, claim, context, http,
    mark_native_write,
};
use crate::{
    activity::{self, ActivityActor},
    agent_core::NativeAgentAuthorizer,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

pub async fn cancel(
    pool: &PgPool,
    authorizer: &dyn NativeAgentAuthorizer,
    actor: &AgentExecutionActor,
    organization_id: &str,
    run_id: &str,
) -> Result<bool, AgentExecutionError> {
    let org = claim::canonical_id(organization_id)?;
    let run_id = claim::canonical_id(run_id)?;
    let initial=sqlx::query("SELECT agent_id::text AS agent_id,context_snapshot FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND scene='heartbeat' AND target_type='wakeup_request'")
        .bind(&org).bind(&run_id).fetch_optional(pool).await?.ok_or_else(||http(404,"Heartbeat run not found"))?;
    let agent_id: String = initial.try_get("agent_id")?;
    let snapshot = initial
        .try_get::<Option<Value>, _>("context_snapshot")?
        .unwrap_or_else(|| json!({}));
    let mut tx = pool.begin().await?;
    if let Some(issue_id) = context::nonempty(snapshot.get("issueId")) {
        sqlx::query("SELECT id FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
            .bind(&org)
            .bind(claim::canonical_id(&issue_id)?)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(&run_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("agent-run-state:{agent_id}"))
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(&org)
        .bind(&agent_id)
        .execute(&mut *tx)
        .await?;
    admission::authorize(&mut tx, authorizer, &org).await?;
    if !matches!(actor.actor_type, "user" | "agent") {
        return Err(http(401, "Agent or Board authentication required"));
    }
    let current=sqlx::query("SELECT status,wakeup_request_id::text AS wakeup_id FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND scene='heartbeat' AND target_type='wakeup_request' FOR UPDATE")
        .bind(&org).bind(&run_id).fetch_optional(&mut *tx).await?.ok_or_else(||http(404,"Heartbeat run not found"))?;
    let status: String = current.try_get("status")?;
    let wakeup_id: String = current.try_get("wakeup_id")?;
    let changed = if status == "queued" {
        claim::cancel_queued(
            &mut tx,
            &org,
            &run_id,
            &wakeup_id,
            &agent_id,
            "Cancelled by Rudder",
        )
        .await?
    } else if status == "running" {
        mark_native_write(&mut tx).await?;
        let changed=sqlx::query("UPDATE heartbeat_runs SET error=CASE WHEN error_code='cancel_requested' THEN error ELSE 'Cancelled by Rudder' END,error_code='cancel_requested',updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND status='running'")
            .bind(&org).bind(&run_id).execute(&mut *tx).await?.rows_affected()==1;
        if changed {
            claim::append_event(
                &mut tx,
                &org,
                &run_id,
                &agent_id,
                "run cancellation requested",
                "warn",
                &format!("agent-run-cancel:{run_id}"),
            )
            .await?;
        }
        changed
    } else {
        false
    };
    if changed {
        activity::write_activity(
            &mut tx,
            &org,
            &ActivityActor {
                actor_type: actor.actor_type,
                actor_id: actor.actor_id.clone(),
                run_id: actor.run_id.clone(),
            },
            "heartbeat.cancelled",
            "heartbeat_run",
            &run_id,
            Some(&json!({"agentId":agent_id})),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(changed)
}

pub async fn retry(
    pool: &PgPool,
    authorizer: &dyn NativeAgentAuthorizer,
    actor: &AgentExecutionActor,
    organization_id: &str,
    run_id: &str,
) -> Result<AgentRunAdmission, AgentExecutionError> {
    let org = claim::canonical_id(organization_id)?;
    let source_id = claim::canonical_id(run_id)?;
    let initial=sqlx::query("SELECT agent_id::text AS agent_id,context_snapshot FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND scene='heartbeat' AND target_type='wakeup_request'")
        .bind(&org).bind(&source_id).fetch_optional(pool).await?.ok_or_else(||http(404,"Heartbeat run not found"))?;
    let agent_id: String = initial.try_get("agent_id")?;
    let mut snapshot = initial
        .try_get::<Option<Value>, _>("context_snapshot")?
        .unwrap_or_else(|| json!({}));
    let mut tx = pool.begin().await?;
    backfill_recovery_context(&mut tx, &org, &source_id, &mut snapshot).await?;
    let issue_id = context::nonempty(snapshot.get("issueId"));
    let issue = if let Some(issue_id) = issue_id.as_deref() {
        sqlx::query("SELECT i.id::text AS id,i.status,i.execution_run_id::text AS execution_run_id,COALESCE(r.created_at<=i.execution_cancellation_at,false) AS fenced,i.execution_cancellation_at IS NOT NULL AS has_fence FROM issues i JOIN heartbeat_runs r ON r.org_id=i.org_id AND r.id=$3::uuid WHERE i.org_id=$1::uuid AND i.id=$2::uuid FOR UPDATE OF i")
        .bind(&org).bind(claim::canonical_id(issue_id)?).bind(&source_id).fetch_optional(&mut *tx).await?
    } else {
        None
    };
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("heartbeat-run-retry:{source_id}"))
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("agent-run-state:{agent_id}"))
        .execute(&mut *tx)
        .await?;
    let agent=sqlx::query("SELECT name,status,pause_reason,runtime_config,agent_runtime_type FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(&org).bind(&agent_id).fetch_optional(&mut *tx).await?.ok_or_else(||http(404,"Agent not found"))?;
    admission::authorize(&mut tx, authorizer, &org).await?;
    if !matches!(actor.actor_type, "agent" | "user") {
        return Err(http(401, "Agent or Board authentication required"));
    }
    let source=sqlx::query("SELECT status,terminal_effects_pending,error_code,error,stdout_excerpt,stderr_excerpt,goal_id::text AS goal_id,source_run_id::text AS source_run_id,process_loss_retry_count FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND scene='heartbeat' AND target_type='wakeup_request' FOR UPDATE")
        .bind(&org).bind(&source_id).fetch_optional(&mut *tx).await?.ok_or_else(||http(404,"Heartbeat run not found"))?;
    let status: String = source.try_get("status")?;
    if !matches!(status.as_str(), "failed" | "timed_out" | "cancelled") {
        return Err(AgentExecutionError::Http(
            409,
            "Only failed, timed out, or cancelled runs can be retried".into(),
            Some(json!({"status":status})),
        ));
    }
    if source.try_get::<bool, _>("terminal_effects_pending")? {
        return Err(AgentExecutionError::Http(
            409,
            "Run terminal effects must complete before it can be retried".into(),
            Some(json!({"status":status,"terminalEffectsPending":true})),
        ));
    }
    let agent_status: String = agent.try_get("status")?;
    if matches!(
        agent_status.as_str(),
        "paused" | "terminated" | "pending_approval"
    ) {
        return Err(AgentExecutionError::Http(
            409,
            "Agent is not invokable in its current state".into(),
            Some(json!({"status":agent_status})),
        ));
    }
    let runtime_config: Value = agent.try_get("runtime_config")?;
    if !admission::wake_on_demand_enabled(&runtime_config) {
        return Err(http(409, "Agent is not configured for on-demand wakeups"));
    }
    let pause_reason: Option<String> = agent.try_get("pause_reason")?;
    if let Some(block) = super::budget::invocation_block(
        &mut tx,
        &org,
        &agent_id,
        &agent_status,
        pause_reason.as_deref(),
    )
    .await?
    {
        return Err(AgentExecutionError::Http(
            409,
            block.reason.into(),
            Some(json!({"scopeType":block.scope_type,"scopeId":block.scope_id})),
        ));
    }
    if let Some(issue) = issue.as_ref() {
        let issue_status: String = issue.try_get("status")?;
        if issue.try_get::<bool, _>("fenced")?
            || (issue_status == "cancelled" && !issue.try_get::<bool, _>("has_fence")?)
        {
            return Err(AgentExecutionError::Http(
                409,
                "Cannot retry a run fenced by its linked Issue cancellation".into(),
                Some(json!({"issueId":issue_id})),
            ));
        }
    }
    let existing=sqlx::query("SELECT id::text AS id,wakeup_request_id::text AS wakeup_id,status FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid AND retry_of_run_id=$3::uuid AND (status IN ('queued','running') OR terminal_effects_pending=true) ORDER BY created_at LIMIT 1")
        .bind(&org).bind(&agent_id).bind(&source_id).fetch_optional(&mut *tx).await?;
    if let Some(existing) = existing {
        return Ok(AgentRunAdmission {
            wakeup_request_id: existing.try_get("wakeup_id")?,
            run_id: Some(existing.try_get("id")?),
            status: existing.try_get("status")?,
            replayed: true,
            invocation_block: None,
        });
    }
    if let Some(issue) = issue.as_ref() {
        if let Some(active_id) = issue.try_get::<Option<String>, _>("execution_run_id")? {
            let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid AND (status IN ('queued','running') OR terminal_effects_pending=true))")
                .bind(&org).bind(&active_id).fetch_one(&mut *tx).await?;
            if active {
                return Err(AgentExecutionError::Http(
                    409,
                    "Issue already has an active execution run".into(),
                    Some(json!({"issueId":issue_id,"executionRunId":active_id})),
                ));
            }
        }
    }
    let kind: Option<String> = source.try_get("error_code")?;
    let kind = kind.unwrap_or_else(|| status.clone());
    let summary = [
        source.try_get::<Option<String>, _>("error")?,
        source.try_get("stderr_excerpt")?,
        source.try_get("stdout_excerpt")?,
    ]
    .into_iter()
    .flatten()
    .find_map(|value| {
        value
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_owned)
    })
    .unwrap_or_else(|| {
        if status == "timed_out" {
            "The run timed out before it completed."
        } else {
            "The previous run failed before it completed."
        }
        .into()
    });
    let mention = context::comment_mention(None, &snapshot, &Value::Null);
    snapshot["wakeReason"] = json!("retry_failed_run");
    snapshot["wakeSource"] = json!(if mention {
        "comment.mention"
    } else {
        "recovery.manual"
    });
    snapshot["wakeTriggerDetail"] = json!("manual");
    snapshot["retryOfRunId"] = json!(source_id);
    snapshot["retryReason"] = json!(kind);
    snapshot["recovery"] = json!({"originalRunId":source_id,"failureKind":kind,"failureSummary":summary,"recoveryTrigger":"manual","recoveryMode":"continue_preferred"});
    for field in [
        "resumeFromRunId",
        "resumeSessionDisplayId",
        "resumeSessionParams",
    ] {
        snapshot
            .as_object_mut()
            .expect("persisted context normalized")
            .remove(field);
    }
    let payload = json!({"originalRunId":source_id,"failureKind":kind,"recoveryTrigger":"manual","resumeFromRunId":source_id,"issueId":issue_id});
    let runtime_type: String = agent.try_get("agent_runtime_type")?;
    super::resume::hydrate_explicit_resume(
        &mut tx,
        &org,
        &agent_id,
        &runtime_type,
        &payload,
        &mut snapshot,
    )
    .await?;
    let session =
        claim::select_claim_session(&mut tx, &org, &agent_id, &runtime_type, &snapshot).await?;
    let session_id = session.display_id.clone().or_else(|| {
        session
            .params
            .as_ref()
            .and_then(|value| context::nonempty(value.get("sessionId")))
    });
    let session_intent = json!({"kind":if session.reuse_scope=="none"{"fresh"}else{"resume"},"reuseScope":session.reuse_scope,"sourceRunId":context::nonempty(snapshot.get("resumeFromRunId")),"sessionId":session_id,"sessionParams":session.params});
    let goal_id: Option<String> = source.try_get("goal_id")?;
    let source_run_id: Option<String> = source.try_get("source_run_id")?;
    let retry_count: i32 = source.try_get("process_loss_retry_count")?;
    let wakeup_id = Uuid::new_v4().to_string();
    let run_id = Uuid::new_v4().to_string();
    mark_native_write(&mut tx).await?;
    sqlx::query("INSERT INTO agent_wakeup_requests(id,org_id,agent_id,source,trigger_detail,reason,payload,status,execution_authority,requested_by_actor_type,requested_by_actor_id) VALUES($1::uuid,$2::uuid,$3::uuid,'on_demand','manual','retry_failed_run',$4::jsonb,'queued','native_rust',$5,$6)")
        .bind(&wakeup_id).bind(&org).bind(&agent_id).bind(payload).bind(actor.actor_type).bind(&actor.actor_id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO heartbeat_runs(id,org_id,agent_id,invocation_source,trigger_detail,status,wakeup_request_id,execution_authority,goal_id,source_run_id,context_snapshot,session_reuse_scope,session_id_before,session_params_before_json,scene,target_type,target_id,session_intent_json,retry_of_run_id,process_loss_retry_count) VALUES($1::uuid,$2::uuid,$3::uuid,'on_demand','manual','queued',$4::uuid,'native_rust',$5::uuid,$6::uuid,$7::jsonb,$8,$9,$10::jsonb,'heartbeat','wakeup_request',$4::text,$11::jsonb,$12::uuid,$13)")
        .bind(&run_id).bind(&org).bind(&agent_id).bind(&wakeup_id).bind(goal_id).bind(source_run_id).bind(snapshot).bind(session.reuse_scope).bind(session_id).bind(session.params).bind(session_intent).bind(&source_id).bind(retry_count).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE agent_wakeup_requests SET run_id=$3::uuid WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&org)
    .bind(&wakeup_id)
    .bind(&run_id)
    .execute(&mut *tx)
    .await?;
    if let Some(issue_id) = issue_id.as_deref() {
        let name: String = agent.try_get("name")?;
        sqlx::query("UPDATE issues SET execution_run_id=$3::uuid,execution_agent_name_key=$4,execution_locked_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(&org).bind(issue_id).bind(&run_id).bind(name.trim().to_lowercase()).execute(&mut *tx).await?;
    }
    activity::write_activity(
        &mut tx,
        &org,
        &ActivityActor {
            actor_type: actor.actor_type,
            actor_id: actor.actor_id.clone(),
            run_id: actor.run_id.clone(),
        },
        "heartbeat.retried",
        "heartbeat_run",
        &run_id,
        Some(&json!({"agentId":agent_id,"originalRunId":source_id,"recoveryTrigger":"manual"})),
    )
    .await?;
    tx.commit().await?;
    Ok(AgentRunAdmission {
        wakeup_request_id: wakeup_id,
        run_id: Some(run_id),
        status: "queued".into(),
        replayed: false,
        invocation_block: None,
    })
}

async fn backfill_recovery_context(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
    source_id: &str,
    snapshot: &mut Value,
) -> Result<(), sqlx::Error> {
    if !snapshot.is_object() {
        *snapshot = json!({});
    }
    let mut current = Some(source_id.to_owned());
    for _ in 0..8 {
        let Some(id) = current else {
            break;
        };
        let row=sqlx::query("SELECT retry_of_run_id::text AS retry_of_run_id,context_snapshot,goal_id::text AS goal_id FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(org).bind(id).fetch_optional(&mut **tx).await?;
        let Some(row) = row else {
            break;
        };
        let context = row
            .try_get::<Option<Value>, _>("context_snapshot")?
            .unwrap_or(Value::Null);
        for field in [
            "issueId",
            "taskId",
            "taskKey",
            "projectId",
            "projectWorkspaceId",
            "sourceRunId",
            "delegationTask",
            "commentId",
            "wakeCommentId",
            "issue",
            "comment",
            "source",
            "wakeSource",
            "wakeTriggerDetail",
        ] {
            if snapshot
                .get(field)
                .is_none_or(|value| value.is_null() || value == "")
            {
                if let Some(value) = context
                    .get(field)
                    .filter(|value| !value.is_null() && *value != "")
                {
                    snapshot[field] = value.clone();
                }
            }
        }
        if let Some(goal) = row.try_get::<Option<String>, _>("goal_id")? {
            if snapshot.get("goalId").is_none() {
                snapshot["goalId"] = json!(goal);
            }
        }
        current = row.try_get("retry_of_run_id")?;
    }
    Ok(())
}

/// Existing organization/Agent budget enforcement uses the same native
/// heartbeat Stop intent. Chat remains under its separate execution owner.
pub(crate) async fn cancel_heartbeat_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
    run_id: &str,
    reason: &str,
) -> Result<bool, sqlx::Error> {
    let run=sqlx::query("SELECT agent_id::text AS agent_id,wakeup_request_id::text AS wakeup_id,status,idempotency_key FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND scene='heartbeat' AND target_type='wakeup_request' AND status IN ('queued','running') FOR UPDATE")
        .bind(org).bind(run_id).fetch_optional(&mut **tx).await?;
    let Some(run) = run else {
        return Ok(false);
    };
    let agent_id: String = run.try_get("agent_id")?;
    let status: String = run.try_get("status")?;
    if status == "queued" {
        return claim::cancel_queued(
            tx,
            org,
            run_id,
            &run.try_get::<String, _>("wakeup_id")?,
            &agent_id,
            reason,
        )
        .await;
    }
    mark_native_write(tx).await?;
    let changed=sqlx::query("UPDATE heartbeat_runs SET error=CASE WHEN error_code='cancel_requested' THEN error ELSE $3 END,error_code='cancel_requested',updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND status='running' AND execution_authority='native_rust'")
        .bind(org).bind(run_id).bind(reason).execute(&mut **tx).await?.rows_affected()==1;
    if changed {
        let goal = run
            .try_get::<Option<String>, _>("idempotency_key")?
            .is_some_and(|key| key.starts_with("goal-wakeup:"));
        let prefix = if goal {
            "goal-run-cancel"
        } else {
            "agent-run-cancel"
        };
        claim::append_event(
            tx,
            org,
            run_id,
            &agent_id,
            "run cancellation requested",
            "warn",
            &format!("{prefix}:{run_id}"),
        )
        .await?;
    }
    Ok(changed)
}
