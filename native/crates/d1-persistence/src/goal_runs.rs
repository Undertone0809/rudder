//! Durable ownership for Goal wakeups.
//!
//! Wakeup ownership is recorded before a Run exists. The wakeup row lock,
//! `run_id IS NULL` fence, Run insert, attempt insert, and wakeup link all
//! commit in one transaction so the legacy TypeScript queue cannot also claim
//! a Goal wakeup tagged `native_rust`.

use rudder_native_process_transport::{
    ConnectionLaunchPermit, DurableHostCleanupReceipt, HostCleanupProof,
};
use serde_json::{Map, Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

const GOAL_WAKE_REASONS: &[&str] = &["goal_started"];

const MAX_DUE_WAKEUPS: i64 = 32;
const MAX_EXPIRED_GOAL_RUNS: i64 = 32;
const NATIVE_GOAL_WRITE_MARKER: &str = "native_chat:goal_run";

async fn mark_native_goal_write(tx: &mut Transaction<'_, Postgres>) -> Result<(), GoalRunError> {
    sqlx::query("SELECT set_config('rudder.native_chat_write',$1,true)")
        .bind(NATIVE_GOAL_WRITE_MARKER)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[derive(Debug, Error)]
pub enum GoalRunError {
    #[error("Goal wakeup is not valid for native execution")]
    InvalidWakeup,
    #[error("Goal wakeup Agent or Goal is not eligible for execution")]
    Ineligible,
    #[error("Native Goal run currently supports claude_local only")]
    UnsupportedRuntime,
    #[error(transparent)]
    RuntimeConfig(#[from] crate::native_chat::Error),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Opaque durable claim returned only after the wakeup, Run, and first attempt
/// have been committed together. Runtime configuration is retained in memory
/// for the worker and is intentionally omitted from `Debug`.
pub struct GoalRunClaim {
    pub organization_id: String,
    pub agent_id: String,
    pub agent_name: String,
    /// The same persisted Agent fields that the legacy runtime exposes to
    /// configured prompt templates. This is claim-time DB data, never caller
    /// JSON, and intentionally does not implement `Debug`.
    pub agent_context: Value,
    pub runtime_type: String,
    pub goal_id: String,
    pub wakeup_request_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub owner_token: String,
    pub attempt_epoch: i32,
    pub invocation_source: String,
    pub trigger_detail: Option<String>,
    pub reason: String,
    pub wake_payload: Value,
    pub context_snapshot: Value,
    /// Connection identity is derived from the durable attempt row: the
    /// attempt epoch is its connection epoch and the attempt ID is its claim
    /// ID. These values therefore survive owner-process death unchanged.
    connection_epoch: i32,
    connection_claim_id: String,
    connection_launch_permit: Option<ConnectionLaunchPermit>,
}

impl GoalRunClaim {
    /// Consume the single-connection launch capability minted for this exact
    /// Run, Attempt, and owner. A claimed attempt cannot start another host.
    pub fn take_connection_launch_permit(&mut self) -> Option<ConnectionLaunchPermit> {
        self.connection_launch_permit.take()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DueGoalWakeup {
    pub organization_id: String,
    pub wakeup_request_id: String,
}

/// Persisted identity required to inspect one expired Goal process-host
/// receipt. Owner tokens are intentionally omitted from `Debug` and logs.
pub struct ExpiredNativeGoalRun {
    pub organization_id: String,
    pub agent_id: String,
    pub wakeup_request_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub owner_token: String,
    pub attempt_epoch: i32,
    pub connection_epoch: i32,
    pub connection_claim_id: String,
    pub process_id: Option<i32>,
}

/// Find a bounded batch of due native GoalStarted wake intents for the one
/// currently supported provider. The authoritative row lock and eligibility
/// checks remain in `claim_wakeup`; this scan never changes queue state.
pub async fn list_due_native_goal_wakeups(
    pool: &PgPool,
) -> Result<Vec<DueGoalWakeup>, GoalRunError> {
    let rows = sqlx::query(
        "SELECT w.org_id::text AS org_id, w.id::text AS wakeup_id
         FROM agent_wakeup_requests w
         JOIN agents a ON a.org_id=w.org_id AND a.id=w.agent_id
         JOIN organizations o ON o.id=w.org_id
         JOIN goals g ON g.org_id=w.org_id AND g.owner_agent_id=w.agent_id
           AND g.id::text=COALESCE(w.payload->>'goalId',
             w.payload#>>'{_paperclipWakeContext,goalId}',
             w.payload#>>'{_paperclipWakeContext,goal,id}')
         WHERE w.execution_authority='native_rust' AND w.run_id IS NULL
           AND w.reason='goal_started'
           AND w.payload->>'event'='goal_started'
           AND NULLIF(btrim(w.payload->>'goalStartRequestId'),'') IS NOT NULL
           AND w.payload->>'taskKey'=('goal:' || g.id::text || ':goal_started:' || (w.payload->>'goalStartRequestId'))
           AND w.status IN ('queued','deferred_goal_focus','deferred_goal_blocked','deferred_agent_paused')
           AND w.requested_at <= statement_timestamp()
           AND a.agent_runtime_type='claude_local'
           AND a.status NOT IN ('paused','terminated','pending_approval')
           AND o.status <> 'paused'
           AND g.status='active' AND g.lifecycle='active'
           AND NOT EXISTS (
             SELECT 1 FROM goals focused
             WHERE focused.org_id=w.org_id AND focused.status='active'
               AND focused.lifecycle='active' AND focused.focus=true AND focused.id<>g.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM heartbeat_runs active
             WHERE active.org_id=w.org_id AND active.agent_id=w.agent_id
               AND (active.status IN ('queued','running') OR active.terminal_effects_pending=true)
           )
           AND NOT EXISTS (
             SELECT 1 FROM budget_policies p
             WHERE p.org_id=w.org_id AND p.is_active=true AND p.metric='billed_cents'
               AND p.hard_stop_enabled=true AND p.amount>0
               AND ((p.scope_type='organization' AND p.scope_id=w.org_id)
                 OR (p.scope_type='agent' AND p.scope_id=w.agent_id))
           )
         ORDER BY w.requested_at,w.id
         LIMIT $1",
    )
    .bind(MAX_DUE_WAKEUPS)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(DueGoalWakeup {
                organization_id: row.try_get("org_id")?,
                wakeup_request_id: row.try_get("wakeup_id")?,
            })
        })
        .collect()
}

/// Discover native Goal owners whose lease expired. This does not take over a
/// Run or authorize another provider launch; the worker must first recover a
/// matching process-host cleanup receipt.
pub async fn list_expired_native_goal_runs(
    pool: &PgPool,
) -> Result<Vec<ExpiredNativeGoalRun>, GoalRunError> {
    let rows = sqlx::query(
        "SELECT r.org_id::text AS org_id,r.agent_id::text AS agent_id,
                r.wakeup_request_id::text AS wakeup_id,r.id::text AS run_id,
                r.execution_owner_token AS owner_token,r.process_pid,
                a.id::text AS attempt_id,a.attempt_epoch
         FROM heartbeat_runs r
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
           AND a.owner_token=r.execution_owner_token AND a.status='started'
         JOIN agent_wakeup_requests w ON w.org_id=r.org_id AND w.id=r.wakeup_request_id
           AND w.run_id=r.id AND w.execution_authority='native_rust'
         WHERE r.execution_authority='native_rust' AND r.goal_id IS NOT NULL
           AND r.scene='heartbeat' AND r.target_type='wakeup_request'
           AND r.status='running' AND r.execution_owner_token IS NOT NULL
           AND r.execution_lease_expires_at <= statement_timestamp()
           AND r.process_exited_at IS NULL AND r.terminal_effects_pending=false
         ORDER BY r.execution_lease_expires_at,r.id LIMIT $1",
    )
    .bind(MAX_EXPIRED_GOAL_RUNS)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let attempt_id: String = row.try_get("attempt_id")?;
            let attempt_epoch: i32 = row.try_get("attempt_epoch")?;
            Ok(ExpiredNativeGoalRun {
                organization_id: row.try_get("org_id")?,
                agent_id: row.try_get("agent_id")?,
                wakeup_request_id: row.try_get("wakeup_id")?,
                run_id: row.try_get("run_id")?,
                owner_token: row.try_get("owner_token")?,
                process_id: row.try_get("process_pid")?,
                attempt_id: attempt_id.clone(),
                attempt_epoch,
                // Connection identity is derived from the same durable
                // attempt row: its epoch and ID were persisted before launch.
                connection_epoch: attempt_epoch,
                connection_claim_id: attempt_id,
            })
        })
        .collect()
}

/// Leave a durable operator-facing warning when an expired owner has no
/// matching cleanup receipt. The Run stays running and no replacement provider
/// is launched until cleanup can be proven.
pub async fn record_cleanup_unknown(
    pool: &PgPool,
    expired: &ExpiredNativeGoalRun,
) -> Result<(), GoalRunError> {
    let mut tx = pool.begin().await?;
    crate::native_chat::lock_goal_run_budget_state(&mut tx, &expired.organization_id).await?;
    crate::goal_writes::lock_goal_run_organization(&mut tx, &expired.organization_id)
        .await
        .map_err(|error| match error {
            crate::StoreError::Database(error) => GoalRunError::Database(error),
            _ => GoalRunError::Ineligible,
        })?;
    mark_native_goal_write(&mut tx).await?;
    let row = sqlx::query(
        "UPDATE heartbeat_runs SET
           error=COALESCE(error,'Previous native Goal owner lease expired, but the exact process-host cleanup receipt is not available. No provider retry was started.'),
           error_code=CASE WHEN error_code IS NULL THEN 'goal_owner_cleanup_unknown' ELSE error_code END,
           updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust'
           AND goal_id IS NOT NULL AND scene='heartbeat' AND target_type='wakeup_request'
           AND status='running' AND execution_owner_token=$3
           AND execution_lease_expires_at <= statement_timestamp()
           AND process_exited_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM heartbeat_run_events e
             WHERE e.org_id=heartbeat_runs.org_id AND e.run_id=heartbeat_runs.id
               AND e.idempotency_key='goal-run-owner-cleanup-unknown:' || heartbeat_runs.id::text
           )
         RETURNING agent_id::text AS agent_id,error_code",
    )
    .bind(&expired.organization_id)
    .bind(&expired.run_id)
    .bind(&expired.owner_token)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(row) = row {
        let agent_id: String = row.try_get("agent_id")?;
        let error_code: String = row.try_get("error_code")?;
        sqlx::query(
            "INSERT INTO heartbeat_run_events
               (org_id,run_id,agent_id,seq,event_type,stream,level,message,idempotency_key)
             SELECT $1::uuid,$2::uuid,$3::uuid,
               coalesce((SELECT max(seq) FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid),0)+1,
               'lifecycle','system','warn',$4,$5
             ON CONFLICT (run_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING",
        )
        .bind(&expired.organization_id)
        .bind(&expired.run_id)
        .bind(agent_id)
        .bind("Native Goal owner was lost; waiting for its matching process-host cleanup receipt")
        .bind(format!("goal-run-owner-cleanup-unknown:{}", expired.run_id))
        .execute(&mut *tx)
        .await?;
        tracing::warn!(
            event = "native_goal_owner_cleanup_unknown",
            run_id = %expired.run_id,
            error_code,
        );
    }
    tx.commit().await?;
    Ok(())
}

/// Finalize one expired Goal Run only after the process host's durable receipt
/// proves cleanup for the exact persisted attempt identity. Provider work is
/// never retried by this recovery path.
pub async fn recover_expired_with_cleanup_receipt(
    pool: &PgPool,
    expired: &ExpiredNativeGoalRun,
    receipt: &DurableHostCleanupReceipt,
) -> Result<bool, GoalRunError> {
    if !receipt.cleanup_proof().matches_connection_claim(
        &expired.run_id,
        &expired.attempt_id,
        &expired.owner_token,
        expired.connection_epoch,
        &expired.connection_claim_id,
    ) || expired.connection_epoch != expired.attempt_epoch
        || expired.connection_claim_id != expired.attempt_id
        || receipt.process_id().is_some_and(|pid| pid <= 1)
        || receipt
            .process_id()
            .is_some_and(|pid| expired.process_id.is_some_and(|expected| expected != pid))
        || (expired.process_id.is_some() && receipt.process_id().is_none())
    {
        record_cleanup_unknown(pool, expired).await?;
        return Ok(false);
    }

    let mut tx = pool.begin().await?;
    crate::native_chat::lock_goal_run_budget_state(&mut tx, &expired.organization_id).await?;
    crate::goal_writes::lock_goal_run_organization(&mut tx, &expired.organization_id)
        .await
        .map_err(|error| match error {
            crate::StoreError::Database(error) => GoalRunError::Database(error),
            _ => GoalRunError::Ineligible,
        })?;
    mark_native_goal_write(&mut tx).await?;
    let run = sqlx::query(
        "SELECT agent_id::text AS agent_id,error,error_code,
                result_json::text AS result_json,usage_json::text AS usage_json
         FROM heartbeat_runs
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust'
           AND goal_id IS NOT NULL AND scene='heartbeat' AND target_type='wakeup_request'
           AND status='running' AND execution_owner_token=$3
           AND execution_lease_expires_at <= statement_timestamp()
           AND process_exited_at IS NULL AND terminal_effects_pending=false
         FOR UPDATE",
    )
    .bind(&expired.organization_id)
    .bind(&expired.run_id)
    .bind(&expired.owner_token)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(run) = run else {
        tx.rollback().await?;
        return Ok(false);
    };
    let attempt = sqlx::query(
        "SELECT id::text AS id,owner_token,attempt_epoch,status
         FROM heartbeat_run_attempts
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid
         FOR UPDATE",
    )
    .bind(&expired.organization_id)
    .bind(&expired.run_id)
    .bind(&expired.attempt_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(attempt) = attempt else {
        tx.rollback().await?;
        return Ok(false);
    };
    if attempt.try_get::<String, _>("owner_token")? != expired.owner_token
        || attempt.try_get::<i32, _>("attempt_epoch")? != expired.attempt_epoch
        || attempt.try_get::<String, _>("status")? != "started"
    {
        tx.rollback().await?;
        return Ok(false);
    }

    let agent_id: String = run.try_get("agent_id")?;
    let current_error: Option<String> = run.try_get("error")?;
    let current_error_code: Option<String> = run.try_get("error_code")?;
    let existing_result = run
        .try_get::<Option<String>, _>("result_json")?
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .filter(|value| !value.is_null());
    let existing_usage = run
        .try_get::<Option<String>, _>("usage_json")?
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .filter(|value| !value.is_null());
    let provider_result_observed = existing_result.is_some();
    let cancelled = current_error_code.as_deref() == Some("cancel_requested");
    let result_status = existing_result
        .as_ref()
        .and_then(|result| result.get("status"))
        .and_then(Value::as_str);
    let final_status = if cancelled {
        "cancelled"
    } else if result_status == Some("succeeded") && receipt.host_status() == "succeeded" {
        "succeeded"
    } else {
        "failed"
    };
    let recovery_error = if cancelled {
        current_error.clone()
    } else if final_status == "failed" {
        Some(if existing_result.is_some() {
            format!(
                "Goal provider cleanup completed after owner loss, but terminal status was not successful ({})",
                receipt.host_error_code().unwrap_or(receipt.host_status())
            )
        } else {
            "Goal owner was lost after provider launch; the process host proved cleanup, but provider result and usage were not durably observed".to_owned()
        })
    } else {
        existing_result
            .as_ref()
            .and_then(|result| result.get("error"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let error_code = if cancelled {
        "cancelled".to_owned()
    } else if final_status == "failed" && existing_result.is_none() {
        "process_lost".to_owned()
    } else if final_status == "failed" {
        existing_result
            .as_ref()
            .and_then(|result| result.get("errorCode"))
            .and_then(Value::as_str)
            .unwrap_or("process_lost")
            .to_owned()
    } else {
        String::new()
    };
    let mut result = existing_result.unwrap_or_else(|| {
        json!({
            "provider": "anthropic",
            "errorCode": if cancelled { "cancelled" } else { "process_lost" },
            "error": recovery_error,
            "recovery": {
                "processHostCleanup": "proven",
                "providerResult": "unknown",
                "usage": "unknown",
                "hostStatus": receipt.host_status(),
                "hostErrorCode": receipt.host_error_code()
            }
        })
    });
    if let Some(recovery) = result.as_object_mut() {
        recovery.insert(
            "ownerRecovery".to_owned(),
            json!({
                "processHostCleanup": "proven",
                "providerResult": if provider_result_observed { "observed" } else { "unknown" },
                "usage": if existing_usage.is_some() { "observed" } else { "unknown" },
                "hostStatus": receipt.host_status(),
                "hostErrorCode": receipt.host_error_code()
            }),
        );
    }
    let summary = existing_usage
        .as_ref()
        .and_then(|usage| summarize_result_json(&result, usage))
        .map(|value| value.to_string());
    let run_update = sqlx::query(
        "UPDATE heartbeat_runs SET
           process_pid=COALESCE(process_pid,$4),
           process_exited_at=statement_timestamp(),
           execution_owner_token=NULL,execution_lease_expires_at=NULL,
           status=$5,finished_at=COALESCE(finished_at,statement_timestamp()),
           error_code=NULLIF($6,''),error=CASE WHEN $7 THEN error ELSE $8 END,
           result_json=$9::jsonb,usage_json=$10::jsonb,result_summary_json=$11::jsonb,
           terminal_effects_pending=true,
           terminal_effects_json=$12::jsonb,terminal_effects_completed_json=NULL,
           terminal_effects_dead_lettered_json=NULL,terminal_effects_attempts_json=NULL,
           terminal_effects_next_attempt_at=NULL,terminal_effects_dead_lettered_at=NULL,
           terminal_effects_claim_token=NULL,terminal_effects_claimed_at=NULL,
           terminal_effects_attempt_count=0,terminal_effects_last_error=NULL,
           updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_owner_token=$3
           AND status='running' AND execution_lease_expires_at <= statement_timestamp()
           AND process_exited_at IS NULL RETURNING id",
    )
    .bind(&expired.organization_id)
    .bind(&expired.run_id)
    .bind(&expired.owner_token)
    .bind(receipt.process_id())
    .bind(final_status)
    .bind(&error_code)
    .bind(cancelled)
    .bind(recovery_error.as_deref())
    .bind(result.to_string())
    .bind(existing_usage.as_ref().map(Value::to_string))
    .bind(summary)
    .bind(json!({"version":1,"goalRunCostSettlement":true}).to_string())
    .fetch_optional(&mut *tx)
    .await?;
    if run_update.is_none() {
        tx.rollback().await?;
        return Ok(false);
    }
    sqlx::query(
        "UPDATE heartbeat_run_attempts SET status=$4,usage_delta_json=$5::jsonb,
           error=$6,error_code=NULLIF($7,''),finished_at=statement_timestamp()
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid
           AND owner_token=$8 AND attempt_epoch=$9 AND status='started'",
    )
    .bind(&expired.organization_id)
    .bind(&expired.run_id)
    .bind(&expired.attempt_id)
    .bind(final_status)
    .bind(existing_usage.as_ref().map(Value::to_string))
    .bind(recovery_error.as_deref())
    .bind(&error_code)
    .bind(&expired.owner_token)
    .bind(expired.attempt_epoch)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE agent_wakeup_requests SET status=$4,finished_at=statement_timestamp(),
           error=$5,updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND run_id=$3::uuid
           AND execution_authority='native_rust'",
    )
    .bind(&expired.organization_id)
    .bind(&expired.wakeup_request_id)
    .bind(&expired.run_id)
    .bind(match final_status {
        "succeeded" => "completed",
        "cancelled" => "cancelled",
        _ => "failed",
    })
    .bind(recovery_error.as_deref())
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO heartbeat_run_events
           (org_id,run_id,agent_id,seq,event_type,stream,level,message,idempotency_key)
         SELECT $1::uuid,$2::uuid,$3::uuid,
           coalesce((SELECT max(seq) FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid),0)+1,
           'lifecycle','system','warn',$4,$5
         ON CONFLICT (run_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING",
    )
    .bind(&expired.organization_id)
    .bind(&expired.run_id)
    .bind(&agent_id)
    .bind(if final_status == "cancelled" {
        "run cancelled after process-host cleanup receipt recovery"
    } else {
        "run finalized after process-host cleanup receipt recovery"
    })
    .bind(format!("goal-run-owner-recovered:{}", expired.run_id))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}

/// Claim one already-tagged Goal wakeup. A missing, legacy-owned, linked, or
/// not-yet-due row is left untouched and returns `None`.
pub async fn claim_wakeup(
    pool: &PgPool,
    organization_id: &str,
    wakeup_request_id: &str,
) -> Result<Option<GoalRunClaim>, GoalRunError> {
    let organization_id = Uuid::parse_str(organization_id)
        .map_err(|_| GoalRunError::InvalidWakeup)?
        .to_string();
    let wakeup_request_id = Uuid::parse_str(wakeup_request_id)
        .map_err(|_| GoalRunError::InvalidWakeup)?
        .to_string();
    let owner_token = Uuid::new_v4().to_string();
    let mut tx = pool.begin().await?;
    crate::native_chat::lock_goal_run_budget_state(&mut tx, &organization_id).await?;
    crate::goal_writes::lock_goal_run_organization(&mut tx, &organization_id)
        .await
        .map_err(|error| match error {
            crate::StoreError::Database(error) => GoalRunError::Database(error),
            _ => GoalRunError::Ineligible,
        })?;

    let wakeup = sqlx::query(
        "SELECT id::text AS id, org_id::text AS org_id, agent_id::text AS agent_id,
                source, trigger_detail, reason, payload::text AS payload, status,
                run_id::text AS run_id, requested_at <= statement_timestamp() AS due,
                execution_authority
         FROM agent_wakeup_requests
         WHERE org_id=$1::uuid AND id=$2::uuid
         FOR UPDATE",
    )
    .bind(&organization_id)
    .bind(&wakeup_request_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(wakeup) = wakeup else {
        tx.rollback().await?;
        return Ok(None);
    };
    if wakeup.try_get::<String, _>("execution_authority")? != "native_rust"
        || wakeup.try_get::<Option<String>, _>("run_id")?.is_some()
        || !matches!(
            wakeup.try_get::<String, _>("status")?.as_str(),
            "queued" | "deferred_goal_focus" | "deferred_goal_blocked" | "deferred_agent_paused"
        )
    {
        tx.rollback().await?;
        return Ok(None);
    }
    let due: bool = wakeup.try_get("due")?;
    if !due {
        tx.rollback().await?;
        return Ok(None);
    }

    let organization_id = wakeup.try_get::<String, _>("org_id")?;
    let agent_id = wakeup.try_get::<String, _>("agent_id")?;
    let reason = wakeup
        .try_get::<Option<String>, _>("reason")?
        .ok_or(GoalRunError::InvalidWakeup)?;
    if !GOAL_WAKE_REASONS.contains(&reason.as_str()) {
        tx.rollback().await?;
        return Ok(None);
    }
    let source = wakeup.try_get::<String, _>("source")?;
    let trigger_detail = wakeup.try_get::<Option<String>, _>("trigger_detail")?;
    let wake_payload = wakeup
        .try_get::<Option<String>, _>("payload")?
        .and_then(|payload| serde_json::from_str(&payload).ok())
        .unwrap_or_else(|| json!({}));
    if source != "on_demand"
        || trigger_detail.as_deref() != Some("system")
        || wake_payload.get("event").and_then(Value::as_str) != Some("goal_started")
    {
        tx.rollback().await?;
        return Err(GoalRunError::InvalidWakeup);
    }
    let goal_start_request_id = wake_payload
        .get("goalStartRequestId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(GoalRunError::InvalidWakeup)?;
    let wake_context = wake_payload
        .get("_paperclipWakeContext")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let goal_id = wake_payload
        .get("goalId")
        .and_then(Value::as_str)
        .or_else(|| wake_context.get("goalId").and_then(Value::as_str))
        .or_else(|| {
            wake_context
                .get("goal")
                .and_then(|goal| goal.get("id"))
                .and_then(Value::as_str)
        })
        .and_then(|value| Uuid::parse_str(value).ok())
        .map(|value| value.to_string())
        .ok_or(GoalRunError::InvalidWakeup)?;
    let expected_task_key = format!("goal:{goal_id}:goal_started:{goal_start_request_id}");
    if wake_payload.get("taskKey").and_then(Value::as_str) != Some(expected_task_key.as_str()) {
        tx.rollback().await?;
        return Err(GoalRunError::InvalidWakeup);
    }

    // Serialize claims for one Agent with its existing row lock. Do not create
    // an overlapping native Goal run while a legacy or native execution is
    // still active.
    let agent = sqlx::query(
        "SELECT a.name, a.status, a.agent_runtime_type,
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
         FROM agents a WHERE a.org_id=$1::uuid AND a.id=$2::uuid FOR UPDATE",
    )
    .bind(&organization_id)
    .bind(&agent_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(GoalRunError::Ineligible)?;
    let agent_status: String = agent.try_get("status")?;
    let runtime_type: String = agent.try_get("agent_runtime_type")?;
    let agent_name: String = agent.try_get("name")?;
    let agent_context: Value = agent.try_get("agent_context")?;
    if matches!(
        agent_status.as_str(),
        "paused" | "terminated" | "pending_approval"
    ) {
        tx.rollback().await?;
        return Err(GoalRunError::Ineligible);
    }
    if runtime_type != "claude_local" {
        tx.rollback().await?;
        return Err(GoalRunError::UnsupportedRuntime);
    }
    if crate::native_chat::ensure_goal_run_not_blocked(&mut tx, &organization_id, &agent_id)
        .await
        .is_err()
    {
        tx.rollback().await?;
        return Err(GoalRunError::Ineligible);
    }
    // Goal Runs now write and settle their own durable cost event. Keep the
    // shared hard-stop preflight above, but do not apply Native Chat's
    // unknown-cost fail-closed gate to this billed Goal execution path.
    let active: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM heartbeat_runs
           WHERE org_id=$1::uuid AND agent_id=$2::uuid
             AND (status IN ('queued','running') OR terminal_effects_pending=true)
         )",
    )
    .bind(&organization_id)
    .bind(&agent_id)
    .fetch_one(&mut *tx)
    .await?;
    if active {
        tx.rollback().await?;
        return Ok(None);
    }

    let goal = sqlx::query(
        "SELECT status, lifecycle, owner_agent_id::text AS owner_agent_id
         FROM goals WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    )
    .bind(&organization_id)
    .bind(&goal_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(GoalRunError::Ineligible)?;
    if goal.try_get::<String, _>("status")? != "active"
        || goal.try_get::<String, _>("lifecycle")? != "active"
        || goal
            .try_get::<Option<String>, _>("owner_agent_id")?
            .as_deref()
            != Some(agent_id.as_str())
    {
        tx.rollback().await?;
        return Err(GoalRunError::Ineligible);
    }
    let another_goal_focused: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM goals
           WHERE org_id=$1::uuid AND lifecycle='active' AND status='active'
             AND focus=true AND id<>$2::uuid
         )",
    )
    .bind(&organization_id)
    .bind(&goal_id)
    .fetch_one(&mut *tx)
    .await?;
    if another_goal_focused {
        tx.rollback().await?;
        return Ok(None);
    }

    mark_native_goal_write(&mut tx).await?;

    let mut context = Map::from_iter(wake_context);
    context.insert("goalId".into(), Value::String(goal_id.clone()));
    context.insert(
        "wakeupRequestId".into(),
        Value::String(wakeup_request_id.clone()),
    );
    context.insert("wakeReason".into(), Value::String(reason.clone()));
    context.insert("wakeSource".into(), Value::String(source.clone()));
    context.insert(
        "wakeTriggerDetail".into(),
        trigger_detail
            .as_ref()
            .map(|value| Value::String(value.clone()))
            .unwrap_or(Value::Null),
    );
    let context_snapshot = Value::Object(context);
    let session_intent = json!({
        "kind": "fresh",
        "reuseScope": "none",
        "sourceRunId": null,
        "sessionId": null,
        "sessionParams": null,
    });
    let idempotency_key = format!("goal-wakeup:{wakeup_request_id}");

    let run = sqlx::query(
        "INSERT INTO heartbeat_runs
           (org_id, agent_id, invocation_source, trigger_detail, status,
            running_substate, started_at, wakeup_request_id, session_reuse_scope,
            execution_authority, native_admission_hold, goal_id, context_snapshot,
            scene, target_type, target_id, idempotency_key, session_intent_json,
            execution_owner_token, execution_lease_expires_at, created_at, updated_at)
         VALUES ($1::uuid,$2::uuid,$3,$4,'running','executing',statement_timestamp(),
            $5::uuid,'none','native_rust',false,$6::uuid,$7::jsonb,
            'heartbeat','wakeup_request',$5,$8,$9::jsonb,$10,statement_timestamp()+interval '30 seconds',
            statement_timestamp(),statement_timestamp())
         RETURNING id::text AS id",
    )
    .bind(&organization_id)
    .bind(&agent_id)
    .bind(&source)
    .bind(&trigger_detail)
    .bind(&wakeup_request_id)
    .bind(&goal_id)
    .bind(context_snapshot.to_string())
    .bind(&idempotency_key)
    .bind(session_intent.to_string())
    .bind(&owner_token)
    .fetch_one(&mut *tx)
    .await?;
    let run_id: String = run.try_get("id")?;
    let attempt = sqlx::query(
        "INSERT INTO heartbeat_run_attempts
           (org_id,run_id,agent_id,attempt_index,runtime_type,status,owner_token,attempt_epoch,started_at)
         VALUES($1::uuid,$2::uuid,$3::uuid,1,'claude_local','started',$4,1,statement_timestamp())
         RETURNING id::text,attempt_epoch",
    )
    .bind(&organization_id)
    .bind(&run_id)
    .bind(&agent_id)
    .bind(&owner_token)
    .fetch_one(&mut *tx)
    .await?;
    let attempt_id: String = attempt.try_get("id")?;
    let attempt_epoch: i32 = attempt.try_get("attempt_epoch")?;
    let linked = sqlx::query(
        "UPDATE agent_wakeup_requests
         SET status='claimed', run_id=$3::uuid, claimed_at=statement_timestamp(),
             updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust'
           AND run_id IS NULL AND status IN ('queued','deferred_goal_focus','deferred_goal_blocked','deferred_agent_paused')
         RETURNING id",
    )
    .bind(&organization_id)
    .bind(&wakeup_request_id)
    .bind(&run_id)
    .fetch_optional(&mut *tx)
    .await?;
    if linked.is_none() {
        tx.rollback().await?;
        return Ok(None);
    }
    sqlx::query("UPDATE agents SET status='running', updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&organization_id)
        .bind(&agent_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO heartbeat_run_events
           (org_id,run_id,agent_id,seq,event_type,stream,level,message,idempotency_key)
         VALUES($1::uuid,$2::uuid,$3::uuid,1,'lifecycle','system','info','run started',$4)",
    )
    .bind(&organization_id)
    .bind(&run_id)
    .bind(&agent_id)
    .bind(format!("goal-run-start:{run_id}"))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let connection_epoch = attempt_epoch;
    let connection_claim_id = attempt_id.clone();
    let connection_launch_permit = ConnectionLaunchPermit::from_claim(
        run_id.clone(),
        attempt_id.clone(),
        owner_token.clone(),
        connection_epoch,
        connection_claim_id.clone(),
    );
    Ok(Some(GoalRunClaim {
        organization_id,
        agent_id,
        agent_name,
        agent_context,
        runtime_type,
        goal_id,
        wakeup_request_id,
        run_id,
        attempt_id,
        owner_token,
        attempt_epoch,
        invocation_source: source,
        trigger_detail,
        reason,
        wake_payload,
        context_snapshot,
        connection_epoch,
        connection_claim_id,
        connection_launch_permit: Some(connection_launch_permit),
    }))
}

/// Resolve the trusted Claude Agent profile and managed Goal workspace after
/// the durable Run claim. The persisted Agent config is never returned raw.
pub async fn resolve_claude_runtime(
    pool: &PgPool,
    claim: &GoalRunClaim,
    host: &crate::native_chat::config::LocalHostContext,
) -> Result<crate::native_chat::config::ResolvedCodexConfig, GoalRunError> {
    let mut tx = pool.begin().await?;
    let config = crate::native_chat::config::resolve_goal_claude_config(
        &mut tx,
        &claim.organization_id,
        &claim.goal_id,
        &claim.agent_id,
        host,
    )
    .await?;
    tx.commit().await?;
    Ok(config)
}

/// Renew only the current run/attempt owner. A stale executor cannot extend a
/// replacement owner's lease or continue after cancellation/terminalization.
pub async fn renew_lease(
    pool: &PgPool,
    claim: &GoalRunClaim,
    lease_for: Duration,
) -> Result<bool, GoalRunError> {
    if lease_for.is_zero() || lease_for > Duration::from_secs(120) {
        return Err(GoalRunError::InvalidWakeup);
    }
    let seconds = i64::try_from(lease_for.as_secs()).map_err(|_| GoalRunError::InvalidWakeup)?;
    let mut tx = pool.begin().await?;
    mark_native_goal_write(&mut tx).await?;
    let result = sqlx::query(
        "UPDATE heartbeat_runs r
         SET execution_lease_expires_at=statement_timestamp()+($5::bigint * interval '1 second'),
             updated_at=statement_timestamp()
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust'
           AND r.status='running' AND r.error_code IS DISTINCT FROM 'cancel_requested'
           AND COALESCE(r.execution_lease_expires_at > statement_timestamp(), false)
           AND r.execution_owner_token=$3
           AND EXISTS (SELECT 1 FROM heartbeat_run_attempts a
             WHERE a.org_id=r.org_id AND a.run_id=r.id AND a.id=$4::uuid
               AND a.owner_token=$3 AND a.attempt_epoch=$6 AND a.status='started')",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.owner_token)
    .bind(&claim.attempt_id)
    .bind(seconds)
    .bind(claim.attempt_epoch)
    .execute(&mut *tx)
    .await?;
    let renewed = result.rows_affected() == 1;
    tx.commit().await?;
    Ok(renewed)
}

/// Record the provider process identity only while the same owner still has a
/// running Run. A false result tells the launcher to stop the child it just
/// created and preserve the Run as unresolved until cleanup is proven.
pub async fn record_process_started(
    pool: &PgPool,
    claim: &GoalRunClaim,
    process_id: i32,
) -> Result<bool, GoalRunError> {
    if process_id <= 0 {
        return Err(GoalRunError::InvalidWakeup);
    }
    let mut tx = pool.begin().await?;
    mark_native_goal_write(&mut tx).await?;
    let result = sqlx::query(
        "UPDATE heartbeat_runs r
         SET process_pid=$4, process_started_at=statement_timestamp(),
             updated_at=statement_timestamp()
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust'
           AND r.status='running' AND r.error_code IS DISTINCT FROM 'cancel_requested'
           AND r.process_pid IS NULL AND r.process_started_at IS NULL
           AND COALESCE(r.execution_lease_expires_at > statement_timestamp(), false)
           AND r.execution_owner_token=$3
           AND EXISTS (SELECT 1 FROM heartbeat_run_attempts a
             WHERE a.org_id=r.org_id AND a.run_id=r.id AND a.id=$5::uuid
               AND a.owner_token=$3 AND a.attempt_epoch=$6 AND a.status='started')",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.owner_token)
    .bind(process_id)
    .bind(&claim.attempt_id)
    .bind(claim.attempt_epoch)
    .execute(&mut *tx)
    .await?;
    let recorded = result.rows_affected() == 1;
    tx.commit().await?;
    Ok(recorded)
}

/// Poll the durable cancellation state before launching and while the Claude
/// host is live. The owner token fences a stale process after replacement.
pub async fn cancellation_requested(
    pool: &PgPool,
    claim: &GoalRunClaim,
) -> Result<bool, GoalRunError> {
    let cancelled: Option<bool> = sqlx::query_scalar(
        "SELECT COALESCE(error_code='cancel_requested', false) FROM heartbeat_runs
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust'
           AND execution_owner_token=$3",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.owner_token)
    .fetch_optional(pool)
    .await?;
    Ok(cancelled.unwrap_or(true))
}

/// Keep ownership alive while a cancelled provider process is being reaped.
/// This separate path cannot authorize provider work and only extends a lease
/// that is still live under the matching Run and Attempt owner.
pub async fn renew_cleanup_lease(
    pool: &PgPool,
    claim: &GoalRunClaim,
    lease_for: Duration,
) -> Result<bool, GoalRunError> {
    if lease_for.is_zero() || lease_for > Duration::from_secs(120) {
        return Err(GoalRunError::InvalidWakeup);
    }
    let seconds = i64::try_from(lease_for.as_secs()).map_err(|_| GoalRunError::InvalidWakeup)?;
    let mut tx = pool.begin().await?;
    mark_native_goal_write(&mut tx).await?;
    let result = sqlx::query(
        "UPDATE heartbeat_runs r
         SET execution_lease_expires_at=statement_timestamp()+($5::bigint * interval '1 second'),
             updated_at=statement_timestamp()
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust'
           AND r.status='running' AND r.error_code='cancel_requested'
           AND COALESCE(r.execution_lease_expires_at > statement_timestamp(), false)
           AND r.execution_owner_token=$3
           AND EXISTS (SELECT 1 FROM heartbeat_run_attempts a
             WHERE a.org_id=r.org_id AND a.run_id=r.id AND a.id=$4::uuid
               AND a.owner_token=$3 AND a.attempt_epoch=$6 AND a.status='started')",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.owner_token)
    .bind(&claim.attempt_id)
    .bind(seconds)
    .bind(claim.attempt_epoch)
    .execute(&mut *tx)
    .await?;
    let renewed = result.rows_affected() == 1;
    tx.commit().await?;
    Ok(renewed)
}

/// Persist one terminal provider outcome only after the owned Claude process
/// proved cleanup. Without cleanup evidence the caller must leave the Run
/// unresolved and retain its execution lease for reconciliation.
pub async fn finalize(
    pool: &PgPool,
    claim: &GoalRunClaim,
    status: &str,
    exit_code: Option<i32>,
    signal: Option<&str>,
    usage: &Value,
    result: &Value,
    error: Option<&str>,
    cleanup_proof: &HostCleanupProof,
) -> Result<bool, GoalRunError> {
    if !cleanup_proof.matches_connection_claim(
        &claim.run_id,
        &claim.attempt_id,
        &claim.owner_token,
        claim.connection_epoch,
        &claim.connection_claim_id,
    ) || !matches!(status, "succeeded" | "failed" | "cancelled" | "timed_out")
    {
        return Ok(false);
    }
    let summary = summarize_result_json(result, usage).map(|value| value.to_string());
    let mut tx = pool.begin().await?;
    mark_native_goal_write(&mut tx).await?;
    let run = sqlx::query(
        "UPDATE heartbeat_runs
         SET error_code=CASE WHEN error_code='cancel_requested' OR $4='cancelled' THEN 'cancelled' WHEN $4='timed_out' THEN 'timeout' ELSE NULL END,
             exit_code=$6, signal=$7, usage_json=$8::jsonb, result_json=$9::jsonb,
             session_id_after=$12, session_params_after_json=$13::jsonb,
             result_summary_json=$14::jsonb,
             process_exited_at=statement_timestamp(), execution_owner_token=NULL,
             execution_lease_expires_at=NULL, terminal_effects_pending=true,
             terminal_effects_json=$15::jsonb, terminal_effects_completed_json=NULL,
             terminal_effects_dead_lettered_json=NULL, terminal_effects_attempts_json=NULL,
             terminal_effects_next_attempt_at=NULL, terminal_effects_dead_lettered_at=NULL,
             terminal_effects_claim_token=NULL, terminal_effects_claimed_at=NULL,
             terminal_effects_attempt_count=0, terminal_effects_last_error=NULL,
             updated_at=statement_timestamp(),
             status=CASE WHEN error_code='cancel_requested' OR $4='cancelled' THEN 'cancelled' ELSE $4 END,
             finished_at=coalesce(finished_at,statement_timestamp()),
             error=CASE WHEN error_code='cancel_requested' THEN error ELSE $5 END
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust'
           AND status='running'
           AND COALESCE(execution_lease_expires_at > statement_timestamp(), false)
           AND execution_owner_token=$3
           AND EXISTS (SELECT 1 FROM heartbeat_run_attempts a
             WHERE a.org_id=heartbeat_runs.org_id AND a.run_id=heartbeat_runs.id
               AND a.id=$10::uuid AND a.owner_token=$3 AND a.attempt_epoch=$11 AND a.status='started')
         RETURNING status",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.owner_token)
    .bind(status)
    .bind(error)
    .bind(exit_code)
    .bind(signal)
    .bind(usage.to_string())
    .bind(result.to_string())
    .bind(&claim.attempt_id)
    .bind(claim.attempt_epoch)
    .bind(result.get("sessionId").and_then(Value::as_str))
    .bind(result.get("sessionParamsAfter").map(Value::to_string))
    .bind(summary)
    .bind(json!({"version":1,"goalRunCostSettlement":true}).to_string())
    .fetch_optional(&mut *tx)
    .await?;
    let Some(run) = run else {
        tx.rollback().await?;
        return Ok(false);
    };
    let final_status: String = run.try_get("status")?;
    sqlx::query(
        "UPDATE heartbeat_run_attempts
         SET status=$4, usage_delta_json=$5::jsonb, error=$6,
             error_code=CASE WHEN $4='cancelled' THEN 'cancelled' WHEN $4='timed_out' THEN 'timeout' ELSE NULL END,
             finished_at=statement_timestamp()
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid
           AND owner_token=$7 AND attempt_epoch=$8 AND status='started'",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.attempt_id)
    .bind(&final_status)
    .bind(usage.to_string())
    .bind(error)
    .bind(&claim.owner_token)
    .bind(claim.attempt_epoch)
    .execute(&mut *tx)
    .await?;
    append_terminal_event(&mut tx, claim, &final_status).await?;
    sqlx::query(
        "UPDATE agent_wakeup_requests
         SET status=$3, finished_at=statement_timestamp(), error=$4,
             updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND run_id=$5::uuid",
    )
    .bind(&claim.organization_id)
    .bind(&claim.wakeup_request_id)
    .bind(match final_status.as_str() {
        "succeeded" => "completed",
        "cancelled" => "cancelled",
        _ => "failed",
    })
    .bind(error)
    .bind(&claim.run_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}

/// Finalize a failure or cancellation that occurred before consuming the
/// one-use process-host capability. This path is valid only while the claim
/// still holds that unspent capability and PostgreSQL confirms no process was
/// recorded. Once launch was attempted, only `HostCleanupProof` may terminalize.
pub async fn finalize_unlaunched(
    pool: &PgPool,
    claim: &GoalRunClaim,
    status: &str,
    error: Option<&str>,
    usage: &Value,
    result: &Value,
) -> Result<bool, GoalRunError> {
    if claim.connection_launch_permit.is_none()
        || !matches!(status, "succeeded" | "failed" | "cancelled" | "timed_out")
    {
        return Ok(false);
    }
    let summary = summarize_result_json(result, usage).map(|value| value.to_string());
    let mut tx = pool.begin().await?;
    mark_native_goal_write(&mut tx).await?;
    let run = sqlx::query(
        "UPDATE heartbeat_runs
         SET error_code=CASE WHEN error_code='cancel_requested' OR $4='cancelled' THEN 'cancelled' WHEN $4='timed_out' THEN 'timeout' ELSE NULL END,
             usage_json=$5::jsonb, result_json=$6::jsonb, result_summary_json=$10::jsonb,
             execution_owner_token=NULL, execution_lease_expires_at=NULL,
             terminal_effects_pending=true,
             terminal_effects_json=$11::jsonb, terminal_effects_completed_json=NULL,
             terminal_effects_dead_lettered_json=NULL, terminal_effects_attempts_json=NULL,
             terminal_effects_next_attempt_at=NULL, terminal_effects_dead_lettered_at=NULL,
             terminal_effects_claim_token=NULL, terminal_effects_claimed_at=NULL,
             terminal_effects_attempt_count=0, terminal_effects_last_error=NULL,
             process_exited_at=statement_timestamp(), updated_at=statement_timestamp(),
             status=CASE WHEN error_code='cancel_requested' OR $4='cancelled' THEN 'cancelled' ELSE $4 END,
             finished_at=coalesce(finished_at,statement_timestamp()),
             error=CASE WHEN error_code='cancel_requested' THEN error ELSE $7 END
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust'
           AND status='running' AND process_pid IS NULL AND process_started_at IS NULL
           AND COALESCE(execution_lease_expires_at > statement_timestamp(), false)
           AND execution_owner_token=$3
           AND EXISTS (SELECT 1 FROM heartbeat_run_attempts a
             WHERE a.org_id=heartbeat_runs.org_id AND a.run_id=heartbeat_runs.id
               AND a.id=$8::uuid AND a.owner_token=$3 AND a.attempt_epoch=$9 AND a.status='started')
         RETURNING status",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.owner_token)
    .bind(status)
    .bind(usage.to_string())
    .bind(result.to_string())
    .bind(error)
    .bind(&claim.attempt_id)
    .bind(claim.attempt_epoch)
    .bind(summary)
    .bind(json!({"version":1,"goalRunCostSettlement":true}).to_string())
    .fetch_optional(&mut *tx)
    .await?;
    let Some(run) = run else {
        tx.rollback().await?;
        return Ok(false);
    };
    let final_status: String = run.try_get("status")?;
    sqlx::query(
        "UPDATE heartbeat_run_attempts
         SET status=$4, usage_delta_json=$5::jsonb, error=$6,
             error_code=CASE WHEN $4='cancelled' THEN 'cancelled' WHEN $4='timed_out' THEN 'timeout' ELSE NULL END,
             finished_at=statement_timestamp()
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid
           AND owner_token=$7 AND attempt_epoch=$8 AND status='started'",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.attempt_id)
    .bind(&final_status)
    .bind(usage.to_string())
    .bind(error)
    .bind(&claim.owner_token)
    .bind(claim.attempt_epoch)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE agent_wakeup_requests
         SET status=$3, finished_at=statement_timestamp(), error=$4,
             updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND run_id=$5::uuid",
    )
    .bind(&claim.organization_id)
    .bind(&claim.wakeup_request_id)
    .bind(match final_status.as_str() {
        "succeeded" => "completed",
        "cancelled" => "cancelled",
        _ => "failed",
    })
    .bind(error)
    .bind(&claim.run_id)
    .execute(&mut *tx)
    .await?;
    append_terminal_event(&mut tx, claim, &final_status).await?;
    tx.commit().await?;
    Ok(true)
}

fn summarize_result_json(result: &Value, usage: &Value) -> Option<Value> {
    let mut summary = Map::new();
    for key in ["summary", "result", "message", "error", "userMessage"] {
        if let Some(value) = result.get(key).and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                summary.insert(
                    key.to_owned(),
                    Value::String(value.chars().take(500).collect()),
                );
            }
        }
    }
    for key in ["provider", "biller", "model", "billingType"] {
        let value = result
            .get(key)
            .and_then(Value::as_str)
            .or_else(|| usage.get(key).and_then(Value::as_str));
        if let Some(value) = value {
            summary.insert(
                key.to_owned(),
                Value::String(value.chars().take(500).collect()),
            );
        }
    }
    let cost = result
        .get("costUsd")
        .or_else(|| usage.get("costUsd"))
        .cloned()
        .or_else(|| {
            result
                .get("totalCostUsdMicros")
                .and_then(Value::as_u64)
                .map(|micros| json!(micros as f64 / 1_000_000.0))
        });
    if let Some(cost) = cost {
        summary.insert("costUsd".into(), cost);
    }
    (!summary.is_empty()).then_some(Value::Object(summary))
}

async fn append_terminal_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    claim: &GoalRunClaim,
    status: &str,
) -> Result<(), GoalRunError> {
    let message = match status {
        "succeeded" => "run completed",
        "cancelled" => "run cancelled",
        "timed_out" => "run timed out",
        _ => "run failed",
    };
    sqlx::query(
        "INSERT INTO heartbeat_run_events
           (org_id,run_id,agent_id,seq,event_type,stream,level,message,idempotency_key)
         SELECT $1::uuid,$2::uuid,$3::uuid,
           coalesce((SELECT max(seq) FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid),0)+1,
           'lifecycle','system',CASE WHEN $4='succeeded' THEN 'info' ELSE 'warn' END,$5,$6
         ON CONFLICT (run_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.agent_id)
    .bind(status)
    .bind(message)
    .bind(format!("goal-run-terminal:{}", claim.run_id))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Record cancellation intent on an existing Run without terminalizing it.
/// The process owner observes `error_code='cancel_requested'`, stops Claude,
/// proves cleanup, then calls `finalize` to project both Run and wakeup as
/// cancelled.
pub async fn request_cancel(
    pool: &PgPool,
    organization_id: &str,
    run_id: &str,
    reason: &str,
) -> Result<bool, GoalRunError> {
    let organization_id = Uuid::parse_str(organization_id)
        .map_err(|_| GoalRunError::InvalidWakeup)?
        .to_string();
    let run_id = Uuid::parse_str(run_id)
        .map_err(|_| GoalRunError::InvalidWakeup)?
        .to_string();
    let mut tx = pool.begin().await?;
    let requested =
        request_cancel_in_transaction(&mut tx, &organization_id, &run_id, reason).await?;
    tx.commit().await?;
    Ok(requested)
}

/// Persist a cooperative stop request inside an existing budget/effects
/// transaction. The owner remains running until its process cleanup proof is
/// finalized by the matching execution claim.
pub(crate) async fn request_cancel_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    run_id: &str,
    reason: &str,
) -> Result<bool, GoalRunError> {
    mark_native_goal_write(tx).await?;
    let run = sqlx::query(
        "UPDATE heartbeat_runs SET error=CASE WHEN error_code='cancel_requested' THEN error ELSE $3 END,
           error_code='cancel_requested', updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust'
           AND goal_id IS NOT NULL AND scene='heartbeat' AND target_type='wakeup_request'
           AND status='running'
         RETURNING agent_id::text AS agent_id",
    )
    .bind(&organization_id)
    .bind(&run_id)
    .bind(reason)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(run) = run else {
        return Ok(false);
    };
    let agent_id: String = run.try_get("agent_id")?;
    sqlx::query(
        "INSERT INTO heartbeat_run_events
           (org_id,run_id,agent_id,seq,event_type,stream,level,message,idempotency_key)
         SELECT $1::uuid,$2::uuid,$3::uuid,
           coalesce((SELECT max(seq) FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid),0)+1,
           'lifecycle','system','warn','run cancellation requested',$4
         ON CONFLICT (run_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING",
    )
    .bind(&organization_id)
    .bind(&run_id)
    .bind(&agent_id)
    .bind(format!("goal-run-cancel:{run_id}"))
    .execute(&mut **tx)
    .await?;
    Ok(true)
}
