//! Persist visible output from the exact owned transport, before publishing it.
//! This changes neither provider-effect checkpoints nor terminal Run authority.
use super::{ExecutionFence, Result, context::lock_current_execution, http};
use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use crate::native_chat::NativeChatExecutionActor;
use rudder_codex_app_server::{VisibleOutputKind, VisibleOutputReceipt};
use rudder_runtime_core::native_chat::{NativeChatProtocolCheckpoint, NativeChatProtocolPhase};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_PAYLOAD_BYTES: i32 = 512 * 1024;
const SNAPSHOT_INTERVAL: u64 = 64;
// Bound durable event/audit growth even for empty or single-byte deltas.
// Unpersisted output is never published. The executor uses this same limit to
// distinguish a known pre-transaction rejection from an ambiguous DB failure.
pub const MAX_VISIBLE_OUTPUTS_PER_TURN: u64 = 4096;

mod failure;
pub(super) use failure::fail_existing_projection;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputCommit {
    pub generation_seq: i32,
    pub body_hash: String,
    pub assistant_message_id: String,
    pub replayed: bool,
}

// Provider locators are represented only by digests in the public event ledger.
// Raw Thread/Turn IDs remain in the private execution checkpoint.
// Never put a claim ID or either owner token into this projection.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    version: u8,
    organization_id: String,
    generation_id: String,
    run_id: String,
    attempt_id: String,
    generation_attempt_epoch: i32,
    run_attempt_epoch: i32,
    connection_id: String,
    connection_epoch: i32,
    claim_digest: String,
    assistant_message_id: String,
    receipt_text_digest: String,
    thread_digest: String,
    turn_digest: String,
    ordinal: u64,
    item_id: String,
    kind: String,
    fingerprint: String,
}

