//! Atomic first-message creation for ordinary Chat.
//!
//! The caller supplies only the existing user choices that this Rust path
//! implements. Actor, organization grant, Agent runtime config, host facts,
//! and every generated identity come from trusted Rust state or persisted
//! rows. Conversation creation and the normal Native Chat admission body share
//! one SQL transaction.

use super::{Error, FirstSendContextLink, config::LocalHostContext};
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
    pub context_goal_id: Option<&'a str>,
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
    #[serde(default)]
    context_goal_id: Option<String>,
    safe_runtime_descriptor: SafeRuntimeDescriptor,
    safe_chat_runtime: SafeChatRuntime,
}

pub(super) fn context_goal_id(links: &[FirstSendContextLink]) -> Result<Option<String>> {
    match links {
        [] => Ok(None),
        [link] if link.entity_type == "goal" => {
            let goal_id = validation::canonical_uuid(&link.entity_id, "Goal id")?;
            Ok(Some(goal_id))
        }
        _ => Err(http(
            422,
            "Native Chat first-send supports at most one Goal context link",
        )),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SafeRuntimeDescriptor {
    version: u8,
    runtime_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SafeChatRuntime {
    version: u8,
    source_type: String,
    runtime_type: String,
    source_label: String,
    runtime_agent_id: String,
    model: Option<String>,
    effort: Option<String>,
    available: bool,
    error: Option<String>,
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
        context_goal_id,
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
    if let Some(goal_id) = context_goal_id {
        match crate::links::validate_native_chat_goal_context(&mut tx, organization_id, goal_id)
            .await
        {
            Ok(()) => (),
            Err(crate::StoreError::NotFound) => {
                return Err(http(
                    422,
                    "Goal context must belong to the same organization",
                ));
            }
            Err(crate::StoreError::Database(error)) => return Err(Error::Database(error)),
            Err(_) => return Err(http(500, "Goal context validation failed")),
        }
    }
    let draft_fingerprint = first_draft_fingerprint(
        body,
        &selected_agent_id,
        title,
        model_override,
        effort_override,
        Some(&issue_creation_mode),
        context_goal_id,
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
        "contextGoalId": context_goal_id,
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

    if let Some(goal_id) = context_goal_id {
        sqlx::query(
            "INSERT INTO chat_context_links
               (org_id, conversation_id, entity_type, entity_id, metadata)
             VALUES ($1::uuid, $2::uuid, 'goal', $3, NULL)",
        )
        .bind(organization_id)
        .bind(&conversation_id)
        .bind(goal_id)
        .execute(&mut *tx)
        .await?;
    }

    let (mut tx, receipt) = admission::submit_in_transaction(
        tx,
        actor,
        admission::AdmissionInput {
            organization_id,
            conversation_id: &conversation_id,
            client_mutation_id,
            body,
            fingerprint: &body_fingerprint,
            initial_draft_snapshot: Some(&initial_draft_snapshot),
            message_activity: true,
            host,
        },
    )
    .await?;
    // Admission augments this immutable draft proof with the resolved safe
    // runtime descriptor in the same transaction. Read the durable value back
    // instead of projecting from the request-side draft snapshot.
    let proof = initial_draft_proof(
        &mut tx,
        organization_id,
        &conversation_id,
        client_mutation_id,
    )
    .await?
    .ok_or_else(|| http(409, "Initial Native Chat draft proof is unavailable"))?;
    let public_conversation = public_conversation_projection(
        &mut tx,
        organization_id,
        &conversation_id,
        client_mutation_id,
        &proof,
    )
    .await?;
    let mut receipt = receipt;
    receipt
        .as_object_mut()
        .ok_or_else(|| http(500, "Native Chat admission receipt is malformed"))?
        .insert("conversation".into(), public_conversation);
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
    let mut receipt = receipt.json();
    let public_conversation = public_conversation_projection(
        tx,
        organization_id,
        conversation_id,
        client_mutation_id,
        &proof,
    )
    .await?;
    receipt
        .as_object_mut()
        .ok_or_else(|| http(500, "Native Chat admission receipt is malformed"))?
        .insert("conversation".into(), public_conversation);
    Ok(receipt)
}

async fn public_conversation_projection(
    tx: &mut auth::Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
    client_mutation_id: &str,
    proof: &InitialDraftProof,
) -> Result<Value> {
    validate_public_runtime_snapshot(proof)?;
    let row = sqlx::query(
        "SELECT c.id::text AS id,c.org_id::text AS org_id,c.status,c.title,c.summary,
                c.preferred_agent_id::text AS preferred_agent_id,
                c.model_override,c.effort_override,c.issue_creation_mode,c.plan_mode,
                c.routed_agent_id::text AS routed_agent_id,c.primary_issue_id::text AS primary_issue_id,
                c.forked_from_conversation_id::text AS forked_from_conversation_id,
                c.forked_from_message_id::text AS forked_from_message_id,
                c.fork_root_conversation_id::text AS fork_root_conversation_id,
                c.created_by_user_id,c.resolved_at::text AS resolved_at,
                c.created_at::text AS created_at,c.updated_at::text AS updated_at,
                COALESCE(c.last_message_at,m.created_at)::text AS last_message_at,
                (SELECT count(*)::int FROM chat_messages u
                 WHERE u.org_id=c.org_id AND u.conversation_id=c.id
                   AND u.role='user' AND u.kind='message' AND u.status='completed'
                   AND u.superseded_at IS NULL) AS user_message_count,
                (SELECT left(u.body,200) FROM chat_messages u
                 WHERE u.org_id=c.org_id AND u.conversation_id=c.id
                   AND u.role='user' AND u.kind='message' AND u.status='completed'
                   AND u.superseded_at IS NULL
                 ORDER BY u.created_at DESC,u.id DESC LIMIT 1) AS latest_user_message_preview
         FROM chat_conversations c
         JOIN chat_messages m
           ON m.org_id=c.org_id AND m.conversation_id=c.id
          AND m.client_mutation_id=$3 AND m.role='user' AND m.kind='message'
          AND m.status='completed'
         WHERE c.org_id=$1::uuid AND c.id=$2::uuid
           AND c.conversation_kind='chat' AND c.initial_client_mutation_id=$3
         LIMIT 1",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .bind(client_mutation_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(409, "Initial Native Chat conversation projection is unavailable"))?;

    let id: String = row.try_get("id")?;
    let org_id: String = row.try_get("org_id")?;
    let status: String = row.try_get("status")?;
    let title: String = row.try_get("title")?;
    let preferred_agent_id: Option<String> = row.try_get("preferred_agent_id")?;
    if id != conversation_id
        || org_id != organization_id
        || !matches!(status.as_str(), "active" | "resolved" | "archived")
    {
        return Err(http(409, "Initial Native Chat conversation changed"));
    }

    let summary: Option<String> = row.try_get("summary")?;
    let model_override: Option<String> = row.try_get("model_override")?;
    let effort_override: Option<String> = row.try_get("effort_override")?;
    let issue_creation_mode: String = row.try_get("issue_creation_mode")?;
    let plan_mode: bool = row.try_get("plan_mode")?;
    let routed_agent_id: Option<String> = row.try_get("routed_agent_id")?;
    let primary_issue_id: Option<String> = row.try_get("primary_issue_id")?;
    let forked_from_conversation_id: Option<String> = row.try_get("forked_from_conversation_id")?;
    let forked_from_message_id: Option<String> = row.try_get("forked_from_message_id")?;
    let fork_root_conversation_id: Option<String> = row.try_get("fork_root_conversation_id")?;
    let created_by_user_id: Option<String> = row.try_get("created_by_user_id")?;
    let resolved_at: Option<String> = row.try_get("resolved_at")?;
    let created_at: String = row.try_get("created_at")?;
    let updated_at: String = row.try_get("updated_at")?;
    let last_message_at: String = row.try_get("last_message_at")?;
    let latest_user_message_preview: String = row.try_get("latest_user_message_preview")?;
    let user_message_count: i32 = row.try_get("user_message_count")?;

    let context_rows = sqlx::query(
        "SELECT id::text AS id, org_id::text AS org_id,
                conversation_id::text AS conversation_id, entity_type, entity_id,
                metadata, created_at::text AS created_at, updated_at::text AS updated_at
         FROM chat_context_links
         WHERE conversation_id=$1::uuid
         ORDER BY entity_type, entity_id",
    )
    .bind(conversation_id)
    .fetch_all(&mut **tx)
    .await?;
    let expected_context_count = if proof.context_goal_id.is_some() {
        1
    } else {
        0
    };
    if context_rows.len() != expected_context_count {
        return Err(http(409, "Initial Native Chat context link changed"));
    }
    let mut context_links = Vec::with_capacity(context_rows.len());
    for context_row in context_rows {
        let context_org_id: String = context_row.try_get("org_id")?;
        let context_conversation_id: String = context_row.try_get("conversation_id")?;
        let entity_type: String = context_row.try_get("entity_type")?;
        let entity_id: String = context_row.try_get("entity_id")?;
        if context_org_id != organization_id
            || context_conversation_id != conversation_id
            || entity_type != "goal"
            || proof.context_goal_id.as_deref() != Some(entity_id.as_str())
        {
            return Err(http(409, "Initial Native Chat context link changed"));
        }
        let id: String = context_row.try_get("id")?;
        let metadata: Option<Value> = context_row.try_get("metadata")?;
        let created_at: String = context_row.try_get("created_at")?;
        let updated_at: String = context_row.try_get("updated_at")?;
        context_links.push(serde_json::json!({
            "id": id,
            "orgId": context_org_id,
            "conversationId": context_conversation_id,
            "entityType": entity_type,
            "entityId": entity_id,
            "metadata": metadata,
            "entity": null,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }));
    }

    // The accepted Run remains bound to its immutable Agent proof. Current
    // Conversation preferences are display state, not part of that proof.
    // Do not present the original runtime as the newly selected Agent or
    // resolve mutable configuration merely to recover an accepted message.
    let chat_runtime = if preferred_agent_id.as_deref() == Some(proof.selected_agent_id.as_str()) {
        serde_json::json!({
        "sourceType":proof.safe_chat_runtime.source_type,
        "sourceLabel":proof.safe_chat_runtime.source_label,
        "runtimeAgentId":proof.safe_chat_runtime.runtime_agent_id,
        "agentRuntimeType":proof.safe_chat_runtime.runtime_type,
        "model":proof.safe_chat_runtime.model,
        "effort":proof.safe_chat_runtime.effort,
        "available":proof.safe_chat_runtime.available,
        "error":proof.safe_chat_runtime.error,
        })
    } else {
        serde_json::json!({
            "sourceType":"agent",
            "sourceLabel":"Agent",
            "runtimeAgentId":preferred_agent_id,
            "agentRuntimeType":null,
            "model":null,
            "effort":null,
            "available":false,
            "error":"Refresh this chat to load its current Agent.",
        })
    };
    let mut projection = serde_json::Map::new();
    for (key, value) in [
        ("id", serde_json::json!(id)),
        ("orgId", serde_json::json!(org_id)),
        ("status", serde_json::json!(status)),
        ("conversationKind", serde_json::json!("chat")),
        ("messengerVisible", serde_json::json!(true)),
        ("sideChatState", serde_json::json!(null)),
        ("sideChatExpiresAt", serde_json::json!(null)),
        ("sideChatCompletedAt", serde_json::json!(null)),
        ("sideChatKeptAt", serde_json::json!(null)),
        ("sideChatClientMutationId", serde_json::json!(null)),
        (
            "initialClientMutationId",
            serde_json::json!(client_mutation_id),
        ),
        ("mutability", serde_json::json!("native_chat")),
        ("title", serde_json::json!(title)),
        ("summary", serde_json::json!(summary)),
        ("latestReplyPreview", serde_json::json!(null)),
        (
            "latestUserMessagePreview",
            serde_json::json!(latest_user_message_preview),
        ),
        ("userMessageCount", serde_json::json!(user_message_count)),
        ("preferredAgentId", serde_json::json!(preferred_agent_id)),
        ("modelOverride", serde_json::json!(model_override)),
        ("effortOverride", serde_json::json!(effort_override)),
        ("routedAgentId", serde_json::json!(routed_agent_id)),
        ("primaryIssueId", serde_json::json!(primary_issue_id)),
        (
            "forkedFromConversationId",
            serde_json::json!(forked_from_conversation_id),
        ),
        (
            "forkedFromMessageId",
            serde_json::json!(forked_from_message_id),
        ),
        (
            "forkRootConversationId",
            serde_json::json!(fork_root_conversation_id),
        ),
        ("primaryIssue", serde_json::json!(null)),
        ("issueCreationMode", serde_json::json!(issue_creation_mode)),
        ("planMode", serde_json::json!(plan_mode)),
        ("createdByUserId", serde_json::json!(created_by_user_id)),
        ("lastMessageAt", serde_json::json!(last_message_at)),
        ("lastReadAt", serde_json::json!(null)),
        ("isPinned", serde_json::json!(false)),
        ("isUnread", serde_json::json!(false)),
        ("unreadCount", serde_json::json!(0)),
        ("needsAttention", serde_json::json!(false)),
        ("resolvedAt", serde_json::json!(resolved_at)),
        ("contextLinks", serde_json::json!(context_links)),
        ("sourceMetadata", serde_json::json!(null)),
        ("chatRuntime", serde_json::json!(chat_runtime)),
        ("createdAt", serde_json::json!(created_at)),
        ("updatedAt", serde_json::json!(updated_at)),
    ] {
        projection.insert(key.to_owned(), value);
    }
    Ok(Value::Object(projection))
}

fn validate_public_runtime_snapshot(proof: &InitialDraftProof) -> Result<()> {
    let runtime_type = proof.safe_runtime_descriptor.runtime_type.as_str();
    let runtime = &proof.safe_chat_runtime;
    if proof.safe_runtime_descriptor.version != 1
        || runtime.version != 1
        || runtime.source_type != "agent"
        || runtime.runtime_type != runtime_type
        || runtime.source_label.trim().is_empty()
        || runtime.source_label.chars().count() > 200
        || runtime.runtime_agent_id != proof.selected_agent_id
        || runtime
            .model
            .as_ref()
            .is_some_and(|model| model.len() > 256)
        || runtime
            .effort
            .as_ref()
            .is_some_and(|effort| effort.len() > 64)
        || !runtime.available
        || runtime.error.is_some()
    {
        return Err(http(
            409,
            "Initial Native Chat runtime projection is malformed",
        ));
    }
    Ok(())
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
        || proof.context_goal_id.as_deref() != input.context_goal_id
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
        proof.context_goal_id.as_deref(),
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
    context_goal_id: Option<&str>,
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
    if let Some(goal_id) = context_goal_id {
        // Keep the no-context fingerprint byte-for-byte compatible with
        // existing receipts while binding a Goal-bearing draft to its link.
        hasher.update(b"context_goal\0");
        hash_field(&mut hasher, goal_id.as_bytes());
    }
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
