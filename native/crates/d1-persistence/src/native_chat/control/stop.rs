use super::*;
use crate::activity::{ActivityActor, write_activity};
use serde_json::json;

/// Persist operator intent under the same target/Conversation/Generation lock
/// order as admission and finalization. No transport authority is returned.
pub async fn request_stop(
    pool: &PgPool,
    actor: &VerifiedActor,
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
    // A retry must be authorized now even when its action was accepted earlier.
    if let Some(action) = sqlx::query(
        "SELECT org_id::text,expected_generation_id::text,expected_attempt_epoch,expected_control_version,
          action_kind,requested_render_seq,requested_body_hash,applied_control_version,
          accepted_through_seq,frozen_body_hash,last_error,
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
        let reason:Option<String>=action.try_get("last_error")?;
        return Ok(StopReceipt {
            control_action_id:request.control_action_id.clone(), generation_id:request.generation_id.clone(),
            outcome:match reason.as_deref() {
                Some("generation_result_already_committed")=>StopOutcome::CompletionCommitted,
                Some("generation_runtime_already_terminal")=>StopOutcome::AlreadyTerminal,
                Some("generation_stop_already_in_progress")=>StopOutcome::StopInProgress,
                None=>StopOutcome::StopIntentRecorded,
                _=>return Err(http(409,"Stop action is not a native control-ledger receipt")),
            }, idempotent:true, applied_control_version:action.try_get("applied_control_version")?,
            accepted_through_seq:action.try_get("accepted_through_seq")?, frozen_body_hash:action.try_get("frozen_body_hash")?,
        });
    }
    if generation.try_get::<i32, _>("attempt_epoch")? != request.expected_attempt_epoch {
        return Err(http(409, "Native Chat generation attempt changed"));
    }
    let attempt = sqlx::query_scalar::<_, Option<i32>>(
        "SELECT generation_attempt_epoch FROM heartbeat_run_attempts
         WHERE org_id=$1::uuid AND run_id=$2::uuid ORDER BY attempt_index DESC LIMIT 1 FOR UPDATE",
    )
    .bind(org)
    .bind(&hint.run_id)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    if attempt != Some(request.expected_attempt_epoch) {
        return Err(http(409, "Native Chat Run attempt changed"));
    }
    // Both terminal writers and Stop hold the Generation lock. A committed
    // terminal wins without truncating its answer or changing provider state.
    let completion:bool=sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
          AND attempt_epoch=$3 AND event_kind='terminal_projected')",
    ).bind(org).bind(&request.generation_id).bind(request.expected_attempt_epoch).fetch_one(&mut *tx).await?;
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
          CASE WHEN $14 THEN clock_timestamp() ELSE NULL END,'{\"authority\":\"native_rust_control_v1\"}'::jsonb)
         ON CONFLICT(id) DO NOTHING RETURNING id::text",
    ).bind(&request.control_action_id).bind(org).bind(&request.generation_id).bind(request.expected_attempt_epoch)
        .bind(request.expected_control_version).bind(receipt.applied_control_version).bind(disposition).bind(owner)
        .bind(request.requested_render_seq).bind(&requested_hash).bind(receipt.accepted_through_seq)
        .bind(&receipt.frozen_body_hash).bind(reason).bind(completion||terminal).fetch_optional(&mut *tx).await?;
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
