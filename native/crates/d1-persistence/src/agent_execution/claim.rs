//! Claim already admitted generic native Runs. Admission and execution ownership
//! remain separate, exactly as the existing Issue queue contract requires.

use super::{AgentExecutionError, OwnedAgentRun, Settlement, context, http, mark_native_write};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

/// Trusted claim-time data. Runtime configuration can contain secret references
/// and therefore this type deliberately does not implement Debug/Serialize.
pub struct AgentRunClaim {
    pub owned: OwnedAgentRun,
    pub agent_name: String,
    pub agent_context: Value,
    pub runtime_type: String,
    pub goal_id: Option<String>,
    pub issue_id: Option<String>,
    pub wake_payload: Value,
    pub context_snapshot: Value,
    pub invocation_source: String,
    pub trigger_detail: Option<String>,
    pub reason: Option<String>,
    pub session_id_before: Option<String>,
    pub session_params_before: Option<Value>,
    pub session_reuse_scope: String,
}

impl std::ops::Deref for AgentRunClaim {
    type Target = OwnedAgentRun;
    fn deref(&self) -> &Self::Target {
        &self.owned
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DueAgentRun {
    pub organization_id: String,
    pub run_id: String,
}

pub async fn list_due_runs(pool: &PgPool) -> Result<Vec<DueAgentRun>, AgentExecutionError> {
    let rows = sqlx::query(
        "SELECT r.org_id::text AS org_id,r.id::text AS run_id
         FROM heartbeat_runs r
         JOIN agent_wakeup_requests w ON w.org_id=r.org_id AND w.id=r.wakeup_request_id
           AND w.agent_id=r.agent_id AND w.run_id=r.id AND w.execution_authority='native_rust'
         WHERE r.execution_authority='native_rust' AND r.status='queued'
           AND r.scene='heartbeat' AND r.target_type='wakeup_request'
           AND r.chat_generation_id IS NULL AND w.status='queued'
           AND w.requested_at <= statement_timestamp()
         ORDER BY r.created_at,r.id LIMIT 32",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(DueAgentRun {
                organization_id: row.try_get("org_id")?,
                run_id: row.try_get("run_id")?,
            })
        })
        .collect()
}

