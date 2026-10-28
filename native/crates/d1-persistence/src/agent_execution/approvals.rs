//! Durable runtime approval requests. A provider receives permission only after
//! the real approval row resolves, while the exact Run/Attempt still owns work.
use super::{AgentExecutionError, AgentRunObserver, http, mark_native_write};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

pub struct RuntimeApproval {
    pub id: String,
    pub status: String,
}

pub async fn create_runtime_approval(
    pool: &PgPool,
    claim: &AgentRunObserver,
    runtime_type: &str,
    request_key: &str,
    payload: &Value,
) -> Result<RuntimeApproval, AgentExecutionError> {
    if !payload.is_object() || request_key.trim().is_empty() {
        return Err(http(422, "Invalid runtime approval request"));
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(&claim.run_id)
        .execute(&mut *tx)
        .await?;
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$4::uuid AND a.owner_token=$3 AND a.attempt_epoch=$5 AND a.runtime_type=$6 AND a.status='started' WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust' AND r.scene='heartbeat' AND r.status='running' AND r.execution_owner_token=$3 AND r.error_code IS DISTINCT FROM 'cancel_requested' AND r.execution_lease_expires_at>statement_timestamp())")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(&claim.owner_token).bind(&claim.attempt_id).bind(claim.attempt_epoch).bind(runtime_type).fetch_one(&mut *tx).await?;
    if !active {
        return Err(http(409, "Runtime approval owner is no longer active"));
    }
    let approval =
        insert_runtime_approval(&mut tx, claim, runtime_type, request_key, payload).await?;
    tx.commit().await?;
    Ok(approval)
}

pub(crate) async fn insert_runtime_approval(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    claim: &AgentRunObserver,
    runtime_type: &str,
    request_key: &str,
    payload: &Value,
) -> Result<RuntimeApproval, AgentExecutionError> {
    let existing=sqlx::query("SELECT id::text AS id,status FROM approvals WHERE org_id=$1::uuid AND requested_by_agent_id=$2::uuid AND type='agent_runtime' AND payload->>'nativeApprovalRequestKey'=$3 ORDER BY created_at LIMIT 1")
        .bind(&claim.organization_id).bind(&claim.agent_id).bind(request_key).fetch_optional(&mut **tx).await?;
    if let Some(existing) = existing {
        return Ok(RuntimeApproval {
            id: existing.try_get("id")?,
            status: existing.try_get("status")?,
        });
    }
    let mut payload = payload.clone();
    payload["runId"] = json!(claim.run_id);
    payload["agentId"] = json!(claim.agent_id);
    payload["agentRuntimeType"] = json!(runtime_type);
    payload["nativeAttemptId"] = json!(claim.attempt_id);
    payload["nativeApprovalRequestKey"] = json!(request_key);
    let id:String=sqlx::query_scalar("INSERT INTO approvals(org_id,type,requested_by_agent_id,requested_by_user_id,status,payload,decision_note,decided_by_user_id,decided_at) VALUES($1::uuid,'agent_runtime',$2::uuid,NULL,'pending',$3::jsonb,NULL,NULL,NULL) RETURNING id::text")
        .bind(&claim.organization_id).bind(&claim.agent_id).bind(payload).fetch_one(&mut **tx).await?;
    mark_native_write(tx).await?;
    sqlx::query("INSERT INTO heartbeat_run_events(org_id,run_id,agent_id,seq,event_type,stream,level,message,payload,idempotency_key) SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE((SELECT max(seq) FROM heartbeat_run_events WHERE run_id=$2::uuid),0)+1,'approval.requested','system','info','agent runtime approval requested',$4::jsonb,$5 ON CONFLICT(run_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(&claim.agent_id).bind(json!({"approvalId":id,"type":"agent_runtime"})).bind(format!("approval-requested:{request_key}")).execute(&mut **tx).await?;
    Ok(RuntimeApproval {
        id,
        status: "pending".into(),
    })
}

pub async fn read_runtime_approval(
    pool: &PgPool,
    claim: &AgentRunObserver,
    approval_id: &str,
) -> Result<RuntimeApproval, AgentExecutionError> {
    let row=sqlx::query("SELECT approval.id::text AS id,approval.status FROM approvals approval JOIN heartbeat_runs r ON r.org_id=approval.org_id AND r.id=$2::uuid JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$4::uuid AND a.owner_token=$3 AND a.attempt_epoch=$5 AND a.status='started' WHERE approval.org_id=$1::uuid AND approval.id=$6::uuid AND approval.requested_by_agent_id=r.agent_id AND approval.type='agent_runtime' AND approval.payload->>'runId'=r.id::text AND approval.payload->>'nativeAttemptId'=a.id::text AND r.execution_authority='native_rust' AND r.scene='heartbeat' AND r.status='running' AND r.execution_owner_token=$3 AND r.error_code IS DISTINCT FROM 'cancel_requested' AND r.execution_lease_expires_at>statement_timestamp()")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(&claim.owner_token).bind(&claim.attempt_id).bind(claim.attempt_epoch).bind(approval_id).fetch_optional(pool).await?.ok_or_else(||http(409,"Runtime approval owner is no longer active"))?;
    Ok(RuntimeApproval {
        id: row.try_get("id")?,
        status: row.try_get("status")?,
    })
}
