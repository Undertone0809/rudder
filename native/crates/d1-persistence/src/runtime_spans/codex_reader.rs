//! Read-only authorization and identity fencing for the bounded Codex Reader.
//!
//! Provider IPC is deliberately owned by server-foundation. These functions
//! return only a persisted exact-turn plan and later revalidate that plan in a
//! fresh SQL transaction before the provider projection can be returned.

use rudder_auth_core::VerifiedActor;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

use crate::runtime_bindings;

use super::{
    Request,
    projection::span_and_segment,
    validation::{Result, canonical_uuid, http},
};

pub struct CodexTranscriptReadPlan {
    organization_id: String,
    conversation_id: String,
    message_id: String,
    run_id: String,
    generation_id: String,
    span_id: String,
    binding_id: String,
    segment_id: String,
    attempt_id: String,
    span_attempt_epoch: i32,
    run_attempt_epoch: i32,
    generation_epoch: i32,
    connection_epoch: i32,
    agent_id: String,
    host_id: String,
    profile_id: String,
    principal_scope_ref: String,
    thread_id: String,
    turn_id: String,
    message_timestamp: String,
    limit: i32,
}

impl CodexTranscriptReadPlan {
    pub fn organization_id(&self) -> &str {
        &self.organization_id
    }
    pub fn conversation_id(&self) -> &str {
        &self.conversation_id
    }
    pub fn message_id(&self) -> &str {
        &self.message_id
    }
    pub fn run_id(&self) -> &str {
        &self.run_id
    }
    pub fn generation_id(&self) -> &str {
        &self.generation_id
    }
    pub fn span_id(&self) -> &str {
        &self.span_id
    }
    pub fn binding_id(&self) -> &str {
        &self.binding_id
    }
    pub fn segment_id(&self) -> &str {
        &self.segment_id
    }
    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }
    pub fn span_attempt_epoch(&self) -> i32 {
        self.span_attempt_epoch
    }
    pub fn run_attempt_epoch(&self) -> i32 {
        self.run_attempt_epoch
    }
    pub fn generation_epoch(&self) -> i32 {
        self.generation_epoch
    }
    pub fn connection_epoch(&self) -> i32 {
        self.connection_epoch
    }
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }
    pub fn host_id(&self) -> &str {
        &self.host_id
    }
    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }
    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }
    pub fn turn_id(&self) -> &str {
        &self.turn_id
    }
    pub fn message_timestamp(&self) -> &str {
        &self.message_timestamp
    }
    pub fn limit(&self) -> i32 {
        self.limit
    }
}

pub enum CodexTranscriptReadPreflight {
    /// Existing event-ledger rows remain authoritative.
    LedgerPresent,
    /// This request is not the first page of an ordinary native chat read.
    NotApplicable,
    /// Missing history cannot be safely read from one exact terminal Codex turn.
    Incomplete(&'static str),
    Read(Box<CodexTranscriptReadPlan>),
}

pub enum CodexTranscriptReadCompletion {
    /// A Stop/cutoff/source/identity change won the race; caller must reread
    /// the accepted SQL prefix and discard provider output.
    UseSqlPrefix,
    Complete(Value),
}

/// Prepare a Codex read only for an empty first SQL page and only when the
/// entire eligible event prefix has no source rows. This transaction ends
/// before any process is launched by server-foundation.
pub async fn prepare(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &Request,
) -> Result<CodexTranscriptReadPreflight> {
    let Request::ReadMessageTranscript {
        conversation_id: raw_conversation_id,
        message_id: raw_message_id,
        after_seq,
        limit,
    } = request
    else {
        return Err(http(400, "Expected a message transcript read request"));
    };
    if *after_seq != 0 {
        return Ok(CodexTranscriptReadPreflight::NotApplicable);
    }
    let conversation_id = canonical_uuid(raw_conversation_id, "conversation id")?;
    let message_id = canonical_uuid(raw_message_id, "message id")?;
    let organization_id = canonical_uuid(organization_id, "organization id")?;
    let limit = (*limit).clamp(1, 100);
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *tx)
        .await?;

