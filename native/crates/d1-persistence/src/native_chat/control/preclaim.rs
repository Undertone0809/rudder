//! Local cancellation of an admitted input that never acquired a worker.
//! No provider call, lease adoption, synthetic answer, or usage estimate.
use super::*;
use crate::activity::{ActivityActor, write_activity};
use rudder_runtime_core::native_chat::{NativeChatProtocolCheckpoint, NativeChatProtocolPhase};
use serde_json::{Value, json};

const EMPTY_HASH: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinalizeUnclaimedStop {
    pub conversation_id: String,
    pub generation_id: String,
    pub control_action_id: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnclaimedStopReceipt {
    pub control_action_id: String,
    pub generation_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub input_disposition: &'static str,
    pub idempotent: bool,
}

/// Resolve only the exact initial, unclaimed execution pinned by Stop. Expired
/// admission leases do not imply provider work; a claimed Generation, changed
/// Attempt, or any effect evidence rejects this path without releasing holds.
pub async fn finalize_unclaimed_stop(
    pool: &PgPool,
    actor: &VerifiedActor,
    request: &FinalizeUnclaimedStop,
) -> Result<UnclaimedStopReceipt> {
    validate_ids(actor, &request.conversation_id, &request.generation_id)?;
    canonical_id(&request.control_action_id, "control action id")?;
    let org = actor.organization_id();
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await?;
    let hint = target(
        &mut tx,
        actor,
        &request.conversation_id,
        &request.generation_id,
    )
    .await?;
    runtime_bindings::lock_native_chat_target_tx(&mut tx, org, &request.conversation_id).await?;
    let principal = runtime_bindings::authorize_chat_target_read_locked_tx(
        &mut tx,
        actor,
        org,
        &request.conversation_id,
        &hint.agent_id,
    )
    .await?;
    // Do not trust the pre-lock hint. Lock exact associations, then reauthorize.
    sqlx::query(
        "SELECT id FROM chat_generations WHERE org_id=$1::uuid AND id=$2::uuid
      AND conversation_id=$3::uuid AND execution_authority='native_rust' FOR UPDATE",
    )
    .bind(org)
    .bind(&request.generation_id)
    .bind(&request.conversation_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(conflict)?;
    sqlx::query(
        "SELECT id FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid
      AND chat_generation_id=$3::uuid AND chat_conversation_id=$4::uuid AND agent_id=$5::uuid
      AND execution_authority='native_rust' AND scene='chat' AND target_type='chat_conversation'
      AND target_id=$4 FOR UPDATE",
    )
    .bind(org)
    .bind(&hint.run_id)
    .bind(&request.generation_id)
    .bind(&request.conversation_id)
    .bind(&hint.agent_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(conflict)?;
    let attempt_id: String = sqlx::query_scalar(
        "SELECT id::text FROM heartbeat_run_attempts
      WHERE org_id=$1::uuid AND run_id=$2::uuid ORDER BY attempt_index DESC LIMIT 1 FOR UPDATE",
    )
    .bind(org)
    .bind(&hint.run_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(conflict)?;
    auth::authorize_org(&mut tx, actor, org).await?;
    let action = sqlx::query(
        "SELECT applied_control_version,local_disposition,
      CASE WHEN octet_length(provider_evidence::text)<=65536 THEN provider_evidence END AS evidence,
      (action_kind='stop' AND expected_generation_id=$3::uuid
        AND expected_attempt_epoch=1 AND accepted_through_seq=0 AND frozen_body_hash=$4
        AND applied_control_version=expected_control_version+1 AND last_error IS NULL
        AND provider_disposition='not_sent' AND control_owner_token IS NULL) IS TRUE AS valid
      FROM chat_control_actions WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    )
    .bind(org)
    .bind(&request.control_action_id)
    .bind(&request.generation_id)
    .bind(EMPTY_HASH)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(conflict)?;
    let evidence: Option<Value> = action.try_get("evidence")?;
    let mut evidence = evidence.ok_or_else(conflict)?;
    if !action.try_get::<bool, _>("valid")? || evidence["authority"] != "native_rust_control_v1" {
        return Err(conflict());
    }
    let pin: pin::ExecutionPin =
        serde_json::from_value(evidence["executionPin"].clone()).map_err(|_| conflict())?;
    let current_pin = pin::capture(&mut tx, org, &hint.run_id, &attempt_id).await?;
    if !pin.same_identity(&current_pin)
        || pin.attempt_index != 1
        || pin.attempt_epoch != Some(1)
        || pin.generation_attempt_epoch != Some(1)
        || pin.connection_epoch != Some(1)
    {
        return Err(conflict());
    }
    let mut receipt = UnclaimedStopReceipt {
        control_action_id: request.control_action_id.clone(),
        generation_id: request.generation_id.clone(),
        run_id: hint.run_id.clone(),
        attempt_id: attempt_id.clone(),
        input_disposition: "not_submitted",
        idempotent: false,
    };
    let value =
        serde_json::to_value(&receipt).map_err(|_| http(500, "Cannot encode Stop receipt"))?;
    let version: Option<i32> = action.try_get("applied_control_version")?;
    let finalized = evidence.get("terminalization");
    if let Some(proof) = finalized {
        if proof["receipt"] != value
            || proof["checkpointHash"].as_str() != Some(&current_pin.checkpoint_hash)
            || action.try_get::<String, _>("local_disposition")? != "stopped"
            || !terminal_matches(&mut tx, org, request, &receipt, version, &value).await?
        {
            return Err(conflict());
        }
        // Historical receipt remains readable after a later Send or binding
        // rotation. It cannot reacquire ownership or alter the newer Run.
        auth::authorize_org(&mut tx, actor, org).await?;
        receipt.idempotent = true;
        return Ok(receipt);
    }
    if pin != current_pin || action.try_get::<String, _>("local_disposition")? != "stop_requested" {
        return Err(conflict());
    }
    runtime_bindings::authorize_chat_target_run_mutation_tx(
        &mut tx,
        actor,
        org,
        &request.conversation_id,
        &hint.agent_id,
        &hint.run_id,
    )
    .await?;
    ensure_no_effects(&mut tx, org, request, &receipt, version).await?;
    let state = sqlx::query(
        "SELECT r.context_snapshot->>'runtimeBindingId' AS binding,
        r.context_snapshot->>'nativeSegmentId' AS segment,a.checkpoint_json
      FROM heartbeat_runs r JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
      WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND a.id=$3::uuid",
    )
    .bind(org)
    .bind(&hint.run_id)
    .bind(&attempt_id)
    .fetch_one(&mut *tx)
    .await?;
    let binding: String = state
        .try_get::<Option<String>, _>("binding")?
        .ok_or_else(conflict)?;
    let segment: String = state
        .try_get::<Option<String>, _>("segment")?
        .ok_or_else(conflict)?;
    canonical_id(&binding, "binding id").map_err(|_| conflict())?;
    canonical_id(&segment, "segment id").map_err(|_| conflict())?;
    // Validate the admitted binding identity without resolving today's selected
    // Agent config. Cancellation does not need new execution configuration.
    sqlx::query(
        "SELECT id FROM runtime_bindings WHERE org_id=$1::uuid AND id=$2::uuid
      AND conversation_id=$3::uuid AND target_type='chat_conversation' AND target_id=$3
      AND agent_id=$4::uuid AND principal_scope_ref=$5 AND runtime_type='codex_local'
      AND status='active' AND continuity='native' AND current_segment_id=$6::uuid FOR UPDATE",
    )
    .bind(org)
    .bind(&binding)
    .bind(&request.conversation_id)
    .bind(&hint.agent_id)
    .bind(&principal)
    .bind(&segment)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(conflict)?;
    let segment_row = sqlx::query(
        "SELECT state,native_session_id FROM native_segments
      WHERE org_id=$1::uuid AND id=$2::uuid AND binding_id=$3::uuid
        AND runtime_type='codex_local' AND sealed_at IS NULL FOR UPDATE",
    )
    .bind(org)
    .bind(&segment)
    .bind(&binding)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(conflict)?;
    let checkpoint: NativeChatProtocolCheckpoint =
        serde_json::from_value(state.try_get("checkpoint_json")?).map_err(|_| conflict())?;
    checkpoint.validate().map_err(|_| conflict())?;
    let session: Option<String> = segment_row.try_get("native_session_id")?;
    let segment_state: String = segment_row.try_get("state")?;
    if checkpoint.revision() != 0
        || checkpoint.observation_only()
        || checkpoint.turn_id().is_some()
        || !match (segment_state.as_str(), session.as_deref()) {
            ("pending", None) => {
                checkpoint.phase() == NativeChatProtocolPhase::NoThreadRequest
                    && checkpoint.thread_id().is_none()
            }
            ("open", Some(thread)) => {
                checkpoint.phase() == NativeChatProtocolPhase::ThreadKnown
                    && checkpoint.thread_id() == Some(thread)
            }
            _ => false,
        }
    {
        return Err(conflict());
    }
    let mut terminal_checkpoint = serde_json::to_value(checkpoint).map_err(|_| conflict())?;
    terminal_checkpoint["phase"] = json!("execution_terminal_committed");
    terminal_checkpoint["revision"] = json!(1);
    let terminal: NativeChatProtocolCheckpoint =
        serde_json::from_value(terminal_checkpoint.clone()).map_err(|_| conflict())?;
    terminal.validate().map_err(|_| conflict())?;

    // All checks are repeated after the potentially waiting binding locks.
    ensure_no_effects(&mut tx, org, request, &receipt, version).await?;
    auth::authorize_org(&mut tx, actor, org).await?;
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:preclaim_stop',true)")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE heartbeat_run_attempts SET status='cancelled',finished_at=clock_timestamp(),
      protocol_phase='execution_terminal_committed',checkpoint_json=$3
      WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(org)
    .bind(&attempt_id)
    .bind(terminal_checkpoint)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE heartbeat_runs SET status='cancelled',finished_at=clock_timestamp(),
      execution_lease_expires_at=NULL,running_substate=NULL,result_json=$3,updated_at=clock_timestamp()
      WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org).bind(&hint.run_id).bind(json!({"nativeChatPreclaimStop":value})).execute(&mut *tx).await?;
    sqlx::query("UPDATE chat_generations SET status='stopped',control_state='terminal',
      terminal_reason='operator_stop_before_claim',runtime_terminal_at=clock_timestamp(),
      completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org).bind(&request.generation_id).execute(&mut *tx).await?;
    let terminal_pin = pin::capture(&mut tx, org, &hint.run_id, &attempt_id).await?;
    evidence["terminalization"] =
        json!({"receipt":value,"checkpointHash":terminal_pin.checkpoint_hash});
    sqlx::query(
        "UPDATE chat_control_actions SET local_disposition='stopped',resolved_at=clock_timestamp(),
      provider_evidence=$3 WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(org)
    .bind(&request.control_action_id)
    .bind(evidence)
    .execute(&mut *tx)
    .await?;
    let event_payload = json!({"status":"cancelled","inputDisposition":"not_submitted"});
    // runtime_terminal is local execution terminal, not provider completion.
    for kind in ["runtime_terminal", "terminal_projected"] {
        sqlx::query("INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,control_action_id,run_id)
          SELECT $1::uuid,$2::uuid,COALESCE(max(generation_seq),0)+1,1,$3,$4,$5::uuid,$6::uuid
          FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid")
            .bind(org).bind(&request.generation_id).bind(kind).bind(&event_payload)
            .bind(&request.control_action_id).bind(&hint.run_id).execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO heartbeat_run_events(org_id,run_id,agent_id,seq,event_type,payload,idempotency_key)
      SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE(max(seq),0)+1,'status',$4,$5
      FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid")
        .bind(org).bind(&hint.run_id).bind(&hint.agent_id).bind(&event_payload)
        .bind(format!("native-preclaim-stop:{}",request.control_action_id)).execute(&mut *tx).await?;
    let audit = ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: Some(hint.run_id),
    };
    write_activity(
        &mut tx,
        org,
        &audit,
        "runtime.native_chat.stopped_before_claim",
        "chat_generation",
        &request.generation_id,
        Some(&value),
    )
    .await?;
    auth::authorize_org(&mut tx, actor, org).await?;
    tx.commit().await?;
    Ok(receipt)
}

fn conflict() -> super::super::Error {
    http(
        409,
        "Native Chat Stop is not an unchanged, unclaimed execution",
    )
}

async fn ensure_no_effects(
    tx: &mut auth::Tx<'_>,
    org: &str,
    request: &FinalizeUnclaimedStop,
    receipt: &UnclaimedStopReceipt,
    version: Option<i32>,
) -> Result<()> {
    let valid: bool = sqlx::query_scalar(
        "SELECT (
          g.status='stop_requested' AND g.control_state='stopping' AND g.attempt_epoch=1
          AND g.control_version=$5 AND g.accepted_through_seq=0 AND g.frozen_body_hash=$6
          AND NOT g.native_admission_hold AND g.control_owner_token IS NULL
          AND g.control_lease_expires_at IS NULL AND g.control_runtime_type='codex_local'
          AND g.provider_thread_id IS NULL AND g.provider_turn_id IS NULL
          AND g.runtime_terminal_at IS NULL AND g.completed_at IS NULL
          AND g.late_events_dropped=0 AND g.late_bytes=0
          AND r.invocation_source='chat' AND r.status='running' AND NOT r.native_admission_hold
          AND r.execution_owner_token IS NOT NULL AND r.execution_owner_token<>''
          AND r.process_pid IS NULL AND r.process_started_at IS NULL AND r.process_exited_at IS NULL
          AND r.session_id_before IS NULL AND r.session_id_after IS NULL
          AND r.finished_at IS NULL AND r.running_substate IS NULL AND r.result_json IS NULL
          AND r.result_summary_json IS NULL AND r.usage_json IS NULL AND r.exit_code IS NULL AND r.signal IS NULL
          AND r.error IS NULL AND r.error_code IS NULL AND r.recovery_checkpoint IS NULL
          AND r.log_ref IS NULL AND r.log_bytes IS NULL AND r.stdout_excerpt IS NULL AND r.stderr_excerpt IS NULL
          AND NOT r.terminal_effects_pending AND r.terminal_effects_json IS NULL
          AND a.status='started' AND a.attempt_index=1 AND a.runtime_type='codex_local'
          AND a.agent_id=r.agent_id AND a.owner_token=r.execution_owner_token
          AND a.attempt_epoch=1 AND a.generation_attempt_epoch=1 AND a.connection_epoch=1
          AND a.finished_at IS NULL AND a.suspended_at IS NULL AND a.submission_phase IS NULL
          AND a.provider_turn_id IS NULL AND a.usage_delta_json IS NULL AND a.cost_cents IS NULL
          AND a.error IS NULL AND a.error_code IS NULL AND a.session_params_json IS NULL
          AND a.checkpoint_json->>'phase'=a.protocol_phase AND a.checkpoint_json->'revision'='0'::jsonb
          AND a.checkpoint_json->'observationOnly'='false'::jsonb AND a.checkpoint_json->'turnId'='null'::jsonb
          AND r.session_intent_json->'sourceRunId'='null'::jsonb
          AND r.session_intent_json->'sessionParams'='null'::jsonb
          AND ((a.protocol_phase='no_thread_request' AND a.provider_thread_id IS NULL
              AND a.checkpoint_json->'threadId'='null'::jsonb AND r.session_reuse_scope='none'
              AND r.session_intent_json->>'kind'='fresh' AND r.session_intent_json->>'reuseScope'='none'
              AND r.session_intent_json->'sessionId'='null'::jsonb)
            OR (a.protocol_phase='thread_known' AND a.provider_thread_id IS NOT NULL
              AND a.checkpoint_json->>'threadId'=a.provider_thread_id AND r.session_reuse_scope='explicit'
              AND r.session_intent_json->>'kind'='resume' AND r.session_intent_json->>'reuseScope'='explicit'
              AND r.session_intent_json->>'sessionId'=a.provider_thread_id))
          AND (SELECT count(*) FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND run_id=r.id)=1
          AND NOT EXISTS(SELECT 1 FROM run_runtime_spans WHERE org_id=$1::uuid AND run_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM cost_events WHERE org_id=$1::uuid AND heartbeat_run_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM chat_messages WHERE org_id=$1::uuid AND run_id=r.id AND role<>'user')
          AND NOT EXISTS(SELECT 1 FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=r.id
            AND event_type<>'runtime.native_chat_admitted')
          AND NOT EXISTS(SELECT 1 FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=g.id
            AND (attempt_epoch<>1 OR event_kind NOT IN ('generation_started','stop_requested','output_cutoff')))
          AND EXISTS(SELECT 1 FROM chat_messages m WHERE m.org_id=g.org_id AND m.id=g.source_message_id
            AND m.conversation_id=g.conversation_id AND m.run_id=r.id AND m.role='user' AND m.kind='message'
            AND m.turn_variant=g.source_turn_variant AND m.id::text=r.context_snapshot->>'messageId'
            AND m.id::text=r.context_snapshot->>'userMessageId')
        ) IS TRUE FROM chat_generations g JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
          JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
        WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND r.id=$3::uuid AND a.id=$4::uuid",
    ).bind(org).bind(&request.generation_id).bind(&receipt.run_id).bind(&receipt.attempt_id)
        .bind(version).bind(EMPTY_HASH).fetch_one(&mut **tx).await?;
    if !valid {
        return Err(conflict());
    }
    Ok(())
}

async fn terminal_matches(
    tx: &mut auth::Tx<'_>,
    org: &str,
    request: &FinalizeUnclaimedStop,
    receipt: &UnclaimedStopReceipt,
    version: Option<i32>,
    value: &Value,
) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT (g.status='stopped' AND g.control_state='terminal'
      AND g.attempt_epoch=1 AND g.control_version=$5 AND g.accepted_through_seq=0 AND g.frozen_body_hash=$6
      AND g.terminal_reason='operator_stop_before_claim' AND g.runtime_terminal_at IS NOT NULL
      AND g.completed_at IS NOT NULL AND NOT g.native_admission_hold AND NOT r.native_admission_hold
      AND g.control_owner_token IS NULL AND g.control_lease_expires_at IS NULL
      AND r.status='cancelled' AND r.finished_at IS NOT NULL AND r.execution_lease_expires_at IS NULL
      AND r.result_json=jsonb_build_object('nativeChatPreclaimStop',$7::jsonb)
      AND a.status='cancelled' AND a.finished_at IS NOT NULL
      AND a.protocol_phase='execution_terminal_committed' AND a.checkpoint_json->'revision'='1'::jsonb
      AND (SELECT count(*) FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND run_id=r.id)=1) IS TRUE
      FROM chat_generations g JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
      JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
      WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND r.id=$3::uuid AND a.id=$4::uuid")
        .bind(org).bind(&request.generation_id).bind(&receipt.run_id).bind(&receipt.attempt_id)
        .bind(version).bind(EMPTY_HASH).bind(value).fetch_one(&mut **tx).await?)
}
