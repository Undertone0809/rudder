//! Typed, bounded public progress projection for one owned Hermes ACP prompt.
//!
//! Raw ACP values never cross this boundary. Each event is bound to the exact
//! current execution, session, prompt request, admitted source message, and
//! connection claim before it is committed to the Native Chat event ledger.

use super::{ExecutionFence, Result, context::lock_current_execution, http};
use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use crate::native_chat::NativeChatExecutionActor;
use rudder_hermes_acp::{HermesProgressKind, HermesProgressReceipt};
use rudder_runtime_core::native_chat::NativeChatProtocolPhase;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const MAX_PROGRESS_EVENTS: i64 = 512;
const MAX_PROGRESS_TEXT_BYTES: i64 = 256 * 1024;
const MAX_PROGRESS_PAYLOAD_BYTES: i64 = 2 * 1024 * 1024;
const MAX_TOOL_INPUT_BYTES: usize = 32 * 1024;
const MAX_TOOL_INPUT_FIELD_BYTES: usize = 12 * 1024;
const MAX_TOOL_PATH_BYTES: usize = 2 * 1024;
const MAX_TOOL_OUTPUT_BYTES: usize = 12 * 1024;
const TRUNCATED_TEXT: &str =
    "Live progress was truncated; the final response will include the complete answer.";
const PUBLIC_TOOL_INPUT_KEYS: &[&str] = &["path", "query", "url", "command", "code", "details"];

#[derive(Debug)]
pub struct HermesProgressCommit {
    pub generation_seq: i32,
    pub body_hash: String,
    pub assistant_message_id: String,
}

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
    connection_epoch: i32,
    connection_id: String,
    claim_digest: String,
    assistant_message_id: String,
    source_message_digest: String,
    input_fingerprint_digest: String,
    session_digest: String,
    request_id: u64,
    ordinal: u64,
    kind: String,
    item_digest: Option<String>,
    content_digest: String,
    fingerprint: String,
}

#[derive(Debug)]
pub(crate) struct ValidatedHermesProgress {
    pub entry: Value,
    pub body_hash: String,
    pub ordinal: u64,
}

