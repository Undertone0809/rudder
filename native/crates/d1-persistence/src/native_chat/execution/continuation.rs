//! Transaction-only advancement after a typed failed terminal and exact cleanup.
//! This never treats an indeterminate accepted request as permission to replay.
use super::{ExecutionFence, Result, claim::ClaimedExecution, http};
use crate::native_chat::{
    NativeChatExecutionActor, NativeChatExecutionPrincipal,
    config::{LocalHostContext, ResolvedCodexConfig},
};
use rudder_codex_app_server::ConnectionLaunchPermit;
use rudder_runtime_core::native_chat::{
    NativeChatProtocolCheckpoint, NativeChatProtocolStart, NativeChatProvider,
};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};

pub(super) struct NextAttempt {
    pub config: ResolvedCodexConfig,
    pub repair: Option<Value>,
}

fn repair_prompt(raw: &str, run: &str) -> String {
    format!(
        "Rudder internal repair request:\n- Your previous chat turn ended without the required Rudder result sentinel.\n- Do not continue the task, browse, inspect files, ask questions, or add new analysis.\n- Re-emit the final user-visible answer from your previous response as the required Rudder result envelope.\n- For plain text output RUDDER_RESULT_BEGIN on its own line, then the final answer body, then RUDDER_RESULT_END on its own line.\n- Preserve the original kind and structuredPayload only when the previous response already contains a valid Rudder result JSON object.\n- For structured non-message results output __RUDDER_RESULT_{run}__ followed immediately by JSON.\n- Do not output anything before or after the result envelope.\n\nPrevious response text:\n{raw}"
    )
}
fn missing_result(raw: &str, run: &str) -> bool {
    if raw.trim().is_empty() || raw.contains(&format!("__RUDDER_RESULT_{run}__")) {
        return false;
    }
    if let Some(start) = raw.find("RUDDER_RESULT_BEGIN") {
        let body = &raw[start + "RUDDER_RESULT_BEGIN".len()..];
        if body
            .find("RUDDER_RESULT_END")
            .is_some_and(|end| !body[..end].trim().is_empty())
        {
            return false;
        }
    }
    true
}
pub(super) async fn next_config(
    tx: &mut Transaction<'_, Postgres>,
    fence: &ExecutionFence,
    host: &LocalHostContext,
    failed: bool,
    final_text: Option<&str>,
) -> Result<Option<NextAttempt>> {
    let id = fence.identity();
    let snapshot: Value = sqlx::query_scalar(
        "SELECT context_snapshot FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(id.organization_id)
    .bind(id.run_id)
    .fetch_one(&mut **tx)
    .await?;
    // The existing Automation repair is a single terminal-only extra call. It
    // has no model fallback chain and never repairs ordinary public Chat.
    if snapshot["nativeChatRepairAttempted"] == true {
        return Ok(None);
    }
    let (index, repair) = if failed {
        let Some(index) = snapshot["nativeChatModelAttemptIndex"]
            .as_u64()
            .unwrap_or(0)
            .checked_add(1)
            .and_then(|v| usize::try_from(v).ok())
        else {
            return Err(http(409, "Native Chat model attempt index exhausted"));
        };
        (index, None)
    } else {
        let Some(run) = snapshot["automationRunId"].as_str() else {
            return Ok(None);
        };
        let Some(raw) = final_text.filter(|raw| missing_result(raw, run)) else {
            return Ok(None);
        };
        let owned:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM automation_runs ar JOIN chat_generations g ON g.org_id=ar.org_id AND g.conversation_id=ar.linked_chat_conversation_id AND g.source_message_id=ar.started_chat_message_id WHERE ar.org_id=$1::uuid AND ar.id=$2::uuid AND g.id=$3::uuid AND ar.status='running')")
            .bind(id.organization_id).bind(run).bind(id.generation_id).fetch_one(&mut **tx).await?;
        if !owned {
            return Err(http(409, "Automation Chat repair source is not owned"));
        }
        let prompt = repair_prompt(raw, run);
        (
            0,
            Some(
                json!({"sourceAttemptId":id.attempt_id,"originalText":raw,"prompt":prompt,"fingerprint":crate::native_chat::validation::fingerprint(&prompt)}),
            ),
        )
    };
    let Some(config) = crate::native_chat::config::resolve_model_attempt_config(
        tx,
        id.organization_id,
        id.conversation_id,
        host,
        index,
    )
    .await?
    else {
        return Ok(None);
    };
    let plan = config
        .model_attempt
        .as_ref()
        .ok_or_else(|| http(409, "Native Chat model plan is unavailable"))?;
    if snapshot["nativeChatModelPlanRevision"].as_str() != Some(plan.plan_revision.as_str()) {
        return Err(http(
            409,
            "Native Chat model fallback policy changed during execution",
        ));
    }
    crate::native_chat::budget::ensure_not_blocked(tx, id.organization_id, id.agent_id).await?;
    Ok(Some(NextAttempt { config, repair }))
}

