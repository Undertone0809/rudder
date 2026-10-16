use super::{Error, Result, auth, binding_identity, budget, http, locks, validation};
use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
use crate::native_chat::config::{LocalHostContext, resolve_codex_config};
use crate::runtime_bindings;
use rudder_auth_core::VerifiedActor;
use rudder_runtime_core::native_chat::{NativeChatProtocolCheckpoint, NativeChatProtocolStart};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

const NATIVE_WRITE_MARKER: &str = "native_chat:admission";
const ACTIVE_GENERATION_STATUSES: &str = "'starting', 'active', 'running', 'waiting_for_network', 'tool_busy', 'closing', 'stop_requested', 'stopping'";

#[derive(Clone, Debug)]
struct AdmissionReceipt {
    conversation_id: String,
    user_message_id: String,
    generation_id: String,
    generation_status: String,
    run_id: String,
    run_status: String,
    attempt_id: String,
    held: bool,
    replayed: bool,
}

impl AdmissionReceipt {
    fn json(&self) -> Value {
        json!({
            "conversationId": self.conversation_id,
            "userMessageId": self.user_message_id,
            "generationId": self.generation_id,
            "generationStatus": self.generation_status,
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
    actor: &VerifiedActor,
    organization_id: &str,
    conversation_id: &str,
    client_mutation_id: &str,
    body: &str,
    host: &LocalHostContext,
) -> Result<Value> {
    let fingerprint = validation::fingerprint(body);
    let mut tx = pool.begin().await?;
    auth::authorize_org(&mut tx, actor, organization_id).await?;
    runtime_bindings::lock_native_chat_target_tx(&mut tx, organization_id, conversation_id).await?;

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
        &fingerprint,
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
        tx.commit().await?;
        return Ok(receipt.json());
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
        &fingerprint,
    )
    .await?
    {
        tx.commit().await?;
        return Ok(receipt.json());
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

    let config = resolve_codex_config(&mut tx, organization_id, conversation_id, host).await?;
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
    let (protocol_start, reuse_scope, session_id_before, session_intent) =
        match (binding.state.as_str(), binding.native_session_id.as_deref()) {
            ("pending", None) => (
                NativeChatProtocolStart::FreshThread,
                "none",
                None,
                json!({
                    "kind": "fresh",
                    "reuseScope": "none",
                    "sourceRunId": null,
                    "sessionId": null,
                    "sessionParams": null,
                }),
            ),
            ("open", Some(thread_id)) => (
                NativeChatProtocolStart::ExistingThread {
                    thread_id: thread_id.to_owned(),
                },
                "explicit",
                Some(thread_id),
                json!({
                    "kind": "resume",
                    "reuseScope": "explicit",
                    "sourceRunId": null,
                    "sessionId": thread_id,
                    "sessionParams": null,
                }),
            ),
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
    .bind(&fingerprint)
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
                 'starting', 1, 'unregistered', 'codex_local')
         RETURNING id::text",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .bind(&message_id)
    .bind(turn_variant)
    .fetch_one(&mut *tx)
    .await?;

    let owner_token: String = sqlx::query_scalar("SELECT gen_random_uuid()::text")
        .fetch_one(&mut *tx)
        .await?;
    let context_snapshot = json!({
        "scene": "chat",
        "targetType": "chat_conversation",
        "targetId": conversation_id,
        "conversationId": conversation_id,
        "runtimeBindingId": &binding.binding_id,
        "nativeSegmentId": &binding.segment_id,
        "messageId": message_id,
        "userMessageId": message_id,
        "turnVariant": turn_variant,
        "stream": true,
    });
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
    .bind(session_id_before)
    .bind(conversation_id)
    .bind(&generation_id)
    .bind(context_snapshot.to_string())
    .bind(format!("native-chat:{generation_id}"))
    .bind(session_intent.to_string())
    .fetch_one(&mut *tx)
    .await?;

    let checkpoint = NativeChatProtocolCheckpoint::new(protocol_start).map_err(|error| {
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
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'codex_local', 'fresh',
                 'started', $4, 1, 1, 1, $5, $6::jsonb, $7)
         RETURNING id::text",
    )
    .bind(organization_id)
    .bind(&run_id)
    .bind(selected_agent_id)
    .bind(&owner_token)
    .bind(protocol_phase)
    .bind(checkpoint.to_string())
    .bind(binding.native_session_id.as_deref())
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

    tx.commit().await?;
    Ok(AdmissionReceipt {
        conversation_id: conversation_id.to_owned(),
        user_message_id: message_id,
        generation_id,
        generation_status: "starting".into(),
        run_id,
        run_status: "running".into(),
        attempt_id,
        held: false,
        replayed: false,
    }
    .json())
}

async fn lookup_existing_receipt(
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
    Ok(AdmissionReceipt {
        conversation_id: conversation_id.to_owned(),
        user_message_id: message_id.to_owned(),
        generation_id: row.try_get("generation_id")?,
        generation_status: row.try_get("generation_status")?,
        run_id: row.try_get("run_id")?,
        run_status: row.try_get("run_status")?,
        attempt_id: row.try_get("attempt_id")?,
        held: generation_hold,
        replayed: true,
    })
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
           SELECT 1 FROM heartbeat_runs
           WHERE org_id=$1::uuid AND chat_conversation_id=$2::uuid
             AND (native_admission_hold=true OR status IN ('queued','running') OR terminal_effects_pending=true)
         )"
    ))
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Error::from)
}
