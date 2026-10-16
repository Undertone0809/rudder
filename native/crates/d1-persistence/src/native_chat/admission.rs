use super::{Error, Result, auth, budget, http, validation};
use crate::activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options};
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
) -> Result<Value> {
    let fingerprint = validation::fingerprint(body);
    let mut tx = pool.begin().await?;
    auth::authorize_org(&mut tx, actor, organization_id).await?;
    let conversation = auth::lock_conversation(&mut tx, organization_id, conversation_id).await?;
    if conversation.kind != "chat" {
        return Err(http(404, "Ordinary Chat conversation not found"));
    }

    let selected_agent_id = conversation
        .preferred_agent_id
        .as_deref()
        .or(conversation.routed_agent_id.as_deref());
    if actor.actor().kind == "agent" {
        let selected_agent_id =
            selected_agent_id.ok_or_else(|| http(403, "Chat conversation access denied"))?;
        auth::authorize_agent_actor(actor, selected_agent_id)?;
    } else {
        auth::authorize_agent_actor(actor, "user-actor")?;
    }

    // Idempotency is resolved before the active/hold guard. A safe exact retry
    // must return its original receipt even while it still requires recovery.
    if let Some(message) = sqlx::query(
        "SELECT id::text AS id, turn_variant, client_mutation_fingerprint
         FROM chat_messages
         WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND client_mutation_id=$3
         FOR UPDATE",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .bind(client_mutation_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        let message_id: String = message.try_get("id")?;
        let stored_fingerprint: Option<String> = message.try_get("client_mutation_fingerprint")?;
        if stored_fingerprint.as_deref() != Some(fingerprint.as_str()) {
            return Err(http(
                409,
                "Client mutation id conflicts with existing content",
            ));
        }
        let turn_variant: i32 = message.try_get("turn_variant")?;
        let receipt = replay_receipt(
            &mut tx,
            organization_id,
            conversation_id,
            &message_id,
            turn_variant,
        )
        .await?;
        tx.commit().await?;
        return Ok(receipt.json());
    }

    // This bounded admission slice does not yet have a trusted current
    // Binding identity resolver. Never infer provider configuration or Thread
    // continuity from stored Binding/Segment values; require the later Rust
    // execution slice to prove them before accepting another input.
    if has_active_binding(&mut tx, organization_id, conversation_id).await? {
        return Err(http(
            409,
            "Current Chat Binding requires trusted identity resolution before Native Chat admission",
        ));
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

    let selected_agent_id =
        selected_agent_id.ok_or_else(|| http(409, "Chat conversation has no selected Agent"))?;
    let agent = sqlx::query(
        "SELECT agent_runtime_type
         FROM agents WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(organization_id)
    .bind(selected_agent_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Agent not found"))?;
    let runtime_type: String = agent.try_get("agent_runtime_type")?;
    if runtime_type != "codex_local" {
        return Err(http(
            409,
            "Native Chat admission currently supports codex_local only",
        ));
    }

    budget::ensure_not_blocked(&mut tx, organization_id, selected_agent_id).await?;
    sqlx::query("SELECT set_config('rudder.native_chat_write', $1, true)")
        .bind(NATIVE_WRITE_MARKER)
        .execute(&mut *tx)
        .await?;

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
    let session_intent = json!({
        "kind": "fresh",
        "reuseScope": "none",
        "sourceRunId": null,
        "sessionId": null,
        "sessionParams": null,
    });
    let context_snapshot = json!({
        "scene": "chat",
        "targetType": "chat_conversation",
        "targetId": conversation_id,
        "conversationId": conversation_id,
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
                 clock_timestamp(), 'none', NULL, $3, clock_timestamp() + interval '1 minute',
                 $4::uuid, $5::uuid, 'native_rust', false, $6::jsonb, 'chat',
                 'chat_conversation', $4, $7, $8::jsonb)
         RETURNING id::text",
    )
    .bind(organization_id)
    .bind(selected_agent_id)
    .bind(&owner_token)
    .bind(conversation_id)
    .bind(&generation_id)
    .bind(context_snapshot.to_string())
    .bind(format!("native-chat:{generation_id}"))
    .bind(session_intent.to_string())
    .fetch_one(&mut *tx)
    .await?;

    let checkpoint = NativeChatProtocolCheckpoint::new(NativeChatProtocolStart::FreshThread)
        .map_err(|error| {
            http(
                409,
                format!("Invalid initial Native Chat checkpoint: {error}"),
            )
        })?;
    let checkpoint = serde_json::to_value(checkpoint)
        .map_err(|_| http(500, "Failed to encode Native Chat checkpoint"))?;
    let attempt_id: String = sqlx::query_scalar(
        "INSERT INTO heartbeat_run_attempts
           (org_id, run_id, agent_id, attempt_index, runtime_type, resume_source,
            status, owner_token, attempt_epoch, generation_attempt_epoch,
            connection_epoch, protocol_phase, checkpoint_json)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'codex_local', 'fresh',
                 'started', $4, 1, 1, 1, 'no_thread_request', $5::jsonb)
         RETURNING id::text",
    )
    .bind(organization_id)
    .bind(&run_id)
    .bind(selected_agent_id)
    .bind(&owner_token)
    .bind(checkpoint.to_string())
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

async fn has_active_binding(
    tx: &mut auth::Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
) -> Result<bool> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (
           SELECT 1 FROM runtime_bindings
           WHERE org_id=$1::uuid AND status='active'
             AND (conversation_id=$2::uuid
               OR (target_type='chat_conversation' AND target_id=$2))
         )",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(Error::from)
}
