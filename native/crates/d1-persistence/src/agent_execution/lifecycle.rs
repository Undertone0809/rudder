//! Shared, cleanup-gated ownership of persisted native Agent execution.
//!
//! Goal and generic Agent Runs use the same lease, attempt and one-use process
//! launch authority. Provider work cannot clear that authority without its
//! exact host cleanup proof, or an unspent launch permit before launch.

use super::{OwnedAgentRun, SettledRequestProof, mark_native_write};
use crate::goal_runs::GoalRunError;
use rudder_native_process_transport::HostCleanupProof;
use serde_json::{Map, Value, json};
use sqlx::{PgPool, Row};
use std::time::Duration;

/// Renew only the current run/attempt owner. A stale executor cannot extend a
/// replacement owner's lease or continue after cancellation/terminalization.
pub async fn renew_lease(
    pool: &PgPool,
    claim: &OwnedAgentRun,
    lease_for: Duration,
) -> Result<bool, GoalRunError> {
    if lease_for.is_zero() || lease_for > Duration::from_secs(120) {
        return Err(GoalRunError::InvalidWakeup);
    }
    let seconds = i64::try_from(lease_for.as_secs()).map_err(|_| GoalRunError::InvalidWakeup)?;
    let mut tx = pool.begin().await?;
    mark_native_write(&mut tx).await?;
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
    claim: &OwnedAgentRun,
    process_id: i32,
) -> Result<bool, GoalRunError> {
    if process_id <= 0 {
        return Err(GoalRunError::InvalidWakeup);
    }
    let mut tx = pool.begin().await?;
    mark_native_write(&mut tx).await?;
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
    claim: &OwnedAgentRun,
) -> Result<bool, GoalRunError> {
    let row = sqlx::query(
        "SELECT r.error_code,a.status AS agent_status,o.status AS organization_status
         FROM heartbeat_runs r
         JOIN agents a ON a.org_id=r.org_id AND a.id=r.agent_id
         JOIN organizations o ON o.id=r.org_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust'
           AND r.execution_owner_token=$3",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.owner_token)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(true);
    };
    if row.try_get::<Option<String>, _>("error_code")?.as_deref() == Some("cancel_requested") {
        return Ok(true);
    }

    let agent_status: String = row.try_get("agent_status")?;
    let organization_status: String = row.try_get("organization_status")?;
    let pause_reason = match agent_status.as_str() {
        "paused" => Some("Cancelled because the Agent was paused"),
        "terminated" => Some("Cancelled because the Agent was terminated"),
        _ if organization_status == "paused" => {
            Some("Cancelled because the organization was paused")
        }
        _ => None,
    };
    if let Some(reason) = pause_reason {
        // Reuse the native Goal's cleanup-gated cancellation intent. The run
        // remains running and owned until the live host proves cleanup.
        request_cancel_owned(pool, claim, reason).await?;
        return Ok(true);
    }
    Ok(false)
}

