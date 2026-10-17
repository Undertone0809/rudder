//! Narrow continuation of an already-owned execution after durable Stop intent.
//! It can observe late responses and dispatch one interrupt, never submit input.
use super::{
    CheckpointReceipt, CheckpointTransition, ExecutionFence, LeaseReceipt, Result,
    checkpoint::StoppingObservation, http,
};
use crate::native_chat::{NativeChatExecutionActor, auth, control::pin};
use rudder_codex_app_server::{
    CleanupReceipt, ConnectionReceipt, EffectResponseReceipt, OwnedTransport, RequestId,
    TransportError, TurnReceipt,
};
use rudder_hermes_acp::{HermesCleanupReceipt, HermesTurnReceipt};
use rudder_runtime_core::native_chat::NativeChatProtocolPhase;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::time::{Duration, Instant};

/// Opaque observation of one durable action bound to one in-process owner.
/// Re-reading this does not recreate interrupt authority.
#[derive(Clone)]
pub struct StopIntent {
    pub(super) action_id: String,
    fence: ExecutionFence,
}

pub async fn observe_stop(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
) -> Result<Option<StopIntent>> {
    let id = fence.identity();
    if actor.organization_id() != id.organization_id {
        return Err(http(403, "Organization access denied"));
    }
    let mut tx = pool.begin().await?;
    auth::preauthorize_execution_org(&mut tx, actor, fence).await?;
    crate::runtime_bindings::preauthorize_chat_execution_target_read_tx(
        &mut tx,
        actor,
        id.organization_id,
        id.conversation_id,
        id.agent_id,
        fence,
    )
    .await?;
    // This is only a hint. Every Stop operation re-locks the exact action and
    // every owner dimension before granting any authority.
    let actions: Vec<String> = sqlx::query_scalar(
        "SELECT a.id::text FROM chat_control_actions a
         JOIN chat_generations g ON g.org_id=a.org_id AND g.id=a.expected_generation_id
         WHERE a.org_id=$1::uuid AND a.expected_generation_id=$2::uuid
           AND g.conversation_id=$3::uuid AND g.status IN ('stop_requested','stopping')
           AND g.execution_authority='native_rust' AND g.control_state='stopping'
           AND a.action_kind='stop' AND a.last_error IS NULL
           AND a.local_disposition IN ('stop_requested','stopping')
         ORDER BY a.id LIMIT 2",
    )
    .bind(id.organization_id)
    .bind(id.generation_id)
    .bind(id.conversation_id)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    match actions.as_slice() {
        [] => Ok(None),
        [action] => {
            let stop = StopIntent {
                action_id: action.clone(),
                fence: fence.clone(),
            };
            let mut tx = pool.begin().await?;
            super::context::lock_stopping_execution(&mut tx, actor, fence, &stop).await?;
            auth::authorize_execution_org(&mut tx, actor, fence).await?;
            tx.commit().await?;
            Ok(Some(stop))
        }
        _ => Err(http(409, "Native Chat Stop action is ambiguous")),
    }
}