/// Retries of an observation on this connection are idempotent. A replacement
/// connection cannot append replayed deltas: it needs a separately authorized
/// recovery/snapshot operation, not this live-output writer.
pub async fn record_visible_output(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    observation: &VisibleOutputReceipt,
) -> Result<OutputCommit> {
    let id = fence.identity();
    if !observation.matches_connection_claim(
        id.run_id,
        id.attempt_id,
        fence.run_execution_owner_token(),
        id.connection_epoch,
        &fence.connection_claim_id,
    ) || observation.ordinal() == 0
        || observation.ordinal() > MAX_VISIBLE_OUTPUTS_PER_TURN
        || observation.text().len() > MAX_BODY_BYTES
    {
        return Err(http(409, "Native Chat output does not match its execution"));
    }
    let claim_digest = hash(&fence.connection_claim_id);
    let source_kind = match observation.kind() {
        VisibleOutputKind::Delta => "delta",
        VisibleOutputKind::Snapshot => "snapshot",
    };
    let mut source = Source {
        version: 2,
        organization_id: id.organization_id.to_owned(),
        generation_id: id.generation_id.to_owned(),
        run_id: id.run_id.to_owned(),
        attempt_id: id.attempt_id.to_owned(),
        generation_attempt_epoch: id.generation_attempt_epoch,
        run_attempt_epoch: id.run_attempt_epoch,
        connection_id: observation.connection_receipt_id().to_owned(),
        connection_epoch: id.connection_epoch,
        claim_digest: claim_digest.clone(),
        assistant_message_id: String::new(),
        receipt_text_digest: hash(observation.text()),
        thread_digest: hash(observation.thread_id()),
        turn_digest: hash(observation.turn_id()),
        ordinal: observation.ordinal(),
        item_id: observation.item_id().to_owned(),
        kind: source_kind.to_owned(),
        fingerprint: String::new(),
    };
    let mut tx = pool.begin().await?;
    let locked = lock_current_execution(&mut tx, actor, fence).await?;
    if !matches!(
        locked.checkpoint.phase(),
        NativeChatProtocolPhase::TurnKnown
    ) || locked.checkpoint.thread_id() != Some(observation.thread_id())
        || locked.checkpoint.turn_id() != Some(observation.turn_id())
    {
        return Err(http(409, "Native Chat output has no exact durable Turn"));
    }

    let duplicate = sqlx::query(
        "SELECT generation_seq,assistant_message_id::text,payload->>'bodyHash' AS body_hash,
          payload->'nativeSource'->>'fingerprint' AS fingerprint
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
          AND attempt_epoch=$3 AND run_id=$4::uuid
          AND payload->'nativeSource'->>'connectionId'=$5
          AND payload->'nativeSource'->>'ordinal'=$6
          AND payload->'nativeSource'->>'connectionEpoch'=$7
          AND payload->'nativeSource'->>'claimDigest'=$8
         ORDER BY generation_seq LIMIT 2",
    )
    .bind(id.organization_id)
    .bind(id.generation_id)
    .bind(id.generation_attempt_epoch)
    .bind(id.run_id)
    .bind(observation.connection_receipt_id())
    .bind(observation.ordinal().to_string())
    .bind(id.connection_epoch.to_string())
    .bind(&claim_digest)
    .fetch_all(&mut *tx)
    .await?;
    if !duplicate.is_empty() {
        if duplicate.len() != 1 {
            return Err(http(409, "Native Chat output identity conflicts"));
        }
        source.assistant_message_id = duplicate[0].try_get("assistant_message_id")?;
        source.fingerprint = output_fingerprint(&source);
        if duplicate[0].try_get::<String, _>("fingerprint")? != source.fingerprint {
            return Err(http(409, "Native Chat output identity conflicts"));
        }
        let receipt = OutputCommit {
            generation_seq: duplicate[0].try_get("generation_seq")?,
            body_hash: duplicate[0].try_get("body_hash")?,
            assistant_message_id: duplicate[0].try_get("assistant_message_id")?,
            replayed: true,
        };
        // A retry remains authorized and lease-bound even though it writes nothing.
        lock_current_execution(&mut tx, actor, fence).await?;
        tx.commit().await?;
        return Ok(receipt);
    }

    let previous = sqlx::query(
        "SELECT event_kind,
          CASE WHEN octet_length(payload::text)<=$5 THEN payload END AS payload,
          assistant_message_id::text
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
          AND attempt_epoch=$3 AND run_id=$4::uuid
          AND event_kind IN ('assistant_delta','runtime_output')
         ORDER BY generation_seq DESC LIMIT 1",
    )
    .bind(id.organization_id)
    .bind(id.generation_id)
    .bind(id.generation_attempt_epoch)
    .bind(id.run_id)
    .bind(MAX_PAYLOAD_BYTES)
    .fetch_optional(&mut *tx)
    .await?;
    let mut previous_message = None;
    let mut previous_hash = None;
    if let Some(previous) = previous {
        let payload = previous
            .try_get::<Option<Value>, _>("payload")?
            .ok_or_else(|| http(409, "Native Chat output exceeds its projection bound"))?;
        let source: Source = serde_json::from_value(payload["nativeSource"].clone())
            .map_err(|_| http(409, "Native Chat output source is not supported"))?;
        let previous_kind: String = previous.try_get("event_kind")?;
        let previous_snapshot = is_projection_snapshot(&source);
        let previous_text = match (previous_kind.as_str(), previous_snapshot) {
            ("runtime_output", true) => payload["body"].as_str(),
            ("assistant_delta", false) => payload["delta"].as_str(),
            _ => None,
        };
        let previous_projection_text = previous_text
            .ok_or_else(|| http(409, "Native Chat previous output event is invalid"))?;
        let previous_message_id: Option<String> = previous.try_get("assistant_message_id")?;
        if source.version != 2
            || source.organization_id != id.organization_id
            || source.generation_id != id.generation_id
            || source.run_id != id.run_id
            || source.attempt_id != id.attempt_id
            || source.generation_attempt_epoch != id.generation_attempt_epoch
            || source.run_attempt_epoch != id.run_attempt_epoch
            || source.connection_id != observation.connection_receipt_id()
            || source.connection_epoch != id.connection_epoch
            || source.claim_digest != claim_digest
            || source.thread_digest != hash(observation.thread_id())
            || source.turn_digest != hash(observation.turn_id())
            || source.item_id != observation.item_id()
            || previous_message_id.as_deref() != Some(source.assistant_message_id.as_str())
            || source.ordinal.checked_add(1) != Some(observation.ordinal())
            || output_fingerprint(&source) != source.fingerprint
            || (!previous_snapshot || source.kind == "snapshot")
                && hash(previous_projection_text) != source.receipt_text_digest
        {
            return Err(http(
                409,
                "Native Chat output sequence requires reconciliation",
            ));
        }
        previous_message = previous_message_id;
        previous_hash = payload["bodyHash"].as_str().map(str::to_owned);
    } else if observation.ordinal() != 1 {
        return Err(http(
            409,
            "Native Chat output starts after an observation gap",
        ));
    }

    let messages = sqlx::query(
        "SELECT id::text, status,kind,
          CASE WHEN octet_length(body)<=$4 THEN body END AS body,
          (structured_payload IS NULL OR structured_payload IN ('null'::jsonb,'{}'::jsonb)) AS plain
         FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid
          AND run_id=$3::uuid AND role='assistant' AND superseded_at IS NULL ORDER BY id LIMIT 2 FOR UPDATE",
    )
    .bind(id.organization_id)
    .bind(id.conversation_id)
    .bind(id.run_id)
    .bind(MAX_BODY_BYTES as i32)
    .fetch_all(&mut *tx)
    .await?;
    if messages.len() > 1 {
        return Err(http(409, "Native Chat assistant projection is ambiguous"));
    }
    let (message_id, old_body) = match messages.first() {
        Some(message) => {
            let message_id: String = message.try_get("id")?;
            let body: String = message
                .try_get::<Option<String>, _>("body")?
                .ok_or_else(|| http(409, "Native Chat assistant projection exceeds its bound"))?;
            if previous_message.as_deref() != Some(message_id.as_str())
                || previous_hash.as_deref() != Some(hash(&body).as_str())
                || message.try_get::<String, _>("status")? != "streaming"
                || message.try_get::<String, _>("kind")? != "message"
                || !message.try_get::<bool, _>("plain")?
            {
                return Err(http(409, "Native Chat assistant projection changed"));
            }
            (Some(message_id), body)
        }
        None if previous_message.is_none() && previous_hash.is_none() => (None, String::new()),
        None => return Err(http(409, "Native Chat assistant projection is missing")),
    };
    let body = match observation.kind() {
        VisibleOutputKind::Delta => {
            if old_body.len().saturating_add(observation.text().len()) > MAX_BODY_BYTES {
                return Err(http(409, "Native Chat answer exceeds its projection bound"));
            }
            let mut body = old_body.clone();
            body.push_str(observation.text());
            body
        }
        VisibleOutputKind::Snapshot => observation.text().to_owned(),
    };
    let body_hash = hash(&body);
    // Periodic authoritative text checkpoints keep Stop reconstruction bounded
    // without imposing a total-lifetime notification count on long turns.
    let snapshot = is_projection_snapshot(&source);
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:execution',true)")
        .execute(&mut *tx)
        .await?;
    let message_id = match message_id {
        Some(message) => {
            sqlx::query("UPDATE chat_messages SET body=$4,updated_at=clock_timestamp() WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND id=$3::uuid")
                .bind(id.organization_id).bind(id.conversation_id).bind(&message).bind(&body)
                .execute(&mut *tx).await?;
            message
        }
        None => sqlx::query_scalar::<_, String>(
            "INSERT INTO chat_messages (org_id,conversation_id,role,kind,status,body,run_id,
             replying_agent_id,chat_turn_id,turn_variant)
             SELECT $1::uuid,$2::uuid,'assistant','message','streaming',$4,$3::uuid,$5::uuid,m.chat_turn_id,m.turn_variant
             FROM chat_generations g JOIN chat_messages m ON m.org_id=g.org_id AND m.id=g.source_message_id
             WHERE g.org_id=$1::uuid AND g.id=$6::uuid AND g.conversation_id=$2::uuid RETURNING id::text",
        ).bind(id.organization_id).bind(id.conversation_id).bind(id.run_id).bind(&body)
            .bind(id.agent_id).bind(id.generation_id).fetch_one(&mut *tx).await?,
    };
    source.assistant_message_id = message_id.clone();
    source.fingerprint = output_fingerprint(&source);
    let mut payload = if snapshot {
        json!({"body":body,"bodyHash":body_hash})
    } else {
        json!({"delta":observation.text(),"bodyHash":body_hash})
    };
    payload["nativeSource"] = serde_json::to_value(source)
        .map_err(|_| http(500, "Cannot encode Native Chat output source"))?;
    if payload.to_string().len() > MAX_PAYLOAD_BYTES as usize {
        return Err(http(409, "Native Chat output event exceeds its bound"));
    }
    let generation_seq = sqlx::query_scalar::<_, i32>(
        "INSERT INTO chat_generation_events (org_id,generation_id,generation_seq,attempt_epoch,
         event_kind,payload,body_offset,body_length,assistant_message_id,run_id)
         SELECT $1::uuid,$2::uuid,COALESCE(max(generation_seq),0)+1,$3,$4,$5,$6,$7,$8::uuid,$9::uuid
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid RETURNING generation_seq",
    ).bind(id.organization_id).bind(id.generation_id).bind(id.generation_attempt_epoch)
        .bind(if snapshot { "runtime_output" } else { "assistant_delta" }).bind(&payload)
        .bind(if snapshot { 0 } else { old_body.encode_utf16().count() as i32 })
        .bind(if snapshot { body.encode_utf16().count() as i32 } else { observation.text().encode_utf16().count() as i32 }).bind(&message_id).bind(id.run_id)
        .fetch_one(&mut *tx).await?;
    let details = json!({"generationId":id.generation_id,"generationSeq":generation_seq,
        "assistantMessageId":message_id,"bodyHash":body_hash});
    let audit = ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: Some(id.run_id.to_owned()),
    };
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: id.organization_id,
            audit: &audit,
            action: "runtime.native_chat.output_recorded",
            entity_type: "heartbeat_run",
            entity_id: id.run_id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: Some(id.agent_id),
                bind_run: true,
                ..Default::default()
            },
        },
    )
    .await?;
    // Includes late lease/authorization failure after an event or audit wait.
    lock_current_execution(&mut tx, actor, fence).await?;
    tx.commit().await?;
    Ok(OutputCommit {
        generation_seq,
        body_hash,
        assistant_message_id: message_id,
        replayed: false,
    })
}

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn output_fingerprint(source: &Source) -> String {
    hash(
        &json!({
            "organizationId": &source.organization_id,
            "generationId": &source.generation_id,
            "runId": &source.run_id,
            "attemptId": &source.attempt_id,
            "generationAttemptEpoch": source.generation_attempt_epoch,
            "runAttemptEpoch": source.run_attempt_epoch,
            "connectionId": &source.connection_id,
            "connectionEpoch": source.connection_epoch,
            "claimDigest": &source.claim_digest,
            "assistantMessageId": &source.assistant_message_id,
            "receiptTextDigest": &source.receipt_text_digest,
            "threadDigest": &source.thread_digest,
            "turnDigest": &source.turn_digest,
            "itemId": &source.item_id,
            "ordinal": source.ordinal,
            "kind": &source.kind,
        })
        .to_string(),
    )
}

