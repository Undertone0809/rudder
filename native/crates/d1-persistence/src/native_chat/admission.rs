use super::NativeChatActor;
use super::{Error, Result, auth, binding_identity, budget, http, locks, validation};
use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use crate::native_chat::config::{LocalHostContext, resolve_native_config};
use crate::runtime_bindings;
use rudder_runtime_core::native_chat::{
    ClaudeSessionSelector, CursorSessionSelector, HermesSessionSelector,
    NativeChatProtocolCheckpoint, NativeChatProtocolStart, OpenCodeSessionSelector,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

const NATIVE_WRITE_MARKER: &str = "native_chat:admission";
const ACTIVE_GENERATION_STATUSES: &str = "'starting', 'active', 'running', 'waiting_for_network', 'tool_busy', 'closing', 'stop_requested', 'stopping'";

/// Read an exact, already committed browser retry before reserving worker
/// capacity. A miss is only a hint: `submit` repeats the idempotency lookup
/// under the same target lock, so concurrent first sends cannot double-admit.
pub async fn lookup_submission(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    organization_id: &str,
    conversation_id: &str,
    client_mutation_id: &str,
    body: &str,
) -> Result<Option<Value>> {
    let organization_id = validation::canonical_uuid(organization_id, "organization id")?;
    let conversation_id = validation::canonical_uuid(conversation_id, "conversation id")?;
    let client_mutation_id = validation::client_mutation_id(client_mutation_id)?;
    let body = validation::body(body)?;
    if actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }
    let fingerprint = validation::fingerprint(&body);
    let mut tx = pool.begin().await?;
    auth::preauthorize_org(&mut tx, actor, &organization_id).await?;
    runtime_bindings::lock_native_chat_target_tx(&mut tx, &organization_id, &conversation_id)
        .await?;
    auth::authorize_org(&mut tx, actor, &organization_id).await?;

    let target_hint = sqlx::query(
        "SELECT conversation_kind, preferred_agent_id::text AS preferred_agent_id,
                routed_agent_id::text AS routed_agent_id
         FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&organization_id)
    .bind(&conversation_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Chat conversation not found"))?;
    if target_hint.try_get::<String, _>("conversation_kind")? != "chat" {
        return Err(http(404, "Ordinary Chat conversation not found"));
    }
    let hinted_agent = target_hint
        .try_get::<Option<String>, _>("preferred_agent_id")?
        .or(target_hint.try_get::<Option<String>, _>("routed_agent_id")?)
        .ok_or_else(|| http(409, "Chat conversation has no selected Agent"))?;
    auth::authorize_agent_actor(actor, &hinted_agent)?;
    runtime_bindings::authorize_chat_target_read_tx(
        &mut tx,
        actor,
        &organization_id,
        &conversation_id,
        &hinted_agent,
    )
    .await?;

    let receipt = lookup_existing_receipt(
        &mut tx,
        &organization_id,
        &conversation_id,
        &client_mutation_id,
        &fingerprint,
    )
    .await?;
    if receipt.is_some() {
        // Like submit's replay path, authenticate after the Conversation lock
        // and recheck the selected Agent before disclosing a saved receipt.
        let conversation =
            auth::lock_conversation(&mut tx, &organization_id, &conversation_id).await?;
        if conversation.kind != "chat" {
            return Err(http(404, "Ordinary Chat conversation not found"));
        }
        let selected_agent = conversation
            .preferred_agent_id
            .as_deref()
            .or(conversation.routed_agent_id.as_deref())
            .ok_or_else(|| http(409, "Chat conversation has no selected Agent"))?;
        auth::authorize_agent_actor(actor, selected_agent)?;
        runtime_bindings::authorize_chat_target_read_tx(
            &mut tx,
            actor,
            &organization_id,
            &conversation_id,
            selected_agent,
        )
        .await?;
    }
    auth::authorize_org(&mut tx, actor, &organization_id).await?;
    tx.commit().await?;
    Ok(receipt.map(|receipt| receipt.json()))
}

/// Exact ids copied only from the durable admission receipt. This operation
/// quarantines a committed admission when the process supervisor definitively
/// refuses to start its reserved worker. It never starts or retries execution.
pub struct DispatchUnavailableRequest {
    pub conversation_id: String,
    pub generation_id: String,
    pub run_id: String,
    pub attempt_id: String,
}

pub async fn record_dispatch_unavailable(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    request: &DispatchUnavailableRequest,
) -> Result<()> {
    let org = validation::canonical_uuid(actor.organization_id(), "organization id")?;
    let conversation = validation::canonical_uuid(&request.conversation_id, "conversation id")?;
    let generation_id = validation::canonical_uuid(&request.generation_id, "generation id")?;
    let run_id = validation::canonical_uuid(&request.run_id, "Run id")?;
    let attempt_id = validation::canonical_uuid(&request.attempt_id, "Run attempt id")?;

    let mut tx = pool.begin().await?;
    auth::preauthorize_org(&mut tx, actor, &org).await?;
    runtime_bindings::lock_native_chat_target_tx(&mut tx, &org, &conversation).await?;
    auth::authorize_org(&mut tx, actor, &org).await?;
    let hint = sqlx::query(
        "SELECT preferred_agent_id::text AS preferred_agent_id,
                routed_agent_id::text AS routed_agent_id,
                primary_issue_id::text AS primary_issue_id
         FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid
           AND conversation_kind='chat'",
    )
    .bind(&org)
    .bind(&conversation)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Chat conversation not found"))?;
    let hinted_agent = hint
        .try_get::<Option<String>, _>("preferred_agent_id")?
        .or(hint.try_get::<Option<String>, _>("routed_agent_id")?)
        .ok_or_else(|| http(409, "Chat conversation has no selected Agent"))?;
    auth::authorize_agent_actor(actor, &hinted_agent)?;
    runtime_bindings::authorize_chat_target_read_tx(
        &mut tx,
        actor,
        &org,
        &conversation,
        &hinted_agent,
    )
    .await?;
    let hinted_issue: Option<String> = hint.try_get("primary_issue_id")?;
    locks::verify_selected_agent_hint(&mut tx, &org, &conversation, &hinted_agent).await?;
    let locked_issue =
        locks::lock_primary_issue_path_before_conversation(&mut tx, &org, &conversation).await?;
    if locked_issue != hinted_issue {
        return Err(http(409, "Chat primary Issue changed"));
    }
    let locked_chat = auth::lock_conversation(&mut tx, &org, &conversation).await?;
    let selected_agent = locked_chat
        .preferred_agent_id
        .as_deref()
        .or(locked_chat.routed_agent_id.as_deref())
        .ok_or_else(|| http(409, "Chat conversation has no selected Agent"))?;
    if locked_chat.kind != "chat" || selected_agent != hinted_agent {
        return Err(http(409, "Native Chat target changed"));
    }
    auth::authorize_agent_actor(actor, selected_agent)?;
    runtime_bindings::authorize_chat_target_read_tx(
        &mut tx,
        actor,
        &org,
        &conversation,
        selected_agent,
    )
    .await?;

    let generation = sqlx::query(
        "SELECT status,execution_authority,native_admission_hold,attempt_epoch,
                control_state,control_owner_token,
                control_lease_expires_at IS NOT NULL AS control_lease_exists,
                provider_turn_id,runtime_terminal_at IS NOT NULL AS runtime_terminal
         FROM chat_generations WHERE org_id=$1::uuid AND id=$2::uuid
           AND conversation_id=$3::uuid FOR UPDATE",
    )
    .bind(&org)
    .bind(&generation_id)
    .bind(&conversation)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Native Chat generation not found"))?;
    let run = sqlx::query(
        "SELECT status,execution_authority,native_admission_hold,agent_id::text AS agent_id,
                chat_conversation_id::text AS conversation_id,
                chat_generation_id::text AS generation_id,process_pid,
                process_started_at IS NOT NULL AS process_started,
                process_exited_at IS NOT NULL AS process_exited,session_id_after
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
    )
    .bind(&org)
    .bind(&run_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Native Chat Run not found"))?;
    let attempt = sqlx::query(
        "SELECT attempt_index,attempt_epoch,generation_attempt_epoch,connection_epoch,
                protocol_phase,checkpoint_json,runtime_type,provider_turn_id
         FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid
         FOR UPDATE",
    )
    .bind(&org)
    .bind(&run_id)
    .bind(&attempt_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Native Chat Attempt not found"))?;
    let phase: String = attempt.try_get("protocol_phase")?;
    let checkpoint: Value = attempt.try_get("checkpoint_json")?;
    if generation.try_get::<String, _>("execution_authority")? != "native_rust"
        || generation.try_get::<bool, _>("native_admission_hold")?
        || generation.try_get::<String, _>("status")? != "starting"
        || generation.try_get::<i32, _>("attempt_epoch")? != 1
        || generation.try_get::<String, _>("control_state")? != "unregistered"
        || generation
            .try_get::<Option<String>, _>("control_owner_token")?
            .is_some()
        || generation.try_get::<bool, _>("control_lease_exists")?
        || generation
            .try_get::<Option<String>, _>("provider_turn_id")?
            .is_some()
        || generation.try_get::<bool, _>("runtime_terminal")?
        || run.try_get::<String, _>("execution_authority")? != "native_rust"
        || run.try_get::<bool, _>("native_admission_hold")?
        || run.try_get::<String, _>("status")? != "running"
        || run.try_get::<String, _>("agent_id")? != selected_agent
        || run.try_get::<String, _>("conversation_id")? != conversation
        || run.try_get::<String, _>("generation_id")? != generation_id
        || run.try_get::<Option<i32>, _>("process_pid")?.is_some()
        || run.try_get::<bool, _>("process_started")?
        || run.try_get::<bool, _>("process_exited")?
        || run
            .try_get::<Option<String>, _>("session_id_after")?
            .is_some()
        || attempt.try_get::<i32, _>("attempt_index")? != 1
        || attempt.try_get::<i32, _>("attempt_epoch")? != 1
        || attempt.try_get::<i32, _>("generation_attempt_epoch")? != 1
        || attempt.try_get::<i32, _>("connection_epoch")? != 1
        || !matches!(
            attempt.try_get::<String, _>("runtime_type")?.as_str(),
            "codex_local"
                | "hermes_local"
                | "pi_local"
                | "claude_local"
                | "cursor"
                | "cursor_local"
                | "opencode_local"
        )
        || !matches!(phase.as_str(), "no_thread_request" | "thread_known")
        || checkpoint.get("phase").and_then(Value::as_str) != Some(phase.as_str())
        || match attempt.try_get::<String, _>("runtime_type")?.as_str() {
            "codex_local" => checkpoint
                .get("provider")
                .and_then(Value::as_str)
                .is_some_and(|provider| provider != "codex_local"),
            "hermes_local" => {
                checkpoint.get("provider").and_then(Value::as_str) != Some("hermes_local")
            }
            "pi_local" => checkpoint.get("provider").and_then(Value::as_str) != Some("pi_local"),
            "claude_local" => {
                checkpoint.get("provider").and_then(Value::as_str) != Some("claude_local")
            }
            "opencode_local" => {
                checkpoint.get("provider").and_then(Value::as_str) != Some("open_code_local")
            }
            "cursor" | "cursor_local" => {
                checkpoint.get("provider").and_then(Value::as_str) != Some("cursor_local")
            }
            _ => true,
        }
        || attempt
            .try_get::<Option<String>, _>("provider_turn_id")?
            .is_some()
    {
        return Err(http(
            409,
            "Native Chat dispatch failure no longer matches admission",
        ));
    }

    sqlx::query("SELECT set_config('rudder.native_chat_write',$1,true)")
        .bind(NATIVE_WRITE_MARKER)
        .execute(&mut *tx)
        .await?;
    let generation_updated = sqlx::query(
        "UPDATE chat_generations SET native_admission_hold=true,updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND conversation_id=$3::uuid
           AND execution_authority='native_rust' AND native_admission_hold=false
           AND status='starting' AND attempt_epoch=1 AND control_state='unregistered'
           AND control_owner_token IS NULL AND control_lease_expires_at IS NULL
           AND provider_turn_id IS NULL AND runtime_terminal_at IS NULL",
    )
    .bind(&org)
    .bind(&generation_id)
    .bind(&conversation)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    let run_updated = sqlx::query(
        "UPDATE heartbeat_runs SET native_admission_hold=true,updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid AND agent_id=$3::uuid
           AND chat_conversation_id=$4::uuid AND chat_generation_id=$5::uuid
           AND execution_authority='native_rust' AND native_admission_hold=false
           AND status='running' AND process_pid IS NULL AND process_started_at IS NULL
           AND process_exited_at IS NULL AND session_id_after IS NULL",
    )
    .bind(&org)
    .bind(&run_id)
    .bind(selected_agent)
    .bind(&conversation)
    .bind(&generation_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if generation_updated != 1 || run_updated != 1 {
        return Err(http(409, "Native Chat dispatch state changed"));
    }
    let event_payload = json!({"code":"dispatch_unavailable"});
    sqlx::query(
        "INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,
          event_kind,payload,run_id)
         SELECT $1::uuid,$2::uuid,COALESCE(max(generation_seq),0)+1,1,
          'dispatch_unavailable',$3::jsonb,$4::uuid
         FROM chat_generation_events WHERE org_id=$1::uuid AND generation_id=$2::uuid",
    )
    .bind(&org)
    .bind(&generation_id)
    .bind(event_payload.to_string())
    .bind(&run_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO heartbeat_run_events(org_id,run_id,agent_id,seq,event_type,stream,level,message,payload)
         SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE(max(seq),0)+1,
           'runtime.native_chat_dispatch_unavailable','system','error',
           'Native Chat dispatch unavailable',$4::jsonb
         FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid",
    )
    .bind(&org)
    .bind(&run_id)
    .bind(selected_agent)
    .bind(json!({"generationId":generation_id,"code":"dispatch_unavailable"}).to_string())
    .execute(&mut *tx)
    .await?;
    let audit = ActivityActor {
        actor_type: if actor.actor().kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.actor().id.clone(),
        run_id: Some(run_id.clone()),
    };
    // `executionAuthority` is intentionally redacted by activity sanitization
    // because it contains the sensitive-key substring `auth`. Use a safe
    // provenance key so the persisted marker remains verifiable.
    let details = json!({"generationId":generation_id,"runId":run_id,"attemptId":attempt_id,
        "producer":"native_rust","code":"dispatch_unavailable"});
    write_activity_options(
        &mut tx,
        ActivityWrite {
            org: &org,
            audit: &audit,
            action: "chat.native_dispatch_unavailable",
            entity_type: "chat",
            entity_id: &conversation,
            details: Some(&details),
            options: ActivityOptions {
                bind_run: false,
                ..Default::default()
            },
        },
    )
    .await?;
    auth::authorize_org(&mut tx, actor, &org).await?;
    tx.commit().await?;
    Ok(())
}

#[derive(Clone, Debug)]
pub(super) struct AdmissionReceipt {
    conversation_id: String,
    user_message_id: String,
    source_message: Value,
    generation_id: String,
    generation_status: String,
    attempt_epoch: i32,
    execution_owner_live: Option<bool>,
    runtime_terminal: bool,
    run_id: String,
    run_status: String,
    attempt_id: String,
    held: bool,
    replayed: bool,
}

impl AdmissionReceipt {
    pub(super) fn json(&self) -> Value {
        json!({
            "conversationId": self.conversation_id,
            "userMessageId": self.user_message_id,
            "userMessage": self.source_message,
            "generationId": self.generation_id,
            "generationStatus": self.generation_status,
            "attemptEpoch": self.attempt_epoch,
            "executionOwnerLive": self.execution_owner_live,
            "runtimeTerminal": self.runtime_terminal,
            "runId": self.run_id,
            "runStatus": self.run_status,
            "attemptId": self.attempt_id,
            "executionAuthority": "native_rust",
            "nativeAdmissionHold": self.held,
            "idempotentReplay": self.replayed,
        })
    }
}

pub(super) async fn submit(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    organization_id: &str,
    conversation_id: &str,
    client_mutation_id: &str,
    body: &str,
    host: &LocalHostContext,
) -> Result<Value> {
    let fingerprint = validation::fingerprint(body);
    let tx = pool.begin().await?;
    let (tx, receipt) = submit_in_transaction(
        tx,
        actor,
        AdmissionInput {
            organization_id,
            conversation_id,
            client_mutation_id,
            body,
            fingerprint: &fingerprint,
            initial_draft_snapshot: None,
            host,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(receipt)
}

pub(super) struct AdmissionInput<'a> {
    pub organization_id: &'a str,
    pub conversation_id: &'a str,
    pub client_mutation_id: &'a str,
    pub body: &'a str,
    pub fingerprint: &'a str,
    /// Immutable metadata that binds an ordinary Chat's original first-turn
    /// choices. This is separate from the canonical body fingerprint consumed
    /// by the execution source reader and normal message reconciliation.
    pub initial_draft_snapshot: Option<&'a Value>,
    pub host: &'a LocalHostContext,
}

/// Shared existing-conversation admission body. A first-send caller keeps
/// conversation creation and this admission in one transaction, committing
/// only after the source message, binding, Run, Attempt and activity exist.
pub(super) async fn submit_in_transaction<'a>(
    mut tx: auth::Tx<'a>,
    actor: &impl NativeChatActor,
    input: AdmissionInput<'_>,
) -> Result<(auth::Tx<'a>, Value)> {
    let AdmissionInput {
        organization_id,
        conversation_id,
        client_mutation_id,
        body,
        fingerprint,
        initial_draft_snapshot,
        host,
    } = input;
    auth::preauthorize_org(&mut tx, actor, organization_id).await?;
    runtime_bindings::lock_native_chat_target_tx(&mut tx, organization_id, conversation_id).await?;
    // The target lock can wait. Do not hold a credential or membership lock
    // across that wait: once serialized, lock and revalidate the exact browser
    // proof and authorization rows before any admission reads or writes.
    auth::authorize_org(&mut tx, actor, organization_id).await?;

    // Read only enough target state to authorize a safe idempotency lookup.
    // Duplicate requests return before resolving current config so a retry
    // remains exact even when the Agent's settings changed after admission.
    let target_hint = sqlx::query(
        "SELECT conversation_kind, preferred_agent_id::text AS preferred_agent_id,
                routed_agent_id::text AS routed_agent_id,
                primary_issue_id::text AS primary_issue_id
         FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Chat conversation not found"))?;
    let target_kind: String = target_hint.try_get("conversation_kind")?;
    if target_kind != "chat" {
        return Err(http(404, "Ordinary Chat conversation not found"));
    }
    let selected_agent_hint = target_hint
        .try_get::<Option<String>, _>("preferred_agent_id")?
        .or(target_hint.try_get::<Option<String>, _>("routed_agent_id")?)
        .ok_or_else(|| http(409, "Chat conversation has no selected Agent"))?;
    auth::authorize_agent_actor(actor, &selected_agent_hint)?;
    runtime_bindings::authorize_chat_target_read_tx(
        &mut tx,
        actor,
        organization_id,
        conversation_id,
        &selected_agent_hint,
    )
    .await?;

    if let Some(receipt) = lookup_existing_receipt(
        &mut tx,
        organization_id,
        conversation_id,
        client_mutation_id,
        fingerprint,
    )
    .await?
    {
        // Exact mutation replay is still an authorized read. Lock Chat after
        // the optimistic lookup and re-derive its current Agent/owner scope
        // before returning the durable receipt. This path deliberately skips
        // Issue/config/budget work so a retry remains valid after config
        // changes while a reassigned Agent cannot read its old receipt.
        let conversation =
            auth::lock_conversation(&mut tx, organization_id, conversation_id).await?;
        if conversation.kind != "chat" {
            return Err(http(404, "Ordinary Chat conversation not found"));
        }
        let selected_agent_id = conversation
            .preferred_agent_id
            .as_deref()
            .or(conversation.routed_agent_id.as_deref())
            .ok_or_else(|| http(409, "Chat conversation has no selected Agent"))?;
        auth::authorize_agent_actor(actor, selected_agent_id)?;
        runtime_bindings::authorize_chat_target_read_tx(
            &mut tx,
            actor,
            organization_id,
            conversation_id,
            selected_agent_id,
        )
        .await?;
        auth::authorize_org(&mut tx, actor, organization_id).await?;
        return Ok((tx, receipt.json()));
    }

    let hinted_issue_id: Option<String> = target_hint.try_get("primary_issue_id")?;
    locks::verify_selected_agent_hint(
        &mut tx,
        organization_id,
        conversation_id,
        &selected_agent_hint,
    )
    .await?;
    let locked_issue_id = locks::lock_primary_issue_path_before_conversation(
        &mut tx,
        organization_id,
        conversation_id,
    )
    .await?;
    if hinted_issue_id != locked_issue_id {
        return Err(http(409, "Chat primary Issue changed"));
    }

    // New admission follows the FK-safe Project→Workspace→Issue→Conversation
    // row order. The mutation lookup is repeated after the Conversation lock
    // before configuration or any write in case another writer raced us.
    let conversation = auth::lock_conversation(&mut tx, organization_id, conversation_id).await?;
    let selected_agent_id = conversation
        .preferred_agent_id
        .as_deref()
        .or(conversation.routed_agent_id.as_deref())
        .ok_or_else(|| http(409, "Chat conversation has no selected Agent"))?;
    if conversation.kind != "chat"
        || selected_agent_id != selected_agent_hint
        || conversation.primary_issue_id != hinted_issue_id
    {
        return Err(http(409, "Native Chat target changed during admission"));
    }
    auth::authorize_agent_actor(actor, selected_agent_id)?;
    runtime_bindings::authorize_chat_target_read_tx(
        &mut tx,
        actor,
        organization_id,
        conversation_id,
        selected_agent_id,
    )
    .await?;

    if let Some(receipt) = lookup_existing_receipt(
        &mut tx,
        organization_id,
        conversation_id,
        client_mutation_id,
        fingerprint,
    )
    .await?
    {
        auth::authorize_org(&mut tx, actor, organization_id).await?;
        return Ok((tx, receipt.json()));
    }

    if conversation.status != "active" {
        return Err(http(409, "Chat conversation is not active"));
    }
    if has_active_or_held_chat(&mut tx, organization_id, conversation_id).await? {
        return Err(http(
            409,
            "Chat has an active or unreconciled operation; reconcile it before sending another message",
        ));
    }

    if has_unresolved_legacy_queue(&mut tx, organization_id, conversation_id).await? {
        return Err(http(
            409,
            "Chat has unresolved queued input; finish or reconcile it before Native Chat admission",
        ));
    }

    if has_unresolved_legacy_input(&mut tx, organization_id, conversation_id).await? {
        return Err(http(
            409,
            "Chat has unresolved legacy input; finish or reconcile it before Native Chat admission",
        ));
    }

    let config = resolve_native_config(&mut tx, organization_id, conversation_id, host).await?;
    if config.identity.agent_id != selected_agent_id {
        return Err(http(409, "Resolved Native Chat Agent changed"));
    }
    budget::ensure_not_blocked(&mut tx, organization_id, selected_agent_id).await?;

    // Enable only this Rust-owned transaction's guarded persistence writes.
    // From here through message, binding, Run, Attempt, and audit creation,
    // any failure rolls the entire admission back.
    sqlx::query("SELECT set_config('rudder.native_chat_write', $1, true)")
        .bind(NATIVE_WRITE_MARKER)
        .execute(&mut *tx)
        .await?;

    // Ensure the immutable binding and its current segment in this same
    // transaction, after all read-only admission checks and before creating a
    // source message, Generation, Run, or Attempt.
    let identity = binding_identity(&config);
    let binding = runtime_bindings::ensure_native_chat_binding_tx(
        &mut tx,
        actor,
        organization_id,
        conversation_id,
        &identity,
    )
    .await?;
    let runtime_type = config.identity.runtime_type.as_str();
    let (checkpoint, reuse_scope, resume_source, session_intent) = match (
        runtime_type,
        binding.state.as_str(),
        binding.native_session_id.as_deref(),
    ) {
        ("codex_local", "pending", None) => (
            NativeChatProtocolCheckpoint::new(NativeChatProtocolStart::FreshThread),
            "none",
            "fresh",
            json!({"kind":"fresh","reuseScope":"none","sourceRunId":null,"sessionId":null,"sessionParams":null}),
        ),
        ("codex_local", "open", Some(thread_id)) => (
            NativeChatProtocolCheckpoint::new(NativeChatProtocolStart::ExistingThread {
                thread_id: thread_id.to_owned(),
            }),
            "explicit",
            "fresh",
            json!({"kind":"resume","reuseScope":"explicit","sourceRunId":null,"sessionId":thread_id,"sessionParams":null}),
        ),
        ("hermes_local", "pending", None) => (
            NativeChatProtocolCheckpoint::new_hermes_fresh_session(),
            "none",
            "fresh",
            json!({"kind":"fresh","reuseScope":"none","sourceRunId":null,"sessionId":null,"sessionParams":null}),
        ),
        ("hermes_local", "open", Some(session_id)) => {
            let selector = HermesSessionSelector::from_persisted(session_id)
                .map_err(|_| http(409, "Native Chat Hermes session locator is invalid"))?;
            (
                NativeChatProtocolCheckpoint::new_hermes_existing_session(selector),
                "explicit",
                "same_session",
                json!({"kind":"resume","reuseScope":"explicit","sourceRunId":null,"sessionId":session_id,"sessionParams":null}),
            )
        }
        ("claude_local", "pending", None) => (
            NativeChatProtocolCheckpoint::new_claude_fresh_session(),
            "none",
            "fresh",
            json!({"kind":"fresh","reuseScope":"none","sourceRunId":null,"sessionId":null,"sessionParams":null}),
        ),
        ("claude_local", "open", Some(session_id)) => {
            let selector = ClaudeSessionSelector::from_persisted(session_id)
                .map_err(|_| http(409, "Native Chat Claude Code session locator is invalid"))?;
            (
                NativeChatProtocolCheckpoint::new_claude_existing_session(selector),
                "explicit",
                "same_session",
                json!({"kind":"resume","reuseScope":"explicit","sourceRunId":null,"sessionId":session_id,"sessionParams":null}),
            )
        }
        (runtime, "pending", None)
            if matches!(runtime, "cursor" | "cursor_local" | "opencode_local") =>
        {
            let checkpoint = match runtime {
                "opencode_local" => NativeChatProtocolCheckpoint::new_opencode_fresh_session(),
                _ => NativeChatProtocolCheckpoint::new_cursor_fresh_session(),
            };
            (
                checkpoint,
                "none",
                "fresh",
                json!({"kind":"fresh","reuseScope":"none","sourceRunId":null,"sessionId":null,"sessionParams":null}),
            )
        }
        (runtime, "open", Some(session_id))
            if matches!(runtime, "cursor" | "cursor_local" | "opencode_local") =>
        {
            let checkpoint = match runtime {
                "opencode_local" => {
                    let selector =
                        OpenCodeSessionSelector::from_persisted(session_id).map_err(|_| {
                            http(409, "Native Chat OpenCode session locator is invalid")
                        })?;
                    NativeChatProtocolCheckpoint::new_opencode_existing_session(selector)
                }
                _ => {
                    let selector = CursorSessionSelector::from_persisted(session_id)
                        .map_err(|_| http(409, "Native Chat Cursor session locator is invalid"))?;
                    NativeChatProtocolCheckpoint::new_cursor_existing_session(selector)
                }
            };
            (
                checkpoint,
                "explicit",
                "same_session",
                json!({"kind":"resume","reuseScope":"explicit","sourceRunId":null,"sessionId":session_id,"sessionParams":null}),
            )
        }
        _ => return Err(http(409, "Native Chat segment cannot admit new input")),
    };

    let message = sqlx::query(
        "INSERT INTO chat_messages
           (org_id, conversation_id, role, kind, status, body,
            client_mutation_id, client_mutation_fingerprint, turn_variant)
         VALUES ($1::uuid, $2::uuid, 'user', 'message', 'completed', $3, $4, $5, 0)
         RETURNING id::text AS id, turn_variant",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .bind(body)
    .bind(client_mutation_id)
    .bind(fingerprint)
    .fetch_one(&mut *tx)
    .await?;
    let message_id: String = message.try_get("id")?;
    let turn_variant: i32 = message.try_get("turn_variant")?;

    let generation_id: String = sqlx::query_scalar(
        "INSERT INTO chat_generations
           (org_id, conversation_id, execution_authority, source_message_id,
            source_turn_variant, native_admission_hold, status, attempt_epoch,
            control_state, control_runtime_type)
         VALUES ($1::uuid, $2::uuid, 'native_rust', $3::uuid, $4, false,
                 'starting', 1, 'unregistered', $5)
         RETURNING id::text",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .bind(&message_id)
    .bind(turn_variant)
    .bind(runtime_type)
    .fetch_one(&mut *tx)
    .await?;

    let owner_token: String = sqlx::query_scalar("SELECT gen_random_uuid()::text")
        .fetch_one(&mut *tx)
        .await?;
    let mut context_snapshot = json!({
        "scene": "chat",
        "targetType": "chat_conversation",
        "targetId": conversation_id,
        "conversationId": conversation_id,
        "runtimeBindingId": &binding.binding_id,
        "nativeSegmentId": &binding.segment_id,
        "messageId": message_id,
        "userMessageId": message_id,
        "inputFingerprint": fingerprint,
        "turnVariant": turn_variant,
        "stream": true,
    });
    if let Some(initial_draft_snapshot) = initial_draft_snapshot {
        let mut snapshot = initial_draft_snapshot.clone();
        let object = snapshot
            .as_object_mut()
            .ok_or_else(|| http(409, "Initial Native Chat draft proof is invalid"))?;
        // Safe immutable projection facts from the configuration resolved and
        // admitted in this transaction, never from a later mutable Agent row.
        object.insert(
            "safeRuntimeDescriptor".into(),
            json!({
                "version":1, "runtimeType":runtime_type,
            }),
        );
        object.insert(
            "safeChatRuntime".into(),
            json!({
                "version":1, "sourceType":"agent", "runtimeType":runtime_type,
                "sourceLabel":if runtime_type == "hermes_local" { "Hermes Agent" } else { "Codex Agent" }, "runtimeAgentId":config.identity.agent_id,
                "model":config.model, "effort":config.reasoning_effort,
                "available":true, "error":null,
            }),
        );
        context_snapshot
            .as_object_mut()
            .expect("context snapshot is an object")
            .insert("nativeChatInitialDraft".into(), snapshot);
    }
    let run_id: String = sqlx::query_scalar(
        "INSERT INTO heartbeat_runs
           (org_id, agent_id, invocation_source, trigger_detail, status,
            started_at, session_reuse_scope, session_id_before, execution_owner_token,
            execution_lease_expires_at, chat_conversation_id, chat_generation_id,
            execution_authority, native_admission_hold, context_snapshot, scene,
            target_type, target_id, idempotency_key, session_intent_json)
         VALUES ($1::uuid, $2::uuid, 'chat', 'chat_assistant_reply_stream', 'running',
                 clock_timestamp(), $4, $5, $3, clock_timestamp() + interval '1 minute',
                 $6::uuid, $7::uuid, 'native_rust', false, $8::jsonb, 'chat',
                 'chat_conversation', $6, $9, $10::jsonb)
         RETURNING id::text",
    )
    .bind(organization_id)
    .bind(selected_agent_id)
    .bind(&owner_token)
    .bind(reuse_scope)
    .bind(Option::<&str>::None)
    .bind(conversation_id)
    .bind(&generation_id)
    .bind(context_snapshot.to_string())
    .bind(format!("native-chat:{generation_id}"))
    .bind(session_intent.to_string())
    .fetch_one(&mut *tx)
    .await?;

    let checkpoint = checkpoint.map_err(|error| {
        http(
            409,
            format!("Invalid initial Native Chat checkpoint: {error}"),
        )
    })?;
    let protocol_phase = checkpoint.phase().as_str();
    let checkpoint = serde_json::to_value(checkpoint)
        .map_err(|_| http(500, "Failed to encode Native Chat checkpoint"))?;
    let attempt_id: String = sqlx::query_scalar(
        "INSERT INTO heartbeat_run_attempts
           (org_id, run_id, agent_id, attempt_index, runtime_type, resume_source,
            status, owner_token, attempt_epoch, generation_attempt_epoch,
            connection_epoch, protocol_phase, checkpoint_json, provider_thread_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4, $5,
                 'started', $6, 1, 1, 1, $7, $8::jsonb, $9)
         RETURNING id::text",
    )
    .bind(organization_id)
    .bind(&run_id)
    .bind(selected_agent_id)
    .bind(runtime_type)
    .bind(resume_source)
    .bind(&owner_token)
    .bind(protocol_phase)
    .bind(checkpoint.to_string())
    .bind(if runtime_type == "codex_local" {
        binding.native_session_id.as_deref()
    } else {
        None
    })
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query("UPDATE chat_messages SET run_id=$1::uuid, updated_at=clock_timestamp() WHERE org_id=$2::uuid AND id=$3::uuid")
        .bind(&run_id)
        .bind(organization_id)
        .bind(&message_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE chat_conversations SET last_message_at=clock_timestamp(), updated_at=clock_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(organization_id)
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "INSERT INTO chat_generation_events
           (org_id, generation_id, generation_seq, attempt_epoch, event_kind, payload, run_id)
         VALUES ($1::uuid, $2::uuid, 1, 1, 'generation_started', $3::jsonb, $4::uuid)",
    )
    .bind(organization_id)
    .bind(&generation_id)
    .bind(json!({ "runId": run_id, "attemptId": attempt_id }).to_string())
    .bind(&run_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO heartbeat_run_events
           (org_id, run_id, agent_id, seq, event_type, stream, level, message, payload)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'runtime.native_chat_admitted',
                 'system', 'info', 'Native Chat turn admitted', $4::jsonb)",
    )
    .bind(organization_id)
    .bind(&run_id)
    .bind(selected_agent_id)
    .bind(json!({ "generationId": generation_id, "attemptId": attempt_id }).to_string())
    .execute(&mut *tx)
    .await?;

    let activity_details = json!({
        "role": "user",
        "kind": "message",
        "conversationId": conversation_id,
        "messageId": message_id,
        "generationId": generation_id,
        "runId": run_id,
        "attemptId": attempt_id,
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
            org: organization_id,
            audit: &audit,
            action: "chat.message_added",
            entity_type: "chat",
            entity_id: conversation_id,
            details: Some(&activity_details),
            options: ActivityOptions {
                agent_id: (actor.actor().kind == "agent").then_some(selected_agent_id),
                bind_run: false,
                ..Default::default()
            },
        },
    )
    .await?;

    auth::authorize_org(&mut tx, actor, organization_id).await?;
    let source_message = persisted_user_message(
        &mut tx,
        organization_id,
        conversation_id,
        &message_id,
        &generation_id,
        &run_id,
    )
    .await?;
    Ok((
        tx,
        AdmissionReceipt {
            conversation_id: conversation_id.to_owned(),
            user_message_id: message_id,
            source_message,
            generation_id,
            generation_status: "starting".into(),
            attempt_epoch: 1,
            execution_owner_live: Some(false),
            runtime_terminal: false,
            run_id,
            run_status: "running".into(),
            attempt_id,
            held: false,
            replayed: false,
        }
        .json(),
    ))
}

pub(super) async fn lookup_existing_receipt(
    tx: &mut auth::Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
    client_mutation_id: &str,
    fingerprint: &str,
) -> Result<Option<AdmissionReceipt>> {
    let message = sqlx::query(
        "SELECT id::text AS id, turn_variant, client_mutation_fingerprint
         FROM chat_messages
         WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND client_mutation_id=$3",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .bind(client_mutation_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(message) = message else {
        return Ok(None);
    };
    let message_id: String = message.try_get("id")?;
    let stored_fingerprint: Option<String> = message.try_get("client_mutation_fingerprint")?;
    if stored_fingerprint.as_deref() != Some(fingerprint) {
        return Err(http(
            409,
            "Client mutation id conflicts with existing content",
        ));
    }
    let turn_variant: i32 = message.try_get("turn_variant")?;
    replay_receipt(
        tx,
        organization_id,
        conversation_id,
        &message_id,
        turn_variant,
    )
    .await
    .map(Some)
}

async fn replay_receipt(
    tx: &mut auth::Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
    message_id: &str,
    turn_variant: i32,
) -> Result<AdmissionReceipt> {
    let row = sqlx::query(
        "SELECT g.id::text AS generation_id, g.status AS generation_status,
                g.attempt_epoch,
                CASE
                  WHEN g.runtime_terminal_at IS NOT NULL AND g.control_lease_expires_at IS NULL THEN false
             WHEN g.control_owner_token IS NULL AND g.control_lease_expires_at IS NULL THEN false
                  WHEN g.control_owner_token IS NOT NULL
                   AND g.control_lease_expires_at > statement_timestamp() THEN true
                  WHEN g.control_owner_token IS NOT NULL
                   AND g.control_lease_expires_at IS NOT NULL THEN false
                  ELSE NULL
                END AS execution_owner_live,
                (g.runtime_terminal_at IS NOT NULL) AS runtime_terminal,
                g.native_admission_hold AS generation_hold,
                r.id::text AS run_id, r.status AS run_status,
                r.native_admission_hold AS run_hold,
                a.id::text AS attempt_id
         FROM chat_generations g
         JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         WHERE g.org_id=$1::uuid AND g.conversation_id=$2::uuid
           AND g.execution_authority='native_rust'
           AND g.source_message_id=$3::uuid AND g.source_turn_variant=$4
         ORDER BY a.attempt_index ASC LIMIT 1",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .bind(message_id)
    .bind(turn_variant)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| {
        http(
            409,
            "Existing client mutation has no exact Native Chat admission",
        )
    })?;
    let generation_hold: bool = row.try_get("generation_hold")?;
    let run_hold: bool = row.try_get("run_hold")?;
    if generation_hold != run_hold {
        return Err(http(409, "Native Chat hold state requires reconciliation"));
    }
    let generation_id: String = row.try_get("generation_id")?;
    let run_id: String = row.try_get("run_id")?;
    Ok(AdmissionReceipt {
        conversation_id: conversation_id.to_owned(),
        user_message_id: message_id.to_owned(),
        source_message: persisted_user_message(
            tx,
            organization_id,
            conversation_id,
            message_id,
            &generation_id,
            &run_id,
        )
        .await?,
        generation_id,
        generation_status: row.try_get("generation_status")?,
        attempt_epoch: row.try_get("attempt_epoch")?,
        execution_owner_live: row.try_get("execution_owner_live")?,
        runtime_terminal: row.try_get("runtime_terminal")?,
        run_id,
        run_status: row.try_get("run_status")?,
        attempt_id: row.try_get("attempt_id")?,
        held: generation_hold,
        replayed: true,
    })
}

/// Return the exact source-message DTO in the same authorized admission/read
/// transaction as its durable receipt. This lets the HTTP layer acknowledge a
/// committed input even if the browser credential expires before executor
/// claim, without constructing a message from caller data or claiming success.
async fn persisted_user_message(
    tx: &mut auth::Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
    message_id: &str,
    generation_id: &str,
    run_id: &str,
) -> Result<Value> {
    let value: Option<Value> = sqlx::query_scalar(
        "SELECT CASE WHEN octet_length(m.body)<=262144
           AND m.role='user' AND m.kind='message' AND m.status='completed'
           AND m.approval_id IS NULL
           AND (m.structured_payload IS NULL OR m.structured_payload IN ('null'::jsonb,'{}'::jsonb))
           AND NOT EXISTS(SELECT 1 FROM chat_attachments a
             WHERE a.org_id=m.org_id AND a.message_id=m.id)
         THEN jsonb_build_object(
           'id',m.id,'orgId',m.org_id,'conversationId',m.conversation_id,
           'role',m.role,'kind',m.kind,'status',m.status,'body',m.body,
           'structuredPayload',NULL,'approvalId',NULL,'approval',NULL,'attachments','[]'::jsonb,
           'runId',m.run_id,'generationId',$4::uuid,'replyingAgentId',m.replying_agent_id,
           'chatTurnId',m.chat_turn_id,'turnVariant',m.turn_variant,
           'supersededAt',m.superseded_at,'createdAt',m.created_at,'updatedAt',m.updated_at)
         END
         FROM chat_messages m
         WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid AND m.id=$3::uuid
           AND m.run_id=$5::uuid",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .bind(message_id)
    .bind(generation_id)
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?;
    value.ok_or_else(|| http(409, "Native Chat source message projection is unavailable"))
}

async fn has_active_or_held_chat(
    tx: &mut auth::Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
) -> Result<bool> {
    sqlx::query_scalar::<_, bool>(&format!(
        "SELECT EXISTS (
           SELECT 1 FROM chat_generations
           WHERE org_id=$1::uuid AND conversation_id=$2::uuid
             AND (native_admission_hold=true OR status IN ({ACTIVE_GENERATION_STATUSES}))
         ) OR EXISTS (
           SELECT 1 FROM heartbeat_runs r
           WHERE r.org_id=$1::uuid
             AND (r.chat_conversation_id=$2::uuid OR EXISTS (
               SELECT 1 FROM chat_generations g
               WHERE g.org_id=r.org_id AND g.conversation_id=$2::uuid
                 AND g.execution_authority='legacy_ts'
                 AND r.context_snapshot->>'chatGenerationId'=g.id::text
             ))
             AND (r.native_admission_hold=true OR r.status IN ('queued','running') OR r.terminal_effects_pending=true)
         )"
    ))
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Error::from)
}

/// A legacy send commits its user message before creating a Generation. The
/// shared target lock serializes each transaction, but cannot bridge that gap.
/// Do not take over while any retained input has no exact terminal projection.
/// Legacy Generations deliberately have no source_message_id, so use the
/// existing turn/variant association rather than guessing a Generation link.
async fn has_unresolved_legacy_input(
    tx: &mut auth::Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
) -> Result<bool> {
    sqlx::query_scalar(
        "WITH terminal_replies AS MATERIALIZED (
           SELECT chat_turn_id,turn_variant,max(created_at) AS terminal_at
           FROM chat_messages
           WHERE org_id=$1::uuid AND conversation_id=$2::uuid
             AND role='assistant' AND kind='message'
             AND status IN ('completed','failed','stopped')
             AND superseded_at IS NULL AND chat_turn_id IS NOT NULL
           GROUP BY chat_turn_id,turn_variant
         ) SELECT EXISTS (
           SELECT 1 FROM chat_messages source
           LEFT JOIN terminal_replies reply ON reply.chat_turn_id=source.chat_turn_id
             AND reply.turn_variant=source.turn_variant
           WHERE source.org_id=$1::uuid AND source.conversation_id=$2::uuid
             AND source.role='user' AND source.kind='message'
             AND source.superseded_at IS NULL
             AND (reply.terminal_at IS NULL OR reply.terminal_at<source.created_at)
             AND NOT EXISTS (
             SELECT 1 FROM chat_generations g
             WHERE g.org_id=$1::uuid AND g.conversation_id=$2::uuid
               AND g.execution_authority='native_rust'
               AND g.source_message_id=source.id
               AND g.source_turn_variant=source.turn_variant
           )
         )",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Error::from)
}

/// The target advisory and Conversation locks are already held. Legacy queue
/// writers take the same target lock before touching queue rows, so this fresh
/// statement observes the winner of a concurrent legacy delivery. A retry of an
/// existing Native admission returns before this check and remains read-only.
async fn has_unresolved_legacy_queue(
    tx: &mut auth::Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
) -> Result<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS (
           SELECT 1 FROM chat_queued_messages q
           WHERE q.org_id=$1::uuid AND q.conversation_id=$2::uuid
             AND NOT COALESCE((
               q.delivery_lease_token IS NULL AND q.delivery_lease_owner IS NULL
               AND q.delivery_lease_expires_at IS NULL
               AND (
                 (q.status IN ('delivered','completed') AND q.cancelled_at IS NULL)
                 OR (q.status='cancelled' AND q.cancelled_at IS NOT NULL
                   AND q.continuation_generation_id IS NULL AND q.continuation_message_id IS NULL
                   AND q.provider_client_message_id IS NULL AND q.provider_thread_id IS NULL
                   AND q.provider_turn_id IS NULL AND q.provider_evidence IS NULL)
               )
               AND (q.control_action_id IS NULL OR EXISTS (
                 SELECT 1 FROM chat_control_actions a
                 WHERE a.org_id=q.org_id AND a.id=q.control_action_id
                   AND a.resolved_at IS NOT NULL
                   AND (
                     (q.status IN ('delivered','completed')
                       AND a.local_disposition='delivered'
                       AND a.provider_disposition IN ('not_sent','rejected','acknowledged'))
                     OR (q.status='cancelled' AND a.local_disposition='cancelled'
                       AND a.provider_disposition IN ('not_sent','rejected')
                       AND a.provider_sent_at IS NULL AND a.provider_acknowledged_at IS NULL
                       AND a.provider_client_message_id IS NULL AND a.provider_thread_id IS NULL
                       AND a.provider_turn_id IS NULL AND a.provider_evidence IS NULL)
                   )
               ))
             ),false)
         )",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Error::from)
}
