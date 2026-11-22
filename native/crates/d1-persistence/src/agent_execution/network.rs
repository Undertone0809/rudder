//! Same-Run transport waits, fenced by the current owner and actual cleanup.
use super::{AgentExecutionError, OwnedAgentRun, SettledRequestProof, claim, mark_native_write};
use rudder_native_process_transport::HostCleanupProof;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};

pub async fn list_due(pool: &PgPool) -> Result<Vec<super::DueAgentRun>, AgentExecutionError> {
    let rows=sqlx::query("SELECT org_id::text AS org,id::text AS id FROM heartbeat_runs WHERE execution_authority='native_rust' AND scene='heartbeat' AND target_type='wakeup_request' AND status='running' AND running_substate='waiting_for_network' AND execution_owner_token IS NULL AND process_exited_at IS NOT NULL AND (network_wait_next_retry_at IS NULL OR network_wait_next_retry_at<=statement_timestamp()) ORDER BY network_wait_next_retry_at,id LIMIT 32").fetch_all(pool).await?;
    rows.into_iter()
        .map(|r| {
            Ok(super::DueAgentRun {
                organization_id: r.try_get("org")?,
                run_id: r.try_get("id")?,
            })
        })
        .collect()
}
pub fn safe_resume(
    checkpoint: &Value,
    session_id: Option<&str>,
    session_params: Option<&Value>,
) -> bool {
    let pristine = checkpoint["continuation"] == "fresh_if_pristine"
        && checkpoint["submissionPhase"] == "pre_submission"
        && checkpoint["modelOutputObserved"] != true
        && checkpoint["toolActivityObserved"] != true
        && checkpoint["sideEffectRisk"] == "none";
    let same = checkpoint["continuation"] == "resume_same_session"
        && (checkpoint["sessionId"].is_string()
            || session_id.is_some()
            || session_params.is_some());
    pristine || same
}
#[allow(clippy::too_many_arguments)]
pub async fn suspend_process(
    pool: &PgPool,
    owner: &OwnedAgentRun,
    checkpoint: &Value,
    usage: &Value,
    session_id: Option<&str>,
    session_params: Option<&Value>,
    proof: &HostCleanupProof,
) -> Result<bool, AgentExecutionError> {
    if !owner.matches_process_cleanup(proof) {
        return Ok(false);
    }
    suspend(
        pool,
        owner,
        checkpoint,
        usage,
        session_id,
        session_params,
        false,
    )
    .await
}
#[allow(clippy::too_many_arguments)]
pub async fn suspend_request(
    pool: &PgPool,
    owner: &OwnedAgentRun,
    checkpoint: &Value,
    usage: &Value,
    session_id: Option<&str>,
    session_params: Option<&Value>,
    proof: &SettledRequestProof,
) -> Result<bool, AgentExecutionError> {
    if !proof.matches(owner) {
        return Ok(false);
    }
    suspend(
        pool,
        owner,
        checkpoint,
        usage,
        session_id,
        session_params,
        true,
    )
    .await
}
async fn suspend(
    pool: &PgPool,
    owner: &OwnedAgentRun,
    checkpoint: &Value,
    usage: &Value,
    session_id: Option<&str>,
    session_params: Option<&Value>,
    request: bool,
) -> Result<bool, AgentExecutionError> {
    if !checkpoint.is_object() {
        return Err(super::http(422, "Runtime network checkpoint is invalid"));
    }
    let mut tx = pool.begin().await?;
    mark_native_write(&mut tx).await?;
    let row=sqlx::query("SELECT network_wait_attempt_count,session_id_before,session_params_before_json FROM heartbeat_runs r WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND scene='heartbeat' AND status='running' AND execution_owner_token=$3 AND error_code IS DISTINCT FROM 'cancel_requested' AND execution_lease_expires_at>statement_timestamp() AND (NOT $6 OR (process_pid IS NULL AND process_started_at IS NULL)) AND EXISTS(SELECT 1 FROM heartbeat_run_attempts a WHERE a.org_id=r.org_id AND a.run_id=r.id AND a.id=$4::uuid AND a.owner_token=$3 AND a.attempt_epoch=$5 AND a.status='started') FOR UPDATE")
        .bind(&owner.organization_id).bind(&owner.run_id).bind(&owner.owner_token).bind(&owner.attempt_id).bind(owner.attempt_epoch).bind(request).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        tx.rollback().await?;
        return Ok(false);
    };
    let count = row
        .try_get::<i32, _>("network_wait_attempt_count")?
        .saturating_add(1);
    let base =
        [2_i32, 5, 10, 20, 30, 60][usize::try_from(count.saturating_sub(1)).unwrap_or(5).min(5)];
    // Node's bounded +/-10% jitter, generated from the existing random UUID.
    let jitter = (uuid::Uuid::new_v4().as_bytes()[0] as f64 / 255.0) * 0.2 + 0.9;
    let backoff = (f64::from(base) * 1000.0 * jitter).round().max(1000.0) as i64;
    let id = session_id
        .map(str::to_owned)
        .or(row.try_get::<Option<String>, _>("session_id_before")?);
    let params = session_params
        .cloned()
        .or(row.try_get::<Option<Value>, _>("session_params_before_json")?);
    let mut checkpoint = checkpoint.clone();
    checkpoint["sessionId"] = json!(id);
    checkpoint["sessionParams"] = json!(params);
    checkpoint["nativeAttemptId"] = json!(owner.attempt_id);
    sqlx::query("UPDATE heartbeat_run_attempts SET status='waiting_for_network',checkpoint_json=COALESCE(checkpoint_json,'{}'::jsonb)||$6::jsonb,usage_delta_json=$7::jsonb,session_display_id=$8,session_params_json=$9::jsonb,error_code=$10,error=$11,suspended_at=statement_timestamp() WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$4::uuid AND owner_token=$3 AND attempt_epoch=$5 AND status='started'")
        .bind(&owner.organization_id).bind(&owner.run_id).bind(&owner.owner_token).bind(&owner.attempt_id).bind(owner.attempt_epoch).bind(&checkpoint).bind(usage).bind(&id).bind(&params).bind(checkpoint["code"].as_str().unwrap_or("provider_transport_unavailable")).bind(checkpoint["message"].as_str()).execute(&mut *tx).await?;
    sqlx::query("UPDATE heartbeat_runs SET running_substate='waiting_for_network',network_wait_started_at=COALESCE(network_wait_started_at,statement_timestamp()),network_wait_next_retry_at=statement_timestamp()+($4::bigint*interval '1 millisecond'),network_wait_attempt_count=$5,recovery_checkpoint=$6::jsonb,session_id_before=$7,session_params_before_json=$8::jsonb,session_reuse_scope=CASE WHEN $7 IS NOT NULL OR $8 IS NOT NULL THEN 'explicit' ELSE 'none' END,process_exited_at=statement_timestamp(),process_pid=NULL,process_started_at=NULL,execution_owner_token=NULL,execution_lease_expires_at=NULL,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND execution_owner_token=$3")
        .bind(&owner.organization_id).bind(&owner.run_id).bind(&owner.owner_token).bind(backoff).bind(count).bind(checkpoint).bind(id).bind(params).execute(&mut *tx).await?;
    claim::append_event(
        &mut tx,
        &owner.organization_id,
        &owner.run_id,
        &owner.agent_id,
        "run waiting for network",
        "info",
        &format!("network-wait:{}", owner.attempt_id),
    )
    .await?;
    tx.commit().await?;
    Ok(true)
}