/// Persist one public progress entry before any NDJSON event can expose it.
/// `None` means the bounded projection has already been truncated and this
/// later progress item was intentionally suppressed; the final answer still
/// remains eligible for ordinary terminal finalization.
pub async fn record_hermes_progress(
    pool: &PgPool,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    observation: &HermesProgressReceipt,
) -> Result<Option<HermesProgressCommit>> {
    let identity = fence.identity();
    if !observation.matches_connection_claim(
        identity.run_id,
        identity.attempt_id,
        fence.run_execution_owner_token(),
        identity.connection_epoch,
        &fence.connection_claim_id,
    ) || observation.ordinal() == 0
        || observation.ordinal() > MAX_PROGRESS_EVENTS as u64
    {
        return Err(http(409, "Hermes progress does not match its execution"));
    }

    let mut tx = pool.begin().await?;
    sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut *tx)
        .await?;
    let locked = lock_current_execution(&mut tx, actor, fence).await?;
    if locked.checkpoint.phase() != NativeChatProtocolPhase::InputIndeterminate
        || locked
            .checkpoint
            .hermes_session()
            .map(|session| session.as_str())
            != Some(observation.session().as_str())
        || locked.checkpoint.hermes_prompt_request_id() != Some(observation.request_id())
        || locked.admitted_message_id.as_deref() != Some(observation.source_message_id())
        || locked.admitted_input_fingerprint.as_deref() != Some(observation.input_fingerprint())
    {
        return Err(http(
            409,
            "Hermes progress is not bound to the active prompt",
        ));
    }

    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:execution',true)")
        .execute(&mut *tx)
        .await?;
    let assistant_rows = sqlx::query(
        "SELECT id::text,status,kind,body,
           (structured_payload IS NULL OR structured_payload IN ('null'::jsonb,'{}'::jsonb)) AS plain
         FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid
           AND run_id=$3::uuid AND role='assistant' AND superseded_at IS NULL ORDER BY id LIMIT 2 FOR UPDATE",
    )
    .bind(identity.organization_id)
    .bind(identity.conversation_id)
    .bind(identity.run_id)
    .fetch_all(&mut *tx)
    .await?;
    if assistant_rows.len() > 1 {
        return Err(http(409, "Hermes assistant projection is ambiguous"));
    }
    let assistant_message_id = if let Some(message) = assistant_rows.first() {
        let message_id: String = message.try_get("id")?;
        let body: String = message.try_get("body")?;
        if message.try_get::<String, _>("status")? != "streaming"
            || message.try_get::<String, _>("kind")? != "message"
            || !body.is_empty()
            || !message.try_get::<bool, _>("plain")?
        {
            return Err(http(409, "Hermes assistant projection changed"));
        }
        message_id
    } else {
        // Hermes produces no final answer row at prompt admission time. Create
        // it with the first actual public progress event, atomically with that
        // event, so early Stop/no-output turns remain row-free.
        let message_id: Option<String> = sqlx::query_scalar(
            "INSERT INTO chat_messages (org_id,conversation_id,role,kind,status,body,run_id,
             replying_agent_id,chat_turn_id,turn_variant)
             SELECT $1::uuid,$2::uuid,'assistant','message','streaming','',$3::uuid,$5::uuid,
                    m.chat_turn_id,m.turn_variant
             FROM chat_generations g JOIN chat_messages m
               ON m.org_id=g.org_id AND m.id=g.source_message_id
             WHERE g.org_id=$1::uuid AND g.id=$4::uuid
               AND g.conversation_id=$2::uuid AND g.source_message_id=$6::uuid
             RETURNING id::text",
        )
        .bind(identity.organization_id)
        .bind(identity.conversation_id)
        .bind(identity.run_id)
        .bind(identity.generation_id)
        .bind(&locked.agent_id)
        .bind(observation.source_message_id())
        .fetch_optional(&mut *tx)
        .await?;
        message_id.ok_or_else(|| http(409, "Hermes assistant source message is missing"))?
    };

    let mut normalized = make_entry(observation)?;
    let mut source = make_source(
        fence,
        observation,
        &assistant_message_id,
        &normalized.kind,
        normalized.item_digest.clone(),
        normalized.content_digest.clone(),
    );
    let prior = sqlx::query(
        "SELECT count(*)::bigint AS event_count,
                COALESCE(sum(octet_length(payload::text)),0)::bigint AS payload_bytes,
                COALESCE(sum(octet_length(COALESCE(payload#>>'{entry,text}',''))
                    + octet_length(COALESCE(payload#>>'{entry,name}',''))
                    + octet_length(COALESCE(payload#>>'{entry,content}',''))
                    + octet_length(COALESCE(payload#>>'{entry,status}',''))
                    + CASE WHEN payload#>>'{nativeSource,version}'='2'
                        AND payload#>'{entry,input}' IS NOT NULL
                        THEN octet_length((payload#>'{entry,input}')::text) ELSE 0 END),0)::bigint AS text_bytes,
                COALESCE(max((payload#>>'{nativeSource,ordinal}')::bigint),0) AS latest_ordinal,
                COALESCE(bool_or(payload#>>'{entry,kind}'='system'
                    AND payload#>>'{entry,text}'=$8),false) AS truncated,
                count(*) FILTER (WHERE payload#>>'{nativeSource,connectionId}'=$4
                    AND payload#>>'{nativeSource,sessionDigest}'=$5
                    AND payload#>>'{nativeSource,requestId}'=$6
                    AND payload#>>'{nativeSource,claimDigest}'=$7)::bigint AS matching_count
         FROM chat_generation_events
         WHERE org_id=$1::uuid AND generation_id=$2::uuid AND attempt_epoch=$3
           AND run_id=$9::uuid AND event_kind='transcript'",
    )
    .bind(identity.organization_id)
    .bind(identity.generation_id)
    .bind(identity.generation_attempt_epoch)
    .bind(observation.connection_receipt_id())
    .bind(hash(observation.session().as_str()))
    .bind(observation.request_id().to_string())
    .bind(hash(&fence.connection_claim_id))
    .bind(TRUNCATED_TEXT)
    .bind(identity.run_id)
    .fetch_one(&mut *tx)
    .await?;
    let event_count: i64 = prior.try_get("event_count")?;
    let payload_bytes: i64 = prior.try_get("payload_bytes")?;
    let text_bytes: i64 = prior.try_get("text_bytes")?;
    let latest_ordinal: i64 = prior.try_get("latest_ordinal")?;
    let truncated: bool = prior.try_get("truncated")?;
    let matching_count: i64 = prior.try_get("matching_count")?;
    if event_count != matching_count || latest_ordinal != event_count {
        return Err(http(
            409,
            "Hermes progress history belongs to another prompt",
        ));
    }
    if observation.ordinal() as i64 <= event_count {
        let existing = sqlx::query(
            "SELECT generation_seq,payload FROM chat_generation_events
             WHERE org_id=$1::uuid AND generation_id=$2::uuid AND attempt_epoch=$3
               AND run_id=$4::uuid AND event_kind='transcript'
               AND payload#>>'{nativeSource,ordinal}'=$5
             ORDER BY generation_seq LIMIT 2",
        )
        .bind(identity.organization_id)
        .bind(identity.generation_id)
        .bind(identity.generation_attempt_epoch)
        .bind(identity.run_id)
        .bind(observation.ordinal().to_string())
        .fetch_all(&mut *tx)
        .await?;
        if let [row] = existing.as_slice() {
            let payload: Value = row.try_get("payload")?;
            let existing_projection = validate_receipt_projection(
                &payload,
                identity.organization_id,
                identity.generation_id,
                identity.run_id,
                identity.generation_attempt_epoch,
                &assistant_message_id,
                fence,
                observation.connection_receipt_id(),
                observation.session().as_str(),
                observation.request_id(),
                observation.source_message_id(),
                observation.input_fingerprint(),
            )
            .filter(|projection| projection.ordinal == observation.ordinal());
            let existing_fingerprint = payload
                .pointer("/nativeSource/fingerprint")
                .and_then(Value::as_str);
            if existing_projection.is_some()
                && existing_fingerprint == Some(source.fingerprint.as_str())
            {
                let generation_seq: i32 = row.try_get("generation_seq")?;
                tx.commit().await?;
                return Ok(Some(HermesProgressCommit {
                    generation_seq,
                    body_hash: hash(""),
                    assistant_message_id,
                }));
            }
        }
        return Err(http(
            409,
            "Hermes progress retry conflicts with durable history",
        ));
    }
    if truncated {
        tx.commit().await?;
        return Ok(None);
    }
    if observation.ordinal() as i64 != event_count + 1 {
        return Err(http(409, "Hermes progress ordinal is not contiguous"));
    }

    let mut payload = progress_payload(&normalized, &source)?;
    let current_text_bytes = entry_text_bytes(&normalized.entry) as i64;
    let should_truncate = event_count >= MAX_PROGRESS_EVENTS - 1
        || text_bytes.saturating_add(current_text_bytes) > MAX_PROGRESS_TEXT_BYTES
        || payload_bytes.saturating_add(payload.to_string().len() as i64)
            > MAX_PROGRESS_PAYLOAD_BYTES;
    if should_truncate && normalized.kind != "truncated" {
        normalized = NormalizedEntry::truncated(timestamp()?);
        source = make_source(
            fence,
            observation,
            &assistant_message_id,
            &normalized.kind,
            None,
            normalized.content_digest.clone(),
        );
        payload = progress_payload(&normalized, &source)?;
    }
    if event_count >= MAX_PROGRESS_EVENTS
        || payload_bytes + payload.to_string().len() as i64 > MAX_PROGRESS_PAYLOAD_BYTES
    {
        tx.commit().await?;
        return Ok(None);
    }

    let body_hash = hash("");
    payload["bodyHash"] = json!(body_hash);
    let generation_seq = sqlx::query_scalar::<_, i32>(
        "INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,
          event_kind,payload,assistant_message_id,run_id)
         SELECT $1::uuid,$2::uuid,COALESCE(max(generation_seq),0)+1,$3,'transcript',$4,
                $5::uuid,$6::uuid
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid
         RETURNING generation_seq",
    )
    .bind(identity.organization_id)
    .bind(identity.generation_id)
    .bind(identity.generation_attempt_epoch)
    .bind(&payload)
    .bind(&assistant_message_id)
    .bind(identity.run_id)
    .fetch_one(&mut *tx)
    .await?;

    let audit = ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: Some(identity.run_id.to_owned()),
    };
    let details = json!({
        "generationId": identity.generation_id,
        "generationSeq": generation_seq,
        "assistantMessageId": assistant_message_id,
        "progressKind": normalized.kind,
        "ordinal": observation.ordinal(),
    });
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: identity.organization_id,
            audit: &audit,
            action: "runtime.native_chat.hermes_progress_recorded",
            entity_type: "heartbeat_run",
            entity_id: identity.run_id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: Some(&locked.agent_id),
                bind_run: true,
                ..Default::default()
            },
        },
    )
    .await?;
    lock_current_execution(&mut tx, actor, fence).await?;
    tx.commit().await?;
    Ok(Some(HermesProgressCommit {
        generation_seq,
        body_hash,
        assistant_message_id,
    }))
}

struct NormalizedEntry {
    entry: Value,
    kind: String,
    item_digest: Option<String>,
    content_digest: String,
}

impl NormalizedEntry {
    fn truncated(ts: String) -> Self {
        Self {
            entry: json!({"kind":"system","ts":ts,"text":TRUNCATED_TEXT}),
            kind: "truncated".into(),
            item_digest: None,
            content_digest: hash(TRUNCATED_TEXT),
        }
    }
}

fn make_entry(observation: &HermesProgressReceipt) -> Result<NormalizedEntry> {
    let ts = timestamp()?;
    let (entry, kind, item_digest, content_digest) = match observation.kind() {
        HermesProgressKind::ThinkingChunk(text) => (
            json!({"kind":"thinking","ts":ts,"text":text,"delta":true,"phase":"commentary"}),
            "thinking_chunk",
            None,
            hash(text),
        ),
        HermesProgressKind::AssistantChunk(text) => (
            json!({"kind":"assistant","ts":ts,"text":text,"delta":true,"phase":"commentary"}),
            "assistant_chunk",
            None,
            hash(text),
        ),
        HermesProgressKind::ToolCall {
            tool_call_id,
            title,
            input,
        } => {
            if title.is_empty() || title.len() > 1024 || has_unsupported_control(title) {
                return Err(http(409, "Hermes tool name is unsupported"));
            }
            if public_tool_input_exceeds_bound(title, input) {
                return Ok(NormalizedEntry::truncated(ts));
            }
            let input = normalize_public_tool_input(title, input)?;
            let item_digest = tool_use_id(observation, tool_call_id);
            let semantic_digest = tool_call_semantic_digest(title, &input);
            (
                json!({"kind":"tool_call","ts":ts,"name":title,"input":input,"toolUseId":item_digest}),
                "tool_call",
                Some(item_digest),
                semantic_digest,
            )
        }
        HermesProgressKind::ToolCallUpdate {
            tool_call_id,
            status,
            content,
        } => {
            let item_digest = tool_use_id(observation, tool_call_id);
            let is_error = match status.as_str() {
                "pending" | "in_progress" | "completed" => false,
                "failed" => true,
                _ => return Err(http(409, "Hermes tool update status is unsupported")),
            };
            if content.len() > MAX_TOOL_OUTPUT_BYTES {
                return Ok(NormalizedEntry::truncated(ts));
            }
            if has_unsupported_control(content) {
                return Err(http(409, "Hermes tool output contains unsupported text"));
            }
            (
                json!({"kind":"tool_result","ts":ts,"toolUseId":item_digest,"status":status,"content":content,"isError":is_error}),
                "tool_call_update",
                Some(item_digest),
                tool_result_semantic_digest(status, content, is_error),
            )
        }
        HermesProgressKind::Truncated => {
            let entry = NormalizedEntry::truncated(ts);
            return Ok(entry);
        }
    };
    if entry_text_bytes(&entry) > MAX_PROGRESS_TEXT_BYTES as usize {
        return Ok(NormalizedEntry::truncated(timestamp()?));
    }
    Ok(NormalizedEntry {
        entry,
        kind: kind.into(),
        item_digest,
        content_digest,
    })
}

fn public_tool_input_exceeds_bound(name: &str, input: &Value) -> bool {
    let Some(object) = input.as_object() else {
        return false;
    };
    if !public_tool_input_shape_matches_name(name, input) {
        return false;
    }
    let mut text_bytes = 0usize;
    for (key, value) in object {
        if !PUBLIC_TOOL_INPUT_KEYS.contains(&key.as_str()) {
            return false;
        }
        let Some(text) = value.as_str() else {
            return false;
        };
        let field_limit = if key == "path" {
            MAX_TOOL_PATH_BYTES
        } else {
            MAX_TOOL_INPUT_FIELD_BYTES
        };
        text_bytes = text_bytes.saturating_add(text.len());
        if text.len() > field_limit || text_bytes > MAX_TOOL_INPUT_BYTES {
            return true;
        }
    }
    object.len() > PUBLIC_TOOL_INPUT_KEYS.len()
        || Value::Object(object.clone()).to_string().len() > MAX_TOOL_INPUT_BYTES
}

/// Keep only the public, named tool arguments admitted by the Hermes ACP
/// adapter. String-only values make nested provider metadata and secret-like
/// structures impossible to smuggle into the transcript projection.
fn normalize_public_tool_input(name: &str, input: &Value) -> Result<Value> {
    let Some(object) = input.as_object() else {
        return Err(http(409, "Hermes tool input must be a public object"));
    };
    if object.len() > PUBLIC_TOOL_INPUT_KEYS.len() {
        return Err(http(409, "Hermes tool input contains unsupported fields"));
    }
    let mut normalized = serde_json::Map::new();
    let mut text_bytes = 0usize;
    for (key, value) in object {
        if !PUBLIC_TOOL_INPUT_KEYS.contains(&key.as_str()) {
            return Err(http(409, "Hermes tool input contains unsupported fields"));
        }
        let Some(text) = value.as_str() else {
            return Err(http(409, "Hermes tool input fields must be text"));
        };
        if has_unsupported_control(text) {
            return Err(http(409, "Hermes tool input contains unsupported text"));
        }
        let field_limit = if key == "path" {
            MAX_TOOL_PATH_BYTES
        } else {
            MAX_TOOL_INPUT_FIELD_BYTES
        };
        if text.len() > field_limit {
            return Err(http(409, "Hermes tool input field exceeds its bound"));
        }
        text_bytes = text_bytes.saturating_add(text.len());
        if text_bytes > MAX_TOOL_INPUT_BYTES {
            return Err(http(409, "Hermes tool input exceeds its bound"));
        }
        normalized.insert(key.clone(), Value::String(text.to_owned()));
    }
    let normalized = Value::Object(normalized);
    if normalized.to_string().len() > MAX_TOOL_INPUT_BYTES {
        return Err(http(409, "Hermes tool input exceeds its bound"));
    }
    if !public_tool_input_shape_matches_name(name, &normalized) {
        return Err(http(
            409,
            "Hermes tool input does not match its public tool name",
        ));
    }
    Ok(normalized)
}

fn valid_public_tool_input(name: &str, input: &Value) -> bool {
    let Some(object) = input.as_object() else {
        return false;
    };
    if object.len() > PUBLIC_TOOL_INPUT_KEYS.len() {
        return false;
    }
    let mut text_bytes = 0usize;
    for (key, value) in object {
        if !PUBLIC_TOOL_INPUT_KEYS.contains(&key.as_str()) {
            return false;
        }
        let Some(text) = value.as_str() else {
            return false;
        };
        if has_unsupported_control(text) {
            return false;
        }
        let field_limit = if key == "path" {
            MAX_TOOL_PATH_BYTES
        } else {
            MAX_TOOL_INPUT_FIELD_BYTES
        };
        if text.len() > field_limit {
            return false;
        }
        text_bytes = text_bytes.saturating_add(text.len());
        if text_bytes > MAX_TOOL_INPUT_BYTES {
            return false;
        }
    }
    input.to_string().len() <= MAX_TOOL_INPUT_BYTES
        && public_tool_input_shape_matches_name(name, input)
}

fn public_tool_input_shape_matches_name(name: &str, input: &Value) -> bool {
    let Some(object) = input.as_object() else {
        return false;
    };
    let allowed: &[&str] = match name {
        "web_search" => &["query", "path"],
        "terminal" => &["command", "path"],
        "execute_code" => &["code", "details", "path"],
        "read_file" | "write_file" | "patch" => &["path", "details"],
        "search_files" => &["query", "details", "path"],
        "web_extract" => &["url", "path"],
        _ => &["details", "path"],
    };
    object.keys().all(|key| allowed.contains(&key.as_str()))
        && !(name == "execute_code"
            && object.contains_key("code")
            && object.contains_key("details"))
}

fn tool_call_semantic_digest(name: &str, input: &Value) -> String {
    hash(&json!({"name":name,"input":input}).to_string())
}

fn tool_result_semantic_digest(status: &str, content: &str, is_error: bool) -> String {
    hash(&json!({"status":status,"content":content,"isError":is_error}).to_string())
}

fn has_unsupported_control(text: &str) -> bool {
    text.chars()
        .any(|character| character.is_control() && character != '\n' && character != '\t')
}

fn make_source(
    fence: &ExecutionFence,
    observation: &HermesProgressReceipt,
    assistant_message_id: &str,
    kind: &str,
    item_digest: Option<String>,
    content_digest: String,
) -> Source {
    let identity = fence.identity();
    let mut source = Source {
        version: 2,
        organization_id: identity.organization_id.to_owned(),
        generation_id: identity.generation_id.to_owned(),
        run_id: identity.run_id.to_owned(),
        attempt_id: identity.attempt_id.to_owned(),
        generation_attempt_epoch: identity.generation_attempt_epoch,
        run_attempt_epoch: identity.run_attempt_epoch,
        connection_epoch: identity.connection_epoch,
        connection_id: observation.connection_receipt_id().to_owned(),
        claim_digest: hash(&fence.connection_claim_id),
        assistant_message_id: assistant_message_id.to_owned(),
        source_message_digest: hash(observation.source_message_id()),
        input_fingerprint_digest: hash(observation.input_fingerprint()),
        session_digest: hash(observation.session().as_str()),
        request_id: observation.request_id(),
        ordinal: observation.ordinal(),
        kind: kind.to_owned(),
        item_digest,
        content_digest,
        fingerprint: String::new(),
    };
    source.fingerprint = source_fingerprint(&source);
    source
}

fn progress_payload(entry: &NormalizedEntry, source: &Source) -> Result<Value> {
    let mut payload = json!({"entry":entry.entry});
    payload["nativeSource"] = serde_json::to_value(source)
        .map_err(|_| http(500, "Cannot encode Hermes progress provenance"))?;
    if payload.to_string().len() > MAX_PROGRESS_PAYLOAD_BYTES as usize {
        return Err(http(409, "Hermes progress event exceeds its bound"));
    }
    Ok(payload)
}

fn source_fingerprint(source: &Source) -> String {
    hash(
        &json!({
            "version": source.version,
            "organizationId": source.organization_id,
            "generationId": source.generation_id,
            "runId": source.run_id,
            "attemptId": source.attempt_id,
            "generationAttemptEpoch": source.generation_attempt_epoch,
            "runAttemptEpoch": source.run_attempt_epoch,
            "connectionEpoch": source.connection_epoch,
            "connectionId": source.connection_id,
            "claimDigest": source.claim_digest,
            "assistantMessageId": source.assistant_message_id,
            "sourceMessageDigest": source.source_message_digest,
            "inputFingerprintDigest": source.input_fingerprint_digest,
            "sessionDigest": source.session_digest,
            "requestId": source.request_id,
            "ordinal": source.ordinal,
            "kind": source.kind,
            "itemDigest": source.item_digest,
            "contentDigest": source.content_digest,
        })
        .to_string(),
    )
}

fn tool_use_id(observation: &HermesProgressReceipt, tool_call_id: &str) -> String {
    let session = hash(observation.session().as_str());
    format!(
        "hermes-{}",
        hash(&format!(
            "hermes-tool-call-v1:{session}:{}:{tool_call_id}",
            observation.request_id()
        ))
    )
}

fn timestamp() -> Result<String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| http(500, "Cannot timestamp Hermes progress"))
}

fn entry_text_bytes(entry: &Value) -> usize {
    let scalar_bytes = ["text", "name", "content", "status"]
        .into_iter()
        .filter_map(|key| entry.get(key).and_then(Value::as_str))
        .map(str::len)
        .sum::<usize>();
    scalar_bytes.saturating_add(
        entry
            .get("input")
            .map(|input| input.to_string().len())
            .unwrap_or_default(),
    )
}

fn entry_text_bytes_for_version(version: u8, entry: &Value) -> usize {
    if version == 1 {
        ["text", "name", "content"]
            .into_iter()
            .filter_map(|key| entry.get(key).and_then(Value::as_str))
            .map(str::len)
            .sum()
    } else {
        entry_text_bytes(entry)
    }
}

fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

/// Validate the internal event source before returning only its typed public
/// transcript entry. Stop, event reads, and historical turn reads share this
/// strict validation so generic transcript payloads are never whitelisted.
pub(crate) fn validate_public_projection(
    raw: &Value,
    org: &str,
    generation: &str,
    run: &str,
    attempt_epoch: i32,
    assistant_message_id: &str,
) -> Option<ValidatedHermesProgress> {
    if raw.to_string().len() > MAX_PROGRESS_PAYLOAD_BYTES as usize
        || !has_exact_keys(raw, &["entry", "nativeSource", "bodyHash"])
    {
        return None;
    }
    let source: Source = serde_json::from_value(raw.get("nativeSource")?.clone()).ok()?;
    if !matches!(source.version, 1 | 2)
        || source.organization_id != org
        || source.generation_id != generation
        || source.run_id != run
        || source.generation_attempt_epoch != attempt_epoch
        || source.assistant_message_id != assistant_message_id
        || source.ordinal == 0
        || source.ordinal > MAX_PROGRESS_EVENTS as u64
        || source.request_id == 0
        || source.generation_attempt_epoch < 1
        || source.run_attempt_epoch < 1
        || source.connection_epoch < 1
        || source.connection_id.is_empty()
        || source.connection_id.len() > 128
        || source.connection_id.chars().any(char::is_control)
        || !canonical_uuid(&source.attempt_id)
        || !canonical_uuid(&source.assistant_message_id)
        || !valid_hash(&source.claim_digest)
        || !valid_hash(&source.source_message_digest)
        || !valid_hash(&source.input_fingerprint_digest)
        || !valid_hash(&source.session_digest)
        || !valid_hash(&source.content_digest)
        || !valid_hash(&source.fingerprint)
        || source_fingerprint(&source) != source.fingerprint
    {
        return None;
    }
    let body_hash = raw.get("bodyHash")?.as_str()?;
    if body_hash != hash("") {
        return None;
    }
    let entry = raw.get("entry")?.clone();
    if !validate_entry(source.version, &source, &entry) {
        return None;
    }
    Some(ValidatedHermesProgress {
        entry,
        body_hash: body_hash.to_owned(),
        ordinal: source.ordinal,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn validate_receipt_projection(
    raw: &Value,
    org: &str,
    generation: &str,
    run: &str,
    attempt_epoch: i32,
    assistant_message_id: &str,
    fence: &ExecutionFence,
    connection_receipt_id: &str,
    session: &str,
    request_id: u64,
    source_message_id: &str,
    input_fingerprint: &str,
) -> Option<ValidatedHermesProgress> {
    let projection = validate_public_projection(
        raw,
        org,
        generation,
        run,
        attempt_epoch,
        assistant_message_id,
    )?;
    let source: Source = serde_json::from_value(raw.get("nativeSource")?.clone()).ok()?;
    let identity = fence.identity();
    if source.attempt_id != identity.attempt_id
        || source.run_attempt_epoch != identity.run_attempt_epoch
        || source.connection_epoch != identity.connection_epoch
        || source.connection_id != connection_receipt_id
        || source.claim_digest != hash(&fence.connection_claim_id)
        || source.source_message_digest != hash(source_message_id)
        || source.input_fingerprint_digest != hash(input_fingerprint)
        || source.session_digest != hash(session)
        || source.request_id != request_id
    {
        return None;
    }
    Some(projection)
}

fn validate_entry(version: u8, source: &Source, entry: &Value) -> bool {
    let expected_keys: &[&str] = match source.kind.as_str() {
        "thinking_chunk" | "assistant_chunk" => &["kind", "ts", "text", "delta", "phase"],
        "tool_call" => &["kind", "ts", "name", "input", "toolUseId"],
        "tool_call_update" => {
            if version == 1 {
                &["kind", "ts", "toolUseId", "content", "isError"]
            } else {
                &["kind", "ts", "toolUseId", "status", "content", "isError"]
            }
        }
        "truncated" => &["kind", "ts", "text"],
        _ => return false,
    };
    if !has_exact_keys(entry, expected_keys) {
        return false;
    }
    let ts = entry.get("ts").and_then(Value::as_str);
    if ts.is_none_or(|value| OffsetDateTime::parse(value, &Rfc3339).is_err()) {
        return false;
    }
    let (kind, content, item, expected_digest) = match source.kind.as_str() {
        "thinking_chunk" | "assistant_chunk" => {
            let transcript_kind = if source.kind == "thinking_chunk" {
                "thinking"
            } else {
                "assistant"
            };
            if entry.get("kind").and_then(Value::as_str) != Some(transcript_kind)
                || entry.get("delta").and_then(Value::as_bool) != Some(true)
                || entry.get("phase").and_then(Value::as_str) != Some("commentary")
            {
                return false;
            }
            (
                transcript_kind,
                entry.get("text").and_then(Value::as_str),
                None,
                entry.get("text").and_then(Value::as_str).map(hash),
            )
        }
        "tool_call" => {
            if entry.get("kind").and_then(Value::as_str) != Some("tool_call") {
                return false;
            }
            let Some(name) = entry.get("name").and_then(Value::as_str) else {
                return false;
            };
            let Some(input) = entry.get("input") else {
                return false;
            };
            if (version == 1 && input != &json!({}))
                || (version == 2
                    && (name.is_empty()
                        || name.len() > 1024
                        || has_unsupported_control(name)
                        || !valid_public_tool_input(name, input)))
            {
                return false;
            }
            let expected_digest = if version == 1 {
                hash(name)
            } else {
                tool_call_semantic_digest(name, input)
            };
            (
                "tool_call",
                Some(name),
                entry.get("toolUseId").and_then(Value::as_str),
                Some(expected_digest),
            )
        }
        "tool_call_update" => {
            if entry.get("kind").and_then(Value::as_str) != Some("tool_result") {
                return false;
            }
            let content = entry.get("content").and_then(Value::as_str);
            let is_error = entry.get("isError").and_then(Value::as_bool);
            let status = entry.get("status").and_then(Value::as_str);
            if content.is_none_or(|content| {
                content.len()
                    > if version == 1 {
                        MAX_PROGRESS_TEXT_BYTES as usize
                    } else {
                        MAX_TOOL_OUTPUT_BYTES
                    }
            }) || is_error.is_none()
                || (version == 2 && content.is_some_and(has_unsupported_control))
                || (version == 1
                    && (!matches!(content, Some("Completed" | "Failed"))
                        || is_error != Some(content == Some("Failed"))))
                || (version == 2
                    && (!matches!(
                        status,
                        Some("pending" | "in_progress" | "completed" | "failed")
                    ) || is_error != Some(status == Some("failed"))))
            {
                return false;
            }
            let Some(content) = content else { return false };
            let expected_digest = if version == 1 {
                if content == "Completed" {
                    hash("completed")
                } else {
                    hash("failed")
                }
            } else {
                tool_result_semantic_digest(
                    status.unwrap_or_default(),
                    content,
                    is_error.unwrap_or_default(),
                )
            };
            (
                "tool_result",
                Some(content),
                entry.get("toolUseId").and_then(Value::as_str),
                Some(expected_digest),
            )
        }
        "truncated" => (
            "system",
            entry.get("text").and_then(Value::as_str),
            None,
            Some(hash(TRUNCATED_TEXT)),
        ),
        _ => return false,
    };
    let Some(content) = content else { return false };
    if entry.get("kind").and_then(Value::as_str) != Some(kind)
        || expected_digest.as_deref() != Some(source.content_digest.as_str())
        || content.len() > MAX_PROGRESS_TEXT_BYTES as usize
        || entry_text_bytes_for_version(version, entry) > MAX_PROGRESS_TEXT_BYTES as usize
    {
        return false;
    }
    match (source.item_digest.as_deref(), item) {
        (None, None) => true,
        (Some(expected), Some(actual)) => {
            expected == actual && expected.strip_prefix("hermes-").is_some_and(valid_hash)
        }
        _ => false,
    }
}

fn has_exact_keys(value: &Value, expected: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.hyphenated().to_string() == value)
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "10000000-0000-4000-8000-000000000001";
    const GENERATION: &str = "10000000-0000-4000-8000-000000000002";
    const RUN: &str = "10000000-0000-4000-8000-000000000003";
    const ATTEMPT: &str = "10000000-0000-4000-8000-000000000004";
    const MESSAGE: &str = "10000000-0000-4000-8000-000000000005";

    fn source(
        version: u8,
        kind: &str,
        item_digest: Option<String>,
        content_digest: String,
    ) -> Source {
        let mut source = Source {
            version,
            organization_id: ORG.into(),
            generation_id: GENERATION.into(),
            run_id: RUN.into(),
            attempt_id: ATTEMPT.into(),
            generation_attempt_epoch: 1,
            run_attempt_epoch: 1,
            connection_epoch: 1,
            connection_id: "connection-receipt".into(),
            claim_digest: hash("claim"),
            assistant_message_id: MESSAGE.into(),
            source_message_digest: hash("source-message"),
            input_fingerprint_digest: hash("input-fingerprint"),
            session_digest: hash("session-selector"),
            request_id: 1,
            ordinal: 1,
            kind: kind.into(),
            item_digest,
            content_digest,
            fingerprint: String::new(),
        };
        source.fingerprint = source_fingerprint(&source);
        source
    }

    fn tool_call_projection(tool_use_id: &str) -> Value {
        let name = "Inspecting fixture";
        let input = json!({});
        let source = source(1, "tool_call", Some(tool_use_id.into()), hash(name));
        json!({
            "entry": {
                "kind": "tool_call",
                "ts": "2026-10-21T00:00:00Z",
                "name": name,
                "input": input,
                "toolUseId": tool_use_id,
            },
            "nativeSource": source,
            "bodyHash": hash(""),
        })
    }

    fn tool_call_v2_projection(name: &str, input: Value) -> Value {
        let tool_use_id = format!("hermes-{}", hash("opaque tool use"));
        let source = source(
            2,
            "tool_call",
            Some(tool_use_id.clone()),
            tool_call_semantic_digest(name, &input),
        );
        json!({
            "entry": {
                "kind": "tool_call",
                "ts": "2026-10-21T00:00:00Z",
                "name": name,
                "input": input,
                "toolUseId": tool_use_id,
            },
            "nativeSource": source,
            "bodyHash": hash(""),
        })
    }

    fn tool_result_v2_projection(status: &str, content: &str) -> Value {
        let tool_use_id = format!("hermes-{}", hash("opaque tool use"));
        let is_error = status == "failed";
        let source = source(
            2,
            "tool_call_update",
            Some(tool_use_id.clone()),
            tool_result_semantic_digest(status, content, is_error),
        );
        json!({
            "entry": {
                "kind": "tool_result",
                "ts": "2026-10-21T00:00:00Z",
                "toolUseId": tool_use_id,
                "status": status,
                "content": content,
                "isError": is_error,
            },
            "nativeSource": source,
            "bodyHash": hash(""),
        })
    }

    fn tool_result_v1_projection(content: &str, status: &str) -> Value {
        let tool_use_id = format!("hermes-{}", hash("opaque tool use"));
        let source = source(
            1,
            "tool_call_update",
            Some(tool_use_id.clone()),
            hash(status),
        );
        json!({
            "entry": {
                "kind": "tool_result",
                "ts": "2026-10-21T00:00:00Z",
                "toolUseId": tool_use_id,
                "content": content,
                "isError": status == "failed",
            },
            "nativeSource": source,
            "bodyHash": hash(""),
        })
    }

    #[test]
    fn legacy_v1_projection_keeps_the_original_shape_and_rejects_private_fields() {
        let valid_id = format!("hermes-{}", hash("opaque tool use"));
        let valid = tool_call_projection(&valid_id);
        assert!(validate_public_projection(&valid, ORG, GENERATION, RUN, 1, MESSAGE).is_some());

        let mut leaked_tool_input = valid.clone();
        leaked_tool_input["entry"]["rawInput"] = json!({"secret":"must not project"});
        assert!(
            validate_public_projection(&leaked_tool_input, ORG, GENERATION, RUN, 1, MESSAGE)
                .is_none()
        );

        let multibyte_id = "hermes-é";
        let malformed = tool_call_projection(multibyte_id);
        assert!(validate_public_projection(&malformed, ORG, GENERATION, RUN, 1, MESSAGE).is_none());

        let mut v1_input_changed = valid.clone();
        v1_input_changed["entry"]["input"] =
            json!({"command":"do not retroactively allow v1 input"});
        assert!(
            validate_public_projection(&v1_input_changed, ORG, GENERATION, RUN, 1, MESSAGE)
                .is_none()
        );

        let legacy_result = tool_result_v1_projection("Completed", "completed");
        assert!(
            validate_public_projection(&legacy_result, ORG, GENERATION, RUN, 1, MESSAGE).is_some()
        );
        let mut legacy_result_with_status = legacy_result;
        legacy_result_with_status["entry"]["status"] = json!("completed");
        assert!(
            validate_public_projection(
                &legacy_result_with_status,
                ORG,
                GENERATION,
                RUN,
                1,
                MESSAGE
            )
            .is_none()
        );
    }

    #[test]
    fn v2_tool_call_projects_only_bounded_public_string_inputs_and_binds_them() {
        let input = json!({"command":"cargo test -p rudder-d1-persistence", "path":"native/"});
        let mut valid = tool_call_v2_projection("terminal", input.clone());
        assert!(validate_public_projection(&valid, ORG, GENERATION, RUN, 1, MESSAGE).is_some());

        let fingerprint = valid["nativeSource"]["fingerprint"].clone();
        valid["entry"]["ts"] = json!("2026-10-21T00:01:00Z");
        assert_eq!(valid["nativeSource"]["fingerprint"], fingerprint);
        assert!(validate_public_projection(&valid, ORG, GENERATION, RUN, 1, MESSAGE).is_some());
        let shared_input = json!({"details":"Inspect the file", "path":"native/"});
        let read_file = tool_call_v2_projection("read_file", shared_input.clone());
        let changed_name = tool_call_v2_projection("write_file", shared_input);
        assert_ne!(changed_name["nativeSource"]["fingerprint"], fingerprint);
        assert!(validate_public_projection(&read_file, ORG, GENERATION, RUN, 1, MESSAGE).is_some());
        assert!(
            validate_public_projection(&changed_name, ORG, GENERATION, RUN, 1, MESSAGE).is_some()
        );

        let mut tampered_input = valid.clone();
        tampered_input["entry"]["input"]["command"] = json!("different command");
        assert!(
            validate_public_projection(&tampered_input, ORG, GENERATION, RUN, 1, MESSAGE).is_none()
        );

        let unknown = tool_call_v2_projection("terminal", json!({"rawInput":"private"}));
        assert!(validate_public_projection(&unknown, ORG, GENERATION, RUN, 1, MESSAGE).is_none());
        let nested = tool_call_v2_projection("terminal", json!({"command":{"token":"secret"}}));
        assert!(validate_public_projection(&nested, ORG, GENERATION, RUN, 1, MESSAGE).is_none());
        let mismatched_name =
            tool_call_v2_projection("terminal", json!({"code":"private command"}));
        assert!(
            validate_public_projection(&mismatched_name, ORG, GENERATION, RUN, 1, MESSAGE)
                .is_none()
        );
        let oversized = tool_call_v2_projection(
            "terminal",
            json!({"command":"x".repeat(MAX_TOOL_INPUT_FIELD_BYTES + 1)}),
        );
        assert!(validate_public_projection(&oversized, ORG, GENERATION, RUN, 1, MESSAGE).is_none());
        let near_limit_input = json!({
            "code":"x".repeat(12 * 1024),
            "path":"x".repeat(MAX_TOOL_PATH_BYTES),
        });
        assert!(near_limit_input.to_string().len() <= MAX_TOOL_INPUT_BYTES);
        assert!(valid_public_tool_input("execute_code", &near_limit_input));
        let near_limit = tool_call_v2_projection("execute_code", near_limit_input);
        assert!(
            validate_public_projection(&near_limit, ORG, GENERATION, RUN, 1, MESSAGE).is_some()
        );
        assert!(entry_text_bytes(&valid["entry"]) > input["command"].as_str().unwrap().len());
    }

    #[test]
    fn v2_tool_results_preserve_real_empty_and_failed_output_with_truthful_status() {
        let completed = tool_result_v2_projection("completed", "found three matching files");
        assert_eq!(completed["entry"]["content"], "found three matching files");
        assert_eq!(completed["entry"]["status"], "completed");
        assert_eq!(completed["entry"]["isError"], false);
        assert!(validate_public_projection(&completed, ORG, GENERATION, RUN, 1, MESSAGE).is_some());

        let empty = tool_result_v2_projection("completed", "");
        assert_eq!(empty["entry"]["content"], "");
        assert!(validate_public_projection(&empty, ORG, GENERATION, RUN, 1, MESSAGE).is_some());

        let failed = tool_result_v2_projection("failed", "permission denied");
        assert_eq!(failed["entry"]["status"], "failed");
        assert_eq!(failed["entry"]["isError"], true);
        assert!(validate_public_projection(&failed, ORG, GENERATION, RUN, 1, MESSAGE).is_some());
        let empty_failure = tool_result_v2_projection("failed", "");
        assert_eq!(empty_failure["entry"]["content"], "");
        assert_eq!(empty_failure["entry"]["isError"], true);
        assert!(
            validate_public_projection(&empty_failure, ORG, GENERATION, RUN, 1, MESSAGE).is_some()
        );

        let mut tampered_output = failed.clone();
        tampered_output["entry"]["content"] = json!("fabricated success");
        assert!(
            validate_public_projection(&tampered_output, ORG, GENERATION, RUN, 1, MESSAGE)
                .is_none()
        );
        let mut tampered_failure = failed;
        tampered_failure["entry"]["isError"] = json!(false);
        assert!(
            validate_public_projection(&tampered_failure, ORG, GENERATION, RUN, 1, MESSAGE)
                .is_none()
        );
        let oversized =
            tool_result_v2_projection("completed", &"x".repeat(MAX_TOOL_OUTPUT_BYTES + 1));
        assert!(validate_public_projection(&oversized, ORG, GENERATION, RUN, 1, MESSAGE).is_none());
    }

    #[test]
    fn v2_tool_update_keeps_nonterminal_status_and_timestamp_out_of_semantic_digest() {
        let mut running = tool_result_v2_projection("in_progress", "partial output");
        assert_eq!(running["entry"]["status"], "in_progress");
        assert!(validate_public_projection(&running, ORG, GENERATION, RUN, 1, MESSAGE).is_some());

        let fingerprint = running["nativeSource"]["fingerprint"].clone();
        running["entry"]["ts"] = json!("2026-10-21T00:01:00Z");
        assert_eq!(running["nativeSource"]["fingerprint"], fingerprint);
        assert!(validate_public_projection(&running, ORG, GENERATION, RUN, 1, MESSAGE).is_some());

        assert_ne!(
            tool_result_semantic_digest("in_progress", "partial output", false),
            tool_result_semantic_digest("completed", "partial output", false),
        );
        assert_ne!(
            tool_result_semantic_digest("failed", "partial output", true),
            tool_result_semantic_digest("completed", "partial output", false),
        );
    }
}
