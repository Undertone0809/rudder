use super::*;
use serde_json::{Value, json};

const MAX_EVENT_BYTES: i32 = 64 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadEvents {
    pub conversation_id: String,
    pub generation_id: String,
    pub after_seq: i32,
    pub limit: i32,
    /// Bound for the serialized events array, excluding fixed page metadata.
    pub max_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub generation_seq: i32,
    pub attempt_epoch: i32,
    pub event_kind: String,
    pub assistant_message_id: Option<String>,
    pub control_action_id: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub generation_id: String,
    pub events: Vec<Event>,
    pub next_seq: i32,
    pub has_more: bool,
}

/// Read one authorized, repeatable snapshot. It never claims, renews, dispatches,
/// adopts, or checkpoints execution. No raw provider or owner payload is exposed.
pub async fn read_events(
    pool: &PgPool,
    actor: &VerifiedActor,
    request: &ReadEvents,
) -> Result<EventPage> {
    validate_ids(actor, &request.conversation_id, &request.generation_id)?;
    if request.after_seq < 0
        || !(1..=100).contains(&request.limit)
        || !(1024..=256 * 1024).contains(&request.max_bytes)
    {
        return Err(http(422, "Invalid Native Chat event page bounds"));
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    target(
        &mut tx,
        actor,
        &request.conversation_id,
        &request.generation_id,
    )
    .await?;
    // Never materialize an unbounded raw JSON value in the Rust process. The
    // extra row detects more pages; an oversized first event fails explicitly,
    // without silently advancing the cursor over missing content.
    let rows=sqlx::query(
        "SELECT generation_seq,attempt_epoch,event_kind,assistant_message_id::text,control_action_id::text,
          CASE WHEN octet_length(payload::text)<=$4 THEN payload END AS payload
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid AND generation_seq>$3
         ORDER BY generation_seq LIMIT $5",
    ).bind(actor.organization_id()).bind(&request.generation_id).bind(request.after_seq)
        .bind(MAX_EVENT_BYTES).bind(request.limit+1).fetch_all(&mut *tx).await?;
    let mut page = EventPage {
        generation_id: request.generation_id.clone(),
        events: Vec::new(),
        next_seq: request.after_seq,
        has_more: false,
    };
    let mut bytes = 2;
    for row in rows {
        if page.events.len() == request.limit as usize {
            page.has_more = true;
            break;
        }
        let raw: Option<Value> = row.try_get("payload")?;
        let Some(raw) = raw else {
            if page.events.is_empty() {
                return Err(http(
                    422,
                    "Native Chat event exceeds the supported read bound",
                ));
            }
            page.has_more = true;
            break;
        };
        let kind: String = row.try_get("event_kind")?;
        let event = Event {
            generation_seq: row.try_get("generation_seq")?,
            attempt_epoch: row.try_get("attempt_epoch")?,
            payload: public_payload(&kind, &raw)?,
            event_kind: kind,
            assistant_message_id: row.try_get("assistant_message_id")?,
            control_action_id: row.try_get("control_action_id")?,
        };
        let encoded =
            serde_json::to_vec(&event).map_err(|_| http(500, "Cannot encode Native Chat event"))?;
        let added = encoded.len() + usize::from(!page.events.is_empty());
        if bytes + added > request.max_bytes {
            if page.events.is_empty() {
                return Err(http(
                    422,
                    "Native Chat event does not fit the requested page",
                ));
            }
            page.has_more = true;
            break;
        }
        bytes += added;
        page.next_seq = event.generation_seq;
        page.events.push(event);
    }
    tx.commit().await?;
    Ok(page)
}

fn public_payload(kind: &str, raw: &Value) -> Result<Value> {
    let keys: &[&str] = match kind {
        "generation_started" => &[],
        "client_checkpoint" => &["generationSeq", "renderedBodyHash"],
        "stop_requested" => &[
            "requestedRenderSeq",
            "requestedBodyHash",
            "acceptedThroughSeq",
            "frozenBodyHash",
            "appliedControlVersion",
        ],
        "output_cutoff" => &["acceptedThroughSeq", "frozenBodyHash"],
        "assistant_delta" => &["delta", "bodyHash"],
        "runtime_output" => &["body", "bodyHash"],
        "runtime_terminal" | "terminal_projected" => &["status"],
        _ => return Err(http(409, "Native Chat event kind has no public projection")),
    };
    let mut payload = json!({});
    for key in keys {
        let value = raw.get(key).ok_or_else(|| {
            http(
                409,
                "Native Chat event projection is missing a required field",
            )
        })?;
        let valid = match *key {
            "generationSeq"
            | "requestedRenderSeq"
            | "acceptedThroughSeq"
            | "appliedControlVersion" => value
                .as_i64()
                .is_some_and(|v| (0..=i32::MAX as i64).contains(&v)),
            "renderedBodyHash" | "requestedBodyHash" | "frozenBodyHash" | "bodyHash" => {
                value.as_str().is_some_and(|v| normalize_hash(v).is_ok())
            }
            "status" => value
                .as_str()
                .is_some_and(|v| matches!(v, "succeeded" | "failed" | "cancelled")),
            "delta" | "body" => value.is_string(),
            _ => false,
        };
        if !valid {
            return Err(http(409, "Native Chat event projection is invalid"));
        }
        payload[*key] = value.clone();
    }
    if matches!(kind, "runtime_terminal" | "terminal_projected")
        && let Some(disposition) = raw.get("inputDisposition")
    {
        if disposition != "not_submitted" || payload["status"] != "cancelled" {
            return Err(http(
                409,
                "Native Chat terminal input disposition is invalid",
            ));
        }
        payload["inputDisposition"] = disposition.clone();
    }
    Ok(payload)
}
