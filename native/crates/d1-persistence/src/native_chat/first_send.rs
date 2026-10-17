//! Atomic first-message creation for ordinary Chat.
//!
//! The caller supplies only the existing user choices that this Rust path
//! implements. Actor, organization grant, Agent runtime config, host facts,
//! and every generated identity come from trusted Rust state or persisted
//! rows. Conversation creation and the normal Native Chat admission body share
//! one SQL transaction.

use super::{Error, config::LocalHostContext};
use super::{NativeChatActor, Result, admission, auth, http, validation};
use crate::runtime_bindings;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};

pub(super) fn title(value: Option<&str>, body: &str) -> Result<String> {
    if let Some(value) = value {
        let value = value.trim();
        if value.is_empty()
            || value.encode_utf16().count() > 200
            || value.chars().any(char::is_control)
        {
            return Err(http(400, "Invalid chat title"));
        }
        return Ok(value.to_owned());
    }

    // Match the existing first-message title default without introducing a
    // new ordering or a caller-provided Conversation identity.
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let compact = compact.chars().take(200).collect::<String>();
    Ok(if compact.is_empty() {
        "Run feedback".to_owned()
    } else {
        compact
    })
}

pub(super) fn issue_creation_mode(value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if !matches!(value, "manual_approval" | "auto_create") {
        return Err(http(400, "Invalid Chat issue creation mode"));
    }
    Ok(Some(value.to_owned()))
}

#[derive(Clone, Copy)]
pub(super) struct FirstSendInput<'a> {
    pub client_mutation_id: &'a str,
    pub preferred_agent_id: Option<&'a str>,
    pub model_override: Option<&'a str>,
    pub effort_override: Option<&'a str>,
    pub issue_creation_mode: Option<&'a str>,
    pub title: &'a str,
    pub body: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitialDraftProof {
    version: u8,
    fingerprint: String,
    selected_agent_id: String,
    title: String,
    model_override: Option<String>,
    effort_override: Option<String>,
    issue_creation_mode: String,
    plan_mode: bool,
}

pub(super) async fn lookup_submission(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    organization_id: &str,
    input: &FirstSendInput<'_>,
) -> Result<Option<Value>> {
    let client_mutation_id = input.client_mutation_id;
    validate_actor(actor, organization_id)?;
    let mut tx = pool.begin().await?;
    auth::preauthorize_org(&mut tx, actor, organization_id).await?;
    let candidate = find_initial_conversation(
        &mut tx,
        organization_id,
        &actor.actor().id,
        client_mutation_id,
    )
    .await?;
    let Some(conversation_id) = candidate else {
        auth::authorize_org(&mut tx, actor, organization_id).await?;
        tx.commit().await?;
        return Ok(None);
    };

    runtime_bindings::lock_native_chat_target_tx(&mut tx, organization_id, &conversation_id)
        .await?;
    auth::authorize_org(&mut tx, actor, organization_id).await?;
    let value =
        exact_existing_receipt(&mut tx, actor, organization_id, &conversation_id, input).await?;
    tx.commit().await?;
    Ok(Some(value))
}

