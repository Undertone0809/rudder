use super::*;
use crate::activity::{ActivityActor, write_activity};
use serde_json::json;

/// Persist operator intent under the same target/Conversation/Generation lock
/// order as admission and finalization. No transport authority is returned.
pub async fn request_stop(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    request: &StopRequest,
) -> Result<StopReceipt> {
    validate_ids(actor, &request.conversation_id, &request.generation_id)?;
    canonical_id(&request.control_action_id, "control action id")?;
    if request.expected_attempt_epoch < 1
        || request.expected_control_version < 0
        || request.requested_render_seq < 0
    {
        return Err(http(422, "Invalid Native Chat Stop fence"));
    }
    let requested_hash = normalize_hash(&request.requested_body_hash)?;
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
    runtime_bindings::authorize_chat_target_read_locked_tx(
        &mut tx,
        actor,
        org,
        &request.conversation_id,
        &hint.agent_id,
    )
    .await?;
    let generation = sqlx::query(
        "SELECT status,attempt_epoch,control_version,control_owner_token,
                accepted_through_seq,frozen_body_hash,last_client_checkpoint_seq,last_client_checkpoint_hash,
                runtime_terminal_at IS NOT NULL AS terminal
         FROM chat_generations WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND id=$3::uuid
           AND execution_authority='native_rust' FOR UPDATE",
    ).bind(org).bind(&request.conversation_id).bind(&request.generation_id)
        .fetch_optional(&mut *tx).await?.ok_or_else(|| http(404,"Native Chat generation not found"))?;
    let run = sqlx::query_scalar::<_, String>(
        "SELECT agent_id::text FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid
          AND chat_generation_id=$3::uuid AND chat_conversation_id=$4::uuid
          AND execution_authority='native_rust' AND scene='chat'
          AND target_type='chat_conversation' AND target_id=$4 FOR UPDATE",
    )
    .bind(org)
    .bind(&hint.run_id)
    .bind(&request.generation_id)
    .bind(&request.conversation_id)
    .fetch_optional(&mut *tx)
    .await?;
    if run.as_deref() != Some(hint.agent_id.as_str()) {
        return Err(http(409, "Native Chat Run association changed"));
    }
    auth::authorize_org(&mut tx, actor, org).await?;
    if generation.try_get::<i32, _>("attempt_epoch")? != request.expected_attempt_epoch {
        return Err(http(409, "Native Chat generation attempt changed"));
    }
    // Keep the same Conversation -> Generation -> Run -> Attempt ordering used
    // by the execution finalizer. The private action pin is compared with this
    // current Attempt before any replay can be reported as terminal.
    let attempt = sqlx::query(
        "SELECT id::text, generation_attempt_epoch FROM heartbeat_run_attempts
         WHERE org_id=$1::uuid AND run_id=$2::uuid ORDER BY attempt_index DESC LIMIT 1 FOR UPDATE",
    )
    .bind(org)
    .bind(&hint.run_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(409, "Native Chat Run attempt is missing"))?;
    if attempt.try_get::<Option<i32>, _>("generation_attempt_epoch")?
        != Some(request.expected_attempt_epoch)
    {
        return Err(http(409, "Native Chat Run attempt changed"));
    }
    let attempt_id: String = attempt.try_get("id")?;
    let current_pin = pin::capture(&mut tx, org, &hint.run_id, &attempt_id).await?;
    // A retry must be authorized now even when its action was accepted earlier.
    if let Some(action) = sqlx::query(
        "SELECT org_id::text,expected_generation_id::text,expected_attempt_epoch,expected_control_version,
          action_kind,requested_render_seq,requested_body_hash,applied_control_version,
          accepted_through_seq,frozen_body_hash,last_error,local_disposition,
          resolved_at IS NOT NULL AS resolved,
          CASE WHEN octet_length(provider_evidence::text)<=65536 THEN provider_evidence END AS evidence,
          COALESCE(provider_evidence->'authority'='\"native_rust_control_v1\"'::jsonb,false) AS native_receipt
         FROM chat_control_actions WHERE id=$1::uuid",
    ).bind(&request.control_action_id).fetch_optional(&mut *tx).await? {
        if !action.try_get::<bool, _>("native_receipt")? {
            return Err(http(409, "Control action id is not a native control-ledger receipt"));
        }
        if action.try_get::<String,_>("org_id")? != org
            || action.try_get::<Option<String>,_>("expected_generation_id")?.as_deref()!=Some(request.generation_id.as_str())
            || action.try_get::<Option<i32>,_>("expected_attempt_epoch")?!=Some(request.expected_attempt_epoch)
            || action.try_get::<Option<i32>,_>("expected_control_version")?!=Some(request.expected_control_version)
            || action.try_get::<String,_>("action_kind")?!="stop"
            || action.try_get::<Option<i32>,_>("requested_render_seq")?!=Some(request.requested_render_seq)
            || action.try_get::<Option<String>,_>("requested_body_hash")?.as_deref()!=Some(requested_hash.as_str()) {
            return Err(http(409,"Control action id was already used for a different Stop request"));
        }
        let evidence: Option<serde_json::Value> = action.try_get("evidence")?;
        let evidence = evidence.ok_or_else(|| http(409, "Stop action evidence exceeds its bound"))?;
        let stored_pin: pin::ExecutionPin = serde_json::from_value(
            evidence["executionPin"].clone(),
        )
        .map_err(|_| http(409, "Stop action execution pin is invalid"))?;
        if !stored_pin.same_identity(&current_pin)
            || stored_pin.run_id != hint.run_id
            || stored_pin.attempt_id != attempt_id
            || stored_pin.attempt_epoch != Some(request.expected_attempt_epoch)
            || stored_pin.generation_attempt_epoch != Some(request.expected_attempt_epoch)
        {
            return Err(http(409, "Stop action belongs to another execution attempt"));
        }
        let reason:Option<String>=action.try_get("last_error")?;
        let local_disposition: String = action.try_get("local_disposition")?;
        let resolved: bool = action.try_get("resolved")?;
        let applied_control_version: Option<i32> = action.try_get("applied_control_version")?;
        let accepted_through_seq: Option<i32> = action.try_get("accepted_through_seq")?;
        let frozen_body_hash: Option<String> = action.try_get("frozen_body_hash")?;
        let terminal_stop = if matches!(reason.as_deref(), Some("generation_stop_already_in_progress") | None)
            && local_disposition == "stopped"
            && resolved
        {
            stop_finalization_matches(
                &mut tx,
                org,
                &request.conversation_id,
                &request.generation_id,
                &request.control_action_id,
                &hint.run_id,
                &attempt_id,
                request.expected_attempt_epoch,
                action.try_get("expected_control_version")?,
                applied_control_version,
                accepted_through_seq,
                frozen_body_hash.as_deref(),
            )
            .await?
        } else {
            false
        };
        let input_disposition = if terminal_stop
            && evidence["terminalization"]["receipt"]["controlActionId"]
                == request.control_action_id
            && evidence["terminalization"]["receipt"]["inputDisposition"]
                == "not_submitted"
        {
            Some("not_submitted".to_owned())
        } else {
            None
        };
        if (local_disposition == "stopped" || resolved) && !terminal_stop
            && matches!(reason.as_deref(), Some("generation_stop_already_in_progress") | None)
        {
            return Err(http(409, "Stopped action has no matching terminal receipt"));
        }
        let outcome = match reason.as_deref() {
            Some("generation_result_already_committed") => StopOutcome::CompletionCommitted,
            Some("generation_runtime_already_terminal") => StopOutcome::AlreadyTerminal,
            Some("generation_stop_already_in_progress") if terminal_stop => StopOutcome::Stopped,
            Some("generation_stop_already_in_progress")
                if matches!(local_disposition.as_str(), "stop_requested" | "stopping") =>
            {
                StopOutcome::StopInProgress
            }
            None if terminal_stop => StopOutcome::Stopped,
            None if local_disposition == "stop_requested" => StopOutcome::StopIntentRecorded,
            None if local_disposition == "stopping" => StopOutcome::StopInProgress,
            _ => return Err(http(409, "Stop action is not a native control-ledger receipt")),
        };
        return Ok(StopReceipt {
            control_action_id:request.control_action_id.clone(), generation_id:request.generation_id.clone(),
            outcome, idempotent:true, applied_control_version,
            accepted_through_seq, frozen_body_hash,
            input_disposition,
        });
    }
    let pin = current_pin;
    // Both terminal writers and Stop hold the Generation lock. A committed
    // terminal wins without truncating its answer or changing provider state.
    // A projected terminal event also exists for operator Stop, provider
    // failure, and timeout. Only the durable successful completion projection
    // means a new Stop action must report `completion_committed`.
    let completion: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM chat_generation_events e
           JOIN chat_generations g ON g.org_id=e.org_id AND g.id=e.generation_id
           WHERE e.org_id=$1::uuid AND e.generation_id=$2::uuid
             AND e.attempt_epoch=$3 AND e.event_kind='terminal_projected'
             AND e.payload->>'status'='succeeded'
             AND e.payload->>'generationStatus'='completed'
             AND g.status='completed' AND g.runtime_terminal_at IS NOT NULL
             AND g.attempt_epoch=$3)",
    )
    .bind(org)
    .bind(&request.generation_id)
    .bind(request.expected_attempt_epoch)
    .fetch_one(&mut *tx)
    .await?;
    let status: String = generation.try_get("status")?;
    let terminal: bool = generation.try_get("terminal")?;
    let current_version: i32 = generation.try_get("control_version")?;
    let mut receipt = StopReceipt {
        control_action_id: request.control_action_id.clone(),
        generation_id: request.generation_id.clone(),
        outcome: StopOutcome::StopIntentRecorded,
        idempotent: false,
        applied_control_version: None,
        accepted_through_seq: None,
        frozen_body_hash: None,
        input_disposition: None,
    };
    let (disposition, reason) = if completion {
        receipt.outcome = StopOutcome::CompletionCommitted;
        ("cancelled", Some("generation_result_already_committed"))
    } else if terminal {
        receipt.outcome = StopOutcome::AlreadyTerminal;
        receipt.accepted_through_seq = generation.try_get("accepted_through_seq")?;
        receipt.frozen_body_hash = generation.try_get("frozen_body_hash")?;
        (
            if status == "stopped" {
                "stopped"
            } else {
                "cancelled"
            },
            Some("generation_runtime_already_terminal"),
        )
    } else {
        runtime_bindings::authorize_chat_target_run_mutation_tx(
            &mut tx,
            actor,
            org,
            &request.conversation_id,
            &hint.agent_id,
            &hint.run_id,
        )
        .await?;
        auth::authorize_org(&mut tx, actor, org).await?;
        if current_version != request.expected_control_version {
            return Err(http(409, "Chat generation control version changed"));
        }
        if matches!(status.as_str(), "stop_requested" | "stopping") {
            receipt.outcome = StopOutcome::StopInProgress;
            receipt.accepted_through_seq = generation.try_get("accepted_through_seq")?;
            receipt.frozen_body_hash = generation.try_get("frozen_body_hash")?;
            if receipt.accepted_through_seq.is_none() || receipt.frozen_body_hash.is_none() {
                return Err(http(409, "Native Chat Stop checkpoint is missing"));
            }
            ("stopping", Some("generation_stop_already_in_progress"))
        } else {
            if !matches!(
                status.as_str(),
                "starting" | "active" | "running" | "waiting_for_network" | "tool_busy" | "closing"
            ) {
                return Err(http(409, "Chat generation is no longer stoppable"));
            }
            let durable_seq: Option<i32> = generation.try_get("last_client_checkpoint_seq")?;
            let durable_hash: Option<String> = generation.try_get("last_client_checkpoint_hash")?;
            let durable = durable_seq
                .zip(durable_hash)
                .filter(|(seq, hash)| *seq >= 0 && normalize_hash(hash).is_ok());
            let checkpoint = if let Some((seq, hash)) = durable
                .as_ref()
                .filter(|(seq, _)| *seq > request.requested_render_seq)
            {
                (*seq, normalize_hash(hash)?)
            } else if let Some(hash) = projection::hash_at(
                &mut tx,
                org,
                &request.generation_id,
                request.expected_attempt_epoch,
                request.requested_render_seq,
                &hint.run_id,
            )
            .await?
            {
                if hash != requested_hash {
                    return Err(http(
                        409,
                        "Stop body hash does not match the durable visible projection",
                    ));
                }
                (request.requested_render_seq, hash)
            } else if let Some((seq, hash)) = durable {
                (seq, normalize_hash(&hash)?)
            } else {
                return Err(http(
                    409,
                    "Stop could not establish a durable rendered checkpoint",
                ));
            };
            if projection::hash_at(
                &mut tx,
                org,
                &request.generation_id,
                request.expected_attempt_epoch,
                checkpoint.0,
                &hint.run_id,
            )
            .await?
            .as_deref()
                != Some(checkpoint.1.as_str())
            {
                return Err(http(
                    409,
                    "Durable rendered checkpoint is not present in this attempt",
                ));
            }
            receipt.applied_control_version = Some(
                current_version
                    .checked_add(1)
                    .ok_or_else(|| http(409, "Control version exhausted"))?,
            );
            receipt.accepted_through_seq = Some(checkpoint.0);
            receipt.frozen_body_hash = Some(checkpoint.1);
            ("stop_requested", None)
        }
    };
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:stop_intent',true)")
        .execute(&mut *tx)
        .await?;
    let owner: Option<String> = generation.try_get("control_owner_token")?;
    let inserted:Option<String>=sqlx::query_scalar(
        "INSERT INTO chat_control_actions(id,org_id,expected_generation_id,expected_attempt_epoch,
          expected_control_version,applied_control_version,action_kind,local_disposition,provider_disposition,
          control_owner_token,requested_render_seq,requested_body_hash,accepted_through_seq,frozen_body_hash,last_error,resolved_at,provider_evidence)
         VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,'stop',$7,'not_sent',$8,$9,$10,$11,$12,$13,
          CASE WHEN $14 THEN clock_timestamp() ELSE NULL END,$15)
         ON CONFLICT(id) DO NOTHING RETURNING id::text",
    ).bind(&request.control_action_id).bind(org).bind(&request.generation_id).bind(request.expected_attempt_epoch)
        .bind(request.expected_control_version).bind(receipt.applied_control_version).bind(disposition).bind(owner)
        .bind(request.requested_render_seq).bind(&requested_hash).bind(receipt.accepted_through_seq)
        .bind(&receipt.frozen_body_hash).bind(reason).bind(completion||terminal)
        .bind(json!({"authority":"native_rust_control_v1","executionPin":pin})).fetch_optional(&mut *tx).await?;
    if inserted.is_none() {
        return Err(http(
            409,
            "Control action id was already used for a different Stop request",
        ));
    }
    if receipt.outcome == StopOutcome::StopIntentRecorded {
        let cutoff = receipt.accepted_through_seq.expect("applied Stop cutoff");
        let hash = receipt
            .frozen_body_hash
            .as_deref()
            .expect("applied Stop hash");
        projection::freeze(&mut tx, org, request, &hint.run_id, cutoff, hash).await?;
        let payload = json!({"controlActionId":request.control_action_id,"requestedRenderSeq":request.requested_render_seq,
            "requestedBodyHash":requested_hash,"acceptedThroughSeq":cutoff,"frozenBodyHash":hash,
            "appliedControlVersion":receipt.applied_control_version});
        for kind in ["stop_requested", "output_cutoff"] {
            sqlx::query(
                "INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,control_action_id,run_id)
                 SELECT $1::uuid,$2::uuid,COALESCE(max(generation_seq),0)+1,$3,$4,$5,$6::uuid,$7::uuid
                 FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid",
            ).bind(org).bind(&request.generation_id).bind(request.expected_attempt_epoch).bind(kind)
                .bind(&payload).bind(&request.control_action_id).bind(&hint.run_id).execute(&mut *tx).await?;
        }
        sqlx::query(
            "UPDATE chat_generations SET status='stop_requested',terminal_reason='operator_stop',control_state='stopping',
              control_version=$4,accepted_through_seq=$5,frozen_body_hash=$6,stop_requested_at=clock_timestamp(),updated_at=clock_timestamp()
             WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND id=$3::uuid",
        ).bind(org).bind(&request.conversation_id).bind(&request.generation_id).bind(receipt.applied_control_version)
            .bind(cutoff).bind(hash).execute(&mut *tx).await?;
    }
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
        "runtime.native_chat.stop_requested",
        "chat_generation",
        &request.generation_id,
        Some(&json!({"controlActionId":request.control_action_id,"outcome":receipt.outcome})),
    )
    .await?;
    auth::authorize_org(&mut tx, actor, org).await?;
    tx.commit().await?;
    Ok(receipt)
}

