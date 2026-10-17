use rudder_auth_core::VerifiedActor;
use serde_json::Value;
use sqlx::{PgPool, Row};

use crate::runtime_bindings;

use super::projection::span_and_segment;
use super::validation::{Result, canonical_uuid, http};

const MAX_TRANSCRIPT_LIMIT: i32 = 100;

pub(super) async fn read(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    raw_span_id: &str,
) -> Result<Value> {
    let span_id = canonical_uuid(raw_span_id, "span id")?;
    let mut tx = pool.begin().await?;
    let row = sqlx::query(
        "SELECT s.id::text AS span_id, s.binding_id::text AS binding_id,
                s.segment_id::text AS segment_id, b.agent_id::text AS agent_id,
                b.conversation_id::text AS conversation_id, b.target_type, b.target_id,
                b.principal_scope_ref
         FROM run_runtime_spans s
         JOIN runtime_bindings b ON b.org_id=s.org_id AND b.id=s.binding_id
         WHERE s.org_id=$1::uuid AND s.id=$2::uuid",
    )
    .bind(organization_id)
    .bind(&span_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Run span not found"))?;

    let binding_id: String = row.try_get("binding_id")?;
    let segment_id: String = row.try_get("segment_id")?;
    let agent_id: String = row.try_get("agent_id")?;
    let target_type: Option<String> = row.try_get("target_type")?;
    let target_id: String = row.try_get("target_id")?;
    let conversation_id: Option<String> = row.try_get("conversation_id")?;
    let binding_scope: String = row.try_get("principal_scope_ref")?;
    if target_type.as_deref() != Some("chat_conversation")
        || conversation_id.as_deref() != Some(target_id.as_str())
    {
        return Err(http(404, "Run span not found"));
    }

    let principal_scope_ref = runtime_bindings::authorize_chat_target_read_tx(
        &mut tx,
        actor,
        organization_id,
        &target_id,
        &agent_id,
    )
    .await?;
    if binding_scope != principal_scope_ref {
        return Err(http(404, "Run span not found"));
    }
    let result =
        span_and_segment(&mut tx, organization_id, &span_id, &binding_id, &segment_id).await?;
    tx.commit().await?;
    Ok(result)
}

/// Read the bounded native event projection for one authorized Run span.
/// Cursors are generation sequence numbers and are scoped by the span's
/// immutable Run/Attempt identity; no provider call or legacy transcript read
/// is performed here.
pub(super) async fn read_transcript(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &super::Request,
) -> Result<Value> {
    let super::Request::ReadTranscript {
        span_id: raw_span_id,
        after_seq,
        limit,
    } = request
    else {
        return Err(http(400, "Expected a Run transcript read request"));
    };
    if *after_seq < 0 {
        return Err(http(400, "Invalid transcript cursor"));
    }
    let limit = (*limit).clamp(1, MAX_TRANSCRIPT_LIMIT);
    let span_id = canonical_uuid(raw_span_id, "span id")?;
    let mut tx = pool.begin().await?;
    let row = sqlx::query(
        "SELECT s.binding_id::text AS binding_id, s.segment_id::text AS segment_id,
                s.state, s.completeness, s.source_revision,
                r.chat_generation_id::text AS generation_id,
                b.agent_id::text AS agent_id, b.conversation_id::text AS conversation_id,
                b.target_type, b.target_id, b.principal_scope_ref
         FROM run_runtime_spans s
         JOIN runtime_bindings b ON b.org_id=s.org_id AND b.id=s.binding_id
         JOIN heartbeat_runs r ON r.org_id=s.org_id AND r.id=s.run_id
         WHERE s.org_id=$1::uuid AND s.id=$2::uuid",
    )
    .bind(organization_id)
    .bind(&span_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Run span not found"))?;
    let binding_id: String = row.try_get("binding_id")?;
    let segment_id: String = row.try_get("segment_id")?;
    let generation_id: Option<String> = row.try_get("generation_id")?;
    let agent_id: String = row.try_get("agent_id")?;
    let target_type: Option<String> = row.try_get("target_type")?;
    let target_id: String = row.try_get("target_id")?;
    let conversation_id: Option<String> = row.try_get("conversation_id")?;
    let binding_scope: String = row.try_get("principal_scope_ref")?;
    if target_type.as_deref() != Some("chat_conversation")
        || conversation_id.as_deref() != Some(target_id.as_str())
        || generation_id.is_none()
    {
        return Err(http(404, "Run span not found"));
    }
    let principal_scope_ref = runtime_bindings::authorize_chat_target_read_tx(
        &mut tx,
        actor,
        organization_id,
        &target_id,
        &agent_id,
    )
    .await?;
    if binding_scope != principal_scope_ref {
        return Err(http(404, "Run span not found"));
    }
    let generation_id = generation_id.expect("checked above");
    let events = sqlx::query(
        "SELECT generation_seq, event_kind, payload, recorded_at::text AS recorded_at
         FROM chat_generation_events
         WHERE org_id=$1::uuid AND generation_id=$2::uuid
           AND generation_seq>$3 AND event_kind IN ('assistant_delta','runtime_output')
         ORDER BY generation_seq ASC LIMIT $4",
    )
    .bind(organization_id)
    .bind(&generation_id)
    .bind(*after_seq)
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await?;
    let has_more = events.len() > limit as usize;
    let visible = events.into_iter().take(limit as usize);
    let mut items = Vec::new();
    let mut revision = *after_seq;
    for event in visible {
        let seq: i32 = event.try_get("generation_seq")?;
        revision = seq;
        let kind: String = event.try_get("event_kind")?;
        let payload: Value = event.try_get("payload")?;
        let recorded_at: String = event.try_get("recorded_at")?;
        items.push(serde_json::json!({
            "seq": seq,
            "kind": kind,
            "payload": payload,
            "recordedAt": recorded_at,
        }));
    }
    let span =
        span_and_segment(&mut tx, organization_id, &span_id, &binding_id, &segment_id).await?;
    tx.commit().await?;
    Ok(serde_json::json!({
        "spanId": span_id,
        "source": "native_event_ledger",
        "revision": revision,
        "availability": if row.try_get::<String, _>("state")? == "sealed" { "complete" } else { "partial" },
        "completeness": row.try_get::<Option<String>, _>("completeness")?,
        "nextCursor": has_more.then(|| revision.to_string()),
        "items": items,
        "span": span,
    }))
}
