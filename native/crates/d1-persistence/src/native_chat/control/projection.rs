use super::*;
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_PROJECTION_BYTES: usize = 512 * 1024;
const MAX_HISTORY_BYTES: usize = 2 * 1024 * 1024;
const MAX_PROJECTION_EVENTS: i64 = 2048;

pub(super) fn body_hash(body: &str) -> String {
    format!("{:x}", Sha256::digest(body.as_bytes()))
}

pub(super) async fn hash_at(
    tx: &mut auth::Tx<'_>,
    org: &str,
    generation: &str,
    epoch: i32,
    seq: i32,
    run: &str,
) -> Result<Option<String>> {
    if seq == 0 {
        return Ok(Some(body_hash("")));
    }
    let row = sqlx::query(
        "SELECT event_kind,payload,assistant_message_id::text
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
           AND attempt_epoch=$3 AND generation_seq=$4 AND run_id=$5::uuid
           AND ((event_kind='assistant_delta' AND jsonb_typeof(payload->'delta')='string')
             OR (event_kind='runtime_output' AND jsonb_typeof(payload->'body')='string')
             OR event_kind='transcript')",
    )
    .bind(org)
    .bind(generation)
    .bind(epoch)
    .bind(seq)
    .bind(run)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let kind: String = row.try_get("event_kind")?;
    let payload: Value = row.try_get("payload")?;
    if kind == "transcript" {
        let assistant_message_id: Option<String> = row.try_get("assistant_message_id")?;
        let Some(assistant_message_id) = assistant_message_id else {
            return Ok(None);
        };
        let Some(projection) = super::super::execution::hermes_progress::validate_public_projection(
            &payload,
            org,
            generation,
            run,
            epoch,
            &assistant_message_id,
        ) else {
            return Ok(None);
        };
        return Ok(Some(projection.body_hash));
    }
    let hash = payload.get("bodyHash").and_then(Value::as_str);
    Ok(hash.and_then(|hash| normalize_hash(hash).ok()))
}

