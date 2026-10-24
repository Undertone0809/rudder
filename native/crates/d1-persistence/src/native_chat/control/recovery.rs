//! Operator recovery for a claimed Native Chat run whose owner lease expired.
//!
//! This records loss of control and keeps the admission quarantine. It is not
//! evidence that the provider process exited or that runtime cleanup finished.
use super::*;
use crate::activity::{ActivityActor, write_activity};
use serde_json::{Value, json};

const OWNER_LOSS_CODE: &str = "native_chat_owner_lost_cleanup_unknown";
const MAX_PENDING_STOP_ACTIONS: i64 = 64;

/// Settle the exact accepted Stop only after the public path has failed the
/// stricter unclaimed-execution proof. A claimed owner can be declared lost
/// only when both independent leases are expired while all owner rows are
/// locked. Holds, owner identity, and unknown process state remain durable.
pub async fn recover_expired_claimed_stop(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    request: &StopRequest,
) -> Result<Option<StopReceipt>> {
    validate_ids(actor, &request.conversation_id, &request.generation_id)?;
    canonical_id(&request.control_action_id, "control action id")?;
    if actor.actor().kind != "user" {
        // A normal agent Stop may already have persisted its intent before the
        // stricter claimed-owner recovery check runs. Keep that request on the
        // ordinary stopping path; only an operator may resolve owner loss.
        return Ok(None);
    }

    let org = actor.organization_id();
    let requested_hash = normalize_hash(&request.requested_body_hash)?;
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
    runtime_bindings::authorize_chat_target_read_locked_tx(
        &mut tx,
        actor,
        org,
        &request.conversation_id,
        &hint.agent_id,
    )
    .await?;

    let generation = sqlx::query(
        "SELECT status,attempt_epoch,control_version,control_state,control_owner_token,
                control_lease_expires_at IS NOT NULL
                  AND control_lease_expires_at <= clock_timestamp() AS lease_expired,
                native_admission_hold,runtime_terminal_at IS NULL AS no_runtime_terminal,
                completed_at IS NULL AS not_completed,accepted_through_seq,frozen_body_hash
         FROM chat_generations
         WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND id=$3::uuid
           AND execution_authority='native_rust'
         FOR UPDATE",
    )
    .bind(org)
    .bind(&request.conversation_id)
    .bind(&request.generation_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Native Chat generation not found"))?;
    let run = sqlx::query(
        "SELECT id::text,agent_id::text,status,execution_owner_token,
                execution_lease_expires_at IS NOT NULL
                  AND execution_lease_expires_at <= clock_timestamp() AS lease_expired,
                native_admission_hold,process_exited_at IS NULL AS process_exit_unknown,
                finished_at IS NULL AS not_finished
         FROM heartbeat_runs
         WHERE org_id=$1::uuid AND id=$2::uuid AND chat_generation_id=$3::uuid
           AND chat_conversation_id=$4::uuid AND execution_authority='native_rust'
           AND scene='chat' AND target_type='chat_conversation' AND target_id=$4
         FOR UPDATE",
    )
    .bind(org)
    .bind(&hint.run_id)
    .bind(&request.generation_id)
    .bind(&request.conversation_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(409, "Native Chat Run association changed"))?;
    runtime_bindings::authorize_chat_target_run_mutation_tx(
        &mut tx,
        actor,
        org,
        &request.conversation_id,
        &hint.agent_id,
        &hint.run_id,
    )
    .await?;

    // The newest Attempt is locked after Conversation, Generation, and Run.
    let attempt = sqlx::query(
        "SELECT id::text,status,owner_token,attempt_epoch,generation_attempt_epoch,
                protocol_phase,finished_at IS NULL AS not_finished
         FROM heartbeat_run_attempts
         WHERE org_id=$1::uuid AND run_id=$2::uuid
         ORDER BY attempt_index DESC LIMIT 1 FOR UPDATE",
    )
    .bind(org)
    .bind(&hint.run_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(409, "Native Chat Run attempt is missing"))?;
    auth::authorize_org(&mut tx, actor, org).await?;

    let attempt_id: String = attempt.try_get("id")?;
    let attempt_epoch: Option<i32> = attempt.try_get("generation_attempt_epoch")?;
    let current_pin = pin::capture(&mut tx, org, &hint.run_id, &attempt_id).await?;
    let generation_status: String = generation.try_get("status")?;
    let generation_control: String = generation.try_get("control_state")?;
    let generation_epoch: i32 = generation.try_get("attempt_epoch")?;
    let generation_lease_expired: bool = generation.try_get("lease_expired")?;
    let generation_hold: bool = generation.try_get("native_admission_hold")?;
    let generation_has_no_terminal: bool = generation.try_get("no_runtime_terminal")?;
    let generation_not_completed: bool = generation.try_get("not_completed")?;
    let generation_owner: Option<String> = generation.try_get("control_owner_token")?;
    let generation_control_version: i32 = generation.try_get("control_version")?;
    let generation_cutoff: Option<i32> = generation.try_get("accepted_through_seq")?;
    let generation_hash: Option<String> = generation.try_get("frozen_body_hash")?;
    let run_status: String = run.try_get("status")?;
    let run_owner: Option<String> = run.try_get("execution_owner_token")?;
    let run_lease_expired: bool = run.try_get("lease_expired")?;
    let run_hold: bool = run.try_get("native_admission_hold")?;
    let process_exit_unknown: bool = run.try_get("process_exit_unknown")?;
    let run_not_finished: bool = run.try_get("not_finished")?;
    let attempt_status: String = attempt.try_get("status")?;
    let attempt_owner: Option<String> = attempt.try_get("owner_token")?;
    let attempt_epoch_value: Option<i32> = attempt.try_get("attempt_epoch")?;
    let attempt_not_finished: bool = attempt.try_get("not_finished")?;
    let attempt_phase: Option<String> = attempt.try_get("protocol_phase")?;

    // A concurrent operator may have committed the exact incident after this
    // request recorded its Stop. Re-read its action rather than returning a
    // stale `stopping` receipt or duplicating audit/status/event side effects.
    if generation_status == "interrupted_unverified"
        && generation.try_get::<String, _>("control_state")? == "control_lost"
    {
        let incident = current_owner_loss_incident(
            &mut tx,
            org,
            &request.conversation_id,
            &request.generation_id,
            &hint.run_id,
            &attempt_id,
            request.expected_attempt_epoch,
            &current_pin,
        )
        .await?;
        if incident.is_some() {
            let action = sqlx::query(
                "SELECT expected_generation_id::text,expected_attempt_epoch,expected_control_version,
                        action_kind,local_disposition,last_error,resolved_at IS NOT NULL AS resolved,
                        requested_render_seq,requested_body_hash,accepted_through_seq,frozen_body_hash,
                        CASE WHEN octet_length(provider_evidence::text)<=65536 THEN provider_evidence END AS evidence
                 FROM chat_control_actions WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
            )
            .bind(org)
            .bind(&request.control_action_id)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(action) = action {
                let evidence: Option<Value> = action.try_get("evidence")?;
                if let Some(evidence) = evidence {
                    let matches = action
                        .try_get::<Option<String>, _>("expected_generation_id")?
                        .as_deref()
                        == Some(request.generation_id.as_str())
                        && action.try_get::<Option<i32>, _>("expected_attempt_epoch")?
                            == Some(request.expected_attempt_epoch)
                        && action.try_get::<Option<i32>, _>("expected_control_version")?
                            == Some(request.expected_control_version)
                        && action.try_get::<String, _>("action_kind")? == "stop"
                        && action.try_get::<String, _>("local_disposition")? == "control_lost"
                        && action
                            .try_get::<Option<String>, _>("last_error")?
                            .as_deref()
                            == Some(OWNER_LOSS_CODE)
                        && action.try_get::<bool, _>("resolved")?
                        && action.try_get::<Option<i32>, _>("requested_render_seq")?
                            == Some(request.requested_render_seq)
                        && action
                            .try_get::<Option<String>, _>("requested_body_hash")?
                            .as_deref()
                            == Some(requested_hash.as_str())
                        && action_matches_owner_loss(
                            &mut tx,
                            org,
                            &request.conversation_id,
                            &request.generation_id,
                            &hint.run_id,
                            &attempt_id,
                            request.expected_attempt_epoch,
                            &current_pin,
                            &evidence,
                        )
                        .await?;
                    if matches {
                        return Ok(Some(StopReceipt {
                            control_action_id: request.control_action_id.clone(),
                            generation_id: request.generation_id.clone(),
                            outcome: StopOutcome::ControlLost,
                            idempotent: true,
                            applied_control_version: None,
                            accepted_through_seq: action.try_get("accepted_through_seq")?,
                            frozen_body_hash: action.try_get("frozen_body_hash")?,
                            input_disposition: None,
                        }));
                    }
                }
            }
        }
        return Ok(None);
    }

    if request.expected_attempt_epoch != generation_epoch
        || attempt_epoch != Some(request.expected_attempt_epoch)
        || attempt_epoch_value != Some(request.expected_attempt_epoch)
        || !matches!(generation_status.as_str(), "stop_requested" | "stopping")
        || generation_control != "stopping"
        || run_status != "running"
        || !matches!(attempt_status.as_str(), "started" | "waiting_for_network")
        || attempt_phase.is_none()
        || attempt_phase.as_deref() == Some("execution_terminal_committed")
        || !generation_lease_expired
        || !run_lease_expired
        || !generation_hold
        || !run_hold
        || !generation_has_no_terminal
        || !generation_not_completed
        || !process_exit_unknown
        || !run_not_finished
        || !attempt_not_finished
        || generation_owner
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        || run_owner
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        || attempt_owner
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        || generation_cutoff.is_none()
        || generation_hash
            .as_deref()
            .is_none_or(|hash| normalize_hash(hash).is_err())
        || current_pin.run_id != hint.run_id
        || current_pin.attempt_id != attempt_id
        || current_pin.generation_attempt_epoch != Some(request.expected_attempt_epoch)
    {
        return Ok(None);
    }

    let pending_actions = sqlx::query(
        "SELECT id::text,org_id::text,expected_generation_id::text,
                expected_attempt_epoch,expected_control_version,applied_control_version,
                action_kind,local_disposition,control_owner_token,requested_render_seq,
                requested_body_hash,accepted_through_seq,frozen_body_hash,
                CASE WHEN octet_length(provider_evidence::text)<=65536 THEN provider_evidence END AS evidence,
                provider_evidence IS NOT NULL AND octet_length(provider_evidence::text)<=65536 AS evidence_bounded
         FROM chat_control_actions
         WHERE org_id=$1::uuid AND expected_generation_id=$2::uuid
           AND expected_attempt_epoch=$3 AND action_kind='stop'
           AND resolved_at IS NULL AND local_disposition IN ('stop_requested','stopping')
         ORDER BY requested_at,id LIMIT $4 FOR UPDATE",
    )
    .bind(org)
    .bind(&request.generation_id)
    .bind(request.expected_attempt_epoch)
    .bind(MAX_PENDING_STOP_ACTIONS + 1)
    .fetch_all(&mut *tx)
    .await?;
    if pending_actions.len() as i64 > MAX_PENDING_STOP_ACTIONS {
        return Ok(None);
    }

    let mut exact_action_ids = Vec::new();
    let mut requested_action_found = false;
    for action in &pending_actions {
        let evidence_bounded: bool = action.try_get("evidence_bounded")?;
        if !evidence_bounded {
            continue;
        }
        let evidence: Option<Value> = action.try_get("evidence")?;
        let Some(evidence) = evidence else { continue };
        if evidence["authority"] != "native_rust_control_v1" {
            continue;
        }
        let stored_pin: pin::ExecutionPin =
            match serde_json::from_value(evidence["executionPin"].clone()) {
                Ok(value) => value,
                Err(_) => continue,
            };
        if !stored_pin.same_identity(&current_pin)
            || stored_pin.run_id != hint.run_id
            || stored_pin.attempt_id != attempt_id
            || stored_pin.attempt_epoch != Some(request.expected_attempt_epoch)
            || stored_pin.generation_attempt_epoch != Some(request.expected_attempt_epoch)
        {
            continue;
        }
        let action_id: String = action.try_get("id")?;
        let expected_version: Option<i32> = action.try_get("expected_control_version")?;
        let applied_version: Option<i32> = action.try_get("applied_control_version")?;
        let cutoff: Option<i32> = action.try_get("accepted_through_seq")?;
        let frozen_hash: Option<String> = action.try_get("frozen_body_hash")?;
        let action_owner: Option<String> = action.try_get("control_owner_token")?;
        if action.try_get::<String, _>("org_id")? != org
            || action
                .try_get::<Option<String>, _>("expected_generation_id")?
                .as_deref()
                != Some(request.generation_id.as_str())
            || action.try_get::<Option<i32>, _>("expected_attempt_epoch")?
                != Some(request.expected_attempt_epoch)
            || action.try_get::<String, _>("action_kind")? != "stop"
            || !matches!(
                action.try_get::<String, _>("local_disposition")?.as_str(),
                "stop_requested" | "stopping"
            )
            || action_owner.as_deref() != generation_owner.as_deref()
            || cutoff != generation_cutoff
            || frozen_hash.as_deref() != generation_hash.as_deref()
            || expected_version.is_none_or(|version| version > generation_control_version)
            || applied_version.is_some_and(|version| {
                expected_version.and_then(|value| value.checked_add(1)) != Some(version)
            })
        {
            continue;
        }
        if action_id == request.control_action_id {
            requested_action_found = expected_version == Some(request.expected_control_version)
                && action.try_get::<Option<i32>, _>("requested_render_seq")?
                    == Some(request.requested_render_seq)
                && action
                    .try_get::<Option<String>, _>("requested_body_hash")?
                    .as_deref()
                    == Some(requested_hash.as_str());
        }
        exact_action_ids.push(action_id);
    }
    if !requested_action_found || !exact_action_ids.contains(&request.control_action_id) {
        return Ok(None);
    }

    let incident = json!({
        "version": 1,
        "incidentControlActionId": request.control_action_id,
        "runId": hint.run_id,
        "attemptId": attempt_id,
        "generationAttemptEpoch": request.expected_attempt_epoch,
        "disposition": "control_lost",
        "cleanupState": "unknown",
    });
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:control_lost',true)")
        .execute(&mut *tx)
        .await?;
    let actions_updated = sqlx::query(
        "UPDATE chat_control_actions
         SET local_disposition='control_lost',last_error=$3,
             resolved_at=clock_timestamp(),provider_evidence=provider_evidence || jsonb_build_object('ownerLoss',$4::jsonb),
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=ANY($2::uuid[]) AND resolved_at IS NULL
           AND local_disposition IN ('stop_requested','stopping')",
    )
    .bind(org)
    .bind(&exact_action_ids)
    .bind(OWNER_LOSS_CODE)
    .bind(&incident)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if actions_updated != exact_action_ids.len() as u64 {
        return Err(http(
            409,
            "Native Chat Stop ledger changed during owner-loss recovery",
        ));
    }
    let generation_updated = sqlx::query(
        "UPDATE chat_generations
         SET status='interrupted_unverified',control_state='control_lost',
             terminal_reason=$4,updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND id=$3::uuid
           AND status IN ('stop_requested','stopping') AND control_state='stopping'
           AND attempt_epoch=$5 AND native_admission_hold=true
           AND runtime_terminal_at IS NULL AND completed_at IS NULL
           AND control_owner_token IS NOT NULL
           AND control_lease_expires_at IS NOT NULL
           AND control_lease_expires_at<=clock_timestamp()",
    )
    .bind(org)
    .bind(&request.conversation_id)
    .bind(&request.generation_id)
    .bind(OWNER_LOSS_CODE)
    .bind(request.expected_attempt_epoch)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let run_updated = sqlx::query(
        "UPDATE heartbeat_runs
         SET status='failed',error=$4,error_code=$5,finished_at=clock_timestamp(),
             running_substate=NULL,updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND chat_generation_id=$3::uuid
           AND status='running' AND native_admission_hold=true
           AND execution_owner_token IS NOT NULL AND execution_lease_expires_at IS NOT NULL
           AND execution_lease_expires_at<=clock_timestamp()
           AND process_exited_at IS NULL AND finished_at IS NULL",
    )
    .bind(org)
    .bind(&hint.run_id)
    .bind(&request.generation_id)
    .bind("Native Chat control owner expired; provider cleanup is unverified")
    .bind(OWNER_LOSS_CODE)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let attempt_updated = sqlx::query(
        "UPDATE heartbeat_run_attempts
         SET status='failed',error=$4,error_code=$5,finished_at=clock_timestamp()
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid
           AND status IN ('started','waiting_for_network') AND finished_at IS NULL
           AND owner_token IS NOT NULL AND generation_attempt_epoch=$6",
    )
    .bind(org)
    .bind(&hint.run_id)
    .bind(&attempt_id)
    .bind("Native Chat control owner expired; provider cleanup is unverified")
    .bind(OWNER_LOSS_CODE)
    .bind(request.expected_attempt_epoch)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if generation_updated != 1 || run_updated != 1 || attempt_updated != 1 {
        return Err(http(409, "Native Chat owner state changed during recovery"));
    }

    let generation_payload = json!({
        "generationStatus": "interrupted_unverified",
        "controlState": "control_lost",
        "cleanupState": "unknown",
    });
    sqlx::query(
        "INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,
             event_kind,payload,control_action_id,run_id)
         SELECT $1::uuid,$2::uuid,COALESCE(max(generation_seq),0)+1,$3,
             'control_lost',$4,$5::uuid,$6::uuid
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid",
    )
    .bind(org)
    .bind(&request.generation_id)
    .bind(request.expected_attempt_epoch)
    .bind(&generation_payload)
    .bind(&request.control_action_id)
    .bind(&hint.run_id)
    .execute(&mut *tx)
    .await?;
    let run_payload = json!({
        "status": "failed",
        "errorCode": OWNER_LOSS_CODE,
        "cleanupState": "unknown",
    });
    sqlx::query(
        "INSERT INTO heartbeat_run_events(org_id,run_id,agent_id,seq,event_type,payload,idempotency_key)
         SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE(max(seq),0)+1,'status',$4,$5
         FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid",
    )
    .bind(org)
    .bind(&hint.run_id)
    .bind(&hint.agent_id)
    .bind(&run_payload)
    .bind(format!("native-chat-control-lost:{attempt_id}"))
    .execute(&mut *tx)
    .await?;
    let audit = ActivityActor {
        actor_type: "user",
        actor_id: actor.actor().id.clone(),
        run_id: Some(hint.run_id.clone()),
    };
    write_activity(
        &mut tx,
        org,
        &audit,
        "runtime.native_chat.owner_lost",
        "chat_generation",
        &request.generation_id,
        Some(&json!({
            "controlActionId": request.control_action_id,
            "runId": hint.run_id,
            "attemptId": attempt_id,
            "code": OWNER_LOSS_CODE,
            "cleanupState": "unknown",
            "nativeAdmissionHold": true,
            "processExitState": "unknown",
        })),
    )
    .await?;
    auth::authorize_org(&mut tx, actor, org).await?;
    tx.commit().await?;

    Ok(Some(StopReceipt {
        control_action_id: request.control_action_id.clone(),
        generation_id: request.generation_id.clone(),
        outcome: StopOutcome::ControlLost,
        idempotent: false,
        applied_control_version: None,
        accepted_through_seq: generation_cutoff,
        frozen_body_hash: generation_hash,
        input_disposition: None,
    }))
}

