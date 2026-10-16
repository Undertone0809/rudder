use super::{ExecutionFence, GENERATION_CONTROL_LEASE_SECONDS, NATIVE_WRITE_MARKER, Result, http};
use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use crate::native_chat::config::{LocalHostContext, ResolvedCodexConfig, resolve_codex_config};
use crate::runtime_bindings;
use rudder_auth_core::VerifiedActor;
use rudder_runtime_core::native_chat::{NativeChatProtocolCheckpoint, NativeChatProtocolPhase};
use serde_json::json;
use sqlx::{PgPool, Row};

/// A first-claim receipt carrying the trusted, transactionally resolved local
/// runtime configuration alongside its in-process owner fence. This type has
/// no serialization or `Debug` implementation because its configuration may
/// contain private instruction text and filesystem paths.
pub struct ClaimedExecution {
    pub fence: ExecutionFence,
    pub config: ResolvedCodexConfig,
}

/// Claim the single admitted Native Chat execution for its first local owner.
/// The generation-control capability is created in the database transaction;
/// no expired or previously claimed owner can be adopted by this operation.
pub async fn claim(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    run_id: &str,
    attempt_id: &str,
    host: &LocalHostContext,
) -> Result<ClaimedExecution> {
    let organization_id =
        super::super::validation::canonical_uuid(organization_id, "organization id")?;
    let run_id = super::super::validation::canonical_uuid(run_id, "Run id")?;
    let attempt_id = super::super::validation::canonical_uuid(attempt_id, "Run attempt id")?;
    if actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }

    let mut tx = pool.begin().await?;
    let hint = sqlx::query(
        "SELECT agent_id::text AS agent_id,
                chat_conversation_id::text AS conversation_id,
                chat_generation_id::text AS generation_id
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&organization_id)
    .bind(&run_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Run not found"))?;
    let agent_id: String = hint.try_get("agent_id")?;
    let conversation_id: Option<String> = hint.try_get("conversation_id")?;
    let generation_id: Option<String> = hint.try_get("generation_id")?;
    let conversation_id =
        conversation_id.ok_or_else(|| http(409, "Run is not attached to Native Chat"))?;
    let generation_id =
        generation_id.ok_or_else(|| http(409, "Run is not attached to Native Chat"))?;

    runtime_bindings::authorize_chat_target_run_mutation_tx(
        &mut tx,
        actor,
        &organization_id,
        &conversation_id,
        &agent_id,
        &run_id,
    )
    .await?;

    let conversation = sqlx::query(
        "SELECT conversation_kind, preferred_agent_id::text AS preferred_agent_id,
                routed_agent_id::text AS routed_agent_id,
                primary_issue_id::text AS primary_issue_id
         FROM chat_conversations
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&organization_id)
    .bind(&conversation_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Chat conversation not found"))?;
    let conversation_kind: String = conversation.try_get("conversation_kind")?;
    let preferred_agent_id: Option<String> = conversation.try_get("preferred_agent_id")?;
    let routed_agent_id: Option<String> = conversation.try_get("routed_agent_id")?;
    let primary_issue_id: Option<String> = conversation.try_get("primary_issue_id")?;
    if conversation_kind != "chat"
        || preferred_agent_id.as_deref().or(routed_agent_id.as_deref()) != Some(agent_id.as_str())
    {
        return Err(http(409, "Native Chat target or selected Agent changed"));
    }

    // Agent-core mutations lock Issues before Agents. Resolve the optional
    // primary Issue first so the config resolver's Agent lock cannot invert
    // that established order; its later Issue read reuses this share lock.
    if let Some(issue_id) = primary_issue_id {
        let _: Option<String> = sqlx::query_scalar(
            "SELECT id::text FROM issues
             WHERE org_id=$1::uuid AND id=$2::uuid FOR SHARE",
        )
        .bind(&organization_id)
        .bind(issue_id)
        .fetch_optional(&mut *tx)
        .await?;
    }

    // Resolve identity-bearing runtime state from the locked Conversation and
    // selected Agent before taking execution-owner locks or writing any claim
    // state. Config is never accepted from a caller as binding proof.
    let config = resolve_codex_config(&mut tx, &organization_id, &conversation_id, host).await?;
    if config.identity.agent_id != agent_id {
        return Err(http(409, "Resolved Native Chat Agent changed"));
    }

    // Keep the global lock order aligned with Native Chat span writes and
    // conversation teardown: Conversation -> Generation -> Run -> Attempt.
    let generation = sqlx::query(
        "SELECT conversation_id::text AS conversation_id, execution_authority,
                native_admission_hold, status, attempt_epoch, control_state,
                control_runtime_type, control_owner_token,
                control_lease_expires_at IS NOT NULL AS control_lease_exists,
                provider_thread_id, provider_turn_id,
                runtime_terminal_at IS NOT NULL AS runtime_terminal
         FROM chat_generations
         WHERE org_id=$1::uuid AND id=$2::uuid
         FOR UPDATE",
    )
    .bind(&organization_id)
    .bind(&generation_id)
    .fetch_optional(&mut *tx)
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
    let control_lease_exists: bool = generation.try_get("control_lease_exists")?;
    let generation_thread: Option<String> = generation.try_get("provider_thread_id")?;
    let generation_turn: Option<String> = generation.try_get("provider_turn_id")?;
    let runtime_terminal: bool = generation.try_get("runtime_terminal")?;
    if generation_conversation != conversation_id
        || generation_authority != "native_rust"
        || generation_hold
        || generation_status != "starting"
        || generation_epoch <= 0
        || control_state != "unregistered"
        || control_runtime_type.as_deref() != Some("codex_local")
        || control_owner.is_some()
        || control_lease_exists
        || generation_thread.is_some()
        || generation_turn.is_some()
        || runtime_terminal
    {
        return Err(http(
            409,
            "Native Chat generation was already claimed or changed",
        ));
    }

    let run = sqlx::query(
        "SELECT agent_id::text AS agent_id,
                chat_conversation_id::text AS conversation_id,
                chat_generation_id::text AS generation_id,
                invocation_source, execution_authority, native_admission_hold,
                status, execution_owner_token, execution_lease_expires_at,
                scene, target_type, target_id, process_pid,
                process_started_at IS NOT NULL AS process_started,
                process_exited_at IS NOT NULL AS process_exited, session_id_after
         FROM heartbeat_runs
         WHERE org_id=$1::uuid AND id=$2::uuid
         FOR UPDATE",
    )
    .bind(&organization_id)
    .bind(&run_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Run not found"))?;
    let run_agent_id: String = run.try_get("agent_id")?;
    let run_conversation_id: Option<String> = run.try_get("conversation_id")?;
    let run_generation_id: Option<String> = run.try_get("generation_id")?;
    let invocation_source: String = run.try_get("invocation_source")?;
    let run_authority: String = run.try_get("execution_authority")?;
    let run_hold: bool = run.try_get("native_admission_hold")?;
    let run_status: String = run.try_get("status")?;
    let run_owner: Option<String> = run.try_get("execution_owner_token")?;
    let scene: Option<String> = run.try_get("scene")?;
    let target_type: Option<String> = run.try_get("target_type")?;
    let target_id: Option<String> = run.try_get("target_id")?;
    let process_pid: Option<i32> = run.try_get("process_pid")?;
    let process_started: bool = run.try_get("process_started")?;
    let process_exited: bool = run.try_get("process_exited")?;
    let session_id_after: Option<String> = run.try_get("session_id_after")?;
    if run_agent_id != agent_id
        || run_conversation_id.as_deref() != Some(conversation_id.as_str())
        || run_generation_id.as_deref() != Some(generation_id.as_str())
        || invocation_source != "chat"
        || run_authority != "native_rust"
        || run_hold
        || run_status != "running"
        || run_owner.as_deref().is_none_or(str::is_empty)
        || scene.as_deref() != Some("chat")
        || target_type.as_deref() != Some("chat_conversation")
        || target_id.as_deref() != Some(conversation_id.as_str())
        || process_pid.is_some()
        || process_started
        || process_exited
        || session_id_after.is_some()
    {
        return Err(http(
            409,
            "Native Chat Run is not eligible for first ownership",
        ));
    }
    let run_owner = run_owner.ok_or_else(|| http(409, "Run execution owner is missing"))?;

    // Recheck the target after the Run lock. This also applies the exact
    // Side Chat admission-time expiry rule should the target kind evolve.
    runtime_bindings::authorize_chat_target_run_mutation_tx(
        &mut tx,
        actor,
        &organization_id,
        &conversation_id,
        &agent_id,
        &run_id,
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
    .bind(&organization_id)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Run attempt not found"))?;
    let attempt_agent_id: String = attempt.try_get("agent_id")?;
    let attempt_index: i32 = attempt.try_get("attempt_index")?;
    let attempt_runtime: String = attempt.try_get("runtime_type")?;
    let attempt_status: String = attempt.try_get("status")?;
    let attempt_owner: Option<String> = attempt.try_get("owner_token")?;
    let run_attempt_epoch: Option<i32> = attempt.try_get("attempt_epoch")?;
    let attempt_generation_epoch: Option<i32> = attempt.try_get("generation_attempt_epoch")?;
    let connection_epoch: Option<i32> = attempt.try_get("connection_epoch")?;
    let phase: Option<String> = attempt.try_get("protocol_phase")?;
    let checkpoint_json: Option<serde_json::Value> = attempt.try_get("checkpoint_json")?;
    let attempt_thread: Option<String> = attempt.try_get("provider_thread_id")?;
    let attempt_turn: Option<String> = attempt.try_get("provider_turn_id")?;
    if attempt_agent_id != agent_id
        || attempt_index != 1
        || attempt_runtime != "codex_local"
        || attempt_status != "started"
        || attempt_owner.as_deref() != Some(run_owner.as_str())
        || run_attempt_epoch.is_none_or(|epoch| epoch <= 0)
        || attempt_generation_epoch != Some(generation_epoch)
        || connection_epoch.is_none_or(|epoch| epoch <= 0)
        || phase.as_deref() != Some("no_thread_request")
        || attempt_thread.is_some()
        || attempt_turn.is_some()
    {
        return Err(http(
            409,
            "Native Chat attempt is not eligible for first ownership",
        ));
    }
    let run_attempt_epoch = run_attempt_epoch.expect("epoch checked above");
    let connection_epoch = connection_epoch.expect("epoch checked above");
    let checkpoint_json =
        checkpoint_json.ok_or_else(|| http(409, "Native Chat checkpoint is missing"))?;
    let checkpoint: NativeChatProtocolCheckpoint = serde_json::from_value(checkpoint_json)
        .map_err(|_| http(409, "Native Chat checkpoint is invalid"))?;
    checkpoint
        .validate()
        .map_err(|_| http(409, "Native Chat checkpoint is invalid"))?;
    if checkpoint.phase() != NativeChatProtocolPhase::NoThreadRequest
        || checkpoint.revision() != 0
        || checkpoint.thread_id().is_some()
        || checkpoint.turn_id().is_some()
    {
        return Err(http(409, "Native Chat attempt has already advanced"));
    }

    let agent = sqlx::query(
        "SELECT agent_runtime_type, status FROM agents
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&organization_id)
    .bind(&agent_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Agent not found"))?;
    let agent_runtime: String = agent.try_get("agent_runtime_type")?;
    let agent_status: String = agent.try_get("status")?;
    if agent_runtime != "codex_local"
        || matches!(agent_status.as_str(), "terminated" | "pending_approval")
    {
        return Err(http(409, "Native Chat Agent is not available"));
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
    .bind(&organization_id)
    .bind(&generation_id)
    .bind(&conversation_id)
    .bind(&run_id)
    .fetch_one(&mut *tx)
    .await?;
    if !source_matches {
        return Err(http(409, "Native Chat source message association changed"));
    }

    let has_newer_attempt: bool = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM heartbeat_run_attempts
           WHERE org_id=$1::uuid AND run_id=$2::uuid AND attempt_index > $3
         )",
    )
    .bind(&organization_id)
    .bind(&run_id)
    .bind(attempt_index)
    .fetch_one(&mut *tx)
    .await?;
    if has_newer_attempt {
        return Err(http(409, "Run attempt is no longer current"));
    }

    let leases_live: bool = sqlx::query_scalar(
        "SELECT COALESCE(r.execution_lease_expires_at > clock_timestamp(), false)
         FROM heartbeat_runs r
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid
           AND r.execution_owner_token=$3",
    )
    .bind(&organization_id)
    .bind(&run_id)
    .bind(&run_owner)
    .fetch_optional(&mut *tx)
    .await?
    .unwrap_or(false);
    if !leases_live {
        return Err(http(409, "Run execution lease is stale"));
    }

    let generation_owner_token: String = sqlx::query_scalar("SELECT gen_random_uuid()::text")
        .fetch_one(&mut *tx)
        .await?;
    if generation_owner_token == run_owner {
        return Err(http(409, "Failed to create a distinct Native Chat owner"));
    }

    sqlx::query("SELECT set_config('rudder.native_chat_write', $1, true)")
        .bind(NATIVE_WRITE_MARKER)
        .execute(&mut *tx)
        .await?;
    let generation_updated = sqlx::query(
        "UPDATE chat_generations
         SET control_owner_token=$4,
             control_lease_expires_at=clock_timestamp() + make_interval(secs => $5),
             native_admission_hold=true,
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND conversation_id=$3::uuid
           AND execution_authority='native_rust' AND native_admission_hold=false
           AND status='starting' AND attempt_epoch=$6 AND control_state='unregistered'
           AND control_owner_token IS NULL AND control_lease_expires_at IS NULL
           AND control_runtime_type='codex_local' AND provider_thread_id IS NULL
           AND provider_turn_id IS NULL AND runtime_terminal_at IS NULL",
    )
    .bind(&organization_id)
    .bind(&generation_id)
    .bind(&conversation_id)
    .bind(&generation_owner_token)
    .bind(GENERATION_CONTROL_LEASE_SECONDS)
    .bind(generation_epoch)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if generation_updated != 1 {
        return Err(http(409, "Native Chat generation claim changed"));
    }

    let run_updated = sqlx::query(
        "UPDATE heartbeat_runs
         SET native_admission_hold=true, updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND agent_id=$3::uuid
           AND chat_conversation_id=$4::uuid AND chat_generation_id=$5::uuid
           AND execution_authority='native_rust' AND native_admission_hold=false
           AND status='running' AND execution_owner_token=$6
           AND COALESCE(execution_lease_expires_at > clock_timestamp(), false)",
    )
    .bind(&organization_id)
    .bind(&run_id)
    .bind(&agent_id)
    .bind(&conversation_id)
    .bind(&generation_id)
    .bind(&run_owner)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if run_updated != 1 {
        return Err(http(409, "Run execution lease expired during first claim"));
    }

    let identity_details = json!({
        "conversationId": conversation_id,
        "generationId": generation_id,
        "runId": run_id,
        "attemptId": attempt_id,
        "generationAttemptEpoch": generation_epoch,
        "runAttemptEpoch": run_attempt_epoch,
        "connectionEpoch": connection_epoch,
        "executionAuthority": "native_rust",
    });
    let audit = ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: Some(run_id.clone()),
    };
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: &organization_id,
            audit: &audit,
            action: "runtime.native_chat.execution_claimed",
            entity_type: "chat_generation",
            entity_id: &generation_id,
            details: Some(&identity_details),
            options: ActivityOptions {
                agent_id: Some(&agent_id),
                bind_run: true,
                ..ActivityOptions::default()
            },
        },
    )
    .await?;

    let still_live: bool = sqlx::query_scalar(
        "SELECT g.native_admission_hold AND r.native_admission_hold
                AND g.control_owner_token=$4 AND r.execution_owner_token=$5
                AND COALESCE(g.control_lease_expires_at > clock_timestamp(), false)
                AND COALESCE(r.execution_lease_expires_at > clock_timestamp(), false)
         FROM chat_generations g
         JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE g.org_id=$1::uuid AND g.id=$2::uuid AND r.id=$3::uuid",
    )
    .bind(&organization_id)
    .bind(&generation_id)
    .bind(&run_id)
    .bind(&generation_owner_token)
    .bind(&run_owner)
    .fetch_one(&mut *tx)
    .await?;
    if !still_live {
        return Err(http(
            409,
            "Native Chat execution lease expired during claim",
        ));
    }

    tx.commit().await?;
    Ok(ClaimedExecution {
        fence: ExecutionFence {
            organization_id,
            conversation_id,
            generation_id,
            run_id,
            attempt_id,
            agent_id,
            generation_attempt_epoch: generation_epoch,
            run_attempt_epoch,
            connection_epoch,
            generation_owner_token,
            run_owner_token: run_owner,
        },
        config,
    })
}
