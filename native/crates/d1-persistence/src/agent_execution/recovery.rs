//! Expired generic owners reuse the existing attempt/lease identity. Request
//! owner loss records an unknown remote result; it never manufactures cleanup.
use super::{AgentExecutionError, analytics, mark_native_write};
use rudder_native_process_transport::{
    DurableCleanupReceiptError, DurableHostCleanupReceipt, read_durable_cleanup_receipt,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::path::Path;

/// Durable observation identity, with no launch or request capability.
/// Opaque tokens deliberately have no Debug/Serialize implementation.
pub struct ExpiredAgentRun {
    pub organization_id: String,
    pub agent_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub wakeup_request_id: String,
    owner_token: String,
    attempt_epoch: i32,
    process_id: Option<i32>,
    request_started: bool,
}
impl ExpiredAgentRun {
    pub fn request_started(&self) -> bool {
        self.request_started
    }
    pub fn read_process_cleanup_receipt(
        &self,
        runtime_root: &Path,
    ) -> Result<Option<DurableHostCleanupReceipt>, DurableCleanupReceiptError> {
        if self.request_started {
            return Ok(None);
        }
        read_durable_cleanup_receipt(
            runtime_root,
            &self.run_id,
            &self.attempt_id,
            &self.owner_token,
            self.attempt_epoch,
            &self.attempt_id,
        )
    }
}

pub async fn list_expired(pool: &PgPool) -> Result<Vec<ExpiredAgentRun>, AgentExecutionError> {
    let rows=sqlx::query("SELECT r.org_id::text AS org,r.agent_id::text AS agent,r.id::text AS run,r.wakeup_request_id::text AS wake,r.execution_owner_token AS token,r.process_pid,a.id::text AS attempt,a.attempt_epoch,COALESCE(a.checkpoint_json#>>'{executionTransport,kind}'='request',false) AS request_started FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.owner_token=r.execution_owner_token AND a.status='started' JOIN agent_wakeup_requests w ON w.org_id=r.org_id AND w.id=r.wakeup_request_id AND w.run_id=r.id AND w.execution_authority='native_rust' WHERE r.execution_authority='native_rust' AND r.scene='heartbeat' AND r.target_type='wakeup_request' AND r.idempotency_key NOT LIKE 'goal-wakeup:%' AND r.status='running' AND r.execution_owner_token IS NOT NULL AND r.execution_lease_expires_at<=statement_timestamp() AND r.process_exited_at IS NULL AND r.terminal_effects_pending=false ORDER BY r.execution_lease_expires_at,r.id LIMIT 32")
        .fetch_all(pool).await?;
    rows.into_iter()
        .map(|row| {
            Ok(ExpiredAgentRun {
                organization_id: row.try_get("org")?,
                agent_id: row.try_get("agent")?,
                run_id: row.try_get("run")?,
                wakeup_request_id: row.try_get("wake")?,
                owner_token: row.try_get("token")?,
                process_id: row.try_get("process_pid")?,
                attempt_id: row.try_get("attempt")?,
                attempt_epoch: row.try_get("attempt_epoch")?,
                request_started: row.try_get("request_started")?,
            })
        })
        .collect()
}

/// An expired in-flight request cannot return its in-memory settlement proof.
/// Fail visibly and retain unknown remote state; do not replay or claim stop.
pub async fn recover_request_owner_lost(
    pool: &PgPool,
    expired: &ExpiredAgentRun,
) -> Result<bool, AgentExecutionError> {
    if !expired.request_started || expired.process_id.is_some() {
        return Ok(false);
    }
    recover(pool, expired, None).await
}

pub async fn recover_process_with_cleanup_receipt(
    pool: &PgPool,
    expired: &ExpiredAgentRun,
    receipt: &DurableHostCleanupReceipt,
) -> Result<bool, AgentExecutionError> {
    if expired.request_started
        || !receipt.cleanup_proof().matches_connection_claim(
            &expired.run_id,
            &expired.attempt_id,
            &expired.owner_token,
            expired.attempt_epoch,
            &expired.attempt_id,
        )
        || receipt.process_id().is_some_and(|pid| {
            pid <= 1 || expired.process_id.is_some_and(|expected| expected != pid)
        })
        || (expired.process_id.is_some() && receipt.process_id().is_none())
    {
        record_cleanup_unknown(pool, expired).await?;
        return Ok(false);
    }
    recover(pool, expired, Some(receipt)).await
}

pub async fn record_cleanup_unknown(
    pool: &PgPool,
    expired: &ExpiredAgentRun,
) -> Result<(), AgentExecutionError> {
    let mut tx = pool.begin().await?;
    mark_native_write(&mut tx).await?;
    let changed=sqlx::query("UPDATE heartbeat_runs r SET error=COALESCE(error,'Rudder restarted before this runtime finished. Waiting for its process host to confirm cleanup; no replacement was started.'),error_code=COALESCE(error_code,'runtime_owner_cleanup_unknown'),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND scene='heartbeat' AND status='running' AND execution_owner_token=$3 AND execution_lease_expires_at<=statement_timestamp() AND process_exited_at IS NULL AND EXISTS(SELECT 1 FROM heartbeat_run_attempts a WHERE a.org_id=r.org_id AND a.run_id=r.id AND a.id=$4::uuid AND a.owner_token=$3 AND a.attempt_epoch=$5 AND a.status='started') AND NOT EXISTS(SELECT 1 FROM heartbeat_run_events e WHERE e.org_id=r.org_id AND e.run_id=r.id AND e.idempotency_key=$6)")
        .bind(&expired.organization_id).bind(&expired.run_id).bind(&expired.owner_token).bind(&expired.attempt_id).bind(expired.attempt_epoch).bind(format!("agent-owner-cleanup-unknown:{}",expired.attempt_id)).execute(&mut *tx).await?.rows_affected()==1;
    if changed {
        event(
            &mut tx,
            expired,
            "Previous runtime owner was lost; waiting for its process-host cleanup receipt",
            "cleanup-unknown",
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn recover(
    pool: &PgPool,
    expired: &ExpiredAgentRun,
    receipt: Option<&DurableHostCleanupReceipt>,
) -> Result<bool, AgentExecutionError> {
    let mut tx = pool.begin().await?;
    // Preserve Issue -> Run -> Agent ordering used by claim and cancel.
    let issue:Option<String>=sqlx::query_scalar("SELECT context_snapshot->>'issueId' FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&expired.organization_id).bind(&expired.run_id).fetch_optional(&mut *tx).await?.flatten();
    if let Some(issue) = issue.filter(|id| uuid::Uuid::parse_str(id).is_ok()) {
        sqlx::query("SELECT id FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
            .bind(&expired.organization_id)
            .bind(issue)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(&expired.run_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("agent-run-state:{}", expired.agent_id))
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(&expired.organization_id)
        .bind(&expired.agent_id)
        .execute(&mut *tx)
        .await?;
    mark_native_write(&mut tx).await?;
    let row=sqlx::query("SELECT r.error_code,r.result_json,r.usage_json,a.checkpoint_json FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$4::uuid AND a.owner_token=$3 AND a.attempt_epoch=$5 AND a.status='started' WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust' AND r.scene='heartbeat' AND r.target_type='wakeup_request' AND r.idempotency_key NOT LIKE 'goal-wakeup:%' AND r.status='running' AND r.execution_owner_token=$3 AND r.execution_lease_expires_at<=statement_timestamp() AND r.process_exited_at IS NULL AND r.terminal_effects_pending=false FOR UPDATE OF r,a")
        .bind(&expired.organization_id).bind(&expired.run_id).bind(&expired.owner_token).bind(&expired.attempt_id).bind(expired.attempt_epoch).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        tx.rollback().await?;
        return Ok(false);
    };
    let checkpoint = row
        .try_get::<Option<Value>, _>("checkpoint_json")?
        .unwrap_or_else(|| json!({}));
    let request = checkpoint
        .pointer("/executionTransport/kind")
        .and_then(Value::as_str)
        == Some("request");
    if request != expired.request_started || request != receipt.is_none() {
        tx.rollback().await?;
        return Ok(false);
    };
    let cancelled = !request
        && row.try_get::<Option<String>, _>("error_code")?.as_deref() == Some("cancel_requested");
    let mut result = row
        .try_get::<Option<Value>, _>("result_json")?
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let usage = row.try_get::<Option<Value>, _>("usage_json")?;
    let status = if cancelled {
        "cancelled"
    } else if receipt.is_some_and(|r| r.host_status() == "succeeded")
        && result.get("status").and_then(Value::as_str) == Some("succeeded")
    {
        "succeeded"
    } else {
        "failed"
    };
    let code = if request {
        "runtime_owner_lost"
    } else if cancelled {
        "cancelled"
    } else if status == "failed" {
        "process_lost"
    } else {
        ""
    };
    let error = if request {
        Some(
            "Rudder restarted while this runtime request was in progress. The remote result is unknown. Review the external runtime before retrying.",
        )
    } else if cancelled {
        Some("Runtime cancelled; its process host confirmed cleanup after Rudder restarted.")
    } else if status == "failed" {
        Some(
            "Rudder restarted before the runtime result was saved. Its process host confirmed cleanup.",
        )
    } else {
        None
    };
    result["ownerRecovery"] = if let Some(receipt) = receipt {
        json!({"processHostCleanup":"proven","providerResult":if result.get("status").is_some(){"observed"}else{"unknown"},"usage":if usage.is_some(){"observed"}else{"unknown"},"hostStatus":receipt.host_status(),"hostErrorCode":receipt.host_error_code()})
    } else {
        json!({"requestOwner":"lost","remoteState":"unknown","automaticRetry":false})
    };
    if !code.is_empty() {
        result["errorCode"] = json!(code);
    }
    let intent =
        json!({"version":1,"nativeAgentRunSettlement":true,"nativeRequestOwnerLost":request});
    let changed=sqlx::query("UPDATE heartbeat_runs SET process_pid=COALESCE(process_pid,$4),process_exited_at=CASE WHEN $5 THEN NULL ELSE statement_timestamp() END,execution_owner_token=NULL,execution_lease_expires_at=NULL,status=$6,running_substate=NULL,finished_at=COALESCE(finished_at,statement_timestamp()),error_code=NULLIF($7,''),error=$8,result_json=$9::jsonb,terminal_effects_pending=true,terminal_effects_json=$10::jsonb,terminal_effects_completed_json=NULL,terminal_effects_dead_lettered_json=NULL,terminal_effects_attempts_json=NULL,terminal_effects_next_attempt_at=NULL,terminal_effects_dead_lettered_at=NULL,terminal_effects_claim_token=NULL,terminal_effects_claimed_at=NULL,terminal_effects_attempt_count=0,terminal_effects_last_error=NULL,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND execution_owner_token=$3 AND status='running' AND execution_lease_expires_at<=statement_timestamp()")
        .bind(&expired.organization_id).bind(&expired.run_id).bind(&expired.owner_token).bind(receipt.and_then(DurableHostCleanupReceipt::process_id)).bind(request).bind(status).bind(code).bind(error).bind(&result).bind(intent).execute(&mut *tx).await?.rows_affected()==1;
    if !changed {
        tx.rollback().await?;
        return Ok(false);
    };
    let mut checkpoint = checkpoint;
    if request {
        checkpoint["executionTransport"]["state"] = json!("owner_lost");
        checkpoint["executionTransport"]["remoteState"] = json!("unknown");
    }
    sqlx::query("UPDATE heartbeat_run_attempts SET status=$6,error_code=NULLIF($7,''),error=$8,checkpoint_json=$9::jsonb,usage_delta_json=$10::jsonb,finished_at=statement_timestamp() WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$4::uuid AND owner_token=$3 AND attempt_epoch=$5 AND status='started'")
        .bind(&expired.organization_id).bind(&expired.run_id).bind(&expired.owner_token).bind(&expired.attempt_id).bind(expired.attempt_epoch).bind(status).bind(code).bind(error).bind(checkpoint).bind(usage).execute(&mut *tx).await?;
    sqlx::query("UPDATE agent_wakeup_requests SET status=$4,error=$5,finished_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND run_id=$3::uuid AND execution_authority='native_rust'")
        .bind(&expired.organization_id).bind(&expired.wakeup_request_id).bind(&expired.run_id).bind(if status=="succeeded"{"completed"}else{status}).bind(error).execute(&mut *tx).await?;
    event(
        &mut tx,
        expired,
        if request {
            "Runtime request interrupted by Rudder restart; remote result unknown"
        } else {
            "Runtime finalized after matching process-host cleanup recovery"
        },
        "recovered",
    )
    .await?;
    analytics::terminal(&mut tx, &expired.organization_id, &expired.run_id).await?;
    tx.commit().await?;
    Ok(true)
}
async fn event(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    run: &ExpiredAgentRun,
    message: &str,
    key: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO heartbeat_run_events(org_id,run_id,agent_id,seq,event_type,stream,level,message,idempotency_key) SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE((SELECT max(seq) FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid),0)+1,'lifecycle','system','warn',$4,$5 ON CONFLICT(run_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING")
        .bind(&run.organization_id).bind(&run.run_id).bind(&run.agent_id).bind(message).bind(format!("agent-owner-{key}:{}",run.attempt_id)).execute(&mut **tx).await?;
    Ok(())
}