/// Return the one durable owner-loss incident only while its exact run and
/// latest Attempt still prove the quarantine state. This also fences retries.
pub(super) async fn current_owner_loss_incident(
    tx: &mut auth::Tx<'_>,
    org: &str,
    conversation_id: &str,
    generation_id: &str,
    run_id: &str,
    attempt_id: &str,
    attempt_epoch: i32,
    current_pin: &pin::ExecutionPin,
) -> Result<Option<String>> {
    let state = sqlx::query(
        "SELECT g.status AS generation_status,g.control_state,g.attempt_epoch,
                g.native_admission_hold AS generation_hold,
                g.runtime_terminal_at IS NULL AS no_runtime_terminal,
                g.completed_at IS NULL AS not_completed,
                g.control_lease_expires_at IS NOT NULL
                  AND g.control_lease_expires_at<=clock_timestamp() AS generation_expired,
                COALESCE(btrim(g.control_owner_token)<>'',false) AS generation_owner_present,
                r.status AS run_status,r.native_admission_hold AS run_hold,
                r.process_exited_at IS NULL AS process_exit_unknown,
                r.execution_lease_expires_at IS NOT NULL
                  AND r.execution_lease_expires_at<=clock_timestamp() AS run_expired,
                COALESCE(btrim(r.execution_owner_token)<>'',false) AS run_owner_present,
                a.id::text AS latest_attempt_id,a.status AS attempt_status,
                a.generation_attempt_epoch,a.finished_at IS NOT NULL AS attempt_finished,
                COALESCE(btrim(a.owner_token)<>'',false) AS attempt_owner_present,
                (SELECT count(*) FROM chat_generation_events e
                 WHERE e.org_id=$1::uuid AND e.generation_id=$3::uuid
                   AND e.attempt_epoch=$4 AND e.run_id=$5::uuid
                   AND e.event_kind='control_lost') AS incident_count,
                (SELECT e.control_action_id::text FROM chat_generation_events e
                 WHERE e.org_id=$1::uuid AND e.generation_id=$3::uuid
                   AND e.attempt_epoch=$4 AND e.run_id=$5::uuid
                   AND e.event_kind='control_lost' ORDER BY e.generation_seq LIMIT 1) AS incident_action_id,
                (SELECT e.payload FROM chat_generation_events e
                 WHERE e.org_id=$1::uuid AND e.generation_id=$3::uuid
                   AND e.attempt_epoch=$4 AND e.run_id=$5::uuid
                   AND e.event_kind='control_lost' ORDER BY e.generation_seq LIMIT 1) AS incident_payload,
                (SELECT count(*) FROM heartbeat_run_events re
                 WHERE re.org_id=$1::uuid AND re.run_id=$5::uuid AND re.event_type='status'
                   AND re.idempotency_key='native-chat-control-lost:'||$7) AS run_event_count,
                (SELECT re.payload FROM heartbeat_run_events re
                 WHERE re.org_id=$1::uuid AND re.run_id=$5::uuid AND re.event_type='status'
                   AND re.idempotency_key='native-chat-control-lost:'||$7 LIMIT 1) AS run_event_payload
         FROM chat_generations g
         JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         WHERE g.org_id=$1::uuid AND g.conversation_id=$2::uuid AND g.id=$3::uuid
           AND g.execution_authority='native_rust'
           AND r.id=$5::uuid AND a.id=$6::uuid AND a.attempt_index=(
             SELECT max(a2.attempt_index) FROM heartbeat_run_attempts a2
             WHERE a2.org_id=r.org_id AND a2.run_id=r.id)
           AND a.generation_attempt_epoch=$4
           AND r.chat_conversation_id=$2::uuid AND r.chat_generation_id=g.id
           AND r.execution_authority='native_rust' AND r.scene='chat'
           AND r.target_type='chat_conversation' AND r.target_id=$2::text",
    )
    .bind(org)
    .bind(conversation_id)
    .bind(generation_id)
    .bind(attempt_epoch)
    .bind(run_id)
    .bind(attempt_id)
    .bind(attempt_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(state) = state else { return Ok(None) };
    let generation_status: String = state.try_get("generation_status")?;
    let control_state: String = state.try_get("control_state")?;
    let generation_epoch: i32 = state.try_get("attempt_epoch")?;
    let generation_hold: bool = state.try_get("generation_hold")?;
    let no_runtime_terminal: bool = state.try_get("no_runtime_terminal")?;
    let not_completed: bool = state.try_get("not_completed")?;
    let generation_expired: bool = state.try_get("generation_expired")?;
    let generation_owner_present: bool = state.try_get("generation_owner_present")?;
    let run_status: String = state.try_get("run_status")?;
    let run_hold: bool = state.try_get("run_hold")?;
    let process_exit_unknown: bool = state.try_get("process_exit_unknown")?;
    let run_expired: bool = state.try_get("run_expired")?;
    let run_owner_present: bool = state.try_get("run_owner_present")?;
    let latest_attempt_id: String = state.try_get("latest_attempt_id")?;
    let attempt_status: String = state.try_get("attempt_status")?;
    let generation_attempt_epoch: Option<i32> = state.try_get("generation_attempt_epoch")?;
    let attempt_finished: bool = state.try_get("attempt_finished")?;
    let attempt_owner_present: bool = state.try_get("attempt_owner_present")?;
    let incident_count: i64 = state.try_get("incident_count")?;
    let incident_action_id: Option<String> = state.try_get("incident_action_id")?;
    let incident_payload: Option<Value> = state.try_get("incident_payload")?;
    let run_event_count: i64 = state.try_get("run_event_count")?;
    let run_event_payload: Option<Value> = state.try_get("run_event_payload")?;
    let Some(incident_action_id) = incident_action_id else {
        return Ok(None);
    };
    let Some(incident_payload) = incident_payload else {
        return Ok(None);
    };
    let Some(run_event_payload) = run_event_payload else {
        return Ok(None);
    };
    let incident_action_valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM chat_control_actions c
         WHERE c.org_id=$1::uuid AND c.id=$2::uuid AND c.expected_generation_id=$3::uuid
           AND c.expected_attempt_epoch=$4 AND c.action_kind='stop'
           AND c.local_disposition='control_lost' AND c.resolved_at IS NOT NULL
           AND c.last_error=$5
           AND c.provider_evidence->'authority'='\"native_rust_control_v1\"'::jsonb
           AND c.provider_evidence->'ownerLoss'->>'incidentControlActionId'=$2::text
           AND c.provider_evidence->'ownerLoss'->>'runId'=$6
           AND c.provider_evidence->'ownerLoss'->>'attemptId'=$7
           AND (c.provider_evidence->'ownerLoss'->>'generationAttemptEpoch')::integer=$4
           AND c.provider_evidence->'ownerLoss'->>'disposition'='control_lost'
           AND c.provider_evidence->'ownerLoss'->>'cleanupState'='unknown')",
    )
    .bind(org)
    .bind(&incident_action_id)
    .bind(generation_id)
    .bind(attempt_epoch)
    .bind(OWNER_LOSS_CODE)
    .bind(run_id)
    .bind(attempt_id)
    .fetch_one(&mut **tx)
    .await?;
    let valid = incident_action_valid
        && generation_status == "interrupted_unverified"
        && control_state == "control_lost"
        && generation_epoch == attempt_epoch
        && generation_attempt_epoch == Some(attempt_epoch)
        && generation_hold
        && no_runtime_terminal
        && not_completed
        && generation_expired
        && generation_owner_present
        && run_status == "failed"
        && run_hold
        && process_exit_unknown
        && run_expired
        && run_owner_present
        && latest_attempt_id == attempt_id
        && attempt_status == "failed"
        && attempt_finished
        && attempt_owner_present
        && incident_count == 1
        && run_event_count == 1
        && incident_payload["generationStatus"] == "interrupted_unverified"
        && incident_payload["controlState"] == "control_lost"
        && incident_payload["cleanupState"] == "unknown"
        && run_event_payload["status"] == "failed"
        && run_event_payload["errorCode"] == OWNER_LOSS_CODE
        && run_event_payload["cleanupState"] == "unknown"
        && current_pin.run_id == run_id
        && current_pin.attempt_id == attempt_id
        && current_pin.generation_attempt_epoch == Some(attempt_epoch);
    if valid {
        Ok(Some(incident_action_id))
    } else {
        Ok(None)
    }
}

pub(super) async fn action_matches_owner_loss(
    tx: &mut auth::Tx<'_>,
    org: &str,
    conversation_id: &str,
    generation_id: &str,
    run_id: &str,
    attempt_id: &str,
    attempt_epoch: i32,
    current_pin: &pin::ExecutionPin,
    evidence: &Value,
) -> Result<bool> {
    if evidence["authority"] != "native_rust_control_v1"
        || evidence["ownerLoss"]["version"] != 1
        || evidence["ownerLoss"]["disposition"] != "control_lost"
        || evidence["ownerLoss"]["cleanupState"] != "unknown"
        || evidence["ownerLoss"]["runId"] != run_id
        || evidence["ownerLoss"]["attemptId"] != attempt_id
        || evidence["ownerLoss"]["generationAttemptEpoch"] != attempt_epoch
    {
        return Ok(false);
    }
    let Some(incident_id) = evidence["ownerLoss"]["incidentControlActionId"].as_str() else {
        return Ok(false);
    };
    Ok(current_owner_loss_incident(
        tx,
        org,
        conversation_id,
        generation_id,
        run_id,
        attempt_id,
        attempt_epoch,
        current_pin,
    )
    .await?
    .as_deref()
        == Some(incident_id))
}
