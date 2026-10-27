//! Live Run observations are fenced by the existing persisted Attempt owner.
use super::{AgentExecutionError, AgentRunObserver, http, mark_native_write};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};

async fn lock(
    tx: &mut Transaction<'_, Postgres>,
    owner: &AgentRunObserver,
) -> Result<(), AgentExecutionError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(&owner.run_id)
        .execute(&mut **tx)
        .await?;
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$4::uuid AND a.owner_token=$3 AND a.attempt_epoch=$5 AND a.status='started' WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust' AND r.scene='heartbeat' AND r.status='running' AND r.execution_owner_token=$3 AND r.execution_lease_expires_at>statement_timestamp())")
        .bind(&owner.organization_id).bind(&owner.run_id).bind(&owner.owner_token).bind(&owner.attempt_id).bind(owner.attempt_epoch).fetch_one(&mut **tx).await?;
    if !active {
        return Err(http(409, "Native Agent output owner is no longer active"));
    }
    mark_native_write(tx).await?;
    Ok(())
}
pub async fn begin_log(
    pool: &PgPool,
    owner: &AgentRunObserver,
    reference: &str,
) -> Result<(), AgentExecutionError> {
    let mut tx = pool.begin().await?;
    lock(&mut tx, owner).await?;
    sqlx::query("UPDATE heartbeat_runs SET log_store='local_file',log_ref=$3,log_compressed=false,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid").bind(&owner.organization_id).bind(&owner.run_id).bind(reference).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn event(
    pool: &PgPool,
    owner: &AgentRunObserver,
    key: &str,
    event_type: &str,
    stream: &str,
    payload: &Value,
) -> Result<(), AgentExecutionError> {
    let mut tx = pool.begin().await?;
    lock(&mut tx, owner).await?;
    sqlx::query("INSERT INTO heartbeat_run_events(org_id,run_id,agent_id,seq,event_type,stream,level,payload,idempotency_key) SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE((SELECT max(seq) FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid),0)+1,$4,$5,'info',$6::jsonb,$7 ON CONFLICT(run_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING")
        .bind(&owner.organization_id).bind(&owner.run_id).bind(&owner.agent_id).bind(event_type).bind(stream).bind(payload).bind(format!("agent-output:{}:{key}",owner.attempt_id)).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn finish_log(
    pool: &PgPool,
    owner: &AgentRunObserver,
    bytes: i64,
    sha256: &str,
    stdout: &str,
    stderr: &str,
) -> Result<(), AgentExecutionError> {
    let mut tx = pool.begin().await?;
    lock(&mut tx, owner).await?;
    sqlx::query("UPDATE heartbeat_runs SET log_bytes=$3,log_sha256=$4,stdout_excerpt=$5,stderr_excerpt=$6,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&owner.organization_id).bind(&owner.run_id).bind(bytes).bind(sha256).bind(stdout).bind(stderr).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
pub async fn request_cancel(
    pool: &PgPool,
    owner: &AgentRunObserver,
    reason: &str,
) -> Result<(), AgentExecutionError> {
    let mut tx = pool.begin().await?;
    lock(&mut tx, owner).await?;
    sqlx::query("UPDATE heartbeat_runs SET error=CASE WHEN error_code='cancel_requested' THEN error ELSE $3 END,error_code='cancel_requested',updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND execution_owner_token=$4 AND status='running'")
        .bind(&owner.organization_id).bind(&owner.run_id).bind(reason).bind(&owner.owner_token).execute(&mut *tx).await?;
    tx.commit().await?;
    event(
        pool,
        owner,
        "shutdown-cancel",
        "lifecycle",
        "system",
        &json!({"message":reason}),
    )
    .await
}
pub async fn provider_failure(
    pool: &PgPool,
    owner: &AgentRunObserver,
    failure: &Value,
) -> Result<(), AgentExecutionError> {
    if failure.get("classification").and_then(Value::as_str) != Some("authentication")
        || failure.get("retryable").and_then(Value::as_bool) != Some(false)
    {
        return Ok(());
    }
    let mut tx = pool.begin().await?;
    lock(&mut tx, owner).await?;
    sqlx::query("UPDATE agents SET readiness_state='failed',readiness_checked_at=statement_timestamp(),readiness_result_code=$3,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&owner.organization_id).bind(&owner.agent_id).bind(failure.get("reason").and_then(Value::as_str).unwrap_or("provider_auth_required")).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}
