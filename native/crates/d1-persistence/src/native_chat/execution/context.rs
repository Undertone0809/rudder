use super::{ExecutionFence, Result, http};
use crate::native_chat::NativeChatExecutionActor;
use crate::runtime_bindings;
use rudder_runtime_core::native_chat::{
    ClaudeSessionSelector, CursorSessionSelector, NativeChatProtocolCheckpoint,
    NativeChatProtocolPhase, NativeChatProvider, OpenCodeSessionSelector,
};
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};

pub(super) struct LockedExecution {
    pub(super) checkpoint: NativeChatProtocolCheckpoint,
    pub(super) agent_id: String,
    pub(super) binding_id: String,
    pub(super) segment_id: String,
    pub(super) segment_state: String,
    pub(super) native_session_id: Option<String>,
    pub(super) admitted_message_id: Option<String>,
    pub(super) admitted_input_fingerprint: Option<String>,
}

/// Reauthorize and lock in the shared Conversation -> Generation -> Run ->
/// Attempt order. Every owner/epoch/lease check is repeated from database rows;
/// an in-memory fence alone never grants authority.
pub(super) async fn lock_current_execution(
    tx: &mut Transaction<'_, Postgres>,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
) -> Result<LockedExecution> {
    lock_execution(tx, actor, fence, None).await
}

pub(super) async fn lock_stopping_execution(
    tx: &mut Transaction<'_, Postgres>,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: &super::stopping::StopIntent,
) -> Result<LockedExecution> {
    lock_execution(tx, actor, fence, Some(stop)).await
}