fn is_projection_snapshot(source: &Source) -> bool {
    source.kind == "snapshot" || source.ordinal.is_multiple_of(SNAPSHOT_INTERVAL)
}

/// Check the already materialized streaming row at normal terminalization.
/// The caller owns the same target/Generation/Run locks as the output writer.
/// A terminal receipt alone cannot authenticate an independently created row.
pub(super) async fn validate_final_projection(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    fence: &ExecutionFence,
    cleanup: &rudder_codex_app_server::CleanupReceipt,
    message_id: &str,
    body: &str,
) -> Result<()> {
    validate_projection(
        tx,
        fence,
        cleanup,
        message_id,
        body,
        NativeChatProtocolPhase::ProviderTerminalObserved,
    )
    .await
}

async fn validate_projection(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    fence: &ExecutionFence,
    cleanup: &rudder_codex_app_server::CleanupReceipt,
    message_id: &str,
    body: &str,
    expected_phase: NativeChatProtocolPhase,
) -> Result<()> {
    let id = fence.identity();
    if body.len() > MAX_BODY_BYTES {
        return Err(http(
            409,
            "Native Chat terminal projection exceeds its bound",
        ));
    }
    let checkpoint_row = sqlx::query(
        "SELECT a.protocol_phase,a.checkpoint_json,a.attempt_epoch,
                a.generation_attempt_epoch,a.connection_epoch
         FROM heartbeat_run_attempts a
         JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
         WHERE a.org_id=$1::uuid AND a.run_id=$2::uuid AND a.id=$3::uuid
           AND r.chat_conversation_id=$4::uuid AND r.chat_generation_id=$5::uuid",
    )
    .bind(id.organization_id)
    .bind(id.run_id)
    .bind(id.attempt_id)
    .bind(id.conversation_id)
    .bind(id.generation_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(409, "Native Chat terminal checkpoint is missing"))?;
    let checkpoint_phase: String = checkpoint_row.try_get("protocol_phase")?;
    let checkpoint_json: Value = checkpoint_row.try_get("checkpoint_json")?;
    let run_attempt_epoch: i32 = checkpoint_row.try_get("attempt_epoch")?;
    let generation_attempt_epoch: i32 = checkpoint_row.try_get("generation_attempt_epoch")?;
    let connection_epoch: i32 = checkpoint_row.try_get("connection_epoch")?;
    let checkpoint: NativeChatProtocolCheckpoint = serde_json::from_value(checkpoint_json)
        .map_err(|_| http(409, "Native Chat terminal checkpoint is invalid"))?;
    checkpoint
        .validate()
        .map_err(|_| http(409, "Native Chat terminal checkpoint is invalid"))?;
    if checkpoint_phase != expected_phase.as_str()
        || checkpoint.phase() != expected_phase
        || run_attempt_epoch != id.run_attempt_epoch
        || generation_attempt_epoch != id.generation_attempt_epoch
        || connection_epoch != id.connection_epoch
        || checkpoint.thread_id().is_none()
        || checkpoint.turn_id().is_none()
    {
        return Err(http(
            409,
            "Native Chat terminal checkpoint differs from its execution",
        ));
    }

    let summary = sqlx::query(
        "SELECT count(*)::bigint AS output_count,
                min(generation_seq) AS first_seq,
                max(generation_seq) AS latest_seq,
                max(generation_seq) FILTER (WHERE event_kind='runtime_output') AS snapshot_seq
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
           AND attempt_epoch=$3 AND run_id=$4::uuid
           AND event_kind IN ('assistant_delta','runtime_output')",
    )
    .bind(id.organization_id)
    .bind(id.generation_id)
    .bind(id.generation_attempt_epoch)
    .bind(id.run_id)
    .fetch_one(&mut **tx)
    .await?;
    let output_count: i64 = summary.try_get("output_count")?;
    let latest_seq: Option<i32> = summary.try_get("latest_seq")?;
    let first_seq: Option<i32> = summary.try_get("first_seq")?;
    let snapshot_seq: Option<i32> = summary.try_get("snapshot_seq")?;
    if output_count <= 0 || output_count > MAX_VISIBLE_OUTPUTS_PER_TURN as i64 {
        return Err(http(409, "Native Chat terminal output count is invalid"));
    }
    if snapshot_seq.is_none() && output_count >= SNAPSHOT_INTERVAL as i64 {
        return Err(http(
            409,
            "Native Chat output history is missing its bounded snapshot",
        ));
    }
    let lower_seq = snapshot_seq.or(first_seq).ok_or_else(|| {
        http(
            409,
            "Native Chat terminal projection has no output provenance",
        )
    })?;
    let ordinal_at_checkpoint: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM chat_generation_events
         WHERE org_id=$1::uuid AND generation_id=$2::uuid AND attempt_epoch=$3
           AND run_id=$4::uuid AND generation_seq <= $5
           AND event_kind IN ('assistant_delta','runtime_output')",
    )
    .bind(id.organization_id)
    .bind(id.generation_id)
    .bind(id.generation_attempt_epoch)
    .bind(id.run_id)
    .bind(lower_seq)
    .fetch_one(&mut **tx)
    .await?;
    let events = sqlx::query(
        "SELECT generation_seq,event_kind,assistant_message_id::text,body_offset,body_length,
                CASE WHEN octet_length(payload::text)<=$5 THEN payload END AS payload
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
           AND attempt_epoch=$3 AND run_id=$4::uuid
           AND generation_seq >= $6 AND event_kind IN ('assistant_delta','runtime_output')
         ORDER BY generation_seq LIMIT 65",
    )
    .bind(id.organization_id)
    .bind(id.generation_id)
    .bind(id.generation_attempt_epoch)
    .bind(id.run_id)
    .bind(MAX_PAYLOAD_BYTES)
    .bind(lower_seq)
    .fetch_all(&mut **tx)
    .await?;
    if events.is_empty() || events.len() > 64 {
        return Err(http(
            409,
            "Native Chat output history exceeds its reconstruction bound",
        ));
    }
    let latest_event_seq: i32 = events
        .last()
        .ok_or_else(|| http(409, "Native Chat terminal output history is empty"))?
        .try_get("generation_seq")?;
    if Some(latest_event_seq) != latest_seq {
        return Err(http(
            409,
            "Native Chat terminal output history is incomplete",
        ));
    }
    let mut read_bytes = 0usize;
    let max_read_bytes = MAX_PAYLOAD_BYTES as usize * 64;
    let mut reconstructed: Option<String> = None;
    let mut previous_ordinal = None;
    let mut latest_source = None;
    for (index, event) in events.iter().enumerate() {
        let payload: Value = event
            .try_get::<Option<Value>, _>("payload")?
            .ok_or_else(|| http(409, "Native Chat output event exceeds its bound"))?;
        read_bytes = read_bytes.saturating_add(payload.to_string().len());
        if read_bytes > max_read_bytes {
            return Err(http(
                409,
                "Native Chat output reconstruction exceeds its bound",
            ));
        }
        let event_kind: String = event.try_get("event_kind")?;
        let source: Source = serde_json::from_value(payload["nativeSource"].clone())
            .map_err(|_| http(409, "Native Chat terminal output provenance is invalid"))?;
        validate_source(
            &source,
            id,
            cleanup.connection_receipt_id(),
            &fence.connection_claim_id,
            checkpoint.thread_id().expect("checkpoint validated"),
            checkpoint.turn_id().expect("checkpoint validated"),
            message_id,
        )?;
        if source.fingerprint.len() != 64
            || !source.fingerprint.bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err(http(409, "Native Chat output fingerprint is invalid"));
        }
        let is_snapshot = is_projection_snapshot(&source);
        let text = match (event_kind.as_str(), is_snapshot) {
            ("runtime_output", true) => payload["body"].as_str(),
            ("assistant_delta", false) => payload["delta"].as_str(),
            _ => None,
        };
        let text = text.ok_or_else(|| http(409, "Native Chat output event kind is invalid"))?;
        if text.len() > MAX_BODY_BYTES
            || output_fingerprint(&source) != source.fingerprint
            || (!is_snapshot || source.kind == "snapshot")
                && hash(text) != source.receipt_text_digest
            || event
                .try_get::<Option<String>, _>("assistant_message_id")?
                .as_deref()
                != Some(message_id)
        {
            return Err(http(
                409,
                "Native Chat output event differs from its provenance",
            ));
        }
        if previous_ordinal
            .is_some_and(|ordinal: u64| ordinal.checked_add(1) != Some(source.ordinal))
            || (index == 0 && snapshot_seq.is_none() && source.ordinal != 1)
            || (index == 0 && snapshot_seq.is_some() && !is_snapshot)
            || (index == 0 && source.ordinal != ordinal_at_checkpoint as u64)
        {
            return Err(http(409, "Native Chat output ordinals are not contiguous"));
        }
        let body = if is_snapshot {
            if index != 0 || reconstructed.is_some() {
                return Err(http(
                    409,
                    "Native Chat output reconstruction contains an unexpected snapshot",
                ));
            }
            if event.try_get::<i32, _>("body_offset")? != 0
                || event.try_get::<i32, _>("body_length")? != text.encode_utf16().count() as i32
            {
                return Err(http(409, "Native Chat snapshot offsets are invalid"));
            }
            text.to_owned()
        } else {
            let current = reconstructed.get_or_insert_with(String::new);
            if event.try_get::<i32, _>("body_offset")? != current.encode_utf16().count() as i32
                || event.try_get::<i32, _>("body_length")? != text.encode_utf16().count() as i32
                || current.len().saturating_add(text.len()) > MAX_BODY_BYTES
            {
                return Err(http(409, "Native Chat delta offsets are invalid"));
            }
            current.push_str(text);
            current.clone()
        };
        if payload["bodyHash"].as_str() != Some(hash(&body).as_str()) {
            return Err(http(409, "Native Chat output body hash is invalid"));
        }
        reconstructed = Some(body);
        previous_ordinal = Some(source.ordinal);
        latest_source = Some(source);
    }
    let reconstructed = reconstructed.ok_or_else(|| {
        http(
            409,
            "Native Chat terminal projection has no reconstructable output",
        )
    })?;
    let source = latest_source.expect("nonempty events checked");
    if reconstructed != body || source.ordinal != output_count as u64 {
        return Err(http(
            409,
            "Native Chat terminal text differs from its output history",
        ));
    }

    Ok(())
}

