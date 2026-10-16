use super::*;
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_PROJECTION_BYTES: usize = 512 * 1024;
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
) -> Result<Option<String>> {
    if seq == 0 {
        return Ok(Some(body_hash("")));
    }
    let hash: Option<String> = sqlx::query_scalar(
        "SELECT CASE WHEN jsonb_typeof(payload->'bodyHash')='string'
           AND length(payload->>'bodyHash')=64 THEN payload->>'bodyHash' END
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
           AND attempt_epoch=$3 AND generation_seq=$4",
    )
    .bind(org)
    .bind(generation)
    .bind(epoch)
    .bind(seq)
    .fetch_optional(&mut **tx)
    .await?
    .flatten();
    Ok(hash.and_then(|hash| normalize_hash(&hash).ok()))
}

/// A bounded text projection, including cutoff zero. No native transcript or
/// tool event writer exists yet; encountering one fails closed until its typed
/// projection is implemented. Never retain an unprojected structured payload.
pub(super) async fn freeze(
    tx: &mut auth::Tx<'_>,
    org: &str,
    request: &StopRequest,
    run: &str,
    cutoff: i32,
    expected_hash: &str,
) -> Result<()> {
    let (count, total_bytes): (i64, i64) = sqlx::query_as(
        "SELECT count(*),COALESCE(sum(octet_length(payload::text)),0)::bigint
         FROM (SELECT payload FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
           AND attempt_epoch=$3 AND generation_seq<=$4 ORDER BY generation_seq LIMIT 2049) AS bounded_events",
    )
    .bind(org)
    .bind(&request.generation_id)
    .bind(request.expected_attempt_epoch)
    .bind(cutoff)
    .fetch_one(&mut **tx)
    .await?;
    if count > MAX_PROJECTION_EVENTS || total_bytes > MAX_PROJECTION_BYTES as i64 {
        return Err(http(
            409,
            "Native Chat projection exceeds the control ledger bound",
        ));
    }
    let rows = sqlx::query(
        "SELECT event_kind, CASE WHEN octet_length(payload::text)<=$5 THEN payload END AS payload
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
           AND attempt_epoch=$3 AND generation_seq<=$4 ORDER BY generation_seq LIMIT $6",
    )
    .bind(org)
    .bind(&request.generation_id)
    .bind(request.expected_attempt_epoch)
    .bind(cutoff)
    .bind(MAX_PROJECTION_BYTES as i32)
    .bind(MAX_PROJECTION_EVENTS + 1)
    .fetch_all(&mut **tx)
    .await?;
    if rows.len() > MAX_PROJECTION_EVENTS as usize {
        return Err(http(
            409,
            "Native Chat projection exceeds the control ledger bound",
        ));
    }
    let mut body = String::new();
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
        "SELECT id::text, (structured_payload IS NULL OR structured_payload IN ('null'::jsonb,'{}'::jsonb)) AS supported_structure FROM chat_messages
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
    for message in messages {
        if !message.try_get::<bool, _>("supported_structure")? {
            return Err(http(
                409,
                "Native Chat structured projection is not supported by Stop yet",
            ));
        }
        let id: String = message.try_get("id")?;
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