async fn lock_execution(
    tx: &mut Transaction<'_, Postgres>,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
    stop: Option<&super::stopping::StopIntent>,
) -> Result<LockedExecution> {
    let id = fence.identity();
    if actor.organization_id() != id.organization_id {
        return Err(http(403, "Organization access denied"));
    }
    super::super::auth::preauthorize_execution_org(tx, actor, fence).await?;

    let hint = sqlx::query(
        "SELECT agent_id::text AS agent_id,
                chat_conversation_id::text AS conversation_id,
                chat_generation_id::text AS generation_id
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(id.organization_id)
    .bind(id.run_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Run not found"))?;
    let hinted_agent_id: String = hint.try_get("agent_id")?;
    let hinted_conversation_id: Option<String> = hint.try_get("conversation_id")?;
    let hinted_generation_id: Option<String> = hint.try_get("generation_id")?;
    if hinted_conversation_id.as_deref() != Some(id.conversation_id)
        || hinted_generation_id.as_deref() != Some(id.generation_id)
        || hinted_agent_id != id.agent_id
    {
        return Err(http(409, "Run execution identity changed"));
    }

    // Verify access before taking the advisory lock, then serialize all
    // checkpoint operations with Native Chat admission/segment rotation.
    runtime_bindings::preauthorize_chat_execution_target_read_tx(
        tx,
        actor,
        id.organization_id,
        id.conversation_id,
        &hinted_agent_id,
        fence,
    )
    .await?;
    runtime_bindings::lock_native_chat_target_tx(tx, id.organization_id, id.conversation_id)
        .await?;

    runtime_bindings::authorize_chat_execution_target_run_mutation_tx(
        tx,
        actor,
        id.organization_id,
        id.conversation_id,
        &hinted_agent_id,
        id.run_id,
        fence,
    )
    .await?;

    let conversation = sqlx::query(
        "SELECT conversation_kind, COALESCE(preferred_agent_id, routed_agent_id)::text
                    AS selected_agent_id
         FROM chat_conversations
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(id.organization_id)
    .bind(id.conversation_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Chat conversation not found"))?;
    let conversation_kind: String = conversation.try_get("conversation_kind")?;
    let selected_agent_id: Option<String> = conversation.try_get("selected_agent_id")?;
    if conversation_kind != "chat" {
        return Err(http(404, "Ordinary Chat conversation not found"));
    }
    if selected_agent_id.as_deref() != Some(id.agent_id) {
        return Err(http(409, "Run Agent is no longer selected for this Chat"));
    }

    let generation = sqlx::query(
        "SELECT conversation_id::text AS conversation_id, execution_authority,
                native_admission_hold, status, attempt_epoch, control_state,
                control_runtime_type, control_owner_token,
                runtime_terminal_at IS NOT NULL AS runtime_terminal,
                provider_thread_id, provider_turn_id
         FROM chat_generations
         WHERE org_id=$1::uuid AND id=$2::uuid
         FOR UPDATE",
    )
    .bind(id.organization_id)
    .bind(id.generation_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Native Chat generation not found"))?;
    let generation_conversation: String = generation.try_get("conversation_id")?;
    let generation_authority: String = generation.try_get("execution_authority")?;
    let generation_hold: bool = generation.try_get("native_admission_hold")?;
    let generation_status: String = generation.try_get("status")?;
    let generation_epoch: i32 = generation.try_get("attempt_epoch")?;
    let control_state: String = generation.try_get("control_state")?;
    let control_runtime_type: Option<String> = generation.try_get("control_runtime_type")?;
    let control_owner: Option<String> = generation.try_get("control_owner_token")?;
    let generation_thread: Option<String> = generation.try_get("provider_thread_id")?;
    let generation_turn: Option<String> = generation.try_get("provider_turn_id")?;
    let runtime_terminal: bool = generation.try_get("runtime_terminal")?;
    if generation_conversation != id.conversation_id
        || generation_authority != "native_rust"
        || !generation_hold
        || if stop.is_some() {
            !matches!(generation_status.as_str(), "stop_requested" | "stopping")
        } else {
            !matches!(
                generation_status.as_str(),
                "starting" | "active" | "running" | "tool_busy"
            )
        }
        || generation_epoch != id.generation_attempt_epoch
        || if stop.is_some() {
            control_state != "stopping"
        } else {
            !matches!(control_state.as_str(), "unregistered" | "ready")
        }
        || control_runtime_type.as_deref() != Some(fence.runtime_type())
        || control_owner.as_deref() != Some(fence.generation_owner_token.as_str())
        || runtime_terminal
    {
        return Err(http(409, "Native Chat generation owner or epoch is stale"));
    }

    let run = sqlx::query(
        "SELECT agent_id::text AS agent_id,
                chat_conversation_id::text AS conversation_id,
                chat_generation_id::text AS generation_id,
                execution_authority, native_admission_hold, status,
                execution_owner_token, scene, target_type, target_id,
                process_pid, process_started_at, process_exited_at, session_id_before, session_id_after,
                context_snapshot
         FROM heartbeat_runs
         WHERE org_id=$1::uuid AND id=$2::uuid
         FOR UPDATE",
    )
    .bind(id.organization_id)
    .bind(id.run_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Run not found"))?;
    let run_agent_id: String = run.try_get("agent_id")?;
    let run_conversation_id: Option<String> = run.try_get("conversation_id")?;
    let run_generation_id: Option<String> = run.try_get("generation_id")?;
    let run_authority: String = run.try_get("execution_authority")?;
    let run_hold: bool = run.try_get("native_admission_hold")?;
    let run_status: String = run.try_get("status")?;
    let run_owner: Option<String> = run.try_get("execution_owner_token")?;
    let scene: Option<String> = run.try_get("scene")?;
    let target_type: Option<String> = run.try_get("target_type")?;
    let target_id: Option<String> = run.try_get("target_id")?;
    let context_snapshot: Value = run.try_get("context_snapshot")?;
    let admitted_message_id = context_snapshot
        .get("userMessageId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let admitted_input_fingerprint = context_snapshot
        .get("inputFingerprint")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if run_agent_id != id.agent_id
        || run_conversation_id.as_deref() != Some(id.conversation_id)
        || run_generation_id.as_deref() != Some(id.generation_id)
        || run_authority != "native_rust"
        || !run_hold
        || run_status != "running"
        || run_owner.as_deref() != Some(fence.run_owner_token.as_str())
        || scene.as_deref() != Some("chat")
        || target_type.as_deref() != Some("chat_conversation")
        || target_id.as_deref() != Some(id.conversation_id)
    {
        return Err(http(409, "Run execution owner or identity is stale"));
    }

    // Revalidate target scope after all higher-level locks. Conversation rows
    // cannot change while locked, and the Run association is now locked too.
    let principal_scope_ref = runtime_bindings::authorize_chat_execution_target_run_mutation_tx(
        tx,
        actor,
        id.organization_id,
        id.conversation_id,
        &run_agent_id,
        id.run_id,
        fence,
    )
    .await?;

    let attempt = sqlx::query(
        "SELECT agent_id::text AS agent_id, attempt_index, runtime_type, status,
                owner_token, attempt_epoch, generation_attempt_epoch,
                connection_epoch, protocol_phase, checkpoint_json,
                provider_thread_id, provider_turn_id, model
         FROM heartbeat_run_attempts
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid
         FOR UPDATE",
    )
    .bind(id.organization_id)
    .bind(id.run_id)
    .bind(id.attempt_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Run attempt not found"))?;
    let attempt_agent_id: String = attempt.try_get("agent_id")?;
    let attempt_index: i32 = attempt.try_get("attempt_index")?;
    let attempt_runtime: String = attempt.try_get("runtime_type")?;
    let attempt_status: String = attempt.try_get("status")?;
    let attempt_owner: Option<String> = attempt.try_get("owner_token")?;
    let attempt_epoch: Option<i32> = attempt.try_get("attempt_epoch")?;
    let attempt_generation_epoch: Option<i32> = attempt.try_get("generation_attempt_epoch")?;
    let connection_epoch: Option<i32> = attempt.try_get("connection_epoch")?;
    let phase: Option<String> = attempt.try_get("protocol_phase")?;
    let checkpoint_json: Option<Value> = attempt.try_get("checkpoint_json")?;
    let attempt_thread: Option<String> = attempt.try_get("provider_thread_id")?;
    let attempt_turn: Option<String> = attempt.try_get("provider_turn_id")?;
    let attempt_model: Option<String> = attempt.try_get("model")?;
    if attempt_agent_id != id.agent_id
        || attempt_runtime != fence.runtime_type()
        || !matches!(attempt_status.as_str(), "started" | "waiting_for_network")
        || attempt_owner.as_deref() != Some(fence.run_owner_token.as_str())
        || attempt_epoch != Some(id.run_attempt_epoch)
        || attempt_generation_epoch != Some(id.generation_attempt_epoch)
        || connection_epoch != Some(id.connection_epoch)
        || attempt_model != fence.selected_model
    {
        return Err(http(409, "Run attempt owner or epoch is stale"));
    }

    let agent = sqlx::query(
        "SELECT agent_runtime_type, status FROM agents
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(id.organization_id)
    .bind(id.agent_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Agent not found"))?;
    let agent_runtime: String = agent.try_get("agent_runtime_type")?;
    let agent_status: String = agent.try_get("status")?;
    if agent_runtime != fence.runtime_type()
        || matches!(agent_status.as_str(), "terminated" | "pending_approval")
    {
        return Err(http(409, "Native Chat Agent is not available"));
    }

    let has_newer_attempt: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM heartbeat_run_attempts
           WHERE org_id=$1::uuid AND run_id=$2::uuid AND attempt_index > $3
         )",
    )
    .bind(id.organization_id)
    .bind(id.run_id)
    .bind(attempt_index)
    .fetch_one(&mut **tx)
    .await?;
    if has_newer_attempt {
        return Err(http(409, "Run attempt is no longer current"));
    }

    let checkpoint_json =
        checkpoint_json.ok_or_else(|| http(409, "Native Chat checkpoint is missing"))?;
    let checkpoint: NativeChatProtocolCheckpoint = serde_json::from_value(checkpoint_json)
        .map_err(|_| http(409, "Native Chat checkpoint is invalid"))?;
    checkpoint
        .validate()
        .map_err(|_| http(409, "Native Chat checkpoint is invalid"))?;
    let phase = phase.ok_or_else(|| http(409, "Native Chat protocol phase is missing"))?;
    if phase != checkpoint.phase().as_str()
        || checkpoint.phase() == NativeChatProtocolPhase::ExecutionTerminalCommitted
        || checkpoint.observation_only()
        || run
            .try_get::<Option<String>, _>("session_id_after")?
            .is_some()
        || run
            .try_get::<Option<String>, _>("session_id_before")?
            .is_some()
    {
        return Err(http(409, "Native Chat checkpoint identity is inconsistent"));
    }
    // The narrow Stop path locks and validates its exact action after Attempt
    // and before Binding. No effect authorization can use this mode.
    if let Some(stop) = stop {
        super::stopping::validate_action(tx, fence, stop).await?;
    }

    let binding_id = snapshot_uuid(&context_snapshot, "runtimeBindingId", "binding")?;
    let segment_id = snapshot_uuid(&context_snapshot, "nativeSegmentId", "segment")?;
    if binding_id != fence.binding_id || segment_id != fence.segment_id {
        return Err(http(409, "Native Chat execution binding changed"));
    }
    let binding = sqlx::query(
        "SELECT b.agent_id::text AS agent_id,
                b.conversation_id::text AS conversation_id,
                b.target_type, b.target_id, b.runtime_type AS binding_runtime_type,
                b.principal_scope_ref, b.current_segment_id::text AS current_segment_id,
                b.status AS binding_status, b.continuity,
                s.id::text AS segment_id, s.runtime_type AS segment_runtime_type,
                s.state AS segment_state, s.native_session_id,
                s.sealed_at IS NOT NULL AS sealed
         FROM runtime_bindings b
         JOIN native_segments s ON s.org_id=b.org_id AND s.binding_id=b.id
         WHERE b.org_id=$1::uuid AND b.id=$2::uuid AND s.id=$3::uuid
         FOR UPDATE OF b, s",
    )
    .bind(id.organization_id)
    .bind(&binding_id)
    .bind(&segment_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(409, "Native Chat binding or segment is unavailable"))?;
    let binding_agent_id: String = binding.try_get("agent_id")?;
    let binding_conversation_id: Option<String> = binding.try_get("conversation_id")?;
    let binding_target_type: Option<String> = binding.try_get("target_type")?;
    let binding_target_id: Option<String> = binding.try_get("target_id")?;
    let binding_runtime_type: String = binding.try_get("binding_runtime_type")?;
    let binding_scope: String = binding.try_get("principal_scope_ref")?;
    let current_segment_id: Option<String> = binding.try_get("current_segment_id")?;
    let binding_status: String = binding.try_get("binding_status")?;
    let continuity: String = binding.try_get("continuity")?;
    let stored_segment_id: String = binding.try_get("segment_id")?;
    let segment_runtime_type: String = binding.try_get("segment_runtime_type")?;
    let segment_state: String = binding.try_get("segment_state")?;
    let native_session_id: Option<String> = binding.try_get("native_session_id")?;
    let segment_sealed: bool = binding.try_get("sealed")?;
    if binding_agent_id != run_agent_id
        || binding_conversation_id.as_deref() != Some(id.conversation_id)
        || binding_target_type.as_deref() != Some("chat_conversation")
        || binding_target_id.as_deref() != Some(id.conversation_id)
        || binding_runtime_type != fence.runtime_type()
        || attempt_runtime != binding_runtime_type
        || segment_runtime_type != binding_runtime_type
        || binding_scope != principal_scope_ref
        || current_segment_id.as_deref() != Some(segment_id.as_str())
        || binding_status != "active"
        || continuity != "native"
        || segment_sealed
    {
        return Err(http(409, "Run, binding, and current segment do not match"));
    }
    let codex_identity_matches = checkpoint.provider() == NativeChatProvider::CodexLocal
        && fence.runtime_type() == "codex_local"
        && attempt_thread.as_deref() == checkpoint.thread_id()
        && attempt_turn.as_deref() == checkpoint.turn_id()
        && generation_thread.as_deref() == checkpoint.thread_id()
        && generation_turn.as_deref() == checkpoint.turn_id()
        && match (
            segment_state.as_str(),
            native_session_id.as_deref(),
            checkpoint.thread_id(),
        ) {
            ("pending", None, None) => matches!(
                checkpoint.phase(),
                NativeChatProtocolPhase::NoThreadRequest
                    | NativeChatProtocolPhase::ThreadStartIndeterminate
            ),
            ("open", Some(stored), Some(thread)) => stored == thread && !stored.trim().is_empty(),
            _ => false,
        };
    let hermes_identity_matches = checkpoint.provider() == NativeChatProvider::HermesLocal
        && fence.runtime_type() == "hermes_local"
        && attempt_thread.is_none()
        && attempt_turn.is_none()
        && generation_thread.is_none()
        && generation_turn.is_none()
        && match (
            segment_state.as_str(),
            native_session_id.as_deref(),
            checkpoint.hermes_session(),
        ) {
            ("pending", None, None) => matches!(
                checkpoint.phase(),
                NativeChatProtocolPhase::NoThreadRequest
                    | NativeChatProtocolPhase::ThreadStartIndeterminate
            ),
            ("open", Some(stored), Some(selector)) => stored == selector.as_str(),
            _ => false,
        };
    let pi_identity_matches = checkpoint.provider() == NativeChatProvider::PiLocal
        && fence.runtime_type() == "pi_local"
        && attempt_thread.is_none()
        && attempt_turn.is_none()
        && generation_thread.is_none()
        && generation_turn.is_none()
        && match (
            segment_state.as_str(),
            native_session_id.as_deref(),
            checkpoint.pi_session(),
        ) {
            ("pending", None, None) => matches!(
                checkpoint.phase(),
                NativeChatProtocolPhase::NoThreadRequest
                    | NativeChatProtocolPhase::ThreadStartIndeterminate
            ),
            ("open", Some(stored), Some(selector)) => stored == selector.session_id.as_str(),
            _ => false,
        };
    let claude_identity_matches = checkpoint.provider() == NativeChatProvider::ClaudeLocal
        && fence.runtime_type() == "claude_local"
        && attempt_thread.is_none()
        && attempt_turn.is_none()
        && generation_thread.is_none()
        && generation_turn.is_none()
        && match (
            segment_state.as_str(),
            native_session_id.as_deref(),
            checkpoint.claude_session(),
        ) {
            ("pending", None, None) => matches!(
                checkpoint.phase(),
                NativeChatProtocolPhase::NoThreadRequest
                    | NativeChatProtocolPhase::ThreadStartIndeterminate
            ),
            ("open", Some(stored), Some(selector)) => {
                stored == selector.as_str() && ClaudeSessionSelector::from_persisted(stored).is_ok()
            }
            _ => false,
        };
    let opencode_identity_matches = checkpoint.provider() == NativeChatProvider::OpenCodeLocal
        && fence.runtime_type() == "opencode_local"
        && attempt_thread.is_none()
        && attempt_turn.is_none()
        && generation_thread.is_none()
        && generation_turn.is_none()
        && match (
            segment_state.as_str(),
            native_session_id.as_deref(),
            checkpoint.opencode_session(),
        ) {
            ("pending", None, None) => matches!(
                checkpoint.phase(),
                NativeChatProtocolPhase::NoThreadRequest
                    | NativeChatProtocolPhase::ThreadStartIndeterminate
            ),
            ("open", Some(stored), Some(selector)) => {
                stored == selector.as_str()
                    && OpenCodeSessionSelector::from_persisted(stored).is_ok()
            }
            _ => false,
        };
    let cursor_identity_matches = checkpoint.provider() == NativeChatProvider::CursorLocal
        && matches!(fence.runtime_type(), "cursor" | "cursor_local")
        && attempt_thread.is_none()
        && attempt_turn.is_none()
        && generation_thread.is_none()
        && generation_turn.is_none()
        && match (
            segment_state.as_str(),
            native_session_id.as_deref(),
            checkpoint.cursor_session(),
        ) {
            ("pending", None, None) => matches!(
                checkpoint.phase(),
                NativeChatProtocolPhase::NoThreadRequest
                    | NativeChatProtocolPhase::ThreadStartIndeterminate
            ),
            ("open", Some(stored), Some(selector)) => {
                stored == selector.as_str() && CursorSessionSelector::from_persisted(stored).is_ok()
            }
            _ => false,
        };
    if !codex_identity_matches
        && !hermes_identity_matches
        && !pi_identity_matches
        && !claude_identity_matches
        && !opencode_identity_matches
        && !cursor_identity_matches
    {
        return Err(http(
            409,
            "Native Chat checkpoint does not match its provider and current segment",
        ));
    }

    let lease_live: bool = sqlx::query_scalar(
        "SELECT COALESCE(g.control_lease_expires_at > clock_timestamp(), false)
                AND COALESCE(r.execution_lease_expires_at > clock_timestamp(), false)
         FROM chat_generations g
         JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND r.id=$3::uuid
           AND g.control_owner_token=$4 AND r.execution_owner_token=$5",
    )
    .bind(id.organization_id)
    .bind(id.generation_id)
    .bind(id.run_id)
    .bind(&fence.generation_owner_token)
    .bind(&fence.run_owner_token)
    .fetch_optional(&mut **tx)
    .await?
    .unwrap_or(false);
    if !lease_live {
        return Err(http(409, "Native Chat execution lease is stale"));
    }

    let source_matches: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM chat_generations g
           JOIN chat_messages m ON m.org_id=g.org_id AND m.id=g.source_message_id
             AND m.conversation_id=g.conversation_id
           WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND g.conversation_id=$3::uuid
             AND m.run_id=$4::uuid AND m.role='user' AND m.kind='message'
             AND m.turn_variant=g.source_turn_variant
         )",
    )
    .bind(id.organization_id)
    .bind(id.generation_id)
    .bind(id.conversation_id)
    .bind(id.run_id)
    .fetch_one(&mut **tx)
    .await?;
    if !source_matches {
        return Err(http(409, "Native Chat source message association changed"));
    }

    super::super::auth::authorize_execution_org(tx, actor, fence).await?;
    Ok(LockedExecution {
        checkpoint,
        agent_id: run_agent_id,
        binding_id,
        segment_id: stored_segment_id,
        segment_state,
        native_session_id,
        admitted_message_id,
        admitted_input_fingerprint,
    })
}

fn snapshot_uuid(snapshot: &Value, key: &str, label: &str) -> Result<String> {
    let value = snapshot
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| http(409, format!("Native Chat Run has no {label} association")))?;
    let canonical = super::super::validation::canonical_uuid(value, label).map_err(|_| {
        http(
            409,
            format!("Native Chat Run has an invalid {label} association"),
        )
    })?;
    if canonical != value {
        return Err(http(
            409,
            format!("Native Chat Run has a noncanonical {label} association"),
        ));
    }
    Ok(canonical)
}
