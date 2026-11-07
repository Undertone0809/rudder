//! Persist a client's acknowledgement of already durable visible output.
//! This grants no execution authority and never changes a Stop cutoff.
use super::*;
use crate::activity::{ActivityActor, write_activity};
use serde_json::json;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientCheckpointRequest {
    pub conversation_id: String,
    pub generation_id: String,
    pub attempt_epoch: i32,
    pub generation_seq: i32,
    pub rendered_body_hash: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCheckpointReceipt {
    pub generation_id: String,
    pub generation_seq: i32,
    pub advanced: bool,
}

pub async fn record_client_checkpoint(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    request: &ClientCheckpointRequest,
) -> Result<ClientCheckpointReceipt> {
    validate_ids(actor, &request.conversation_id, &request.generation_id)?;
    if request.attempt_epoch < 1 || request.generation_seq < 0 {
        return Err(http(422, "Invalid Native Chat client checkpoint"));
    }
    let hash = normalize_hash(&request.rendered_body_hash)?;
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
    runtime_bindings::authorize_chat_target_run_mutation_tx(
        &mut tx,
        actor,
        org,
        &request.conversation_id,
        &hint.agent_id,
        &hint.run_id,
    )
    .await?;
    let generation = sqlx::query(
        "SELECT status,attempt_epoch,control_state,runtime_terminal_at IS NOT NULL AS terminal,
           last_client_checkpoint_seq,last_client_checkpoint_hash
         FROM chat_generations WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND id=$3::uuid
           AND execution_authority='native_rust' FOR UPDATE",
    )
    .bind(org)
    .bind(&request.conversation_id)
    .bind(&request.generation_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Native Chat generation not found"))?;
    let run_agent = sqlx::query_scalar::<_, String>(
        "SELECT agent_id::text FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid
          AND chat_generation_id=$3::uuid AND chat_conversation_id=$4::uuid
          AND execution_authority='native_rust' AND scene='chat'
          AND target_type='chat_conversation' AND target_id=$4::text FOR UPDATE",
    )
    .bind(org)
    .bind(&hint.run_id)
    .bind(&request.generation_id)
    .bind(&request.conversation_id)
    .fetch_optional(&mut *tx)
    .await?;
    if run_agent.as_deref() != Some(hint.agent_id.as_str()) {
        return Err(http(409, "Native Chat Run association changed"));
    }
    auth::authorize_org(&mut tx, actor, org).await?;
    let status: String = generation.try_get("status")?;
    let control: String = generation.try_get("control_state")?;
    if generation.try_get::<i32, _>("attempt_epoch")? != request.attempt_epoch
        || generation.try_get::<bool, _>("terminal")?
        || !matches!(control.as_str(), "unregistered" | "ready")
        || !matches!(
            status.as_str(),
            "starting" | "active" | "running" | "waiting_for_network" | "tool_busy" | "closing"
        )
    {
        return Err(http(
            409,
            "Native Chat output acknowledgement is closed or stale",
        ));
    }
    let durable_hash = projection::hash_at(
        &mut tx,
        org,
        &request.generation_id,
        request.attempt_epoch,
        request.generation_seq,
        &hint.run_id,
    )
    .await?;
    if durable_hash.as_deref() != Some(hash.as_str()) {
        return Err(http(
            409,
            "Client checkpoint does not match durable visible output",
        ));
    }
    let current_seq: Option<i32> = generation.try_get("last_client_checkpoint_seq")?;
    let current_hash: Option<String> = generation.try_get("last_client_checkpoint_hash")?;
    match (current_seq, current_hash.as_deref()) {
        (None, None) => {}
        (Some(seq), Some(value)) if seq >= 0 && normalize_hash(value).is_ok() => {
            if projection::hash_at(
                &mut tx,
                org,
                &request.generation_id,
                request.attempt_epoch,
                seq,
                &hint.run_id,
            )
            .await?
            .as_deref()
                != Some(normalize_hash(value)?.as_str())
            {
                return Err(http(
                    409,
                    "Stored client checkpoint is not durable visible output",
                ));
            }
        }
        _ => return Err(http(409, "Stored Native Chat client checkpoint is invalid")),
    }
    let advanced = current_seq.is_none_or(|seq| request.generation_seq > seq);
    let receipt = ClientCheckpointReceipt {
        generation_id: request.generation_id.clone(),
        generation_seq: current_seq.unwrap_or(0).max(request.generation_seq),
        advanced,
    };
    if !advanced {
        auth::authorize_org(&mut tx, actor, org).await?;
        tx.commit().await?;
        return Ok(receipt);
    }
    sqlx::query(
        "SELECT set_config('rudder.native_chat_write','native_chat:client_checkpoint',true)",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE chat_generations SET last_client_checkpoint_seq=$4,last_client_checkpoint_hash=$5,
          updated_at=clock_timestamp() WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND id=$3::uuid",
    ).bind(org).bind(&request.conversation_id).bind(&request.generation_id)
        .bind(request.generation_seq).bind(&hash).execute(&mut *tx).await?;
    let payload = json!({"generationSeq":request.generation_seq,"renderedBodyHash":hash});
    sqlx::query(
        "INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,payload,run_id)
         SELECT $1::uuid,$2::uuid,COALESCE(max(generation_seq),0)+1,$3,'client_checkpoint',$4,$5::uuid
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid",
    ).bind(org).bind(&request.generation_id).bind(request.attempt_epoch).bind(&payload).bind(&hint.run_id)
        .execute(&mut *tx).await?;
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
        "runtime.native_chat.client_checkpoint",
        "chat_generation",
        &request.generation_id,
        Some(&payload),
    )
    .await?;
    auth::authorize_org(&mut tx, actor, org).await?;
    tx.commit().await?;
    Ok(receipt)
}