#[allow(clippy::too_many_arguments)]
async fn stop_finalization_matches(
    tx: &mut auth::Tx<'_>,
    org: &str,
    conversation_id: &str,
    generation_id: &str,
    action_id: &str,
    run_id: &str,
    attempt_id: &str,
    attempt_epoch: i32,
    expected_control_version: i32,
    applied_control_version: Option<i32>,
    accepted_through_seq: Option<i32>,
    frozen_body_hash: Option<&str>,
) -> Result<bool> {
    let (Some(applied_control_version), Some(accepted_through_seq), Some(frozen_body_hash)) = (
        applied_control_version,
        accepted_through_seq,
        frozen_body_hash,
    ) else {
        return Ok(false);
    };
    let frozen_body_hash = normalize_hash(frozen_body_hash)?;
    if expected_control_version.checked_add(1) != Some(applied_control_version)
        || accepted_through_seq < 0
    {
        return Ok(false);
    }

    let state = sqlx::query(
        "SELECT (c.local_disposition='stopped' AND c.resolved_at IS NOT NULL
          AND c.action_kind='stop' AND c.org_id=$1::uuid AND c.id=$4::uuid
          AND c.expected_generation_id=$3::uuid AND c.expected_attempt_epoch=$7
          AND c.expected_control_version=$8 AND c.applied_control_version=$9
          AND c.applied_control_version=c.expected_control_version+1
          AND c.accepted_through_seq=$10 AND c.frozen_body_hash=$11
          AND c.provider_evidence->'authority'='\"native_rust_control_v1\"'::jsonb
          AND (
            (c.provider_evidence->'stopResolution'->>'connectionProof' ~ '^[0-9a-f]{64}$'
              AND c.provider_evidence->'stopResolution'->'result'->>'status'='cancelled'
              AND r.result_json->'nativeChatFinalization'->>'controlActionId'=c.id::text)
            OR
            (c.provider_evidence->'terminalization'->'receipt'->>'controlActionId'=c.id::text
              AND c.provider_evidence->'terminalization'->'receipt'->>'inputDisposition'='not_submitted'
              AND r.result_json->'nativeChatPreclaimStop'->>'controlActionId'=c.id::text
              AND r.result_json->'nativeChatPreclaimStop'->>'inputDisposition'='not_submitted')
          )
          AND g.org_id=$1::uuid AND g.conversation_id=$2::uuid AND g.id=$3::uuid
          AND g.execution_authority='native_rust' AND g.attempt_epoch=$7
          AND g.status='stopped' AND g.control_state='terminal'
          AND g.runtime_terminal_at IS NOT NULL AND g.completed_at IS NOT NULL
          AND g.control_version=$9 AND g.accepted_through_seq=$10 AND g.frozen_body_hash=$11
          AND r.org_id=$1::uuid AND r.id=$5::uuid AND r.execution_authority='native_rust'
          AND r.chat_conversation_id=$2::uuid AND r.chat_generation_id=$3::uuid
          AND r.scene='chat' AND r.target_type='chat_conversation' AND r.target_id=$2::text
          AND r.status='cancelled' AND r.finished_at IS NOT NULL
          AND r.execution_lease_expires_at IS NULL
          AND a.org_id=$1::uuid AND a.run_id=r.id AND a.id=$6::uuid
          AND a.status='cancelled' AND a.finished_at IS NOT NULL
          AND a.protocol_phase='execution_terminal_committed'
          AND a.generation_attempt_epoch=$7
          AND (SELECT count(*)=1 FROM heartbeat_run_attempts a2
            WHERE a2.org_id=$1::uuid AND a2.run_id=r.id AND a2.id=$6::uuid)
          AND (SELECT count(*)=2
               AND count(*) FILTER (WHERE e.event_kind='runtime_terminal')=1
               AND count(*) FILTER (WHERE e.event_kind='terminal_projected')=1
               AND bool_and(e.attempt_epoch=$7 AND e.run_id=r.id AND e.control_action_id=c.id
                 AND e.payload->>'status'='cancelled')
             FROM chat_generation_events e
             WHERE e.org_id=$1::uuid AND e.generation_id=g.id
               AND e.event_kind IN ('runtime_terminal','terminal_projected')
               AND e.control_action_id=c.id)
          AND EXISTS (SELECT 1 FROM heartbeat_run_events re
             WHERE re.org_id=$1::uuid AND re.run_id=r.id AND re.event_type='status'
               AND re.payload->>'status'='cancelled'
               AND re.idempotency_key IN ('native-finalize:'||a.id::text,
                 'native-preclaim-stop:'||c.id::text))) IS TRUE AS complete
         FROM chat_control_actions c
         JOIN chat_generations g ON g.org_id=c.org_id AND g.id=c.expected_generation_id
         JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         WHERE c.org_id=$1::uuid AND c.id=$4::uuid AND c.expected_generation_id=$3::uuid
           AND g.conversation_id=$2::uuid AND r.id=$5::uuid AND a.id=$6::uuid",
    )
    .bind(org)
    .bind(conversation_id)
    .bind(generation_id)
    .bind(action_id)
    .bind(run_id)
    .bind(attempt_id)
    .bind(attempt_epoch)
    .bind(expected_control_version)
    .bind(applied_control_version)
    .bind(accepted_through_seq)
    .bind(frozen_body_hash)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(state) = state else {
        return Ok(false);
    };
    Ok(state.try_get("complete")?)
}