    let rows = sqlx::query(
        "SELECT c.conversation_kind, c.preferred_agent_id::text AS preferred_agent_id,
                c.routed_agent_id::text AS routed_agent_id,
                m.created_at::text AS message_timestamp, m.run_id::text AS run_id,
                r.execution_authority, r.chat_conversation_id::text AS run_conversation_id,
                r.chat_generation_id::text AS generation_id, r.status AS run_status,
                g.status AS generation_status, g.terminal_reason, g.stop_requested_at IS NOT NULL AS stop_requested,
                g.accepted_through_seq, g.runtime_terminal_at IS NOT NULL AS runtime_terminal,
                g.attempt_epoch AS generation_epoch, g.provider_thread_id AS generation_thread_id,
                g.provider_turn_id AS generation_turn_id,
                s.id::text AS span_id, s.binding_id::text AS binding_id,
                s.segment_id::text AS segment_id, s.attempt_id::text AS attempt_id,
                s.attempt_epoch AS span_attempt_epoch, s.state AS span_state,
                s.completeness AS span_completeness, s.native_execution_ref,
                s.selector_json, b.agent_id::text AS agent_id, b.host_id, b.profile_id,
                b.runtime_type AS binding_runtime_type, b.target_type, b.target_id,
                b.principal_scope_ref, n.runtime_type AS segment_runtime_type,
                n.state AS segment_state, a.runtime_type AS attempt_runtime_type,
                a.status AS attempt_status, a.attempt_epoch AS run_attempt_epoch,
                a.generation_attempt_epoch, a.connection_epoch, a.protocol_phase,
                a.checkpoint_json, a.provider_thread_id AS attempt_thread_id,
                a.provider_turn_id AS attempt_turn_id,
                (SELECT count(*) FROM run_runtime_spans s2
                 WHERE s2.org_id=r.org_id AND s2.run_id=r.id AND s2.relation='primary') AS primary_span_count,
                (SELECT count(*) FROM heartbeat_run_attempts a2
                 WHERE a2.org_id=r.org_id AND a2.run_id=r.id) AS run_attempt_count
         FROM chat_messages m
         JOIN chat_conversations c ON c.org_id=m.org_id AND c.id=m.conversation_id
         LEFT JOIN heartbeat_runs r ON r.org_id=m.org_id AND r.id=m.run_id
         LEFT JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         LEFT JOIN run_runtime_spans s ON s.org_id=r.org_id AND s.run_id=r.id AND s.relation='primary'
         LEFT JOIN runtime_bindings b ON b.org_id=s.org_id AND b.id=s.binding_id
         LEFT JOIN native_segments n ON n.org_id=s.org_id AND n.binding_id=s.binding_id AND n.id=s.segment_id
         LEFT JOIN heartbeat_run_attempts a ON a.org_id=s.org_id AND a.run_id=s.run_id AND a.id=s.attempt_id
         WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid
           AND m.id=$3::uuid AND m.role='assistant'
         ORDER BY s.ordinal ASC",
    )
    .bind(&organization_id)
    .bind(&conversation_id)
    .bind(&message_id)
    .fetch_all(&mut *tx)
    .await?;
    let Some(first) = rows.first() else {
        return Err(http(404, "Chat message not found"));
    };
    let conversation_kind: String = first.try_get("conversation_kind")?;
    let auth_agent = rows
        .iter()
        .find_map(|row| row.try_get::<Option<String>, _>("agent_id").ok().flatten())
        .or(first.try_get::<Option<String>, _>("preferred_agent_id")?)
        .or(first.try_get::<Option<String>, _>("routed_agent_id")?);
    let authorized_scope = if let Some(agent_id) = auth_agent.as_deref() {
        runtime_bindings::authorize_chat_target_read_tx(
            &mut tx,
            actor,
            &organization_id,
            &conversation_id,
            agent_id,
        )
        .await?
    } else {
        runtime_bindings::authorize_chat_target_read_without_agent_tx(
            &mut tx,
            actor,
            &organization_id,
            &conversation_id,
        )
        .await?
    };
    if conversation_kind == "side_chat" {
        tx.commit().await?;
        return Ok(CodexTranscriptReadPreflight::NotApplicable);
    }
    if conversation_kind != "chat" {
        tx.commit().await?;
        return Ok(CodexTranscriptReadPreflight::NotApplicable);
    }
    let Some(run_id) = first.try_get::<Option<String>, _>("run_id")? else {
        tx.commit().await?;
        return Ok(CodexTranscriptReadPreflight::NotApplicable);
    };
    let Some(generation_id) = first.try_get::<Option<String>, _>("generation_id")? else {
        tx.commit().await?;
        return Ok(CodexTranscriptReadPreflight::NotApplicable);
    };
    if first
        .try_get::<Option<String>, _>("execution_authority")?
        .as_deref()
        != Some("native_rust")
    {
        tx.commit().await?;
        return Ok(CodexTranscriptReadPreflight::NotApplicable);
    }