fn validate_source(
    source: &Source,
    id: super::ExecutionIdentity<'_>,
    connection_id: &str,
    connection_claim_id: &str,
    thread_id: &str,
    turn_id: &str,
    message_id: &str,
) -> Result<()> {
    if source.version != 2
        || source.organization_id != id.organization_id
        || source.generation_id != id.generation_id
        || source.run_id != id.run_id
        || source.attempt_id != id.attempt_id
        || source.generation_attempt_epoch != id.generation_attempt_epoch
        || source.run_attempt_epoch != id.run_attempt_epoch
        || source.connection_id != connection_id
        || source.connection_epoch != id.connection_epoch
        || source.claim_digest != hash(connection_claim_id)
        || source.assistant_message_id != message_id
        || source.receipt_text_digest.len() != 64
        || !source
            .receipt_text_digest
            .bytes()
            .all(|c| c.is_ascii_hexdigit())
        || source.thread_digest != hash(thread_id)
        || source.turn_digest != hash(turn_id)
        || source.item_id.is_empty()
        || !matches!(source.kind.as_str(), "delta" | "snapshot")
        || source.ordinal == 0
        || source.ordinal > MAX_VISIBLE_OUTPUTS_PER_TURN
    {
        return Err(http(409, "Native Chat terminal output provenance is stale"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(ordinal: u64, receipt_text: &str) -> Source {
        Source {
            version: 2,
            organization_id: "org".into(),
            generation_id: "generation".into(),
            run_id: "run".into(),
            attempt_id: "attempt".into(),
            generation_attempt_epoch: 1,
            run_attempt_epoch: 1,
            connection_id: "connection".into(),
            connection_epoch: 1,
            claim_digest: "claim-digest".into(),
            assistant_message_id: "assistant-message".into(),
            receipt_text_digest: hash(receipt_text),
            thread_digest: hash("thread"),
            turn_digest: hash("turn"),
            ordinal,
            item_id: "answer".into(),
            kind: "delta".into(),
            fingerprint: String::new(),
        }
    }

    #[test]
    fn output_provenance_accepts_the_last_ordinal_and_rejects_the_next() {
        let id = super::super::ExecutionIdentity {
            organization_id: "org",
            conversation_id: "chat",
            generation_id: "generation",
            run_id: "run",
            attempt_id: "attempt",
            agent_id: "agent",
            generation_attempt_epoch: 1,
            run_attempt_epoch: 1,
            connection_epoch: 1,
        };
        let mut receipt = source(MAX_VISIBLE_OUTPUTS_PER_TURN, "prefix");
        receipt.claim_digest = hash("claim");
        assert!(
            validate_source(
                &receipt,
                id,
                "connection",
                "claim",
                "thread",
                "turn",
                "assistant-message",
            )
            .is_ok()
        );
        for ordinal in [0, MAX_VISIBLE_OUTPUTS_PER_TURN + 1, u64::MAX] {
            receipt.ordinal = ordinal;
            assert!(
                validate_source(
                    &receipt,
                    id,
                    "connection",
                    "claim",
                    "thread",
                    "turn",
                    "assistant-message",
                )
                .is_err()
            );
        }
    }

    #[test]
    fn periodic_snapshot_replay_and_following_delta_keep_receipt_identity() {
        let mut ordinal_64 = source(64, "the original 64th delta");
        ordinal_64.fingerprint = output_fingerprint(&ordinal_64);
        let duplicate_64 = ordinal_64.clone();
        assert_eq!(
            output_fingerprint(&duplicate_64),
            ordinal_64.fingerprint,
            "replaying the same checkpoint receipt retains its idempotency fingerprint"
        );
        assert_ne!(
            ordinal_64.receipt_text_digest,
            hash("the cumulative answer through ordinal 64"),
            "the periodic snapshot body is not mistaken for the original delta text"
        );

        let mut ordinal_65 = source(65, "the 65th delta");
        ordinal_65.fingerprint = output_fingerprint(&ordinal_65);
        assert_ne!(ordinal_64.fingerprint, ordinal_65.fingerprint);
    }
}