pub(super) async fn submit(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    organization_id: &str,
    input: &FirstSendInput<'_>,
    host: &LocalHostContext,
) -> Result<Value> {
    let FirstSendInput {
        client_mutation_id,
        preferred_agent_id,
        model_override,
        effort_override,
        issue_creation_mode,
        title,
        body,
    } = *input;
    validate_actor(actor, organization_id)?;
    let mut tx = pool.begin().await?;
    // Authenticate without retaining grants while waiting for the per-owner
    // first-send serialization key. The locked check follows it before writes.
    auth::preauthorize_org(&mut tx, actor, organization_id).await?;
    lock_first_send_key(
        &mut tx,
        organization_id,
        &actor.actor().id,
        client_mutation_id,
    )
    .await?;

    if let Some(conversation_id) = find_initial_conversation(
        &mut tx,
        organization_id,
        &actor.actor().id,
        client_mutation_id,
    )
    .await?
    {
        runtime_bindings::lock_native_chat_target_tx(&mut tx, organization_id, &conversation_id)
            .await?;
        auth::authorize_org(&mut tx, actor, organization_id).await?;
        let value =
            exact_existing_receipt(&mut tx, actor, organization_id, &conversation_id, input)
                .await?;
        tx.commit().await?;
        return Ok(value);
    }

    let selected_agent_id =
        resolve_selected_agent(&mut tx, organization_id, preferred_agent_id).await?;
    let issue_creation_mode = match issue_creation_mode {
        Some(value) => value.to_owned(),
        None => organization_issue_creation_mode(&mut tx, organization_id).await?,
    };
    let draft_fingerprint = first_draft_fingerprint(
        body,
        &selected_agent_id,
        title,
        model_override,
        effort_override,
        Some(&issue_creation_mode),
    );
    let body_fingerprint = validation::fingerprint(body);
    let initial_draft_snapshot = serde_json::json!({
        "version": 1,
        "fingerprint": draft_fingerprint,
        "selectedAgentId": selected_agent_id,
        "title": title,
        "modelOverride": model_override,
        "effortOverride": effort_override,
        "issueCreationMode": issue_creation_mode,
        "planMode": false,
    });

    // The partial unique index remains the authority across legacy Node
    // writers that do not take this advisory key. A collision is only replayed
    // when an exact Native receipt proves the same immutable draft.
    let inserted = sqlx::query(
        "INSERT INTO chat_conversations
           (org_id, title, preferred_agent_id, model_override, effort_override,
            issue_creation_mode, plan_mode, created_by_user_id,
            initial_client_mutation_id, last_message_at, updated_at)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, false, $7, $8,
                 clock_timestamp(), clock_timestamp())
         ON CONFLICT (org_id, created_by_user_id, initial_client_mutation_id)
           WHERE initial_client_mutation_id IS NOT NULL
         DO NOTHING
         RETURNING id::text AS id",
    )
    .bind(organization_id)
    .bind(title)
    .bind(&selected_agent_id)
    .bind(model_override)
    .bind(effort_override)
    .bind(&issue_creation_mode)
    .bind(&actor.actor().id)
    .bind(client_mutation_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(inserted) = inserted else {
        // A legacy first-send can win the DB uniqueness race without taking
        // our advisory lock. Its data has no Native draft proof, so it is not
        // safe to append to it or claim it as an exact replay.
        return Err(http(
            409,
            "Initial mutation key is already owned by an unreconciled Chat",
        ));
    };
    let conversation_id: String = inserted.try_get("id")?;

    let (tx, receipt) = admission::submit_in_transaction(
        tx,
        actor,
        admission::AdmissionInput {
            organization_id,
            conversation_id: &conversation_id,
            client_mutation_id,
            body,
            fingerprint: &body_fingerprint,
            initial_draft_snapshot: Some(&initial_draft_snapshot),
            host,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(receipt)
}

async fn exact_existing_receipt(
    tx: &mut auth::Tx<'_>,
    actor: &impl NativeChatActor,
    organization_id: &str,
    conversation_id: &str,
    input: &FirstSendInput<'_>,
) -> Result<Value> {
    let client_mutation_id = input.client_mutation_id;
    let body = input.body;
    let conversation = auth::lock_conversation(tx, organization_id, conversation_id).await?;
    if conversation.kind != "chat" {
        return Err(http(
            409,
            "Initial mutation key belongs to a non-Chat conversation",
        ));
    }
    let proof = initial_draft_proof(tx, organization_id, conversation_id, client_mutation_id)
        .await?
        .ok_or_else(|| {
            http(
                409,
                "Initial mutation key has no exact Native Chat receipt; reconcile the existing Chat",
            )
        })?;
    validate_initial_draft(&proof, input)?;
    let receipt = admission::lookup_existing_receipt(
        tx,
        organization_id,
        conversation_id,
        client_mutation_id,
        &validation::fingerprint(body),
    )
    .await?
    .ok_or_else(|| {
        http(
            409,
            "Initial mutation key has no exact Native Chat receipt; reconcile the existing Chat",
        )
    })?;
    runtime_bindings::authorize_chat_target_read_tx(
        tx,
        actor,
        organization_id,
        conversation_id,
        &proof.selected_agent_id,
    )
    .await?;
    auth::authorize_org(tx, actor, organization_id).await?;
    Ok(receipt.json())
}

async fn find_initial_conversation(
    tx: &mut auth::Tx<'_>,
    organization_id: &str,
    user_id: &str,
    client_mutation_id: &str,
) -> Result<Option<String>> {
    sqlx::query_scalar(
        "SELECT id::text FROM chat_conversations
         WHERE org_id=$1::uuid AND created_by_user_id=$2
           AND initial_client_mutation_id=$3
         LIMIT 1",
    )
    .bind(organization_id)
    .bind(user_id)
    .bind(client_mutation_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(Error::from)
}

async fn initial_draft_proof(
    tx: &mut auth::Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
    client_mutation_id: &str,
) -> Result<Option<InitialDraftProof>> {
    let row = sqlx::query(
        "SELECT r.context_snapshot->'nativeChatInitialDraft' AS initial_draft
         FROM chat_messages m
         JOIN chat_generations g
           ON g.org_id=m.org_id AND g.conversation_id=m.conversation_id
          AND g.source_message_id=m.id AND g.source_turn_variant=m.turn_variant
          AND g.execution_authority='native_rust'
         JOIN heartbeat_runs r
           ON r.org_id=g.org_id AND r.id=m.run_id AND r.chat_generation_id=g.id
          AND r.execution_authority='native_rust'
         WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid
           AND m.client_mutation_id=$3 AND m.role='user' AND m.kind='message'
           AND m.status='completed'
           AND m.turn_variant=g.source_turn_variant
           AND r.context_snapshot->'nativeChatInitialDraft' IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM chat_messages earlier
             WHERE earlier.org_id=m.org_id AND earlier.conversation_id=m.conversation_id
               AND (earlier.created_at, earlier.id) < (m.created_at, m.id)
           )
         LIMIT 1",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .bind(client_mutation_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let value: Value = row.try_get("initial_draft")?;
    let proof = serde_json::from_value(value)
        .map_err(|_| http(409, "Initial Native Chat draft proof is malformed"))?;
    Ok(Some(proof))
}

async fn resolve_selected_agent(
    tx: &mut auth::Tx<'_>,
    organization_id: &str,
    preferred_agent_id: Option<&str>,
) -> Result<String> {
    let selected = if let Some(preferred_agent_id) = preferred_agent_id {
        let row = sqlx::query(
            "SELECT id::text AS id, status FROM agents
             WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(organization_id)
        .bind(preferred_agent_id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(|| {
            http(
                422,
                "Preferred Agent must be available in this organization",
            )
        })?;
        let status: String = row.try_get("status")?;
        if status == "terminated" {
            return Err(http(
                422,
                "Preferred Agent must be available in this organization",
            ));
        }
        row.try_get::<String, _>("id")?
    } else {
        // Keep the legacy picker semantics: list org Agents excluding
        // terminated, then take the first visible returned row. The old
        // service defines no ORDER BY, so this intentionally promises no
        // deterministic default ordering.
        let rows = sqlx::query(
            "SELECT id::text AS id, metadata FROM agents
             WHERE org_id=$1::uuid AND status <> 'terminated'",
        )
        .bind(organization_id)
        .fetch_all(&mut **tx)
        .await?;
        let selected = rows.into_iter().find_map(|row| {
            let metadata: Option<Value> = row.try_get("metadata").ok()?;
            if hidden_agent_metadata(metadata.as_ref()) {
                return None;
            }
            row.try_get::<String, _>("id").ok()
        });
        selected.ok_or_else(|| http(422, "Chat requires an available Agent"))?
    };

    let status = sqlx::query_scalar::<_, String>(
        "SELECT status FROM agents
         WHERE org_id=$1::uuid AND id=$2::uuid
         FOR SHARE",
    )
    .bind(organization_id)
    .bind(&selected)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(409, "Selected Agent changed during first-send admission"))?;
    if status == "terminated" {
        return Err(http(
            409,
            "Selected Agent changed during first-send admission",
        ));
    }
    Ok(selected)
}

fn hidden_agent_metadata(metadata: Option<&Value>) -> bool {
    let Some(metadata) = metadata.and_then(Value::as_object) else {
        return false;
    };
    metadata.get("hidden").and_then(Value::as_bool) == Some(true)
        || metadata.get("systemManaged").and_then(Value::as_str) == Some("rudder_copilot")
}

async fn organization_issue_creation_mode(
    tx: &mut auth::Tx<'_>,
    organization_id: &str,
) -> Result<String> {
    let mode = sqlx::query_scalar::<_, String>(
        "SELECT default_chat_issue_creation_mode FROM organizations WHERE id=$1::uuid",
    )
    .bind(organization_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Organization not found"))?;
    if !matches!(mode.as_str(), "manual_approval" | "auto_create") {
        return Err(http(409, "Organization Chat issue policy is unsupported"));
    }
    Ok(mode)
}

async fn lock_first_send_key(
    tx: &mut auth::Tx<'_>,
    organization_id: &str,
    user_id: &str,
    client_mutation_id: &str,
) -> Result<()> {
    let key = format!("native-chat-first-send-v1:{organization_id}:{user_id}:{client_mutation_id}");
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(key)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn validate_actor(actor: &impl NativeChatActor, organization_id: &str) -> Result<()> {
    if actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }
    if actor.actor().kind != "user" {
        return Err(http(403, "First Chat messages require a user actor"));
    }
    if actor.actor().id.is_empty() || actor.actor().id.len() > 255 {
        return Err(http(401, "Unauthorized"));
    }
    Ok(())
}

fn ensure_requested_agent(preferred_agent_id: Option<&str>, selected_agent_id: &str) -> Result<()> {
    if preferred_agent_id.is_some_and(|preferred| preferred != selected_agent_id) {
        return Err(http(
            409,
            "Client mutation id conflicts with the original Agent selection",
        ));
    }
    Ok(())
}

fn ensure_requested_issue_mode(requested: Option<&str>, persisted: &str) -> Result<()> {
    if requested.is_some_and(|value| value != persisted) {
        return Err(http(
            409,
            "Client mutation id conflicts with the original issue creation mode",
        ));
    }
    Ok(())
}

fn validate_initial_draft(proof: &InitialDraftProof, input: &FirstSendInput<'_>) -> Result<()> {
    let selected_agent_id = validation::canonical_uuid(&proof.selected_agent_id, "Agent id")
        .map_err(|_| http(409, "Initial Native Chat draft proof is malformed"))?;
    if proof.version != 1
        || proof.plan_mode
        || !matches!(
            proof.issue_creation_mode.as_str(),
            "manual_approval" | "auto_create"
        )
        || proof.title.is_empty()
        || proof.title.encode_utf16().count() > 200
        || proof.title.chars().any(char::is_control)
    {
        return Err(http(409, "Initial Native Chat draft proof is malformed"));
    }
    ensure_requested_agent(input.preferred_agent_id, &selected_agent_id)?;
    ensure_requested_issue_mode(input.issue_creation_mode, &proof.issue_creation_mode)?;
    if proof.title != input.title
        || proof.model_override.as_deref() != input.model_override
        || proof.effort_override.as_deref() != input.effort_override
    {
        return Err(http(
            409,
            "Client mutation id conflicts with the original first-turn settings",
        ));
    }
    let expected = first_draft_fingerprint(
        input.body,
        &selected_agent_id,
        &proof.title,
        proof.model_override.as_deref(),
        proof.effort_override.as_deref(),
        Some(&proof.issue_creation_mode),
    );
    if proof.fingerprint != expected {
        return Err(http(409, "Initial Native Chat draft proof does not match"));
    }
    Ok(())
}

fn first_draft_fingerprint(
    body: &str,
    selected_agent_id: &str,
    title: &str,
    model_override: Option<&str>,
    effort_override: Option<&str>,
    issue_creation_mode: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"native-chat-first-draft-v1\0");
    hash_field(&mut hasher, body.as_bytes());
    hash_field(&mut hasher, selected_agent_id.as_bytes());
    hash_field(&mut hasher, title.as_bytes());
    hash_optional_field(&mut hasher, model_override);
    hash_optional_field(&mut hasher, effort_override);
    hash_optional_field(&mut hasher, issue_creation_mode);
    hash_field(&mut hasher, b"plan_mode=false");
    let digest = hasher.finalize();
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("native-chat-first-v1:{hex}")
}

fn hash_optional_field(hasher: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            hasher.update([1]);
            hash_field(hasher, value.as_bytes());
        }
        None => hasher.update([0]),
    }
}

fn hash_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}