    let has_source: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM chat_generation_events e
           WHERE e.org_id=$1::uuid AND e.generation_id=$2::uuid
             AND e.event_kind IN ('assistant_delta','runtime_output','transcript')
             AND ($3::integer IS NULL OR e.generation_seq <= $3)
         )",
    )
    .bind(&organization_id)
    .bind(&generation_id)
    .bind(first.try_get::<Option<i32>, _>("accepted_through_seq")?)
    .fetch_one(&mut *tx)
    .await?;
    if has_source {
        tx.commit().await?;
        return Ok(CodexTranscriptReadPreflight::LedgerPresent);
    }
    let reason = if first.try_get::<bool, _>("stop_requested")?
        || first
            .try_get::<Option<i32>, _>("accepted_through_seq")?
            .is_some()
        || first
            .try_get::<Option<String>, _>("terminal_reason")?
            .as_deref()
            == Some("operator_stop")
    {
        Some("frozen_prefix")
    } else if first
        .try_get::<Option<String>, _>("generation_status")?
        .as_deref()
        != Some("completed")
        || !first.try_get::<bool, _>("runtime_terminal")?
    {
        Some("generation_not_terminal")
    } else if first.try_get::<Option<String>, _>("run_status")?.as_deref() != Some("succeeded") {
        Some("run_not_successful")
    } else {
        None
    };
    if let Some(reason) = reason {
        tx.commit().await?;
        return Ok(CodexTranscriptReadPreflight::Incomplete(reason));
    }

    if rows.len() != 1 {
        tx.commit().await?;
        return Ok(CodexTranscriptReadPreflight::Incomplete(
            "ambiguous_primary_span",
        ));
    }
    let row = &rows[0];
    if row.try_get::<i64, _>("primary_span_count")? != 1
        || row.try_get::<i64, _>("run_attempt_count")? != 1
    {
        tx.commit().await?;
        return Ok(CodexTranscriptReadPreflight::Incomplete(
            "ambiguous_attempt",
        ));
    }
    let required_string = |name: &'static str| -> Result<String> {
        row.try_get::<Option<String>, _>(name)?
            .ok_or_else(|| http(409, "Exact Codex transcript identity is incomplete"))
    };
    let agent_id = required_string("agent_id")?;
    let binding_id = required_string("binding_id")?;
    let segment_id = required_string("segment_id")?;
    let span_id = required_string("span_id")?;
    let attempt_id = required_string("attempt_id")?;
    let profile_id = required_string("profile_id")?;
    let host_id = required_string("host_id")?;
    let principal_scope_ref = required_string("principal_scope_ref")?;
    let thread_id = required_string("attempt_thread_id")?;
    let turn_id = required_string("attempt_turn_id")?;
    let checkpoint: Value = row.try_get("checkpoint_json")?;
    let selector: Value = row.try_get("selector_json")?;
    let accepted = row.try_get::<Option<i32>, _>("accepted_through_seq")?;
    let eligible = row
        .try_get::<Option<String>, _>("attempt_runtime_type")?
        .as_deref()
        == Some("codex_local")
        && row
            .try_get::<Option<String>, _>("binding_runtime_type")?
            .as_deref()
            == Some("codex_local")
        && row
            .try_get::<Option<String>, _>("segment_runtime_type")?
            .as_deref()
            == Some("codex_local")
        && row
            .try_get::<Option<String>, _>("attempt_status")?
            .as_deref()
            == Some("succeeded")
        && row
            .try_get::<Option<String>, _>("protocol_phase")?
            .as_deref()
            == Some("execution_terminal_committed")
        && row.try_get::<Option<String>, _>("span_state")?.as_deref() == Some("sealed")
        && row
            .try_get::<Option<String>, _>("span_completeness")?
            .as_deref()
            == Some("terminal_only")
        && row
            .try_get::<Option<String>, _>("segment_state")?
            .as_deref()
            == Some("sealed")
        && row.try_get::<Option<String>, _>("target_type")?.as_deref() == Some("chat_conversation")
        && row.try_get::<Option<String>, _>("target_id")?.as_deref()
            == Some(conversation_id.as_str())
        && row
            .try_get::<Option<String>, _>("run_conversation_id")?
            .as_deref()
            == Some(conversation_id.as_str())
        && row.try_get::<Option<i32>, _>("generation_attempt_epoch")?
            == row.try_get::<Option<i32>, _>("generation_epoch")?
        && row.try_get::<Option<i32>, _>("span_attempt_epoch")?
            == row.try_get::<Option<i32>, _>("run_attempt_epoch")?
        && row
            .try_get::<Option<String>, _>("generation_thread_id")?
            .as_deref()
            == Some(thread_id.as_str())
        && row
            .try_get::<Option<String>, _>("generation_turn_id")?
            .as_deref()
            == Some(turn_id.as_str())
        && row
            .try_get::<Option<String>, _>("native_execution_ref")?
            .as_deref()
            == Some(turn_id.as_str())
        && selector["kind"] == "codex_turn"
        && selector["threadId"].as_str() == Some(thread_id.as_str())
        && selector["turnId"].as_str() == Some(turn_id.as_str())
        && checkpoint["phase"] == "execution_terminal_committed"
        && checkpoint["threadId"].as_str() == Some(thread_id.as_str())
        && checkpoint["turnId"].as_str() == Some(turn_id.as_str())
        && accepted.is_none()
        && !row.try_get::<bool, _>("stop_requested")?;
    if !eligible || principal_scope_ref != authorized_scope {
        tx.commit().await?;
        return Ok(CodexTranscriptReadPreflight::Incomplete(
            "exact_codex_turn_unavailable",
        ));
    }
    let attempt_epoch = row
        .try_get::<Option<i32>, _>("run_attempt_epoch")?
        .ok_or_else(|| http(409, "Exact Codex attempt epoch is missing"))?;
    let generation_epoch = row
        .try_get::<Option<i32>, _>("generation_epoch")?
        .ok_or_else(|| http(409, "Exact Codex generation epoch is missing"))?;
    let connection_epoch = row
        .try_get::<Option<i32>, _>("connection_epoch")?
        .ok_or_else(|| http(409, "Exact Codex connection epoch is missing"))?;
    let span_attempt_epoch = row
        .try_get::<Option<i32>, _>("span_attempt_epoch")?
        .ok_or_else(|| http(409, "Exact Codex span epoch is missing"))?;
    let message_timestamp: String = row.try_get("message_timestamp")?;
    tx.commit().await?;
    Ok(CodexTranscriptReadPreflight::Read(Box::new(
        CodexTranscriptReadPlan {
            organization_id,
            conversation_id,
            message_id,
            run_id,
            generation_id,
            span_id,
            binding_id,
            segment_id,
            attempt_id,
            span_attempt_epoch,
            run_attempt_epoch: attempt_epoch,
            generation_epoch,
            connection_epoch,
            agent_id,
            host_id,
            profile_id,
            principal_scope_ref,
            thread_id,
            turn_id,
            message_timestamp,
            limit,
        },
    )))
}