/// Reuse the legacy heartbeat's issue -> run advisory -> Agent advisory/row
/// ordering. Counts include legacy-owned runs so migration cannot add slots.
pub async fn claim_queued_run(
    pool: &PgPool,
    organization_id: &str,
    run_id: &str,
) -> Result<Option<AgentRunClaim>, AgentExecutionError> {
    let org = canonical_id(organization_id)?;
    let run_id = canonical_id(run_id)?;
    let initial = sqlx::query(
        "SELECT agent_id::text AS agent_id,context_snapshot FROM heartbeat_runs
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust'
           AND status='queued' AND scene='heartbeat' AND target_type='wakeup_request'
           AND chat_generation_id IS NULL",
    )
    .bind(&org)
    .bind(&run_id)
    .fetch_optional(pool)
    .await?;
    let Some(initial) = initial else {
        return Ok(None);
    };
    let agent_id: String = initial.try_get("agent_id")?;
    let initial_context: Option<Value> = initial.try_get("context_snapshot")?;
    let issue_id = initial_context
        .as_ref()
        .and_then(|value| context::nonempty(value.get("issueId")));
    let mut tx = pool.begin().await?;
    let issue = if let Some(issue_id) = issue_id.as_deref() {
        Some(
            sqlx::query(
                "SELECT id::text AS id,status,execution_run_id::text AS execution_run_id,
                    execution_cancellation_at FROM issues
             WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
            )
            .bind(&org)
            .bind(canonical_id(issue_id)?)
            .fetch_optional(&mut *tx)
            .await?,
        )
    } else {
        None
    };
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(&run_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("agent-run-state:{agent_id}"))
        .execute(&mut *tx)
        .await?;
    let agent = sqlx::query(
        "SELECT status,pause_reason,name,runtime_config,agent_runtime_type,
                jsonb_build_object(
                    'id', a.id::text,
                    'orgId', a.org_id::text,
                    'name', a.name,
                    'workspaceKey', a.workspace_key,
                    'role', a.role,
                    'title', a.title,
                    'icon', a.icon,
                    'status', a.status,
                    'readinessState', a.readiness_state,
                    'readinessCheckedAt', a.readiness_checked_at,
                    'readinessResultCode', a.readiness_result_code,
                    'capabilities', a.capabilities,
                    'agentRuntimeType', a.agent_runtime_type,
                    'agentRuntimeConfig', a.agent_runtime_config,
                    'runtimeConfig', a.runtime_config,
                    'budgetMonthlyCents', a.budget_monthly_cents,
                    'spentMonthlyCents', a.spent_monthly_cents,
                    'pauseReason', a.pause_reason,
                    'pausedAt', a.paused_at,
                    'permissions', a.permissions,
                    'lastHeartbeatAt', a.last_heartbeat_at,
                    'metadata', a.metadata,
                    'createdAt', a.created_at,
                    'updatedAt', a.updated_at
                ) AS agent_context
         FROM agents a WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    )
    .bind(&org)
    .bind(&agent_id)
    .fetch_optional(&mut *tx)
    .await?;
    let run = sqlx::query(
        "SELECT id::text AS id,wakeup_request_id::text AS wakeup_id,context_snapshot,
                goal_id::text AS goal_id,invocation_source,trigger_detail,error_code,error,
                session_id_before,session_params_before_json,session_reuse_scope
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid
           AND agent_id=$3::uuid AND execution_authority='native_rust' AND status='queued'
           AND scene='heartbeat' AND target_type='wakeup_request' AND chat_generation_id IS NULL
         FOR UPDATE",
    )
    .bind(&org)
    .bind(&run_id)
    .bind(&agent_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(run) = run else {
        return Ok(None);
    };
    let wakeup_id: String = run.try_get("wakeup_id")?;
    let wakeup = sqlx::query(
        "SELECT reason,payload,requested_at <= statement_timestamp() AS due
         FROM agent_wakeup_requests
         WHERE org_id=$1::uuid AND id=$2::uuid AND agent_id=$3::uuid AND run_id=$4::uuid
           AND execution_authority='native_rust' AND status='queued' FOR UPDATE",
    )
    .bind(&org)
    .bind(&wakeup_id)
    .bind(&agent_id)
    .bind(&run_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(wakeup) = wakeup else {
        return Ok(None);
    };
    if !wakeup.try_get::<bool, _>("due")? {
        return Ok(None);
    }
    let context_snapshot = run
        .try_get::<Option<Value>, _>("context_snapshot")?
        .unwrap_or_else(|| json!({}));
    if context::nonempty(context_snapshot.get("issueId")) != issue_id {
        return Ok(None);
    }
    let wake_payload = wakeup
        .try_get::<Option<Value>, _>("payload")?
        .unwrap_or_else(|| json!({}));
    let reason: Option<String> = wakeup.try_get("reason")?;
    let error_code: Option<String> = run.try_get("error_code")?;
    let agent_status = agent
        .as_ref()
        .map(|row| row.try_get::<String, _>("status"))
        .transpose()?;
    let cancellation = if error_code.as_deref() == Some("cancel_requested") {
        Some(
            run.try_get::<Option<String>, _>("error")?
                .unwrap_or_else(|| "Cancelled due to budget pause".into()),
        )
    } else if agent_status
        .as_deref()
        .is_none_or(|status| matches!(status, "paused" | "terminated" | "pending_approval"))
    {
        Some("Cancelled because the agent is not invokable".into())
    } else if let Some(issue) = issue.as_ref() {
        if let Some(issue) = issue.as_ref() {
            let status: String = issue.try_get("status")?;
            let fenced: bool = sqlx::query_scalar(
                "SELECT COALESCE(r.created_at<=i.execution_cancellation_at,false)
                 FROM heartbeat_runs r JOIN issues i ON i.org_id=r.org_id AND i.id=$3::uuid
                 WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
            )
            .bind(&org)
            .bind(&run_id)
            .bind(issue_id.as_deref())
            .fetch_one(&mut *tx)
            .await?;
            (fenced
                || (matches!(status.as_str(), "done" | "cancelled")
                    && !context::comment_mention(
                        reason.as_deref(),
                        &context_snapshot,
                        &wake_payload,
                    )))
            .then(|| "Cancelled because the linked issue is no longer actionable".into())
        } else {
            Some("Cancelled because the linked issue no longer exists".into())
        }
    } else {
        None
    };
    if let Some(cancellation) = cancellation {
        cancel_queued(&mut tx, &org, &run_id, &wakeup_id, &agent_id, &cancellation).await?;
        tx.commit().await?;
        return Ok(None);
    }
    let agent = agent.ok_or_else(|| http(404, "Agent not found"))?;
    let agent_status: String = agent.try_get("status")?;
    let pause_reason: Option<String> = agent.try_get("pause_reason")?;
    if crate::goal_runs::goal_invocation_budget_blocked(
        &mut tx,
        &org,
        &agent_id,
        &agent_status,
        pause_reason.as_deref(),
    )
    .await?
    {
        cancel_queued(
            &mut tx,
            &org,
            &run_id,
            &wakeup_id,
            &agent_id,
            "Cancelled due to budget pause",
        )
        .await?;
        tx.commit().await?;
        return Ok(None);
    }
    let (running, effects_pending): (i64, bool) = sqlx::query_as(
        "SELECT count(*) FILTER(WHERE status='running')::bigint,
                COALESCE(bool_or(terminal_effects_pending),false)
         FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid",
    )
    .bind(&org)
    .bind(&agent_id)
    .fetch_one(&mut *tx)
    .await?;
    let runtime_config: Value = agent.try_get("runtime_config")?;
    if effects_pending || running >= max_concurrent_runs(&runtime_config) {
        return Ok(None);
    }
    let runtime_type: String = agent.try_get("agent_runtime_type")?;
    let session =
        select_claim_session(&mut tx, &org, &agent_id, &runtime_type, &context_snapshot).await?;
    let session_id = session.display_id.clone().or_else(|| {
        session
            .params
            .as_ref()
            .and_then(|value| context::nonempty(value.get("sessionId")))
    });
    let session_intent = json!({
        "kind":if session.reuse_scope == "none" {"fresh"} else {"resume"},
        "reuseScope":session.reuse_scope,"sourceRunId":context::nonempty(context_snapshot.get("resumeFromRunId")),
        "sessionId":session_id,"sessionParams":session.params,
    });
    let owner_token = Uuid::new_v4().to_string();
    mark_native_write(&mut tx).await?;
    sqlx::query(
        "UPDATE heartbeat_runs SET status='running',running_substate='executing',
           started_at=COALESCE(started_at,statement_timestamp()),execution_owner_token=$3,
           execution_lease_expires_at=statement_timestamp()+interval '30 seconds',
           session_id_before=$4,session_params_before_json=$5::jsonb,session_reuse_scope=$6,
           session_intent_json=$7::jsonb,updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND status='queued'",
    )
    .bind(&org)
    .bind(&run_id)
    .bind(&owner_token)
    .bind(&session_id)
    .bind(&session.params)
    .bind(session.reuse_scope)
    .bind(session_intent)
    .execute(&mut *tx)
    .await?;
    let attempt = sqlx::query(
        "INSERT INTO heartbeat_run_attempts
          (org_id,run_id,agent_id,attempt_index,runtime_type,status,owner_token,attempt_epoch,started_at)
         SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE(max(attempt_index),0)+1,$4,'started',$5,
                COALESCE(max(attempt_epoch),0)+1,statement_timestamp()
         FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND run_id=$2::uuid
         RETURNING id::text AS id,attempt_epoch",
    ).bind(&org).bind(&run_id).bind(&agent_id).bind(&runtime_type).bind(&owner_token).fetch_one(&mut *tx).await?;
    let attempt_id: String = attempt.try_get("id")?;
    let attempt_epoch: i32 = attempt.try_get("attempt_epoch")?;
    sqlx::query("UPDATE agent_wakeup_requests SET status='claimed',claimed_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND run_id=$3::uuid")
        .bind(&org).bind(&wakeup_id).bind(&run_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE agents SET status='running',updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&org).bind(&agent_id).execute(&mut *tx).await?;
    append_event(
        &mut tx,
        &org,
        &run_id,
        &agent_id,
        "run started",
        "info",
        &format!("agent-run-start:{run_id}"),
    )
    .await?;
    let agent_name: String = agent.try_get("name")?;
    let agent_context: Value = agent.try_get("agent_context")?;
    let goal_id: Option<String> = run.try_get("goal_id")?;
    let invocation_source: String = run.try_get("invocation_source")?;
    let trigger_detail: Option<String> = run.try_get("trigger_detail")?;
    tx.commit().await?;
    Ok(Some(AgentRunClaim {
        owned: OwnedAgentRun::from_claim(
            org,
            agent_id,
            run_id,
            wakeup_id,
            attempt_id,
            owner_token,
            attempt_epoch,
            Settlement::Agent,
        ),
        agent_name,
        agent_context,
        runtime_type,
        goal_id,
        issue_id,
        wake_payload,
        context_snapshot,
        invocation_source,
        trigger_detail,
        reason,
        session_id_before: session_id,
        session_params_before: session.params,
        session_reuse_scope: session.reuse_scope.into(),
    }))
}

pub(crate) async fn select_claim_session(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    agent_id: &str,
    runtime: &str,
    snapshot: &Value,
) -> Result<context::SessionLineage, sqlx::Error> {
    let reset = context::reset_task_session(snapshot);
    let key = context::task_key(snapshot, &Value::Null);
    let task = if !reset {
        if let Some(key) = key {
            sqlx::query("SELECT session_params_json,session_display_id FROM agent_task_sessions WHERE org_id=$1::uuid AND agent_id=$2::uuid AND agent_runtime_type=$3 AND task_key=$4")
                .bind(org).bind(agent_id).bind(runtime).bind(key).fetch_optional(&mut **tx).await?
        } else {
            None
        }
    } else {
        None
    };
    let params = task
        .as_ref()
        .and_then(|row| {
            row.try_get::<Option<Value>, _>("session_params_json")
                .ok()
                .flatten()
        })
        .filter(|value| value.as_object().is_some_and(|fields| !fields.is_empty()));
    let display = task.as_ref().and_then(|row| {
        row.try_get::<Option<String>, _>("session_display_id")
            .ok()
            .flatten()
    });
    let explicit = super::resume::object_params(snapshot.get("resumeSessionParams"));
    let explicit_display = context::nonempty(snapshot.get("resumeSessionDisplayId"))
        .map(super::resume::truncate_display);
    Ok(context::select_session(
        context::suppression(snapshot).is_some(),
        explicit,
        explicit_display,
        params,
        display.map(super::resume::truncate_display),
    ))
}

pub(crate) async fn cancel_queued(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    run_id: &str,
    wakeup_id: &str,
    agent_id: &str,
    reason: &str,
) -> Result<bool, sqlx::Error> {
    mark_native_write(tx).await?;
    let changed = sqlx::query(
        "UPDATE heartbeat_runs SET status='cancelled',error=$3,error_code='cancelled',
           finished_at=statement_timestamp(),process_exited_at=statement_timestamp(),
           terminal_effects_pending=true,terminal_effects_json=$4::jsonb,updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust'
           AND status='queued' AND execution_owner_token IS NULL
           AND process_pid IS NULL AND process_started_at IS NULL",
    ).bind(org).bind(run_id).bind(reason).bind(json!({"version":1,"nativeAgentRunSettlement":true})).execute(&mut **tx).await?.rows_affected()==1;
    if changed {
        sqlx::query("UPDATE agent_wakeup_requests SET status='cancelled',error=$4,finished_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND run_id=$3::uuid AND execution_authority='native_rust'")
            .bind(org).bind(wakeup_id).bind(run_id).bind(reason).execute(&mut **tx).await?;
        append_event(
            tx,
            org,
            run_id,
            agent_id,
            "run cancelled",
            "warn",
            &format!("agent-run-terminal:{run_id}"),
        )
        .await?;
    }
    Ok(changed)
}

pub(crate) async fn append_event(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    run_id: &str,
    agent_id: &str,
    message: &str,
    level: &str,
    key: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO heartbeat_run_events(org_id,run_id,agent_id,seq,event_type,stream,level,message,idempotency_key)
         SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE((SELECT max(seq) FROM heartbeat_run_events WHERE run_id=$2::uuid),0)+1,
                'lifecycle','system',$5,$4,$6
         ON CONFLICT(run_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING",
    ).bind(org).bind(run_id).bind(agent_id).bind(message).bind(level).bind(key).execute(&mut **tx).await?;
    Ok(())
}

pub(crate) fn canonical_id(value: &str) -> Result<String, AgentExecutionError> {
    Uuid::parse_str(value)
        .map(|value| value.to_string())
        .map_err(|_| http(422, "Invalid Agent Run identity"))
}

fn max_concurrent_runs(config: &Value) -> i64 {
    let value = config["heartbeat"]["maxConcurrentRuns"]
        .as_f64()
        .unwrap_or(8.0)
        .floor();
    if value.is_finite() {
        value.clamp(1.0, 10.0) as i64
    } else {
        8
    }
}
