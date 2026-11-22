//! Native materialization of an existing wake intent or terminal follow-up.
//! Callers hold the linked Issue before locking its target Agent. This reuses
//! the same heartbeat rows, session selection and ownership shape as admission.
use super::{AgentExecutionError, AgentRunAdmission, claim, context, http, mark_native_write};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use uuid::Uuid;

pub(crate) struct Followup<'a> {
    pub org: &'a str,
    pub agent_id: &'a str,
    pub issue_id: Option<&'a str>,
    pub source: &'a str,
    pub trigger_detail: Option<&'a str>,
    pub reason: &'a str,
    pub payload: &'a Value,
    pub context: &'a Value,
    pub idempotency_key: Option<&'a str>,
    pub existing_wakeup_id: Option<&'a str>,
    pub actor_id: Option<&'a str>,
    pub delay_seconds: i32,
    pub retry_of: Option<&'a str>,
    pub process_loss_count: i32,
}

pub(crate) async fn enqueue(
    tx: &mut Transaction<'_, Postgres>,
    input: Followup<'_>,
) -> Result<AgentRunAdmission, AgentExecutionError> {
    let agent=sqlx::query("SELECT name,status,agent_runtime_type FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(input.org).bind(input.agent_id).fetch_optional(&mut **tx).await?.ok_or_else(||http(404,"Follow-up Agent not found"))?;
    let status: String = agent.try_get("status")?;
    if matches!(status.as_str(), "terminated" | "pending_approval") {
        return Err(http(409, "Follow-up Agent is not invokable"));
    }
    if let Some(key) = input
        .idempotency_key
        .filter(|_| input.existing_wakeup_id.is_none())
    {
        let previous=sqlx::query("SELECT id::text AS id,run_id::text AS run_id,status FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid AND idempotency_key=$3 FOR UPDATE")
            .bind(input.org).bind(input.agent_id).bind(key).fetch_optional(&mut **tx).await?;
        if let Some(previous) = previous {
            return Ok(AgentRunAdmission {
                wakeup_request_id: previous.try_get("id")?,
                run_id: previous.try_get("run_id")?,
                status: previous.try_get("status")?,
                replayed: true,
                invocation_block: None,
            });
        }
    }
    mark_native_write(tx).await?;
    let wakeup_id = input
        .existing_wakeup_id
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let next_status = if status == "paused" {
        "deferred_agent_paused"
    } else {
        "queued"
    };
    let mut payload = input.payload.clone();
    if next_status != "queued" {
        if !payload.is_object() {
            payload = json!({});
        }
        payload["_paperclipWakeContext"] = input.context.clone();
    }
    if input.existing_wakeup_id.is_none() {
        sqlx::query("INSERT INTO agent_wakeup_requests(id,org_id,agent_id,source,trigger_detail,reason,payload,status,execution_authority,requested_by_actor_type,requested_by_actor_id,idempotency_key,requested_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8,'native_rust','system',$9,$10,statement_timestamp()+make_interval(secs=>$11))")
            .bind(&wakeup_id).bind(input.org).bind(input.agent_id).bind(input.source).bind(input.trigger_detail).bind(input.reason).bind(&payload).bind(next_status).bind(input.actor_id).bind(input.idempotency_key).bind(input.delay_seconds).execute(&mut **tx).await?;
    } else {
        let changed=sqlx::query("UPDATE agent_wakeup_requests SET status=$4,payload=$5::jsonb,claimed_at=NULL,finished_at=NULL,error=NULL,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND agent_id=$3::uuid AND execution_authority='native_rust' AND run_id IS NULL AND status IN ('queued','deferred_agent_paused','deferred_issue_execution','deferred_goal_focus','deferred_goal_blocked')")
            .bind(input.org).bind(&wakeup_id).bind(input.agent_id).bind(next_status).bind(&payload).execute(&mut **tx).await?.rows_affected()==1;
        if !changed {
            return Err(http(
                409,
                "Native follow-up wake intent changed before materialization",
            ));
        }
    }
    if next_status != "queued" {
        return Ok(AgentRunAdmission {
            wakeup_request_id: wakeup_id,
            run_id: None,
            status: next_status.into(),
            replayed: false,
            invocation_block: None,
        });
    }
    let runtime: String = agent.try_get("agent_runtime_type")?;
    let session =
        claim::select_claim_session(tx, input.org, input.agent_id, &runtime, input.context).await?;
    let session_id = session.display_id.clone().or_else(|| {
        session
            .params
            .as_ref()
            .and_then(|value| context::nonempty(value.get("sessionId")))
    });
    let intent = json!({"kind":if session.reuse_scope=="none"{"fresh"}else{"resume"},"reuseScope":session.reuse_scope,"sourceRunId":if session.reuse_scope=="none"{None}else{context::nonempty(input.context.get("resumeFromRunId"))},"sessionId":session_id,"sessionParams":session.params});
    let run_id = Uuid::new_v4().to_string();
    let goal_id = context::nonempty(input.context.get("goalId"));
    let source_run_id = context::nonempty(input.context.get("sourceRunId"));
    sqlx::query("INSERT INTO heartbeat_runs(id,org_id,agent_id,invocation_source,trigger_detail,status,wakeup_request_id,execution_authority,goal_id,source_run_id,context_snapshot,session_reuse_scope,session_id_before,session_params_before_json,scene,target_type,target_id,idempotency_key,session_intent_json,retry_of_run_id,process_loss_retry_count) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,'queued',$6::uuid,'native_rust',$7::uuid,$8::uuid,$9::jsonb,$10,$11,$12::jsonb,'heartbeat','wakeup_request',$6::text,'agent-wakeup:'||$6::text,$13::jsonb,$14::uuid,$15)")
        .bind(&run_id).bind(input.org).bind(input.agent_id).bind(input.source).bind(input.trigger_detail).bind(&wakeup_id).bind(goal_id).bind(source_run_id).bind(input.context).bind(session.reuse_scope).bind(session_id).bind(session.params).bind(intent).bind(input.retry_of).bind(input.process_loss_count).execute(&mut **tx).await?;
    sqlx::query("UPDATE agent_wakeup_requests SET status='queued',run_id=$3::uuid,reason=$4,claimed_at=NULL,finished_at=NULL,error=NULL,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND execution_authority='native_rust' AND run_id IS NULL")
        .bind(input.org).bind(&wakeup_id).bind(&run_id).bind(input.reason).execute(&mut **tx).await?;
    if let Some(issue_id) = input.issue_id {
        let name: String = agent.try_get("name")?;
        sqlx::query("UPDATE issues SET execution_run_id=$3::uuid,execution_agent_name_key=$4,execution_locked_at=statement_timestamp(),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(input.org).bind(issue_id).bind(&run_id).bind(name.trim().to_lowercase()).execute(&mut **tx).await?;
    }
    Ok(AgentRunAdmission {
        wakeup_request_id: wakeup_id,
        run_id: Some(run_id),
        status: "queued".into(),
        replayed: false,
        invocation_block: None,
    })
}
