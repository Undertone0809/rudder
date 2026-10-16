//! Single-primary-turn finalization. Only validated receipts from the owned
//! transport enter here; provider completion alone cannot release admission.
use super::{ExecutionFence, Result, context::lock_current_execution, http};
use crate::{
    activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options},
    runtime_bindings,
};
use rudder_auth_core::VerifiedActor;
use rudder_codex_app_server::{CleanupReceipt, TurnReceipt, TurnStatus};
use rudder_runtime_core::native_chat::{NativeChatProtocolCheckpoint, NativeChatProtocolPhase};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

/// Atomically project a supported answer and close the exact owned execution.
/// This private path records unknown cost, never a fabricated zero charge.
/// Applicable billed-cost hard stops remain unsupported and retain the holds.
pub async fn finalize(
    pool: &PgPool,
    actor: &VerifiedActor,
    fence: &ExecutionFence,
    turn: &TurnReceipt,
    cleanup: &CleanupReceipt,
) -> Result<Value> {
    let id = fence.identity();
    if actor.organization_id() != id.organization_id {
        return Err(http(403, "Organization access denied"));
    }
    if !cleanup.proves_quiescence_for(turn)
        || !turn.matches_execution(id.run_id, id.attempt_id, fence.run_execution_owner_token())
        || !cleanup.matches_execution(id.run_id, id.attempt_id, fence.run_execution_owner_token())
    {
        return Err(http(
            409,
            "Native Chat receipts belong to another execution",
        ));
    }
    let unprojectable = turn.status() == TurnStatus::Completed
        && turn.final_text().is_none_or(|text| text.trim().is_empty());
    let (run_status, generation_status) = match turn.status() {
        TurnStatus::Completed if unprojectable => ("failed", "failed"),
        TurnStatus::Completed => ("succeeded", "completed"),
        TurnStatus::Failed => ("failed", "failed"),
        TurnStatus::Interrupted => ("cancelled", "stopped"),
    };
    let usage = turn.usage().map(|usage| json!({
        "source":"thread/tokenUsage/updated.tokenUsage.last", "scope":"latest_reported_increment",
        "attemptId":id.attempt_id,
        "inputTokens":usage.input_tokens(), "cachedInputTokens":usage.cached_input_tokens(),
        "outputTokens":usage.output_tokens(), "reasoningOutputTokens":usage.reasoning_output_tokens(),
        "totalTokens":usage.total_tokens(),
    }));
    let cost = json!({"status":"unknown", "reason":"provider_cost_not_reported"});
    // Bind retries to every authority dimension and every projected fact. Owner
    // capabilities are hashed into one fingerprint, never returned or logged.
    let facts = json!({
        "version":1, "organizationId":id.organization_id, "conversationId":id.conversation_id,
        "generationId":id.generation_id, "runId":id.run_id, "attemptId":id.attempt_id,
        "agentId":id.agent_id, "bindingId":fence.binding_id, "segmentId":fence.segment_id,
        "generationEpoch":id.generation_attempt_epoch, "attemptEpoch":id.run_attempt_epoch,
        "connectionEpoch":id.connection_epoch, "generationOwner":fence.generation_control_owner_token(),
        "runOwner":fence.run_execution_owner_token(), "threadId":turn.thread_id(),
        "turnId":turn.turn_id(), "status":run_status, "answer":turn.final_text(),
        "usage":usage, "cost":cost, "cleanupReceipt":cleanup.evidence_fingerprint(),
    });
    let fingerprint = format!("{:x}", Sha256::digest(facts.to_string().as_bytes()));
    let mut tx = pool.begin().await?;
    super::super::budget::lock_policy_state(&mut tx, id.organization_id).await?;
    runtime_bindings::authorize_chat_target_read_tx(
        &mut tx,
        actor,
        id.organization_id,
        id.conversation_id,
        id.agent_id,
    )
    .await?;
    runtime_bindings::lock_native_chat_target_tx(&mut tx, id.organization_id, id.conversation_id)
        .await?;
    // Read-only retry under the same target serialization. A completed execution
    // has no live lease; it cannot pass the first-finalization owner checks.
    let existing: Option<Value> = sqlx::query_scalar(
        "SELECT r.result_json->'nativeChatFinalization' FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$7::uuid
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.execution_authority='native_rust'
           AND r.chat_conversation_id=$3::uuid AND r.chat_generation_id=$4::uuid
           AND r.execution_owner_token=$5 AND g.control_owner_token=$6 AND a.owner_token=$5
           AND g.attempt_epoch=$8 AND a.generation_attempt_epoch=$8 AND a.attempt_epoch=$9
           AND a.connection_epoch=$10 AND a.protocol_phase='execution_terminal_committed'
           AND a.provider_thread_id=$11 AND a.provider_turn_id=$12",
    )
    .bind(id.organization_id)
    .bind(id.run_id)
    .bind(id.conversation_id)
    .bind(id.generation_id)
    .bind(fence.run_execution_owner_token())
    .bind(fence.generation_control_owner_token())
    .bind(id.attempt_id)
    .bind(id.generation_attempt_epoch)
    .bind(id.run_attempt_epoch)
    .bind(id.connection_epoch)
    .bind(turn.thread_id())
    .bind(turn.turn_id())
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    if let Some(existing) = existing {
        if existing["fingerprint"].as_str() != Some(fingerprint.as_str()) {
            return Err(http(
                409,
                "Native Chat finalization evidence conflicts with its committed result",
            ));
        }
        let result = existing["result"].clone();
        if !result.is_object() {
            return Err(http(409, "Native Chat finalization receipt is invalid"));
        }
        tx.commit().await?;
        return Ok(result);
    }
    let locked = lock_current_execution(&mut tx, actor, fence).await?;
    if locked.checkpoint.phase() != NativeChatProtocolPhase::ProviderTerminalObserved
        || locked.checkpoint.thread_id() != Some(turn.thread_id())
        || locked.checkpoint.turn_id() != Some(turn.turn_id())
    {
        return Err(http(
            409,
            "Native Chat terminal does not match the durable checkpoint",
        ));
    }
    let budget_held =
        super::super::budget::has_unsettleable_policy(&mut tx, id.organization_id, id.agent_id)
            .await?;
    let held = budget_held || unprojectable;
    let source = sqlx::query(
        "SELECT m.chat_turn_id::text AS chat_turn_id,m.turn_variant,a.model
         FROM chat_generations g JOIN chat_messages m ON m.org_id=g.org_id AND m.id=g.source_message_id
         JOIN heartbeat_run_attempts a ON a.org_id=g.org_id AND a.id=$3::uuid
         WHERE g.org_id=$1::uuid AND g.id=$2::uuid FOR UPDATE OF m",
    ).bind(id.organization_id).bind(id.generation_id).bind(id.attempt_id)
        .fetch_one(&mut *tx).await?;
    let chat_turn_id: Option<String> = source.try_get("chat_turn_id")?;
    let turn_variant: i32 = source.try_get("turn_variant")?;
    let model: Option<String> = source.try_get("model")?;
    let increment = usage.map(|mut value| {
        value["model"] = json!(model);
        value
    });
    // Codex `last` is the latest model-response increment, not a complete
    // user-turn total. Preserve it as observation without feeding Run counters.
    let usage = json!({"status":"unavailable", "reason":"run_total_not_established",
        "latestReportedIncrement":increment});
    let mut checkpoint = serde_json::to_value(&locked.checkpoint)
        .map_err(|_| http(500, "Cannot encode Native Chat checkpoint"))?;
    checkpoint["phase"] = json!("execution_terminal_committed");
    checkpoint["revision"] = json!(
        locked
            .checkpoint
            .revision()
            .checked_add(1)
            .ok_or_else(|| http(409, "Native Chat checkpoint revision exhausted"))?
    );
    let validated: NativeChatProtocolCheckpoint = serde_json::from_value(checkpoint.clone())
        .map_err(|_| http(409, "Native Chat terminal checkpoint is invalid"))?;
    validated
        .validate()
        .map_err(|_| http(409, "Native Chat terminal checkpoint is invalid"))?;
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:finalize',true)")
        .execute(&mut *tx)
        .await?;

    let message_id: Option<String> =
        if let Some(text) = turn.final_text().filter(|text| !text.trim().is_empty()) {
            Some(
            sqlx::query_scalar(
                "INSERT INTO chat_messages (org_id,conversation_id,role,kind,status,body,run_id,
             replying_agent_id,chat_turn_id,turn_variant)
             VALUES ($1::uuid,$2::uuid,'assistant','message',$3,$4,$5::uuid,$6::uuid,$7::uuid,$8)
             RETURNING id::text",
            )
            .bind(id.organization_id)
            .bind(id.conversation_id)
            .bind(match run_status {
                "succeeded" => "completed",
                "cancelled" => "stopped",
                _ => "failed",
            })
            .bind(text)
            .bind(id.run_id)
            .bind(id.agent_id)
            .bind(chat_turn_id.as_deref())
            .bind(turn_variant)
            .fetch_one(&mut *tx)
            .await?,
        )
        } else {
            None
        };
    let span_id: String = sqlx::query_scalar(
        "UPDATE run_runtime_spans SET state='sealed',completeness='terminal_only',
         native_execution_ref=$8,input_correlation_ref=$9,selector_json=$10,
         closed_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND attempt_id=$3::uuid
           AND binding_id=$4::uuid AND segment_id=$5::uuid AND owner_token=$6
           AND attempt_epoch=$7 AND relation='primary' AND state='open' AND closed_at IS NULL
         RETURNING id::text",
    )
    .bind(id.organization_id)
    .bind(id.run_id)
    .bind(id.attempt_id)
    .bind(&fence.binding_id)
    .bind(&fence.segment_id)
    .bind(fence.run_execution_owner_token())
    .bind(id.run_attempt_epoch)
    .bind(turn.turn_id())
    .bind(locked.admitted_message_id)
    .bind(json!({"kind":"codex_turn","threadId":turn.thread_id(),"turnId":turn.turn_id()}))
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(409, "Native Chat primary span is not open for this owner"))?;
    // All slow writes above remain reversible. Recheck both leases immediately
    // before committing terminal state; every mutation rolls back on expiry.
    lock_current_execution(&mut tx, actor, fence).await?;
    let result = json!({"runId":id.run_id,"generationId":id.generation_id,"attemptId":id.attempt_id,
        "assistantMessageId":message_id,"spanId":span_id,"status":run_status,
        "generationStatus":generation_status,
        "cost":cost,"usage":usage,"nativeAdmissionHold":held,
        "projectionDisposition":if unprojectable { "unsupported_final_answer" } else { "projected" },
        "budgetDisposition":if budget_held { "reconciliation_required" } else { "unbudgeted_unknown_cost" }});
    sqlx::query(
        "UPDATE heartbeat_run_attempts SET status=$4,finished_at=clock_timestamp(),
         protocol_phase='execution_terminal_committed',checkpoint_json=$5,
         usage_delta_json=$6,cost_cents=NULL WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid",
    ).bind(id.organization_id).bind(id.run_id).bind(id.attempt_id).bind(run_status)
        .bind(checkpoint).bind(&usage).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE heartbeat_runs SET status=$3,finished_at=clock_timestamp(),process_exited_at=clock_timestamp(),
         running_substate=NULL,usage_json=$4,result_json=$5,native_admission_hold=$6,
         updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    ).bind(id.organization_id).bind(id.run_id).bind(run_status).bind(&usage)
        .bind(json!({"nativeChatFinalization":{"version":1,"fingerprint":fingerprint,"result":result}})).bind(held)
        .execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE chat_generations SET status=$3,terminal_reason=$4,control_state='terminal',
         runtime_terminal_at=clock_timestamp(),completed_at=clock_timestamp(),
         native_admission_hold=$5,updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid",
    ).bind(id.organization_id).bind(id.generation_id).bind(generation_status)
        .bind(if unprojectable {
            "native_provider_completed_without_projectable_answer".to_owned()
        } else {
            format!("native_provider_{run_status}")
        }).bind(held).execute(&mut *tx).await?;
    for event in ["runtime_terminal", "terminal_projected"] {
        sqlx::query(
            "INSERT INTO chat_generation_events (org_id,generation_id,generation_seq,attempt_epoch,
             event_kind,payload,assistant_message_id,run_id)
             SELECT $1::uuid,$2::uuid,COALESCE(max(generation_seq),0)+1,$3,$4,$5,$6::uuid,$7::uuid
             FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid",
        )
        .bind(id.organization_id)
        .bind(id.generation_id)
        .bind(id.generation_attempt_epoch)
        .bind(event)
        .bind(&result)
        .bind(message_id.as_deref())
        .bind(id.run_id)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "INSERT INTO heartbeat_run_events (org_id,run_id,agent_id,seq,event_type,payload,idempotency_key)
         SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE(max(seq),0)+1,'status',$4,$5
         FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid",
    ).bind(id.organization_id).bind(id.run_id).bind(id.agent_id).bind(&result)
        .bind(format!("native-finalize:{}",id.attempt_id)).execute(&mut *tx).await?;
    let audit = ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: Some(id.run_id.into()),
    };
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: id.organization_id,
            audit: &audit,
            action: "runtime.native_chat.finalized",
            entity_type: "heartbeat_run",
            entity_id: id.run_id,
            details: Some(&result),
            options: ActivityOptions {
                agent_id: Some(id.agent_id),
                bind_run: true,
                ..Default::default()
            },
        },
    )
    .await?;
    // Row locks retain both owners through commit. Even an event/activity
    // write that waited must not commit after the original owner lease expired.
    let leases_live: bool = sqlx::query_scalar(
        "SELECT COALESCE(g.control_lease_expires_at > clock_timestamp(),false)
          AND COALESCE(r.execution_lease_expires_at > clock_timestamp(),false)
         FROM chat_generations g JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND r.id=$3::uuid
           AND g.control_owner_token=$4 AND r.execution_owner_token=$5",
    ).bind(id.organization_id).bind(id.generation_id).bind(id.run_id)
        .bind(fence.generation_control_owner_token()).bind(fence.run_execution_owner_token())
        .fetch_optional(&mut *tx).await?.unwrap_or(false);
    if !leases_live {
        return Err(http(409, "Native Chat lease expired during finalization"));
    }
    sqlx::query("UPDATE chat_generations SET control_lease_expires_at=NULL WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(id.organization_id).bind(id.generation_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=NULL WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(id.organization_id).bind(id.run_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(result)
}