#[allow(clippy::too_many_arguments)] // Validate the existing persisted waiting receipt without a second state wrapper.
pub(crate) async fn validate_waiting(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    run: &str,
    wake: &str,
    agent: &str,
    checkpoint: &Value,
    count: i32,
    id: Option<&str>,
    params: Option<&Value>,
) -> Result<bool, AgentExecutionError> {
    let failure = if !safe_resume(checkpoint, id, params) {
        Some((
            "network_resume_unsafe",
            "Network recovery cannot safely resume this provider attempt",
        ))
    } else if count >= 6 {
        Some((
            "network_retry_exhausted",
            "Network recovery retry policy exhausted",
        ))
    } else {
        None
    };
    let Some((code, error)) = failure else {
        return Ok(true);
    };
    mark_native_write(tx).await?;
    sqlx::query("UPDATE heartbeat_runs SET status='failed',running_substate=NULL,error_code=$3,error=$4,finished_at=statement_timestamp(),terminal_effects_pending=true,terminal_effects_json=$5::jsonb,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND status='running' AND running_substate='waiting_for_network' AND execution_owner_token IS NULL AND process_exited_at IS NOT NULL")
        .bind(org).bind(run).bind(code).bind(error).bind(json!({"version":1,"nativeAgentRunSettlement":true})).execute(&mut **tx).await?;
    sqlx::query("UPDATE agent_wakeup_requests SET status='failed',error=$4,finished_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND run_id=$3::uuid").bind(org).bind(wake).bind(run).bind(error).execute(&mut **tx).await?;
    super::analytics::terminal(tx, org, run).await?;
    claim::append_event(
        tx,
        org,
        run,
        agent,
        error,
        "error",
        &format!("network-terminal:{run}"),
    )
    .await?;
    Ok(false)
}