fn fresh_checkpoint(runtime: &str) -> Result<NativeChatProtocolCheckpoint> {
    let checkpoint = match runtime {
        "codex_local" => NativeChatProtocolCheckpoint::new(NativeChatProtocolStart::FreshThread),
        "hermes_local" => NativeChatProtocolCheckpoint::new_hermes_fresh_session(),
        "pi_local" => NativeChatProtocolCheckpoint::new_pi_fresh_session(),
        "claude_local" => NativeChatProtocolCheckpoint::new_claude_fresh_session(),
        "cursor" | "cursor_local" => NativeChatProtocolCheckpoint::new_cursor_fresh_session(),
        "opencode_local" => NativeChatProtocolCheckpoint::new_opencode_fresh_session(),
        runtime => NativeChatProtocolCheckpoint::new_transport(
            match runtime {
                "http" => NativeChatProvider::Http,
                "hermes_gateway" => NativeChatProvider::HermesGateway,
                "openclaw_gateway" => NativeChatProvider::OpenClawGateway,
                _ => NativeChatProvider::Process,
            },
            None,
        ),
    };
    checkpoint.map_err(|_| http(409, "Native Chat fallback checkpoint is invalid"))
}

/// Caller already holds and has revalidated the exact execution, sealed its
/// span and persisted its failed Attempt. No terminal Run/Generation is exposed.
pub(super) async fn advance(
    tx: &mut Transaction<'_, Postgres>,
    actor: &impl NativeChatExecutionActor,
    previous: &ExecutionFence,
    next_attempt: NextAttempt,
    previous_result: &Value,
) -> Result<ClaimedExecution> {
    let id = previous.identity();
    let NextAttempt { config, mut repair } = next_attempt;
    let repairing = repair.is_some();
    let plan = config
        .model_attempt
        .as_ref()
        .ok_or_else(|| http(409, "Native Chat fallback plan is unavailable"))?;
    let generation_epoch = id
        .generation_attempt_epoch
        .checked_add(1)
        .ok_or_else(|| http(409, "Native Chat generation epoch exhausted"))?;
    let attempt_epoch = id
        .run_attempt_epoch
        .checked_add(1)
        .ok_or_else(|| http(409, "Native Chat attempt epoch exhausted"))?;
    let connection_epoch = id
        .connection_epoch
        .checked_add(1)
        .ok_or_else(|| http(409, "Native Chat connection epoch exhausted"))?;
    let owner = uuid::Uuid::new_v4().to_string();
    let generation_owner = uuid::Uuid::new_v4().to_string();
    let connection_claim = super::claim::new_connection_claim_id()?;
    let checkpoint = fresh_checkpoint(&config.identity.runtime_type)?;
    // A model/runtime transition gets a fresh native identity. Retain every
    // previous binding, segment, receipt and span for historical provenance.
    let binding=sqlx::query("SELECT principal_scope_ref,binding_epoch FROM runtime_bindings WHERE org_id=$1::uuid AND id=$2::uuid AND status='active' FOR UPDATE")
        .bind(id.organization_id).bind(&previous.binding_id).fetch_optional(&mut **tx).await?.ok_or_else(||http(409,"Native Chat fallback binding changed"))?;
    let scope: String = binding.try_get("principal_scope_ref")?;
    let epoch: i32 = binding
        .try_get::<i32, _>("binding_epoch")?
        .checked_add(1)
        .ok_or_else(|| http(409, "Native Chat binding epoch exhausted"))?;
    sqlx::query("UPDATE native_segments SET state='sealed',sealed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE org_id=$1::uuid AND binding_id=$2::uuid AND id=$3::uuid AND state IN ('pending','open') AND sealed_at IS NULL")
        .bind(id.organization_id).bind(&previous.binding_id).bind(&previous.segment_id).execute(&mut **tx).await?;
    sqlx::query("UPDATE runtime_bindings SET status='superseded',updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND status='active'")
        .bind(id.organization_id).bind(&previous.binding_id).execute(&mut **tx).await?;
    let binding_id:String=sqlx::query_scalar("INSERT INTO runtime_bindings(org_id,conversation_id,target_type,target_id,principal_scope_ref,agent_id,runtime_type,host_id,profile_id,workspace_binding_id,instructions_revision,capability_revision,continuity,binding_epoch,parent_binding_id,source_boundary_ref,status) VALUES($1::uuid,$2::uuid,'chat_conversation',$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,'native',$11,$12::uuid,'native_chat_model_fallback','active') RETURNING id::text")
        .bind(id.organization_id).bind(id.conversation_id).bind(scope).bind(id.agent_id).bind(&config.identity.runtime_type).bind(&config.identity.host_id).bind(&config.identity.profile_id).bind(&config.identity.workspace_binding_id).bind(&config.identity.instructions_revision).bind(&config.identity.capability_revision).bind(epoch).bind(&previous.binding_id).fetch_one(&mut **tx).await?;
    let segment:String=sqlx::query_scalar("INSERT INTO native_segments(org_id,binding_id,runtime_type,segment_ordinal,state) VALUES($1::uuid,$2::uuid,$3,0,'pending') RETURNING id::text")
        .bind(id.organization_id).bind(&binding_id).bind(&config.identity.runtime_type).fetch_one(&mut **tx).await?;
    sqlx::query("UPDATE runtime_bindings SET current_segment_id=$3::uuid WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(id.organization_id).bind(&binding_id).bind(&segment).execute(&mut **tx).await?;
    let attempt:String=sqlx::query_scalar("INSERT INTO heartbeat_run_attempts(org_id,run_id,agent_id,attempt_index,runtime_type,model,fallback_index,is_fallback,resume_source,status,owner_token,attempt_epoch,generation_attempt_epoch,connection_epoch,protocol_phase,checkpoint_json,started_at) SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE(max(attempt_index),0)+1,$4,$5,$6,$13,'fresh','started',$7,$8,$9,$10,$11,$12,clock_timestamp() FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND run_id=$2::uuid RETURNING id::text")
        .bind(id.organization_id).bind(id.run_id).bind(id.agent_id).bind(&config.identity.runtime_type).bind(&config.model).bind(if repairing {None} else {Some(i32::try_from(plan.index).map_err(|_|http(409,"Native Chat model attempt index exhausted"))?)} ).bind(&owner).bind(attempt_epoch).bind(generation_epoch).bind(connection_epoch).bind(checkpoint.phase().as_str()).bind(json!(checkpoint)).bind(!repairing).fetch_one(&mut **tx).await?;
    let primary: String = sqlx::query_scalar(
        "SELECT agent_runtime_type FROM agents WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(id.organization_id)
    .bind(id.agent_id)
    .fetch_one(&mut **tx)
    .await?;
    let mut snapshot = json!({"runtimeBindingId":binding_id,"nativeSegmentId":segment,"nativeChatPrimaryRuntime":primary,"nativeChatModelAttemptIndex":plan.index,"nativeChatModelPlanRevision":plan.plan_revision});
    if let Some(hermes) = &config.hermes {
        snapshot["hermesInstructionAdapterRevision"] = json!(hermes.instruction_adapter_revision);
    }
    if let Some(value) = repair.as_mut() {
        value["attemptId"] = json!(attempt);
        snapshot["nativeChatRepairAttempted"] = json!(true);
        snapshot["nativeChatDeliveryFingerprint"] = value["fingerprint"].clone();
        snapshot["nativeChatRepair"] = value.clone();
    }
    if !repairing {
        snapshot["automationArtifactSource"] = json!({"runtimeType":config.identity.runtime_type,"codexHome":config.profile.home,"cwd":config.cwd});
    }
    sqlx::query("UPDATE heartbeat_runs SET execution_owner_token=$4,execution_lease_expires_at=clock_timestamp()+interval '60 seconds',process_pid=NULL,process_started_at=NULL,process_exited_at=NULL,status='running',finished_at=NULL,error=NULL,error_code=NULL,running_substate='executing',session_id_before=NULL,session_id_after=NULL,session_params_before_json=NULL,session_reuse_scope='none',session_intent_json=$5,context_snapshot=context_snapshot||$6,result_json=COALESCE(result_json,'{}'::jsonb)||jsonb_build_object('nativeChatLastAttempt',$7::jsonb),updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND execution_owner_token=$3 AND native_admission_hold")
        .bind(id.organization_id).bind(id.run_id).bind(previous.run_execution_owner_token()).bind(&owner).bind(json!({"kind":"fresh","reuseScope":"none","sourceRunId":null,"sessionId":null,"sessionParams":null})).bind(snapshot).bind(previous_result).execute(&mut **tx).await?;
    sqlx::query("UPDATE chat_generations SET attempt_epoch=$4,control_runtime_type=$5,control_owner_token=$6,control_lease_expires_at=clock_timestamp()+interval '30 seconds',control_state='unregistered',status='starting',provider_thread_id=NULL,provider_turn_id=NULL,runtime_terminal_at=NULL,completed_at=NULL,terminal_reason=NULL,updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND control_owner_token=$3 AND native_admission_hold")
        .bind(id.organization_id).bind(id.generation_id).bind(previous.generation_control_owner_token()).bind(generation_epoch).bind(&config.identity.runtime_type).bind(&generation_owner).execute(&mut **tx).await?;
    // Failed streaming output belongs to its attempt; it must not become the
    // next attempt's assistant projection or final Automation result.
    sqlx::query("UPDATE chat_messages SET superseded_at=clock_timestamp(),updated_at=clock_timestamp() WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND run_id=$3::uuid AND role='assistant' AND superseded_at IS NULL")
        .bind(id.organization_id).bind(id.conversation_id).bind(id.run_id).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO run_runtime_spans(org_id,run_id,binding_id,segment_id,attempt_id,attempt_ref,attempt_epoch,owner_token,ordinal,relation,state) SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$5,$6,$7,COALESCE(max(ordinal),0)+1,'primary','open' FROM run_runtime_spans WHERE org_id=$1::uuid AND run_id=$2::uuid")
        .bind(id.organization_id).bind(id.run_id).bind(&binding_id).bind(&segment).bind(&attempt).bind(attempt_epoch).bind(&owner).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,run_id) SELECT $1::uuid,$2::uuid,COALESCE(max(generation_seq),0)+1,$3,'generation_started',$4,$5::uuid FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid")
        .bind(id.organization_id).bind(id.generation_id).bind(generation_epoch).bind(json!({"runId":id.run_id,"attemptId":attempt,"modelFallback":!repairing,"resultRepair":repairing})).bind(id.run_id).execute(&mut **tx).await?;
    let next = ExecutionFence {
        organization_id: id.organization_id.into(),
        conversation_id: id.conversation_id.into(),
        generation_id: id.generation_id.into(),
        run_id: id.run_id.into(),
        attempt_id: attempt.clone(),
        agent_id: id.agent_id.into(),
        runtime_type: config.identity.runtime_type.clone(),
        binding_id,
        segment_id: segment,
        selected_model: config.model.clone(),
        generation_attempt_epoch: generation_epoch,
        run_attempt_epoch: attempt_epoch,
        connection_epoch,
        connection_claim_id: connection_claim.clone(),
        generation_owner_token: generation_owner,
        run_owner_token: owner.clone(),
    };
    let principal = NativeChatExecutionPrincipal::from_continuation(actor, previous, next.clone())
        .ok_or_else(|| http(403, "Native Chat continuation actor is invalid"))?;
    let permit = ConnectionLaunchPermit::from_claim(
        id.run_id.into(),
        attempt,
        owner,
        connection_epoch,
        connection_claim,
    );
    Ok(ClaimedExecution {
        fence: next,
        config,
        execution_principal: principal,
        connection_launch_permit: permit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_protocol_repairs_plain_text_but_not_a_malformed_present_envelope() {
        assert!(missing_result("useful plain answer", "r"));
        assert!(missing_result(
            r#"{"kind":"issue_proposal","body":"Review"}"#,
            "r"
        ));
        assert!(!missing_result("", "r"));
        assert!(!missing_result("__RUDDER_RESULT_r__{broken", "r"));
        assert!(!missing_result(
            "RUDDER_RESULT_BEGIN\nanswer\nRUDDER_RESULT_END",
            "r"
        ));
        let prompt = repair_prompt("original answer", "r");
        assert!(prompt.contains("Do not continue the task"));
        assert!(prompt.contains("__RUDDER_RESULT_r__"));
        assert!(prompt.ends_with("original answer"));
    }
    #[test]
    fn every_fallback_provider_starts_with_its_own_fresh_checkpoint() {
        for runtime in [
            "codex_local",
            "hermes_local",
            "pi_local",
            "claude_local",
            "cursor",
            "cursor_local",
            "opencode_local",
            "process",
            "http",
            "hermes_gateway",
            "openclaw_gateway",
            "custom_process",
        ] {
            let checkpoint = fresh_checkpoint(runtime).unwrap();
            assert!(checkpoint.provider().matches_runtime(runtime));
            assert_eq!(
                checkpoint.phase(),
                rudder_runtime_core::native_chat::NativeChatProtocolPhase::NoThreadRequest
            );
            assert!(checkpoint.thread_id().is_none());
            assert!(checkpoint.turn_id().is_none());
        }
    }
}
