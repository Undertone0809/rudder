use std::collections::HashMap;

use rudder_auth_core::VerifiedActor;
use serde_json::Value;
use sqlx::{PgPool, Row};

use crate::runtime_bindings;

use super::projection::span_and_segment;
use super::validation::{Result, canonical_uuid, http};

const MAX_TRANSCRIPT_LIMIT: i32 = 100;
const MAX_MESSAGE_LIMIT: i32 = 200;

fn transcript_from_payload(payload: &Value) -> Vec<Value> {
    payload
        .get("__chatTranscript")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn transcript_summary(entries: &[Value]) -> Value {
    if entries.is_empty() {
        return Value::Null;
    }
    let mut started_at: Option<String> = None;
    let mut ended_at: Option<String> = None;
    for entry in entries {
        let Some(ts) = entry.get("ts").and_then(Value::as_str) else {
            continue;
        };
        if started_at.as_deref().is_none_or(|value| ts < value) {
            started_at = Some(ts.to_owned());
        }
        if ended_at.as_deref().is_none_or(|value| ts > value) {
            ended_at = Some(ts.to_owned());
        }
    }
    serde_json::json!({
        "entryCount": entries.len(),
        "startedAt": started_at,
        "endedAt": ended_at,
    })
}

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
         FROM chat_generation_events e
         JOIN chat_generations g ON g.org_id=e.org_id AND g.id=e.generation_id
         WHERE e.org_id=$1::uuid AND e.generation_id=$2::uuid
           AND e.generation_seq>$3 AND e.event_kind IN ('assistant_delta','runtime_output')
           AND (g.accepted_through_seq IS NULL OR e.generation_seq <= g.accepted_through_seq)
        ORDER BY e.generation_seq ASC LIMIT $4",
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

/// Resolve a user-visible assistant message to its exact Native Run span and
/// return the same bounded ledger projection used by the internal span reader.
/// The message lookup is only an index into the native Run; authorization and
/// event ownership are still checked from the binding and target rows below.
pub(super) async fn read_message_transcript(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &super::Request,
) -> Result<Value> {
    let super::Request::ReadMessageTranscript {
        conversation_id: raw_conversation_id,
        message_id: raw_message_id,
        after_seq,
        limit,
    } = request
    else {
        return Err(http(400, "Expected a message transcript read request"));
    };
    if *after_seq < 0 {
        return Err(http(400, "Invalid transcript cursor"));
    }
    let limit = (*limit).clamp(1, MAX_TRANSCRIPT_LIMIT);
    let conversation_id = canonical_uuid(raw_conversation_id, "conversation id")?;
    let message_id = canonical_uuid(raw_message_id, "message id")?;
    let mut tx = pool.begin().await?;
    let native_row = sqlx::query(
        "SELECT m.id::text AS message_id, m.conversation_id::text AS conversation_id,
                r.chat_generation_id::text AS generation_id,
                s.id::text AS span_id, s.binding_id::text AS binding_id,
                s.segment_id::text AS segment_id, s.state, s.completeness,
                b.agent_id::text AS agent_id, b.target_type, b.target_id,
                b.principal_scope_ref
         FROM chat_messages m
         JOIN heartbeat_runs r ON r.org_id=m.org_id AND r.id=m.run_id
           AND r.execution_authority='native_rust'
         JOIN run_runtime_spans s ON s.org_id=r.org_id AND s.run_id=r.id
           AND s.relation='primary'
         JOIN runtime_bindings b ON b.org_id=s.org_id AND b.id=s.binding_id
         WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid
           AND m.id=$3::uuid AND m.role='assistant'",
    )
    .bind(organization_id)
    .bind(&conversation_id)
    .bind(&message_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = native_row else {
        // Legacy/detached Side Chat messages remain readable during the
        // migration. This path is read-only, organization-scoped, and uses
        // the same target authorization as the native ledger path; it never
        // becomes a second writer or a provider authority.
        let message = sqlx::query(
            "SELECT m.id::text AS message_id, m.structured_payload,
                    COALESCE(c.preferred_agent_id, c.routed_agent_id)::text AS agent_id,
                    c.conversation_kind
             FROM chat_messages m
             JOIN chat_conversations c ON c.org_id=m.org_id AND c.id=m.conversation_id
             WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid
               AND m.id=$3::uuid AND m.role='assistant'",
        )
        .bind(organization_id)
        .bind(&conversation_id)
        .bind(&message_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| http(404, "Chat message not found"))?;
        let conversation_kind: String = message.try_get("conversation_kind")?;
        if conversation_kind != "side_chat" {
            return Err(http(404, "Native transcript message not found"));
        }
        let agent_id: Option<String> = message.try_get("agent_id")?;
        if let Some(agent_id) = agent_id.as_deref() {
            runtime_bindings::authorize_chat_target_read_tx(
                &mut tx,
                actor,
                organization_id,
                &conversation_id,
                agent_id,
            )
            .await?;
        } else {
            runtime_bindings::authorize_chat_target_read_without_agent_tx(
                &mut tx,
                actor,
                organization_id,
                &conversation_id,
            )
            .await?;
        }
        let detached = sqlx::query(
            "SELECT entry_seq, payload
             FROM chat_message_transcript_entries
             WHERE org_id=$1::uuid AND message_id=$2::uuid AND entry_seq>$3
             ORDER BY entry_seq ASC LIMIT $4",
        )
        .bind(organization_id)
        .bind(&message_id)
        .bind(*after_seq)
        .bind(limit + 1)
        .fetch_all(&mut *tx)
        .await?;
        let has_more = detached.len() > limit as usize;
        let visible = detached.into_iter().take(limit as usize);
        let mut transcript = Vec::new();
        let mut revision = *after_seq;
        for entry in visible {
            revision = entry.try_get("entry_seq")?;
            transcript.push(entry.try_get("payload")?);
        }
        if transcript.is_empty() && *after_seq == 0 {
            let payload: Option<Value> = message.try_get("structured_payload")?;
            transcript = payload
                .as_ref()
                .map(transcript_from_payload)
                .unwrap_or_default();
        }
        tx.commit().await?;
        return Ok(serde_json::json!({
            "messageId": message_id.clone(),
            "messageRef": message_id,
            "transcript": transcript,
            "reader": {
                "source": "legacy_compatibility",
                "revision": revision,
                "availability": "complete",
                "nextCursor": has_more.then_some(revision.to_string()),
            },
        }));
    };
    let message_id: String = row.try_get("message_id")?;
    let conversation_id: String = row.try_get("conversation_id")?;
    let generation_id: String = row.try_get("generation_id")?;
    let span_id: String = row.try_get("span_id")?;
    let binding_id: String = row.try_get("binding_id")?;
    let segment_id: String = row.try_get("segment_id")?;
    let agent_id: String = row.try_get("agent_id")?;
    let target_type: Option<String> = row.try_get("target_type")?;
    let target_id: String = row.try_get("target_id")?;
    let binding_scope: String = row.try_get("principal_scope_ref")?;
    if target_type.as_deref() != Some("chat_conversation") || target_id != conversation_id {
        return Err(http(404, "Native transcript message not found"));
    }
    let principal_scope_ref = runtime_bindings::authorize_chat_target_read_tx(
        &mut tx,
        actor,
        organization_id,
        &conversation_id,
        &agent_id,
    )
    .await?;
    if binding_scope != principal_scope_ref {
        return Err(http(404, "Native transcript message not found"));
    }
    let events = sqlx::query(
        "SELECT generation_seq, event_kind, payload, recorded_at::text AS recorded_at
         FROM chat_generation_events e
         JOIN chat_generations g ON g.org_id=e.org_id AND g.id=e.generation_id
         WHERE e.org_id=$1::uuid AND e.generation_id=$2::uuid
           AND e.generation_seq>$3
           AND e.event_kind IN ('assistant_delta','runtime_output','transcript')
           AND (g.accepted_through_seq IS NULL OR e.generation_seq <= g.accepted_through_seq)
           ORDER BY e.generation_seq ASC LIMIT $4",
    )
    .bind(organization_id)
    .bind(&generation_id)
    .bind(*after_seq)
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await?;
    let has_more = events.len() > limit as usize;
    let visible = events.into_iter().take(limit as usize);
    let mut transcript = Vec::new();
    let mut revision = *after_seq;
    for event in visible {
        let seq: i32 = event.try_get("generation_seq")?;
        revision = seq;
        let kind: String = event.try_get("event_kind")?;
        let payload: Value = event.try_get("payload")?;
        let recorded_at: String = event.try_get("recorded_at")?;
        if kind == "transcript" {
            let Some(mut entry) = payload.get("entry").cloned() else {
                continue;
            };
            if let Value::Object(object) = &mut entry {
                object.insert(
                    "generationId".to_owned(),
                    Value::String(generation_id.clone()),
                );
                object.insert("generationSeqStart".to_owned(), Value::from(seq));
                object.insert("generationSeqEnd".to_owned(), Value::from(seq));
            }
            transcript.push(entry);
            continue;
        }
        let text = match kind.as_str() {
            "assistant_delta" => payload.get("delta").and_then(Value::as_str),
            "runtime_output" => payload.get("body").and_then(Value::as_str),
            _ => None,
        };
        let Some(text) = text else { continue };
        transcript.push(serde_json::json!({
            "kind": "assistant",
            "ts": recorded_at,
            "text": text,
            "delta": kind == "assistant_delta",
            "phase": if kind == "runtime_output" { "final_answer" } else { "commentary" },
            "generationId": generation_id.clone(),
            "generationSeqStart": seq,
            "generationSeqEnd": seq,
        }));
    }
    let span =
        span_and_segment(&mut tx, organization_id, &span_id, &binding_id, &segment_id).await?;
    let availability = if row.try_get::<String, _>("state")? == "sealed" {
        "complete"
    } else {
        "partial"
    };
    let completeness: Option<String> = row.try_get("completeness")?;
    tx.commit().await?;
    Ok(serde_json::json!({
        "messageId": message_id.clone(),
        "messageRef": message_id,
        "transcript": transcript,
        "reader": {
            "source": "native_event_ledger",
            "spanId": span_id,
            "revision": revision,
            "availability": availability,
            "completeness": completeness,
            "nextCursor": has_more.then(|| revision.to_string()),
        },
        "span": span,
    }))
}

/// Read the bounded user-visible message projection for a Native Chat
/// conversation. This is deliberately separate from the legacy TypeScript
/// transcript hydrator. Structured payloads, approvals, and attachments are
/// projected from the same authorized snapshot as the message rows, while
/// provider locators remain outside the Reader contract. Detailed transcript
/// ranges remain available through `read_message_transcript`.
pub(super) async fn read_conversation_messages(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &super::Request,
) -> Result<Value> {
    let super::Request::ReadConversationMessages {
        conversation_id: raw_conversation_id,
        limit,
        cursor,
        include_transcript,
    } = request
    else {
        return Err(http(400, "Expected a conversation message read request"));
    };
    let cursor = cursor
        .as_deref()
        .map(|raw| canonical_uuid(raw, "message cursor"))
        .transpose()?;
    let conversation_id = canonical_uuid(raw_conversation_id, "conversation id")?;
    let limit = (*limit).clamp(1, MAX_MESSAGE_LIMIT);
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await?;

    let target = sqlx::query(
        "SELECT COALESCE(preferred_agent_id, routed_agent_id)::text AS agent_id,
                conversation_kind
         FROM chat_conversations
         WHERE org_id=$1::uuid AND id=$2::uuid
           AND conversation_kind IN ('chat', 'side_chat')",
    )
    .bind(organization_id)
    .bind(&conversation_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Chat conversation not found"))?;
    let agent_id: Option<String> = target.try_get("agent_id")?;
    let conversation_kind: String = target.try_get("conversation_kind")?;
    if let Some(agent_id) = agent_id.as_deref() {
        runtime_bindings::authorize_chat_target_read_tx(
            &mut tx,
            actor,
            organization_id,
            &conversation_id,
            agent_id,
        )
        .await?;
    } else if conversation_kind == "side_chat" {
        runtime_bindings::authorize_chat_target_read_without_agent_tx(
            &mut tx,
            actor,
            organization_id,
            &conversation_id,
        )
        .await?;
    } else {
        return Err(http(409, "Native Chat conversation has no selected Agent"));
    }

    let rows = sqlx::query(
        "SELECT m.id::text AS id, m.org_id::text AS org_id,
                m.conversation_id::text AS conversation_id, m.role, m.kind,
                m.status, m.body, m.structured_payload,
                m.approval_id::text AS approval_id,
                m.run_id::text AS run_id, m.replying_agent_id::text AS replying_agent_id,
                m.chat_turn_id::text AS chat_turn_id, m.turn_variant,
                m.superseded_at::text AS superseded_at,
                m.created_at::text AS created_at, m.updated_at::text AS updated_at,
                g.id::text AS generation_id, g.terminal_reason,
                g.execution_authority, g.status AS generation_status
         FROM chat_messages m
         LEFT JOIN heartbeat_runs r ON r.org_id=m.org_id AND r.id=m.run_id
         LEFT JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid
           AND ($3::uuid IS NULL OR (m.created_at, m.id) > (
             SELECT c.created_at, c.id FROM chat_messages c
             WHERE c.org_id=$1::uuid AND c.conversation_id=$2::uuid AND c.id=$3::uuid
           ))
         ORDER BY m.created_at ASC, m.id ASC
         LIMIT $4",
    )
    .bind(organization_id)
    .bind(&conversation_id)
    .bind(cursor)
    .bind(limit + 1)
    .fetch_all(&mut *tx)
    .await?;
    let has_more = rows.len() > limit as usize;
    let next_cursor = rows
        .get(limit.saturating_sub(1) as usize)
        .and_then(|row| row.try_get::<String, _>("id").ok());
    let generation_ids = rows
        .iter()
        .filter_map(|row| {
            row.try_get::<Option<String>, _>("generation_id")
                .ok()
                .flatten()
        })
        .collect::<Vec<_>>();
    let message_ids = rows
        .iter()
        .filter_map(|row| row.try_get::<String, _>("id").ok())
        .collect::<Vec<_>>();
    let approval_ids = rows
        .iter()
        .filter_map(|row| {
            row.try_get::<Option<String>, _>("approval_id")
                .ok()
                .flatten()
        })
        .collect::<Vec<_>>();
    let mut approval_by_id: HashMap<String, Value> = HashMap::new();
    if !approval_ids.is_empty() {
        let approval_rows = sqlx::query(
            "SELECT a.id::text AS id,
                    jsonb_build_object(
                      'id', a.id::text,
                      'orgId', a.org_id::text,
                      'type', a.type,
                      'requestedByAgentId', a.requested_by_agent_id::text,
                      'requestedByUserId', a.requested_by_user_id,
                      'status', a.status,
                      'payload', a.payload,
                      'decisionNote', a.decision_note,
                      'decidedByUserId', a.decided_by_user_id,
                      'decidedAt', a.decided_at,
                      'createdAt', a.created_at,
                      'updatedAt', a.updated_at
                    ) AS value
             FROM approvals a
             WHERE a.org_id=$1::uuid AND a.id=ANY($2::text[]::uuid[])",
        )
        .bind(organization_id)
        .bind(&approval_ids)
        .fetch_all(&mut *tx)
        .await?;
        for row in approval_rows {
            approval_by_id.insert(row.try_get("id")?, row.try_get("value")?);
        }
    }
    let mut attachments_by_message_id: HashMap<String, Vec<Value>> = HashMap::new();
    if !message_ids.is_empty() {
        let attachment_rows = sqlx::query(
            "SELECT ca.message_id::text AS message_id,
                    CASE
                      WHEN a.content_type='text/html' AND a.created_by_agent_id IS NOT NULL THEN
                        jsonb_build_object(
                          'id', ca.id::text,
                          'orgId', ca.org_id::text,
                          'conversationId', ca.conversation_id::text,
                          'messageId', ca.message_id::text,
                          'assetId', ca.asset_id::text,
                          'contentType', a.content_type,
                          'byteSize', a.byte_size,
                          'sha256', a.sha256,
                          'originalFilename', a.original_filename,
                          'createdByAgentId', a.created_by_agent_id::text,
                          'createdByUserId', a.created_by_user_id,
                          'createdAt', ca.created_at,
                          'updatedAt', ca.updated_at,
                          'contentPath', '/api/assets/' || a.id::text || '/content'
                        )
                      ELSE
                        jsonb_build_object(
                          'id', ca.id::text,
                          'orgId', ca.org_id::text,
                          'conversationId', ca.conversation_id::text,
                          'messageId', ca.message_id::text,
                          'assetId', ca.asset_id::text,
                          'provider', a.provider,
                          'objectKey', a.object_key,
                          'contentType', a.content_type,
                          'byteSize', a.byte_size,
                          'sha256', a.sha256,
                          'originalFilename', a.original_filename,
                          'createdByAgentId', a.created_by_agent_id::text,
                          'createdByUserId', a.created_by_user_id,
                          'createdAt', ca.created_at,
                          'updatedAt', ca.updated_at,
                          'contentPath', '/api/assets/' || a.id::text || '/content'
                        )
                    END AS value
             FROM chat_attachments ca
             INNER JOIN assets a
               ON a.org_id=ca.org_id AND a.id=ca.asset_id
             WHERE ca.org_id=$1::uuid AND ca.message_id=ANY($2::text[]::uuid[])
             ORDER BY ca.created_at ASC, ca.id ASC",
        )
        .bind(organization_id)
        .bind(&message_ids)
        .fetch_all(&mut *tx)
        .await?;
        for row in attachment_rows {
            attachments_by_message_id
                .entry(row.try_get("message_id")?)
                .or_default()
                .push(row.try_get("value")?);
        }
    }
    let mut detached_by_message_id: HashMap<String, Vec<Value>> = HashMap::new();
    if !message_ids.is_empty() {
        let detached_rows = sqlx::query(
            "SELECT message_id::text AS message_id, entry_seq, payload
             FROM chat_message_transcript_entries
             WHERE org_id=$1::uuid AND message_id=ANY($2::text[]::uuid[])
             ORDER BY message_id, entry_seq ASC",
        )
        .bind(organization_id)
        .bind(&message_ids)
        .fetch_all(&mut *tx)
        .await?;
        for row in detached_rows {
            detached_by_message_id
                .entry(row.try_get("message_id")?)
                .or_default()
                .push(row.try_get("payload")?);
        }
    }
    let mut transcript_by_generation: HashMap<String, Vec<Value>> = HashMap::new();
    let mut fallback_by_generation: HashMap<String, Vec<Value>> = HashMap::new();
    let mut transcript_summary_by_generation: HashMap<String, Value> = HashMap::new();
    if !generation_ids.is_empty() {
        let summaries = sqlx::query(
            "SELECT g.id::text AS generation_id, count(e.generation_seq)::bigint AS entry_count,
                    min(e.recorded_at)::text AS started_at, max(e.recorded_at)::text AS ended_at
             FROM chat_generations g
             LEFT JOIN chat_generation_events e
               ON e.org_id=g.org_id AND e.generation_id=g.id AND e.event_kind='transcript'
              AND (g.accepted_through_seq IS NULL OR e.generation_seq <= g.accepted_through_seq)
             WHERE g.org_id=$1::uuid AND g.id=ANY($2::text[]::uuid[])
             GROUP BY g.id",
        )
        .bind(organization_id)
        .bind(&generation_ids)
        .fetch_all(&mut *tx)
        .await?;
        for summary in summaries {
            let generation_id: String = summary.try_get("generation_id")?;
            let entry_count: i64 = summary.try_get("entry_count")?;
            transcript_summary_by_generation.insert(
                generation_id,
                if entry_count > 0 {
                    serde_json::json!({
                        "entryCount": entry_count,
                        "startedAt": summary.try_get::<Option<String>, _>("started_at")?,
                        "endedAt": summary.try_get::<Option<String>, _>("ended_at")?,
                    })
                } else {
                    Value::Null
                },
            );
        }
    }
    if *include_transcript && !generation_ids.is_empty() {
        let events = sqlx::query(
            "SELECT generation_id::text AS generation_id, generation_seq, event_kind,
                    payload, recorded_at::text AS recorded_at
             FROM chat_generation_events e
             JOIN chat_generations g ON g.org_id=e.org_id AND g.id=e.generation_id
             WHERE e.org_id=$1::uuid AND e.generation_id=ANY($2::text[]::uuid[])
               AND (g.accepted_through_seq IS NULL OR e.generation_seq <= g.accepted_through_seq)
               AND e.event_kind IN ('assistant_delta','runtime_output','transcript')
             ORDER BY e.generation_id, e.generation_seq ASC",
        )
        .bind(organization_id)
        .bind(&generation_ids)
        .fetch_all(&mut *tx)
        .await?;
        for event in events {
            let generation_id: String = event.try_get("generation_id")?;
            let kind: String = event.try_get("event_kind")?;
            let payload: Value = event.try_get("payload")?;
            let seq: i32 = event.try_get("generation_seq")?;
            let recorded_at: String = event.try_get("recorded_at")?;
            if kind == "transcript" {
                let Some(mut entry) = payload.get("entry").cloned() else {
                    continue;
                };
                if let Value::Object(object) = &mut entry {
                    object.insert(
                        "generationId".to_owned(),
                        Value::String(generation_id.clone()),
                    );
                    object.insert("generationSeqStart".to_owned(), Value::from(seq));
                    object.insert("generationSeqEnd".to_owned(), Value::from(seq));
                }
                transcript_by_generation
                    .entry(generation_id)
                    .or_default()
                    .push(entry);
            } else {
                let Some(text) = (match kind.as_str() {
                    "assistant_delta" => payload.get("delta").and_then(Value::as_str),
                    "runtime_output" => payload.get("body").and_then(Value::as_str),
                    _ => None,
                }) else {
                    continue;
                };
                fallback_by_generation
                    .entry(generation_id.clone())
                    .or_default()
                    .push(serde_json::json!({
                        "kind": "assistant",
                        "ts": recorded_at,
                        "text": text,
                        "delta": kind == "assistant_delta",
                        "phase": if kind == "runtime_output" { "final_answer" } else { "commentary" },
                        "generationId": generation_id,
                        "generationSeqStart": seq,
                        "generationSeqEnd": seq,
                    }));
            }
        }
        for (generation_id, fallback) in fallback_by_generation {
            transcript_by_generation
                .entry(generation_id)
                .or_insert(fallback);
        }
    }
    let mut messages = Vec::new();
    for row in rows.into_iter().take(limit as usize) {
        let role: String = row.try_get("role")?;
        let run_id: Option<String> = row.try_get("run_id")?;
        let execution_authority: Option<String> = row.try_get("execution_authority")?;
        if conversation_kind == "chat"
            && role == "assistant"
            && execution_authority.as_deref() != Some("native_rust")
        {
            return Err(http(
                409,
                "Native Chat Reader found a legacy assistant projection",
            ));
        }
        let body: String = row.try_get("body")?;
        if body.len() > 262_144 {
            return Err(http(422, "Native Chat message exceeds the read bound"));
        }
        let id: String = row.try_get("id")?;
        let generation_id: Option<String> = row.try_get("generation_id")?;
        let ledger_transcript = generation_id
            .as_ref()
            .and_then(|id| transcript_by_generation.get(id))
            .cloned()
            .unwrap_or_default();
        let detached_transcript = detached_by_message_id.get(&id).cloned().unwrap_or_default();
        let legacy_transcript = row
            .try_get::<Option<Value>, _>("structured_payload")?
            .as_ref()
            .map(transcript_from_payload)
            .unwrap_or_default();
        let selected_transcript = if !ledger_transcript.is_empty() {
            ledger_transcript
        } else if !detached_transcript.is_empty() {
            detached_transcript
        } else {
            legacy_transcript
        };
        let transcript_summary = generation_id
            .as_ref()
            .and_then(|id| transcript_summary_by_generation.get(id))
            .cloned()
            .filter(|summary| !summary.is_null())
            .unwrap_or_else(|| transcript_summary(&selected_transcript));
        let transcript = if *include_transcript {
            selected_transcript
        } else {
            Vec::new()
        };
        let structured_payload = row
            .try_get::<Option<Value>, _>("structured_payload")?
            .and_then(|payload| match payload {
                Value::Null => None,
                Value::Object(mut object) => {
                    object.remove("__chatTranscript");
                    (!object.is_empty()).then_some(Value::Object(object))
                }
                value => Some(value),
            })
            .unwrap_or(Value::Null);
        let approval_id = row.try_get::<Option<String>, _>("approval_id")?;
        let approval = approval_id
            .as_ref()
            .and_then(|id| approval_by_id.get(id))
            .cloned()
            .unwrap_or(Value::Null);
        let attachments = attachments_by_message_id
            .get(&id)
            .cloned()
            .unwrap_or_default();
        messages.push(serde_json::json!({
            "id": id,
            "orgId": row.try_get::<String, _>("org_id")?,
            "conversationId": row.try_get::<String, _>("conversation_id")?,
            "role": role,
            "kind": row.try_get::<String, _>("kind")?,
            "status": row.try_get::<String, _>("status")?,
            "body": body,
            "structuredPayload": structured_payload,
            "approvalId": approval_id,
            "approval": approval,
            "attachments": attachments,
            "runId": run_id,
            "generationId": generation_id,
            "generationTerminalReason": row.try_get::<Option<String>, _>("terminal_reason")?,
            "replyingAgentId": row.try_get::<Option<String>, _>("replying_agent_id")?,
            "chatTurnId": row.try_get::<Option<String>, _>("chat_turn_id")?,
            "turnVariant": row.try_get::<i32, _>("turn_variant")?,
            "supersededAt": row.try_get::<Option<String>, _>("superseded_at")?,
            "createdAt": row.try_get::<String, _>("created_at")?,
            "updatedAt": row.try_get::<String, _>("updated_at")?,
            "transcriptSummary": transcript_summary,
            "transcript": transcript,
        }));
    }
    tx.commit().await?;
    Ok(serde_json::json!({
        "messages": messages,
        "source": "native_chat_reader",
        "availability": "complete",
        "nextCursor": has_more.then_some(next_cursor).flatten(),
    }))
}