/// Keep ownership alive while a cancelled provider process is being reaped.
/// This separate path cannot authorize provider work and only extends a lease
/// that is still live under the matching Run and Attempt owner.
pub async fn renew_cleanup_lease(
    pool: &PgPool,
    claim: &OwnedAgentRun,
    lease_for: Duration,
) -> Result<bool, GoalRunError> {
    if lease_for.is_zero() || lease_for > Duration::from_secs(120) {
        return Err(GoalRunError::InvalidWakeup);
    }
    let seconds = i64::try_from(lease_for.as_secs()).map_err(|_| GoalRunError::InvalidWakeup)?;
    let mut tx = pool.begin().await?;
    mark_native_write(&mut tx).await?;
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
#[allow(clippy::too_many_arguments)] // Keep terminal fields aligned with the owned process receipt.
pub async fn finalize(
    pool: &PgPool,
    claim: &OwnedAgentRun,
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
    finalize_settled(
        pool, claim, status, exit_code, signal, usage, result, error, false,
    )
    .await
}

/// Finalize a runtime HTTP request only after its owned future returned. This
/// receipt does not claim that a remote service stopped an independent job.
#[allow(clippy::too_many_arguments)]
pub async fn finalize_request(
    pool: &PgPool,
    claim: &OwnedAgentRun,
    status: &str,
    usage: &Value,
    result: &Value,
    error: Option<&str>,
    proof: &SettledRequestProof,
) -> Result<bool, GoalRunError> {
    if !proof.matches(claim)
        || !matches!(status, "succeeded" | "failed" | "cancelled" | "timed_out")
    {
        return Ok(false);
    }
    finalize_settled(pool, claim, status, None, None, usage, result, error, true).await
}

#[allow(clippy::too_many_arguments)] // Both cleanup classes persist the same terminal receipt.
async fn finalize_settled(
    pool: &PgPool,
    claim: &OwnedAgentRun,
    status: &str,
    exit_code: Option<i32>,
    signal: Option<&str>,
    usage: &Value,
    result: &Value,
    error: Option<&str>,
    request_settled: bool,
) -> Result<bool, GoalRunError> {
    let session_id_after = result.get("sessionId").and_then(Value::as_str);
    let session_params_after = result.get("sessionParamsAfter").map(Value::to_string);
    let mut persisted_result = result.clone();
    if let Some(fields) = persisted_result.as_object_mut() {
        fields.remove("sessionId");
        fields.remove("sessionParamsAfter");
    }
    let summary = summarize_result_json(&persisted_result, usage).map(|value| value.to_string());
    let mut tx = pool.begin().await?;
    mark_native_write(&mut tx).await?;
    let run = sqlx::query(
        "UPDATE heartbeat_runs
         SET error_code=CASE WHEN error_code='cancel_requested' OR $4='cancelled' THEN 'cancelled' WHEN $4='timed_out' THEN 'timeout' ELSE CASE WHEN $15 THEN $9::jsonb->>'errorCode' ELSE NULL END END,
             exit_code=$6, signal=$7, usage_json=$8::jsonb, result_json=$9::jsonb,
             result_summary_json=$12::jsonb,
             session_id_after=CASE WHEN $15 THEN $16 ELSE session_id_after END,
             session_params_after_json=CASE WHEN $15 THEN $17::jsonb ELSE session_params_after_json END,
             running_substate=CASE WHEN $15 THEN NULL ELSE running_substate END,
             process_exited_at=statement_timestamp(), execution_owner_token=NULL,
             execution_lease_expires_at=NULL, terminal_effects_pending=true,
             terminal_effects_json=$13::jsonb, terminal_effects_completed_json=NULL,
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
           AND (NOT $14 OR (process_pid IS NULL AND process_started_at IS NULL))
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
    .bind(persisted_result.to_string())
    .bind(&claim.attempt_id)
    .bind(claim.attempt_epoch)
    .bind(summary)
    .bind(claim.terminal_effects_intent().to_string())
    .bind(request_settled)
    .bind(claim.is_generic())
    .bind(session_id_after)
    .bind(&session_params_after)
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
             session_display_id=$9, session_params_json=$10::jsonb,
             error_code=CASE WHEN $4='cancelled' THEN 'cancelled' WHEN $4='timed_out' THEN 'timeout' ELSE $11 END,
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
    .bind(session_id_after)
    .bind(session_params_after)
    .bind(if claim.is_generic() {result.get("errorCode").and_then(Value::as_str)} else {None})
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
    claim: &OwnedAgentRun,
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
    mark_native_write(&mut tx).await?;
    let run = sqlx::query(
        "UPDATE heartbeat_runs
         SET error_code=CASE WHEN error_code='cancel_requested' OR $4='cancelled' THEN 'cancelled' WHEN $4='timed_out' THEN 'timeout' ELSE CASE WHEN $12 THEN $6::jsonb->>'errorCode' ELSE NULL END END,
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
    .bind(claim.terminal_effects_intent().to_string())
    .bind(claim.is_generic())
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
             error_code=CASE WHEN $4='cancelled' THEN 'cancelled' WHEN $4='timed_out' THEN 'timeout' ELSE $9 END,
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
    .bind(if claim.is_generic() {result.get("errorCode").and_then(Value::as_str)} else {None})
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

pub(crate) fn summarize_result_json(result: &Value, usage: &Value) -> Option<Value> {
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
    claim: &OwnedAgentRun,
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
    .bind(claim.terminal_event_key())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn request_cancel_owned(
    pool: &PgPool,
    claim: &OwnedAgentRun,
    reason: &str,
) -> Result<(), GoalRunError> {
    let mut tx = pool.begin().await?;
    mark_native_write(&mut tx).await?;
    let run = sqlx::query(
        "UPDATE heartbeat_runs SET error=CASE WHEN error_code='cancel_requested' THEN error ELSE $4 END,
           error_code='cancel_requested',updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust'
           AND execution_owner_token=$3 AND status='running'
         RETURNING agent_id",
    )
    .bind(&claim.organization_id)
    .bind(&claim.run_id)
    .bind(&claim.owner_token)
    .bind(reason)
    .fetch_optional(&mut *tx)
    .await?;
    if run.is_some() {
        sqlx::query(
            "INSERT INTO heartbeat_run_events
               (org_id,run_id,agent_id,seq,event_type,stream,level,message,idempotency_key)
             SELECT $1::uuid,$2::uuid,$3::uuid,
               coalesce((SELECT max(seq) FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid),0)+1,
               'lifecycle','system','warn','run cancellation requested',$4
             ON CONFLICT (run_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING",
        )
        .bind(&claim.organization_id)
        .bind(&claim.run_id)
        .bind(&claim.agent_id)
        .bind(claim.cancellation_event_key())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