/// A bounded text projection plus validated Hermes transcript entries, including
/// cutoff zero. Generic or unsupported transcript payloads fail closed.
pub(super) async fn freeze(
    tx: &mut auth::Tx<'_>,
    org: &str,
    request: &StopRequest,
    run: &str,
    cutoff: i32,
    expected_hash: &str,
) -> Result<()> {
    // Text snapshots replace the preceding body. Start from the most recent
    // one at or before this exact rendered cutoff; old output remains readable
    // but does not make a long-running turn impossible to stop.
    let floor: i32 = sqlx::query_scalar(
        "SELECT COALESCE(max(generation_seq),0) FROM chat_generation_events
         WHERE org_id=$1::uuid AND generation_id=$2::uuid AND attempt_epoch=$3
           AND generation_seq<=$4 AND event_kind='runtime_output' AND run_id=$5::uuid",
    )
    .bind(org)
    .bind(&request.generation_id)
    .bind(request.expected_attempt_epoch)
    .bind(cutoff)
    .bind(run)
    .fetch_one(&mut **tx)
    .await?;
    let (count, total_bytes): (i64, i64) = sqlx::query_as(
        "SELECT count(*),COALESCE(sum(octet_length(payload::text)),0)::bigint
         FROM (SELECT payload FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
           AND attempt_epoch=$3 AND generation_seq<=$4 AND generation_seq>=$5 AND run_id=$6::uuid ORDER BY generation_seq LIMIT 2049) AS bounded_events",
    )
    .bind(org)
    .bind(&request.generation_id)
    .bind(request.expected_attempt_epoch)
    .bind(cutoff)
    .bind(floor)
    .bind(run)
    .fetch_one(&mut **tx)
    .await?;
    if count > MAX_PROJECTION_EVENTS || total_bytes > MAX_HISTORY_BYTES as i64 {
        return Err(http(
            409,
            "Native Chat projection exceeds the control ledger bound",
        ));
    }
    let rows = sqlx::query(
        "SELECT event_kind, assistant_message_id::text, CASE WHEN octet_length(payload::text)<=$5 THEN payload END AS payload
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
           AND attempt_epoch=$3 AND generation_seq<=$4 AND generation_seq>=$7 AND run_id=$8::uuid ORDER BY generation_seq LIMIT $6",
    )
    .bind(org)
    .bind(&request.generation_id)
    .bind(request.expected_attempt_epoch)
    .bind(cutoff)
    .bind(MAX_PROJECTION_BYTES as i32)
    .bind(MAX_PROJECTION_EVENTS + 1)
    .bind(floor)
    .bind(run)
    .fetch_all(&mut **tx)
    .await?;
    if rows.len() > MAX_PROJECTION_EVENTS as usize {
        return Err(http(
            409,
            "Native Chat projection exceeds the control ledger bound",
        ));
    }
    let mut body = String::new();
    let mut projected_message_id: Option<String> = None;
    let mut last_hermes_ordinal = 0u64;
    for row in rows {
        let kind: String = row.try_get("event_kind")?;
        let payload: Value = row.try_get::<Option<Value>, _>("payload")?.ok_or_else(|| {
            http(
                409,
                "Native Chat projection exceeds the control ledger bound",
            )
        })?;
        match kind.as_str() {
            "assistant_delta" | "runtime_output" => {
                let message_id: String = row
                    .try_get::<Option<String>, _>("assistant_message_id")?
                    .ok_or_else(|| http(409, "Native text event has no assistant projection"))?;
                if projected_message_id
                    .as_ref()
                    .is_some_and(|id| id != &message_id)
                {
                    return Err(http(
                        409,
                        "Native text events refer to different assistant projections",
                    ));
                }
                projected_message_id = Some(message_id);
                let text = payload
                    .get(if kind == "assistant_delta" {
                        "delta"
                    } else {
                        "body"
                    })
                    .and_then(Value::as_str)
                    .ok_or_else(|| http(409, "Invalid native text projection"))?;
                if kind == "runtime_output" {
                    body.clear();
                }
                if body.len().saturating_add(text.len()) > MAX_PROJECTION_BYTES {
                    return Err(http(
                        409,
                        "Native Chat projection exceeds the control ledger bound",
                    ));
                }
                body.push_str(text);
            }
            "transcript" => {
                let message_id: String = row
                    .try_get::<Option<String>, _>("assistant_message_id")?
                    .ok_or_else(|| http(409, "Hermes transcript has no assistant projection"))?;
                let projection =
                    super::super::execution::hermes_progress::validate_public_projection(
                        &payload,
                        org,
                        &request.generation_id,
                        run,
                        request.expected_attempt_epoch,
                        &message_id,
                    )
                    .ok_or_else(|| http(409, "Hermes transcript provenance is invalid"))?;
                if projection.ordinal != last_hermes_ordinal + 1 {
                    return Err(http(409, "Hermes transcript sequence is not contiguous"));
                }
                last_hermes_ordinal = projection.ordinal;
                if projected_message_id
                    .as_ref()
                    .is_some_and(|id| id != &message_id)
                {
                    return Err(http(409, "Hermes transcript changed assistant projection"));
                }
                projected_message_id = Some(message_id);
                if projection.body_hash != body_hash(&body) {
                    return Err(http(409, "Hermes transcript changed the assistant body"));
                }
            }
            "generation_started" | "client_checkpoint" | "stop_requested" | "output_cutoff" => {}
            _ => {
                return Err(http(
                    409,
                    "Native Chat event requires a supported visible projection",
                ));
            }
        }
    }
    if body_hash(&body) != expected_hash {
        return Err(http(
            409,
            "Rendered checkpoint does not match the durable projection",
        ));
    }
    let messages = sqlx::query(
        "SELECT id::text, kind, status, (structured_payload IS NULL OR structured_payload IN ('null'::jsonb,'{}'::jsonb)) AS supported_structure FROM chat_messages
         WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND run_id=$3::uuid
           AND role='assistant' FOR UPDATE",
    )
    .bind(org)
    .bind(&request.conversation_id)
    .bind(run)
    .fetch_all(&mut **tx)
    .await?;
    if messages.len() > 1 {
        return Err(http(409, "Native Chat assistant projection is ambiguous"));
    }
    if messages.is_empty() && projected_message_id.is_some() {
        return Err(http(409, "Native Chat assistant projection is missing"));
    }
    // Even cutoff zero must freeze only the assistant row proven by this Run's
    // visible-output ledger. Later output proves identity, never cutoff text.
    let output_messages: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT DISTINCT assistant_message_id::text FROM chat_generation_events
         WHERE org_id=$1::uuid AND generation_id=$2::uuid AND attempt_epoch=$3
           AND run_id=$4::uuid AND event_kind IN ('assistant_delta','runtime_output','transcript') LIMIT 2",
    )
    .bind(org)
    .bind(&request.generation_id)
    .bind(request.expected_attempt_epoch)
    .bind(run)
    .fetch_all(&mut **tx)
    .await?;
    let ledger_message = match output_messages.as_slice() {
        [] if messages.is_empty() => None,
        [Some(id)] => Some(id.as_str()),
        _ => {
            return Err(http(
                409,
                "Native Chat output has no unique assistant provenance",
            ));
        }
    };
    if messages.is_empty() && ledger_message.is_some() {
        return Err(http(409, "Native Chat assistant projection is missing"));
    }
    for message in messages {
        if !message.try_get::<bool, _>("supported_structure")? {
            return Err(http(
                409,
                "Native Chat structured projection is not supported by Stop yet",
            ));
        }
        let id: String = message.try_get("id")?;
        if ledger_message != Some(id.as_str())
            || message.try_get::<String, _>("kind")? != "message"
            || message.try_get::<String, _>("status")? != "streaming"
            || projected_message_id
                .as_ref()
                .is_some_and(|projected| projected != &id)
        {
            return Err(http(409, "Native Chat assistant projection changed"));
        }
        sqlx::query(
            "UPDATE chat_messages SET body=$4,status='stopped',updated_at=clock_timestamp()
            WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND id=$3::uuid",
        )
        .bind(org)
        .bind(&request.conversation_id)
        .bind(id)
        .bind(&body)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}