/// Reauthorize the exact historical identity after Codex IPC. A new Stop,
/// accepted cutoff, new ledger source, or changed identity discards provider
/// output and asks Foundation to return only the current SQL prefix.
pub async fn complete(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    plan: &CodexTranscriptReadPlan,
    transcript: &[Value],
) -> Result<CodexTranscriptReadCompletion> {
    let organization_id = canonical_uuid(organization_id, "organization id")?;
    if plan.organization_id != organization_id || actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION READ ONLY")
        .execute(&mut *tx)
        .await?;
    let rows = sqlx::query(
        "SELECT c.conversation_kind, b.agent_id::text AS agent_id,
                b.principal_scope_ref, b.profile_id, b.host_id,
                b.runtime_type AS binding_runtime_type,
                r.id::text AS run_id, r.chat_generation_id::text AS generation_id,
                g.status AS generation_status, g.terminal_reason,
                g.stop_requested_at IS NOT NULL AS stop_requested,
                g.accepted_through_seq, g.runtime_terminal_at IS NOT NULL AS runtime_terminal,
                g.attempt_epoch AS generation_epoch, g.provider_thread_id AS generation_thread_id,
                g.provider_turn_id AS generation_turn_id, r.status AS run_status,
                s.id::text AS span_id, s.binding_id::text AS binding_id,
                s.segment_id::text AS segment_id, s.attempt_id::text AS attempt_id,
                s.attempt_epoch AS span_attempt_epoch, s.state AS span_state,
                s.completeness AS span_completeness, s.native_execution_ref,
                s.selector_json, n.state AS segment_state,
                n.runtime_type AS segment_runtime_type,
                a.runtime_type AS attempt_runtime_type, a.status AS attempt_status,
                a.attempt_epoch AS run_attempt_epoch, a.generation_attempt_epoch,
                a.connection_epoch, a.protocol_phase, a.checkpoint_json,
                a.provider_thread_id AS attempt_thread_id,
                a.provider_turn_id AS attempt_turn_id,
                (SELECT count(*) FROM run_runtime_spans s2
                 WHERE s2.org_id=r.org_id AND s2.run_id=r.id AND s2.relation='primary') AS primary_span_count,
                (SELECT count(*) FROM heartbeat_run_attempts a2
                 WHERE a2.org_id=r.org_id AND a2.run_id=r.id) AS run_attempt_count,
                (SELECT EXISTS(
                   SELECT 1 FROM chat_generation_events e
                   WHERE e.org_id=g.org_id AND e.generation_id=g.id
                     AND e.event_kind IN ('assistant_delta','runtime_output','transcript')
                 )) AS has_event_source
         FROM chat_messages m
         JOIN chat_conversations c ON c.org_id=m.org_id AND c.id=m.conversation_id
         JOIN heartbeat_runs r ON r.org_id=m.org_id AND r.id=m.run_id
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         JOIN run_runtime_spans s ON s.org_id=r.org_id AND s.run_id=r.id AND s.relation='primary'
         JOIN runtime_bindings b ON b.org_id=s.org_id AND b.id=s.binding_id
         JOIN native_segments n ON n.org_id=s.org_id AND n.binding_id=s.binding_id AND n.id=s.segment_id
         JOIN heartbeat_run_attempts a ON a.org_id=s.org_id AND a.run_id=s.run_id AND a.id=s.attempt_id
         WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid AND m.id=$3::uuid
           AND m.role='assistant' AND r.execution_authority='native_rust'
           AND r.chat_conversation_id=c.id AND g.execution_authority='native_rust'
           AND b.target_type='chat_conversation' AND b.target_id=c.id::text
           AND s.id=$4::uuid AND s.binding_id=$5::uuid AND s.segment_id=$6::uuid
           AND s.attempt_id=$7::uuid AND s.attempt_epoch=$8
           AND a.attempt_epoch=$9 AND g.attempt_epoch=$10 AND a.connection_epoch=$11
         LIMIT 2",
    )
    .bind(&organization_id)
    .bind(&plan.conversation_id)
    .bind(&plan.message_id)
    .bind(&plan.span_id)
    .bind(&plan.binding_id)
    .bind(&plan.segment_id)
    .bind(&plan.attempt_id)
    .bind(plan.span_attempt_epoch)
    .bind(plan.run_attempt_epoch)
    .bind(plan.generation_epoch)
    .bind(plan.connection_epoch)
    .fetch_all(&mut *tx)
    .await?;
    if rows.len() != 1 {
        tx.commit().await?;
        return Ok(CodexTranscriptReadCompletion::UseSqlPrefix);
    }
    let row = &rows[0];
    let authorized_scope = runtime_bindings::authorize_chat_target_read_tx(
        &mut tx,
        actor,
        &organization_id,
        &plan.conversation_id,
        &plan.agent_id,
    )
    .await?;
    let checkpoint: Value = row.try_get("checkpoint_json")?;
    let selector: Value = row.try_get("selector_json")?;
    let same_identity = row.try_get::<String, _>("conversation_kind")? == "chat"
        && row.try_get::<String, _>("agent_id")? == plan.agent_id
        && row.try_get::<String, _>("principal_scope_ref")? == plan.principal_scope_ref
        && row.try_get::<String, _>("profile_id")? == plan.profile_id
        && row.try_get::<String, _>("host_id")? == plan.host_id
        && row.try_get::<String, _>("binding_runtime_type")? == "codex_local"
        && row.try_get::<String, _>("segment_runtime_type")? == "codex_local"
        && row.try_get::<String, _>("run_id")? == plan.run_id
        && row.try_get::<String, _>("generation_id")? == plan.generation_id
        && row.try_get::<String, _>("attempt_runtime_type")? == "codex_local"
        && row.try_get::<String, _>("attempt_status")? == "succeeded"
        && row.try_get::<String, _>("protocol_phase")? == "execution_terminal_committed"
        && row.try_get::<String, _>("span_state")? == "sealed"
        && row.try_get::<String, _>("span_completeness")? == "terminal_only"
        && row.try_get::<String, _>("segment_state")? == "sealed"
        && row.try_get::<String, _>("generation_status")? == "completed"
        && row.try_get::<String, _>("run_status")? == "succeeded"
        && row.try_get::<i64, _>("primary_span_count")? == 1
        && row.try_get::<i64, _>("run_attempt_count")? == 1
        && row.try_get::<String, _>("attempt_thread_id")? == plan.thread_id
        && row.try_get::<String, _>("attempt_turn_id")? == plan.turn_id
        && row.try_get::<String, _>("generation_thread_id")? == plan.thread_id
        && row.try_get::<String, _>("generation_turn_id")? == plan.turn_id
        && row.try_get::<String, _>("native_execution_ref")? == plan.turn_id
        && row.try_get::<i32, _>("generation_attempt_epoch")? == plan.generation_epoch
        && selector["kind"] == "codex_turn"
        && selector["threadId"].as_str() == Some(plan.thread_id.as_str())
        && selector["turnId"].as_str() == Some(plan.turn_id.as_str())
        && checkpoint["phase"] == "execution_terminal_committed"
        && checkpoint["threadId"].as_str() == Some(plan.thread_id.as_str())
        && checkpoint["turnId"].as_str() == Some(plan.turn_id.as_str());
    if !same_identity || authorized_scope != plan.principal_scope_ref {
        tx.commit().await?;
        return Ok(CodexTranscriptReadCompletion::UseSqlPrefix);
    }
    if row.try_get::<bool, _>("stop_requested")?
        || row
            .try_get::<Option<i32>, _>("accepted_through_seq")?
            .is_some()
        || row
            .try_get::<Option<String>, _>("terminal_reason")?
            .as_deref()
            == Some("operator_stop")
        || row.try_get::<bool, _>("has_event_source")?
    {
        tx.commit().await?;
        return Ok(CodexTranscriptReadCompletion::UseSqlPrefix);
    }
    if transcript.is_empty() {
        tx.commit().await?;
        return Ok(CodexTranscriptReadCompletion::Complete(
            incomplete_response(plan, "transcript_unavailable"),
        ));
    }
    if transcript.len() > plan.limit as usize {
        tx.commit().await?;
        return Ok(CodexTranscriptReadCompletion::Complete(
            incomplete_response(plan, "transcript_exceeds_requested_page"),
        ));
    }
    let span = span_and_segment(
        &mut tx,
        &organization_id,
        &plan.span_id,
        &plan.binding_id,
        &plan.segment_id,
    )
    .await?;
    tx.commit().await?;
    let transcript = transcript.to_vec();
    Ok(CodexTranscriptReadCompletion::Complete(json!({
        "messageId":plan.message_id,
        "messageRef":plan.message_id,
        "transcript":transcript,
        "reader":{
            "source":"codex_exact_turn",
            "spanId":plan.span_id,
            "revision":0,
            "availability":"complete",
            "completeness":"terminal_only",
            "nextCursor":Value::Null
        },
        "span":span
    })))
}

pub fn incomplete_response(plan: &CodexTranscriptReadPlan, reason: &str) -> Value {
    json!({
        "messageId":plan.message_id,
        "messageRef":plan.message_id,
        "transcript":[],
        "reader":{
            "source":"codex_exact_turn",
            "spanId":plan.span_id,
            "revision":0,
            "availability":"incomplete",
            "reason":reason,
            "nextCursor":Value::Null
        }
    })
}
