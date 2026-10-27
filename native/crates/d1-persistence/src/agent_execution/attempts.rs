//! A fallback is another persisted Attempt under the same Run. The old launch
//! capability is never reused; ownership advances only after exact cleanup.
use super::{
    AgentExecutionError, AgentRunClaim, OwnedAgentRun, SettledRequestProof, Settlement,
    mark_native_write, model_attempts::ModelAttempt,
};
use rudder_native_process_transport::HostCleanupProof;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

pub enum Cleanup<'a> {
    Process(&'a HostCleanupProof),
    Request(&'a SettledRequestProof),
    Unlaunched,
}
pub struct Failure<'a> {
    pub status: &'a str,
    pub error_code: Option<&'a str>,
    pub error: Option<&'a str>,
    pub usage: &'a Value,
    pub session_id: Option<&'a str>,
    pub session_params: Option<&'a Value>,
}
impl Cleanup<'_> {
    fn matches(&self, claim: &OwnedAgentRun) -> bool {
        match self {
            Self::Process(proof) => claim.matches_process_cleanup(proof),
            Self::Request(proof) => proof.matches(claim),
            Self::Unlaunched => claim.launch_permit_unspent(),
        }
    }
}

pub async fn record_model(
    pool: &PgPool,
    claim: &AgentRunClaim,
    spec: &ModelAttempt,
) -> Result<bool, AgentExecutionError> {
    if spec.runtime_type != claim.runtime_type || spec.index != claim.model_attempt_index {
        return Err(super::http(
            409,
            "Agent model attempt does not match its persisted owner",
        ));
    }
    let mut tx = pool.begin().await?;
    mark_native_write(&mut tx).await?;
    let changed=sqlx::query("UPDATE heartbeat_run_attempts a SET runtime_type=$6,model=$7,fallback_index=$8,is_fallback=$9,checkpoint_json=COALESCE(checkpoint_json,'{}'::jsonb)||$10::jsonb WHERE a.org_id=$1::uuid AND a.run_id=$2::uuid AND a.id=$4::uuid AND a.owner_token=$3 AND a.attempt_epoch=$5 AND a.status='started' AND EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.org_id=a.org_id AND r.id=a.run_id AND r.execution_owner_token=$3 AND r.status='running' AND r.error_code IS DISTINCT FROM 'cancel_requested' AND r.execution_lease_expires_at>statement_timestamp())")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(&claim.owner_token).bind(&claim.attempt_id).bind(claim.attempt_epoch).bind(&spec.runtime_type).bind(&spec.model).bind(spec.fallback_index).bind(spec.fallback_index.is_some()).bind(json!({"modelAttemptIndex":spec.index,"runtimeType":spec.runtime_type,"model":spec.model})).execute(&mut *tx).await?.rows_affected()==1;
    tx.commit().await?;
    Ok(changed)
}
pub async fn advance(
    pool: &PgPool,
    claim: &mut AgentRunClaim,
    spec: &ModelAttempt,
    failure: Failure<'_>,
    cleanup: Cleanup<'_>,
) -> Result<Option<AgentRunClaim>, AgentExecutionError> {
    if spec.index <= claim.model_attempt_index
        || !matches!(failure.status, "failed" | "timed_out")
        || !cleanup.matches(&claim.owned)
    {
        return Ok(None);
    }
    let mut tx = pool.begin().await?;
    if let Some(issue) = claim.issue_id.as_deref() {
        sqlx::query("SELECT id FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
            .bind(&claim.organization_id)
            .bind(issue)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(&claim.run_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("agent-run-state:{}", claim.agent_id))
        .execute(&mut *tx)
        .await?;
    let agent = sqlx::query(
        "SELECT status,pause_reason FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    )
    .bind(&claim.organization_id)
    .bind(&claim.agent_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(agent) = agent else { return Ok(None) };
    let status: String = agent.try_get("status")?;
    let pause: Option<String> = agent.try_get("pause_reason")?;
    if matches!(
        status.as_str(),
        "paused" | "terminated" | "pending_approval"
    ) || super::budget::invocation_block(
        &mut tx,
        &claim.organization_id,
        &claim.agent_id,
        &status,
        pause.as_deref(),
    )
    .await?
    .is_some()
    {
        return Ok(None);
    }
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$4::uuid AND a.owner_token=$3 AND a.attempt_epoch=$5 AND a.status='started' WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust' AND r.scene='heartbeat' AND r.status='running' AND r.execution_owner_token=$3 AND r.error_code IS DISTINCT FROM 'cancel_requested' AND r.execution_lease_expires_at>statement_timestamp() AND (NOT $6 OR (r.process_pid IS NULL AND r.process_started_at IS NULL)) FOR UPDATE OF r,a)")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(&claim.owner_token).bind(&claim.attempt_id).bind(claim.attempt_epoch).bind(matches!(cleanup,Cleanup::Request(_)|Cleanup::Unlaunched)).fetch_one(&mut *tx).await?;
    if !active {
        return Ok(None);
    }
    if let Some(issue) = claim.issue_id.as_deref() {
        let fenced:bool=sqlx::query_scalar("SELECT COALESCE(r.created_at<=i.execution_cancellation_at,false) FROM heartbeat_runs r JOIN issues i ON i.org_id=r.org_id AND i.id=$3::uuid WHERE r.org_id=$1::uuid AND r.id=$2::uuid").bind(&claim.organization_id).bind(&claim.run_id).bind(issue).fetch_one(&mut *tx).await?;
        if fenced {
            return Ok(None);
        }
    }
    mark_native_write(&mut tx).await?;
    sqlx::query("UPDATE heartbeat_run_attempts SET status=$6,error_code=$7,error=$8,usage_delta_json=$9::jsonb,session_display_id=$10,session_params_json=$11::jsonb,checkpoint_json=COALESCE(checkpoint_json,'{}'::jsonb)||$12::jsonb,finished_at=statement_timestamp() WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$4::uuid AND owner_token=$3 AND attempt_epoch=$5 AND status='started'")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(&claim.owner_token).bind(&claim.attempt_id).bind(claim.attempt_epoch).bind(failure.status).bind(failure.error_code).bind(failure.error).bind(failure.usage).bind(failure.session_id).bind(failure.session_params).bind(json!({"cleanup":{"kind":if matches!(cleanup,Cleanup::Request(_)){"request"}else if matches!(cleanup,Cleanup::Unlaunched){"unlaunched"}else{"process"},"state":if matches!(cleanup,Cleanup::Unlaunched){"not_started"}else{"settled"}}})).execute(&mut *tx).await?;
    let token = uuid::Uuid::new_v4().to_string();
    let attempt=sqlx::query("INSERT INTO heartbeat_run_attempts(org_id,run_id,agent_id,attempt_index,runtime_type,model,fallback_index,is_fallback,resume_source,status,owner_token,attempt_epoch,started_at,checkpoint_json) SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE(max(attempt_index),0)+1,$4,$5,$6,true,'fresh','started',$7,COALESCE(max(attempt_epoch),0)+1,statement_timestamp(),$8::jsonb FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND run_id=$2::uuid RETURNING id::text AS id,attempt_epoch")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(&claim.agent_id).bind(&spec.runtime_type).bind(&spec.model).bind(spec.fallback_index).bind(&token).bind(json!({"modelAttemptIndex":spec.index,"runtimeType":spec.runtime_type,"model":spec.model})).fetch_one(&mut *tx).await?;
    let attempt_id: String = attempt.try_get("id")?;
    let epoch: i32 = attempt.try_get("attempt_epoch")?;
    sqlx::query("UPDATE heartbeat_runs SET execution_owner_token=$4,execution_lease_expires_at=statement_timestamp()+interval '30 seconds',process_pid=NULL,process_started_at=NULL,process_exited_at=NULL,error=NULL,error_code=NULL,running_substate='executing',session_id_before=NULL,session_params_before_json=NULL,session_reuse_scope='none',session_intent_json=$5::jsonb,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND execution_owner_token=$3 AND status='running'")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(&claim.owner_token).bind(&token).bind(json!({"kind":"fresh","reuseScope":"none","sourceRunId":null,"sessionId":null,"sessionParams":null})).execute(&mut *tx).await?;
    super::claim::append_event(
        &mut tx,
        &claim.organization_id,
        &claim.run_id,
        &claim.agent_id,
        "model fallback attempt started",
        "info",
        &format!("model-attempt:{attempt_id}"),
    )
    .await?;
    tx.commit().await?;
    if matches!(cleanup, Cleanup::Unlaunched) {
        drop(claim.owned.take_connection_launch_permit());
    }
    let mut snapshot = claim.context_snapshot.clone();
    snapshot["rudderModelFallback"] = json!({"attemptIndex":spec.index,"agentRuntimeType":spec.runtime_type,"fallbackIndex":spec.fallback_index,"totalFallbacks":spec.total_fallbacks,"model":spec.model});
    if let Some(fields) = snapshot.as_object_mut() {
        for key in [
            "resumeSessionDisplayId",
            "resumeSessionParams",
            "resumeFromRunId",
            "rudderNetworkRecovery",
        ] {
            fields.remove(key);
        }
    }
    Ok(Some(AgentRunClaim {
        owned: OwnedAgentRun::from_claim(
            claim.organization_id.clone(),
            claim.agent_id.clone(),
            claim.run_id.clone(),
            claim.wakeup_request_id.clone(),
            attempt_id,
            token,
            epoch,
            Settlement::Agent,
        ),
        agent_name: claim.agent_name.clone(),
        agent_context: claim.agent_context.clone(),
        runtime_type: spec.runtime_type.clone(),
        model_attempt_index: spec.index,
        effective_attempt_config: Some(spec.config.clone()),
        goal_id: claim.goal_id.clone(),
        issue_id: claim.issue_id.clone(),
        wake_payload: claim.wake_payload.clone(),
        context_snapshot: snapshot,
        invocation_source: claim.invocation_source.clone(),
        trigger_detail: claim.trigger_detail.clone(),
        reason: claim.reason.clone(),
        session_id_before: None,
        session_params_before: None,
        session_reuse_scope: "none".into(),
    }))
}
