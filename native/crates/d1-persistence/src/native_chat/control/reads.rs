use super::*;
use serde_json::{Value, json};

const MAX_EVENT_BYTES: i32 = 512 * 1024;

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
    actor: &impl NativeChatActor,
    request: &ReadEvents,
) -> Result<EventPage> {
    validate_ids(actor, &request.conversation_id, &request.generation_id)?;
    if request.after_seq < 0
        || !(1..=100).contains(&request.limit)
        || !(1024..=1024 * 1024).contains(&request.max_bytes)
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
    let execution_target = target(
        &mut tx,
        actor,
        &request.conversation_id,
        &request.generation_id,
    )
    .await?;
    // Bound raw payload materialization across the page, before decoding JSON.
    // Include at most one event beyond the byte budget; a NULL sentinel keeps
    // pagination honest without transferring the remaining large payloads.
    let rows = sqlx::query(
        "WITH bounded AS MATERIALIZED (
           SELECT e.generation_seq,e.attempt_epoch,e.event_kind,e.assistant_message_id,e.control_action_id,
             e.payload,octet_length(e.payload::text)::bigint AS payload_bytes
           FROM chat_generation_events e
           JOIN chat_generations g ON g.org_id=e.org_id AND g.id=e.generation_id
           WHERE e.org_id=$1::uuid AND e.generation_id=$2::uuid AND e.generation_seq>$3
             AND (e.event_kind<>'transcript' OR g.accepted_through_seq IS NULL
                  OR e.generation_seq<=g.accepted_through_seq)
           ORDER BY e.generation_seq LIMIT $5
         ), sized AS (
           SELECT *,COALESCE(SUM(payload_bytes) OVER (
             ORDER BY generation_seq ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)
             AS prior_bytes FROM bounded
         )
         SELECT generation_seq,attempt_epoch,event_kind,assistant_message_id::text,control_action_id::text,
           CASE WHEN payload_bytes<=$4 AND prior_bytes<$6 THEN payload END AS payload
         FROM sized ORDER BY generation_seq",
    ).bind(actor.organization_id()).bind(&request.generation_id).bind(request.after_seq)
        .bind(MAX_EVENT_BYTES).bind(request.limit+1).bind(request.max_bytes as i64)
        .fetch_all(&mut *tx).await?;
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
        let generation_seq: i32 = row.try_get("generation_seq")?;
        let attempt_epoch: i32 = row.try_get("attempt_epoch")?;
        let assistant_message_id: Option<String> = row.try_get("assistant_message_id")?;
        let event = Event {
            generation_seq,
            attempt_epoch,
            payload: public_payload(
                &kind,
                &raw,
                actor.organization_id(),
                &request.generation_id,
                &execution_target.run_id,
                attempt_epoch,
                assistant_message_id.as_deref(),
            )?,
            event_kind: kind,
            assistant_message_id,
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
    // Recheck wall-clock expiry after building a bounded response. No credential
    // row locks are taken in this repeatable-read, read-only transaction.
    auth::preauthorize_org(&mut tx, actor, actor.organization_id()).await?;
    tx.commit().await?;
    Ok(page)
}

fn public_payload(
    kind: &str,
    raw: &Value,
    org: &str,
    generation: &str,
    run: &str,
    attempt_epoch: i32,
    assistant_message_id: Option<&str>,
) -> Result<Value> {
    if kind == "transcript" {
        let assistant_message_id = assistant_message_id
            .ok_or_else(|| http(409, "Hermes progress has no assistant projection"))?;
        let projection = super::super::execution::hermes_progress::validate_public_projection(
            raw,
            org,
            generation,
            run,
            attempt_epoch,
            assistant_message_id,
        )
        .ok_or_else(|| http(409, "Hermes progress provenance is invalid"))?;
        return Ok(json!({
            "entry": projection.entry,
            "bodyHash": projection.body_hash,
        }));
    }
    if kind == "control_lost" {
        if raw["generationStatus"] != "interrupted_unverified"
            || raw["controlState"] != "control_lost"
            || raw["cleanupState"] != "unknown"
        {
            return Err(http(409, "Native Chat owner-loss projection is invalid"));
        }
        return Ok(json!({
            "generationStatus": "interrupted_unverified",
            "controlState": "control_lost",
            "cleanupState": "unknown",
        }));
    }
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
        "dispatch_unavailable" => &["code"],
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
            "code" => value.as_str() == Some("dispatch_unavailable"),
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

#[cfg(test)]
mod tests {
    use super::public_payload;
    use serde_json::json;

    #[test]
    fn control_lost_public_projection_is_bounded_and_truthful() {
        let payload = public_payload(
            "control_lost",
            &json!({
                "generationStatus": "interrupted_unverified",
                "controlState": "control_lost",
                "cleanupState": "unknown",
                "ownerToken": "never expose",
                "processExited": false,
            }),
            "org",
            "generation",
            "run",
            1,
            None,
        )
        .expect("known owner-loss state is safe to project");

        assert_eq!(
            payload,
            json!({
                "generationStatus": "interrupted_unverified",
                "controlState": "control_lost",
                "cleanupState": "unknown",
            })
        );
    }

    #[test]
    fn control_lost_public_projection_rejects_inconsistent_state() {
        for payload in [
            json!({
                "generationStatus": "stopped",
                "controlState": "control_lost",
                "cleanupState": "unknown",
            }),
            json!({
                "generationStatus": "interrupted_unverified",
                "controlState": "terminal",
                "cleanupState": "unknown",
            }),
            json!({
                "generationStatus": "interrupted_unverified",
                "controlState": "control_lost",
                "cleanupState": "verified",
            }),
        ] {
            assert!(
                public_payload(
                    "control_lost",
                    &payload,
                    "org",
                    "generation",
                    "run",
                    1,
                    None
                )
                .is_err()
            );
        }
    }
}