/// Durably bind an observed Stop action to the exact live OwnedTransport
/// connection. Epoch alone cannot distinguish two transports sharing an owner.
pub async fn bind_stopping_connection(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
    connection: &ConnectionReceipt,
) -> Result<()> {
    let id = fence.identity();
    if !connection.matches_connection_claim(
        id.run_id,
        id.attempt_id,
        fence.run_execution_owner_token(),
        id.connection_epoch,
        &fence.connection_claim_id,
    ) {
        return Err(http(
            409,
            "Stop connection does not match the execution fence",
        ));
    }
    let proof = pin::digest(
        "stop_connection_v1",
        &json!(connection.connection_receipt_id()),
    );
    let mut tx = pool.begin().await?;
    super::context::lock_stopping_execution(&mut tx, actor, fence, stop).await?;
    let mut evidence: Value = sqlx::query_scalar(
        "SELECT provider_evidence FROM chat_control_actions WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(id.organization_id)
    .bind(&stop.action_id)
    .fetch_one(&mut *tx)
    .await?;
    if evidence
        .get("stoppingConnectionProof")
        .is_some_and(|value| value.as_str() != Some(proof.as_str()))
        || evidence
            .get("stoppingConnectionEpoch")
            .is_some_and(|value| value.as_i64() != Some(i64::from(id.connection_epoch)))
        || evidence
            .get("stoppingObservations")
            .and_then(Value::as_array)
            .is_some_and(|chain| {
                chain
                    .iter()
                    .any(|entry| entry["connectionProof"].as_str() != Some(proof.as_str()))
            })
    {
        return Err(http(409, "Stop connection registration changed"));
    }
    evidence["stoppingConnectionProof"] = json!(proof);
    evidence["stoppingConnectionEpoch"] = json!(id.connection_epoch);
    if evidence.to_string().len() > 65536 {
        return Err(http(409, "Stop connection evidence exceeds bound"));
    }
    sqlx::query("UPDATE chat_control_actions SET provider_evidence=$3,updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(id.organization_id)
        .bind(&stop.action_id)
        .bind(evidence)
        .execute(&mut *tx)
        .await?;
    auth::authorize_execution_org(&mut tx, actor, fence).await?;
    tx.commit().await?;
    Ok(())
}

pub(super) async fn validate_action(
    tx: &mut auth::Tx<'_>,
    fence: &ExecutionFence,
    stop: &StopIntent,
) -> Result<()> {
    if &stop.fence != fence {
        return Err(http(409, "Native Chat Stop owner changed"));
    }
    let row = sqlx::query(
        "SELECT a.expected_attempt_epoch,a.expected_control_version,a.applied_control_version,
          a.control_owner_token,a.accepted_through_seq,a.frozen_body_hash,a.local_disposition,
          a.provider_disposition,a.last_error,a.action_kind,
          CASE WHEN octet_length(a.provider_evidence::text)<=65536 THEN a.provider_evidence END AS evidence,
          g.control_version,g.accepted_through_seq AS generation_cutoff,g.frozen_body_hash AS generation_hash
         FROM chat_control_actions a JOIN chat_generations g
           ON g.org_id=a.org_id AND g.id=a.expected_generation_id
         WHERE a.org_id=$1::uuid AND a.id=$2::uuid AND a.expected_generation_id=$3::uuid
         FOR UPDATE OF a",
    ).bind(&fence.organization_id).bind(&stop.action_id).bind(&fence.generation_id)
        .fetch_optional(&mut **tx).await?.ok_or_else(|| http(409,"Native Chat Stop action changed"))?;
    let expected: Option<i32> = row.try_get("expected_control_version")?;
    let applied: Option<i32> = row.try_get("applied_control_version")?;
    let cutoff: Option<i32> = row.try_get("accepted_through_seq")?;
    let hash: Option<String> = row.try_get("frozen_body_hash")?;
    if row.try_get::<String, _>("action_kind")? != "stop"
        || row.try_get::<Option<i32>, _>("expected_attempt_epoch")?
            != Some(fence.generation_attempt_epoch)
        || expected.and_then(|v| v.checked_add(1)) != applied
        || applied.is_none()
        || applied != Some(row.try_get("control_version")?)
        || row
            .try_get::<Option<String>, _>("control_owner_token")?
            .as_deref()
            != Some(fence.generation_owner_token.as_str())
        || !matches!(
            row.try_get::<String, _>("local_disposition")?.as_str(),
            "stop_requested" | "stopping"
        )
        || !matches!(
            row.try_get::<String, _>("provider_disposition")?.as_str(),
            "not_sent" | "unverified"
        )
        || row.try_get::<Option<String>, _>("last_error")?.is_some()
        || cutoff.is_none_or(|v| v < 0)
        || cutoff != row.try_get::<Option<i32>, _>("generation_cutoff")?
        || hash.as_ref().is_none_or(|v| v.len() != 64)
        || hash != row.try_get::<Option<String>, _>("generation_hash")?
    {
        return Err(http(409, "Native Chat Stop action fence is stale"));
    }
    let evidence: Value = row
        .try_get::<Option<Value>, _>("evidence")?
        .ok_or_else(|| http(409, "Native Chat Stop evidence exceeds bound"))?;
    if evidence["authority"] != "native_rust_control_v1" {
        return Err(http(409, "Native Chat Stop provenance is invalid"));
    }
    let pinned: pin::ExecutionPin = serde_json::from_value(evidence["executionPin"].clone())
        .map_err(|_| http(409, "Native Chat Stop execution pin is invalid"))?;
    let current =
        pin::capture(tx, &fence.organization_id, &fence.run_id, &fence.attempt_id).await?;
    let mut checkpoint_hash = pinned.checkpoint_hash.as_str();
    if let Some(chain) = evidence.get("stoppingObservations") {
        let chain = chain
            .as_array()
            .filter(|c| !c.is_empty() && c.len() <= 2)
            .ok_or_else(|| http(409, "Stop observation chain is invalid"))?;
        let mut prior_revision = None;
        for entry in chain {
            let previous = entry["previousRevision"].as_u64();
            let next = entry["nextRevision"].as_u64();
            if entry["previousHash"].as_str() != Some(checkpoint_hash)
                || previous.and_then(|r| r.checked_add(1)) != next
                || next.is_none()
                || prior_revision.is_some_and(|r| Some(r) != previous)
                || !matches!(entry["phase"].as_str(), Some("thread_known" | "turn_known"))
                || entry["responseProof"]
                    .as_str()
                    .is_none_or(|v| v.len() != 64)
                || entry["connectionProof"]
                    .as_str()
                    .is_none_or(|v| v.len() != 64)
            {
                return Err(http(409, "Stop observation chain is invalid"));
            }
            checkpoint_hash = entry["nextHash"]
                .as_str()
                .filter(|v| v.len() == 64)
                .ok_or_else(|| http(409, "Stop observation chain is invalid"))?;
            prior_revision = next;
        }
        if evidence["stoppingCheckpointHash"].as_str() != Some(checkpoint_hash) {
            return Err(http(409, "Stop checkpoint chain changed"));
        }
    } else if evidence.get("stoppingCheckpointHash").is_some() {
        return Err(http(409, "Stop checkpoint chain is missing"));
    }
    let connection_proof = evidence
        .get("stoppingConnectionProof")
        .and_then(Value::as_str);
    let connection_epoch = evidence
        .get("stoppingConnectionEpoch")
        .and_then(Value::as_i64);
    if connection_proof.is_some() != connection_epoch.is_some()
        || connection_proof.is_some_and(|proof| {
            proof.len() != 64
                || connection_epoch != Some(i64::from(fence.connection_epoch))
                || evidence["stoppingObservations"]
                    .as_array()
                    .is_some_and(|chain| {
                        chain
                            .iter()
                            .any(|entry| entry["connectionProof"].as_str() != Some(proof))
                    })
        })
    {
        return Err(http(409, "Stop connection registration is invalid"));
    }
    if !pinned.same_identity(&current) || current.checkpoint_hash != checkpoint_hash {
        return Err(http(409, "Native Chat Stop execution pin changed"));
    }
    Ok(())
}

pub(super) async fn record_checkpoint(
    tx: &mut auth::Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
    previous: &rudder_runtime_core::native_chat::NativeChatProtocolCheckpoint,
    next: &rudder_runtime_core::native_chat::NativeChatProtocolCheckpoint,
    observation: &StoppingObservation<'_>,
) -> Result<()> {
    if !observation.matches_claim(fence) {
        return Err(http(409, "Stop response belongs to another connection"));
    }
    let current =
        pin::capture(tx, &fence.organization_id, &fence.run_id, &fence.attempt_id).await?;
    let mut evidence: Value = sqlx::query_scalar(
        "SELECT provider_evidence FROM chat_control_actions WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&fence.organization_id)
    .bind(&stop.action_id)
    .fetch_one(&mut **tx)
    .await?;
    let before = evidence
        .get("stoppingCheckpointHash")
        .unwrap_or(&evidence["executionPin"]["checkpointHash"])
        .clone();
    let mut chain = evidence
        .get("stoppingObservations")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let list = chain
        .as_array_mut()
        .ok_or_else(|| http(409, "Stop observation chain is invalid"))?;
    if list.len() >= 2 {
        return Err(http(409, "Stop observation chain exceeds bound"));
    }
    list.push(json!({"previousHash":before,"nextHash":current.checkpoint_hash,
        "previousRevision":previous.revision(),"nextRevision":next.revision(),
        "phase":next.phase().as_str(),"responseProof":pin::digest("stop_response_v1",&json!(observation.correlation())),
        "connectionProof":pin::digest("stop_connection_v1",&json!(observation.connection_receipt_id()))}));
    evidence["stoppingObservations"] = chain;
    evidence["stoppingCheckpointHash"] = json!(current.checkpoint_hash);
    if evidence.to_string().len() > 65536 {
        return Err(http(409, "Stop observation evidence exceeds bound"));
    }
    sqlx::query("UPDATE chat_control_actions SET provider_evidence=$3,updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&fence.organization_id).bind(&stop.action_id).bind(evidence)
        .execute(&mut **tx).await?;
    auth::authorize_execution_org(tx, actor, fence).await?;
    Ok(())
}

/// A late successful response can only record its opaque locator. It cannot
/// prepare a new effect; terminal Stop observations use the finalizer receipt.
pub async fn advance_stopping_checkpoint(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
    phase: NativeChatProtocolPhase,
    revision: u64,
    observation: &EffectResponseReceipt,
) -> Result<CheckpointReceipt> {
    let identity = fence.identity();
    if !observation.matches_connection_claim(
        identity.run_id,
        identity.attempt_id,
        fence.run_execution_owner_token(),
        identity.connection_epoch,
        &fence.connection_claim_id,
    ) {
        return Err(http(409, "Stop response belongs to another execution"));
    }
    let transition = match observation.turn_id() {
        Some(turn) => CheckpointTransition::RecordTurn {
            thread_id: observation.thread_id().into(),
            turn_id: turn.into(),
        },
        None => CheckpointTransition::RecordThread {
            thread_id: observation.thread_id().into(),
        },
    };
    super::checkpoint::advance(
        pool,
        actor,
        fence,
        phase,
        revision,
        transition,
        Some((stop, StoppingObservation::Codex(observation))),
    )
    .await
}

/// Persist a late Hermes `session/new` receipt under an already requested
/// Stop. This records the exact ACP session selector without creating any
/// Codex Thread locator or permitting input submission.
pub async fn advance_stopping_hermes_session(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
    phase: NativeChatProtocolPhase,
    revision: u64,
    observation: &rudder_hermes_acp::HermesSessionStartReceipt,
) -> Result<CheckpointReceipt> {
    if !StoppingObservation::HermesSession(observation).matches_claim(fence) {
        return Err(http(
            409,
            "Hermes Stop response belongs to another execution",
        ));
    }
    super::checkpoint::advance(
        pool,
        actor,
        fence,
        phase,
        revision,
        CheckpointTransition::RecordHermesSession {
            session_id: observation.session().as_str().to_owned(),
        },
        Some((stop, StoppingObservation::HermesSession(observation))),
    )
    .await
}

/// Persist a late Hermes prompt receipt under an already requested Stop. The
/// next checkpoint is `TurnKnown`; Stop finalization owns the terminal write.
pub async fn advance_stopping_hermes_turn(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
    phase: NativeChatProtocolPhase,
    revision: u64,
    observation: &HermesTurnReceipt,
) -> Result<CheckpointReceipt> {
    if !StoppingObservation::HermesTurn(observation).matches_claim(fence) {
        return Err(http(
            409,
            "Hermes Stop response belongs to another execution",
        ));
    }
    super::checkpoint::advance(
        pool,
        actor,
        fence,
        phase,
        revision,
        CheckpointTransition::RecordHermesTurn,
        Some((stop, StoppingObservation::HermesTurn(observation))),
    )
    .await
}

pub async fn renew_stopping_lease(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
) -> Result<LeaseReceipt> {
    super::lease::renew(pool, actor, fence, Some(stop)).await
}

/// Move-only, bounded permission to enqueue one interrupt on the existing
/// connection. Ambiguous dispatch never returns it to the caller.
pub struct InterruptPermit {
    deadline: Instant,
    thread: String,
    turn: String,
    connection: String,
}
impl InterruptPermit {
    pub fn dispatch(
        self,
        transport: &mut OwnedTransport,
    ) -> Result<std::result::Result<RequestId, TransportError>> {
        if Instant::now() >= self.deadline || transport.connection_receipt_id() != self.connection {
            return Err(http(
                409,
                "Native Chat interrupt authorization expired or connection changed",
            ));
        }
        Ok(transport.request(
            "turn/interrupt",
            json!({"threadId":self.thread,"turnId":self.turn}),
        ))
    }
}

pub async fn reserve_interrupt(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
    response: &EffectResponseReceipt,
) -> Result<Option<InterruptPermit>> {
    let anchor = Instant::now();
    let mut tx = pool.begin().await?;
    let locked = super::context::lock_stopping_execution(&mut tx, actor, fence, stop).await?;
    if locked.checkpoint.phase() != NativeChatProtocolPhase::TurnKnown {
        return Err(http(
            409,
            "Native Chat interrupt requires an exact active Turn",
        ));
    }
    let thread = locked
        .checkpoint
        .thread_id()
        .ok_or_else(|| http(409, "Native Chat Thread unavailable"))?
        .to_owned();
    let turn = locked
        .checkpoint
        .turn_id()
        .ok_or_else(|| http(409, "Native Chat Turn unavailable"))?
        .to_owned();
    let identity = fence.identity();
    if !response.matches_connection_claim(
        identity.run_id,
        identity.attempt_id,
        fence.run_execution_owner_token(),
        identity.connection_epoch,
        &fence.connection_claim_id,
    ) || response.thread_id() != thread
        || response.turn_id() != Some(turn.as_str())
    {
        return Err(http(
            409,
            "Interrupt response does not match the exact Turn",
        ));
    }
    let connection = response.connection_receipt_id().to_owned();
    let remaining: i64 = sqlx::query_scalar(
        "SELECT floor(LEAST(extract(epoch FROM(g.control_lease_expires_at-clock_timestamp())),
          extract(epoch FROM(r.execution_lease_expires_at-clock_timestamp())))*1000)::bigint
         FROM chat_generations g JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND r.id=$3::uuid",
    ).bind(&fence.organization_id).bind(&fence.generation_id).bind(&fence.run_id).fetch_one(&mut *tx).await?;
    if remaining <= 0 {
        return Err(http(409, "Native Chat Stop lease expired"));
    }
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:interrupt',true)")
        .execute(&mut *tx)
        .await?;
    let updated=sqlx::query("UPDATE chat_control_actions SET provider_disposition='unverified',local_disposition='stopping',provider_evidence=jsonb_set(provider_evidence,'{interruptConnectionProof}',to_jsonb($3::text)),updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND provider_disposition='not_sent'")
        .bind(&fence.organization_id).bind(&stop.action_id).bind(pin::digest("stop_connection_v1",&json!(connection))).execute(&mut *tx).await?.rows_affected();
    if updated == 1 {
        let audit = crate::activity::ActivityActor {
            actor_type: if actor.actor().kind == "agent" {
                "agent"
            } else {
                "user"
            },
            actor_id: actor.actor().id.clone(),
            run_id: Some(fence.run_id.clone()),
        };
        crate::activity::write_activity(
            &mut tx,
            &fence.organization_id,
            &audit,
            "runtime.native_chat.interrupt_reserved",
            "chat_generation",
            &fence.generation_id,
            Some(&json!({"controlActionId":stop.action_id})),
        )
        .await?;
    }
    auth::authorize_execution_org(&mut tx, actor, fence).await?;
    tx.commit().await?;
    Ok((updated == 1).then(|| InterruptPermit {
        deadline: anchor + Duration::from_millis((remaining as u64).min(2000)),
        thread,
        turn,
        connection,
    }))
}

pub(super) async fn frozen_message(
    tx: &mut auth::Tx<'_>,
    fence: &ExecutionFence,
    _stop: &StopIntent,
) -> Result<Option<String>> {
    let hash: String = sqlx::query_scalar(
        "SELECT frozen_body_hash FROM chat_generations WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&fence.organization_id)
    .bind(&fence.generation_id)
    .fetch_one(&mut **tx)
    .await?;
    let rows=sqlx::query("SELECT id::text,status,CASE WHEN octet_length(body)<=524288 THEN body END AS body,(structured_payload IS NULL OR structured_payload IN ('null'::jsonb,'{}'::jsonb)) AS supported FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND run_id=$3::uuid AND role='assistant' ORDER BY id LIMIT 2 FOR UPDATE")
        .bind(&fence.organization_id).bind(&fence.conversation_id).bind(&fence.run_id).fetch_all(&mut **tx).await?;
    if rows.len() > 1 {
        return Err(http(409, "Frozen assistant projection is ambiguous"));
    }
    use sha2::{Digest, Sha256};
    if let Some(row) = rows.first() {
        let body: String = row
            .try_get::<Option<String>, _>("body")?
            .ok_or_else(|| http(409, "Frozen assistant exceeds bound"))?;
        if row.try_get::<String, _>("status")? != "stopped"
            || !row.try_get::<bool, _>("supported")?
            || format!("{:x}", Sha256::digest(body.as_bytes())) != hash
        {
            return Err(http(409, "Frozen assistant projection changed"));
        }
        Ok(Some(row.try_get("id")?))
    } else if format!("{:x}", Sha256::digest(b"")) == hash {
        Ok(None)
    } else {
        Err(http(409, "Frozen assistant projection is missing"))
    }
}

/// A pre-submission Stop has no accepted assistant output to preserve. Refuse
/// to cancel if the durable cutoff or frozen prefix contains any projection.
pub(super) async fn require_empty_frozen_prefix(
    tx: &mut auth::Tx<'_>,
    fence: &ExecutionFence,
    stop: &StopIntent,
) -> Result<()> {
    let id = fence.identity();
    let row = sqlx::query(
        "SELECT a.accepted_through_seq,a.frozen_body_hash,
                g.accepted_through_seq AS generation_cutoff,g.frozen_body_hash AS generation_hash,
                EXISTS(SELECT 1 FROM chat_messages m
                       WHERE m.org_id=a.org_id AND m.conversation_id=g.conversation_id
                         AND m.run_id=$4::uuid AND m.role='assistant') AS has_assistant_projection
         FROM chat_control_actions a JOIN chat_generations g
           ON g.org_id=a.org_id AND g.id=a.expected_generation_id
         WHERE a.org_id=$1::uuid AND a.id=$2::uuid AND a.expected_generation_id=$3::uuid",
    )
    .bind(id.organization_id)
    .bind(&stop.action_id)
    .bind(id.generation_id)
    .bind(id.run_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(409, "Native Chat Stop action is missing"))?;
    let expected_empty_hash = format!("{:x}", Sha256::digest(b""));
    if row.try_get::<Option<i32>, _>("accepted_through_seq")? != Some(0)
        || row.try_get::<Option<i32>, _>("generation_cutoff")? != Some(0)
        || row
            .try_get::<Option<String>, _>("frozen_body_hash")?
            .as_deref()
            != Some(expected_empty_hash.as_str())
        || row
            .try_get::<Option<String>, _>("generation_hash")?
            .as_deref()
            != Some(expected_empty_hash.as_str())
        || row.try_get::<bool, _>("has_assistant_projection")?
    {
        return Err(http(
            409,
            "Pre-submission Stop cannot finalize a nonempty frozen projection",
        ));
    }
    Ok(())
}

/// Resolve a Stop with a transport cleanup receipt when the current durable
/// phase proves no input effect permit was committed. The interrupt disposition
/// stays `not_sent`; this records input disposition, not provider completion.
pub(super) async fn resolve_action_pre_submission(
    tx: &mut auth::Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
    cleanup: &CleanupReceipt,
    result: &Value,
) -> Result<()> {
    if !cleanup.matches_connection_claim(
        &fence.run_id,
        &fence.attempt_id,
        fence.run_execution_owner_token(),
        fence.identity().connection_epoch,
        &fence.connection_claim_id,
    ) {
        return Err(http(
            409,
            "Stop cleanup receipt belongs to another execution",
        ));
    }
    let mut evidence: Value = sqlx::query_scalar(
        "SELECT provider_evidence FROM chat_control_actions WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&fence.organization_id)
    .bind(&stop.action_id)
    .fetch_one(&mut **tx)
    .await?;
    let interrupt_disposition: String = sqlx::query_scalar(
        "SELECT provider_disposition FROM chat_control_actions WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&fence.organization_id)
    .bind(&stop.action_id)
    .fetch_one(&mut **tx)
    .await?;
    if interrupt_disposition != "not_sent" || evidence.get("interruptConnectionProof").is_some() {
        return Err(http(
            409,
            "Stop interrupt evidence conflicts with no-input finalization",
        ));
    }
    let connection = pin::digest(
        "stop_connection_v1",
        &json!(cleanup.connection_receipt_id()),
    );
    if evidence["stoppingConnectionProof"].as_str() != Some(connection.as_str())
        || evidence["stoppingConnectionEpoch"].as_i64()
            != Some(i64::from(fence.identity().connection_epoch))
    {
        return Err(http(
            409,
            "Stop cleanup connection is not the registered owner",
        ));
    }
    if evidence.get("stoppingObservations").is_some_and(|value| {
        value.as_array().is_none_or(|chain| {
            chain.iter().any(|entry| {
                entry["phase"] != "thread_known"
                    || entry["connectionProof"].as_str() != Some(connection.as_str())
            })
        })
    }) {
        return Err(http(409, "Stop response connection conflicts with cleanup"));
    }
    evidence["stopResolution"] = json!({
        "result":result,
        "inputDisposition":"not_submitted",
        "connectionProof":connection,
    });
    sqlx::query("UPDATE chat_control_actions SET local_disposition='stopped',resolved_at=clock_timestamp(),updated_at=clock_timestamp(),provider_evidence=$3 WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&fence.organization_id)
        .bind(&stop.action_id)
        .bind(evidence)
        .execute(&mut **tx)
        .await?;
    auth::authorize_execution_org(tx, actor, fence).await?;
    Ok(())
}

pub(super) async fn resolve_action_hermes_pre_submission(
    tx: &mut auth::Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
    cleanup: &HermesCleanupReceipt,
    result: &Value,
) -> Result<()> {
    if !fence.matches_hermes_cleanup_receipt(cleanup) {
        return Err(http(
            409,
            "Stop cleanup receipt belongs to another execution",
        ));
    }
    let mut evidence: Value = sqlx::query_scalar(
        "SELECT provider_evidence FROM chat_control_actions WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&fence.organization_id)
    .bind(&stop.action_id)
    .fetch_one(&mut **tx)
    .await?;
    let interrupt_disposition: String = sqlx::query_scalar(
        "SELECT provider_disposition FROM chat_control_actions WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&fence.organization_id)
    .bind(&stop.action_id)
    .fetch_one(&mut **tx)
    .await?;
    if interrupt_disposition != "not_sent" || evidence.get("interruptConnectionProof").is_some() {
        return Err(http(
            409,
            "Stop interrupt evidence conflicts with no-input finalization",
        ));
    }
    let connection = pin::digest(
        "stop_connection_v1",
        &json!(cleanup.connection_receipt_id()),
    );
    if evidence["stoppingConnectionProof"].as_str() != Some(connection.as_str())
        || evidence["stoppingConnectionEpoch"].as_i64()
            != Some(i64::from(fence.identity().connection_epoch))
        || evidence.get("stoppingObservations").is_some_and(|value| {
            value.as_array().is_none_or(|chain| {
                chain.iter().any(|entry| {
                    entry["phase"] != "thread_known"
                        || entry["connectionProof"].as_str() != Some(connection.as_str())
                })
            })
        })
    {
        return Err(http(409, "Stop response connection conflicts with cleanup"));
    }
    evidence["stopResolution"] = json!({
        "result":result,
        "inputDisposition":"not_submitted",
        "connectionProof":connection,
    });
    sqlx::query("UPDATE chat_control_actions SET local_disposition='stopped',resolved_at=clock_timestamp(),updated_at=clock_timestamp(),provider_evidence=$3 WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&fence.organization_id).bind(&stop.action_id).bind(evidence).execute(&mut **tx).await?;
    auth::authorize_execution_org(tx, actor, fence).await?;
    Ok(())
}

pub(super) async fn resolve_action(
    tx: &mut auth::Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
    turn: &TurnReceipt,
    cleanup: &CleanupReceipt,
    result: &Value,
) -> Result<()> {
    // The action remains locked by lock_stopping_execution. Terminal row writes
    // above are reversible until this evidence and authorization check commits.
    let mut evidence: Value = sqlx::query_scalar(
        "SELECT provider_evidence FROM chat_control_actions WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&fence.organization_id)
    .bind(&stop.action_id)
    .fetch_one(&mut **tx)
    .await?;
    let connection = pin::digest(
        "stop_connection_v1",
        &json!(cleanup.connection_receipt_id()),
    );
    if evidence
        .get("interruptConnectionProof")
        .is_some_and(|v| v.as_str() != Some(connection.as_str()))
    {
        return Err(http(409, "Stop cleanup connection changed"));
    }
    if evidence["stoppingObservations"]
        .as_array()
        .is_some_and(|chain| {
            chain
                .iter()
                .any(|v| v["connectionProof"].as_str() != Some(connection.as_str()))
        })
    {
        return Err(http(409, "Stop late response connection changed"));
    }
    evidence["stopResolution"] = json!({"result":result,"actualProviderStatus":format!("{:?}",turn.status()),"connectionProof":connection});
    sqlx::query("UPDATE chat_control_actions SET local_disposition='stopped',resolved_at=clock_timestamp(),updated_at=clock_timestamp(),provider_evidence=$3 WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&fence.organization_id).bind(&stop.action_id).bind(evidence).execute(&mut **tx).await?;
    auth::authorize_execution_org(tx, actor, fence).await?;
    Ok(())
}

pub(super) async fn resolve_action_hermes(
    tx: &mut auth::Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &StopIntent,
    turn: &HermesTurnReceipt,
    cleanup: &HermesCleanupReceipt,
    result: &Value,
) -> Result<()> {
    if !fence.matches_hermes_cleanup_receipt(cleanup)
        || !turn.matches_connection_claim(
            &fence.run_id,
            &fence.attempt_id,
            fence.run_execution_owner_token(),
            fence.identity().connection_epoch,
            &fence.connection_claim_id,
        )
        || !cleanup.proves_quiescence_for(turn)
    {
        return Err(http(
            409,
            "Hermes Stop receipt belongs to another execution",
        ));
    }
    let mut evidence: Value = sqlx::query_scalar(
        "SELECT provider_evidence FROM chat_control_actions WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&fence.organization_id)
    .bind(&stop.action_id)
    .fetch_one(&mut **tx)
    .await?;
    let connection = pin::digest(
        "stop_connection_v1",
        &json!(cleanup.connection_receipt_id()),
    );
    if evidence
        .get("interruptConnectionProof")
        .is_some_and(|value| value.as_str() != Some(connection.as_str()))
        || evidence
            .get("stoppingObservations")
            .and_then(Value::as_array)
            .is_some_and(|chain| {
                chain
                    .iter()
                    .any(|entry| entry["connectionProof"].as_str() != Some(connection.as_str()))
            })
    {
        return Err(http(409, "Hermes Stop cleanup connection changed"));
    }
    evidence["stopResolution"] = json!({
        "result":result,
        "actualProviderStatus":match turn.stop_reason() {
            rudder_hermes_acp::HermesStopReason::EndTurn => "end_turn",
            rudder_hermes_acp::HermesStopReason::Cancelled => "cancelled",
            rudder_hermes_acp::HermesStopReason::Refusal => "refusal",
            rudder_hermes_acp::HermesStopReason::ApprovalRequired => "approval_required",
        },
        "connectionProof":connection,
    });
    sqlx::query("UPDATE chat_control_actions SET local_disposition='stopped',resolved_at=clock_timestamp(),updated_at=clock_timestamp(),provider_evidence=$3 WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&fence.organization_id).bind(&stop.action_id).bind(evidence).execute(&mut **tx).await?;
    auth::authorize_execution_org(tx, actor, fence).await?;
    Ok(())
}
