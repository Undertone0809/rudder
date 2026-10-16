use super::{ExecutionFence, Result, http};
use crate::runtime_bindings;
use rudder_auth_core::VerifiedActor;
use rudder_runtime_core::native_chat::{NativeChatProtocolCheckpoint, NativeChatProtocolPhase};
use serde_json::Value;
use sqlx::{Postgres, Row, Transaction};

pub(super) struct LockedExecution {
    pub(super) checkpoint: NativeChatProtocolCheckpoint,
    pub(super) agent_id: String,
}

/// Reauthorize and lock in the shared Conversation -> Generation -> Run ->
/// Attempt order. Every owner/epoch/lease check is repeated from database rows;
/// an in-memory fence alone never grants authority.
pub(super) async fn lock_current_execution(
    tx: &mut Transaction<'_, Postgres>,
    actor: &VerifiedActor,
    fence: &ExecutionFence,
) -> Result<LockedExecution> {
    let id = fence.identity();
    if actor.organization_id() != id.organization_id {
        return Err(http(403, "Organization access denied"));
    }

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

    runtime_bindings::authorize_chat_target_run_mutation_tx(
        tx,
        actor,
        id.organization_id,
        id.conversation_id,
        &hinted_agent_id,
        id.run_id,
    )
    .await?;

    let conversation_kind: String = sqlx::query_scalar(
        "SELECT conversation_kind FROM chat_conversations
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(id.organization_id)
    .bind(id.conversation_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Chat conversation not found"))?;
    if conversation_kind != "chat" {
        return Err(http(404, "Ordinary Chat conversation not found"));
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
        || !matches!(
            generation_status.as_str(),
            "starting" | "active" | "running" | "tool_busy"
        )
        || generation_epoch != id.generation_attempt_epoch
        || !matches!(control_state.as_str(), "unregistered" | "ready")
        || control_runtime_type.as_deref() != Some("codex_local")
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
                process_pid, process_started_at, process_exited_at, session_id_after
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
    runtime_bindings::authorize_chat_target_run_mutation_tx(
        tx,
        actor,
        id.organization_id,
        id.conversation_id,
        &run_agent_id,
        id.run_id,
    )
    .await?;

    let attempt = sqlx::query(
        "SELECT agent_id::text AS agent_id, attempt_index, runtime_type, status,
                owner_token, attempt_epoch, generation_attempt_epoch,
                connection_epoch, protocol_phase, checkpoint_json,
                provider_thread_id, provider_turn_id
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
    if attempt_agent_id != id.agent_id
        || attempt_runtime != "codex_local"
        || !matches!(attempt_status.as_str(), "started" | "waiting_for_network")
        || attempt_owner.as_deref() != Some(fence.run_owner_token.as_str())
        || attempt_epoch != Some(id.run_attempt_epoch)
        || attempt_generation_epoch != Some(id.generation_attempt_epoch)
        || connection_epoch != Some(id.connection_epoch)
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
    if agent_runtime != "codex_local"
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
        || attempt_thread.as_deref() != checkpoint.thread_id()
        || attempt_turn.as_deref() != checkpoint.turn_id()
        || generation_thread.as_deref() != checkpoint.thread_id()
        || generation_turn.as_deref() != checkpoint.turn_id()
        || run
            .try_get::<Option<String>, _>("session_id_after")?
            .as_deref()
            != checkpoint.thread_id()
    {
        return Err(http(409, "Native Chat checkpoint identity is inconsistent"));
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

    Ok(LockedExecution {
        checkpoint,
        agent_id: run_agent_id,
    })
}
