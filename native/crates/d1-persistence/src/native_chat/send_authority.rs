//! Read-only classification of a public Chat send before its body is parsed by
//! the Native-only DTO. Known legacy runtimes retain the existing compatibility
//! route; Native evidence and Native runtime selections never fall back.

use super::{NativeChatActor, Result, auth, http, validation};
use crate::runtime_bindings;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Row, Transaction};

const NATIVE_RUNTIMES: &[&str] = &[
    "codex_local",
    "hermes_local",
    "pi_local",
    "claude_local",
    "cursor",
    "cursor_local",
    "opencode_local",
];
const LEGACY_RUNTIMES: &[&str] = &["process", "http", "openclaw_gateway", "hermes_gateway"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SendAuthority {
    Native,
    Legacy,
}

/// Classify an existing Chat using persisted authority and its selected Agent.
/// A Native Generation or native local-runtime binding remains authoritative
/// even if current Conversation preferences have since changed.
pub async fn classify_existing_send(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    organization_id: &str,
    conversation_id: &str,
) -> Result<SendAuthority> {
    let organization_id = validation::canonical_uuid(organization_id, "organization id")?;
    let conversation_id = validation::canonical_uuid(conversation_id, "conversation id")?;
    validate_actor_org(actor, &organization_id)?;

    let mut tx = pool.begin().await?;
    prepare_read(&mut tx).await?;
    auth::preauthorize_org(&mut tx, actor, &organization_id).await?;
    let conversation = sqlx::query(
        "SELECT conversation_kind,preferred_agent_id::text AS preferred_agent_id,
                routed_agent_id::text AS routed_agent_id
         FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&organization_id)
    .bind(&conversation_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Chat conversation not found"))?;
    let kind: String = conversation.try_get("conversation_kind")?;
    let selected_agent = conversation
        .try_get::<Option<String>, _>("preferred_agent_id")?
        .or(conversation.try_get::<Option<String>, _>("routed_agent_id")?);
    runtime_bindings::preauthorize_chat_target_read_tx(
        &mut tx,
        actor,
        &organization_id,
        &conversation_id,
        selected_agent.as_deref().unwrap_or(""),
    )
    .await?;

    let native_evidence = has_native_evidence(&mut tx, &organization_id, &conversation_id).await?;
    let authority = if native_evidence {
        SendAuthority::Native
    } else {
        let selected_agent = selected_agent
            .as_deref()
            .ok_or_else(|| http(409, "Chat conversation has no selected Agent"))?;
        let runtime = agent_runtime(&mut tx, &organization_id, selected_agent).await?;
        let authority = classify_runtime(&runtime)?;
        if authority == SendAuthority::Native
            && (kind != "chat"
                || has_legacy_context(&mut tx, &organization_id, &conversation_id).await?)
        {
            return Err(http(
                409,
                "Existing Chat context cannot be imported into a new Native session",
            ));
        }
        authority
    };
    tx.commit().await?;
    Ok(authority)
}

/// Classify a first Chat send before applying Native Chat's strict input DTO.
/// Exact existing mutation receipts keep their original authority even if the
/// caller changes Agent selection on a retry.
pub async fn classify_first_send(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    organization_id: &str,
    client_mutation_id: Option<&str>,
    preferred_agent_id: Option<&str>,
) -> Result<SendAuthority> {
    let organization_id = validation::canonical_uuid(organization_id, "organization id")?;
    validate_actor_org(actor, &organization_id)?;
    if actor.actor().kind != "user" {
        return Err(http(403, "First Chat messages require a user actor"));
    }

    let mut tx = pool.begin().await?;
    prepare_read(&mut tx).await?;
    auth::preauthorize_org(&mut tx, actor, &organization_id).await?;

    if let Some(client_mutation_id) = client_mutation_id
        && let Some(conversation_id) = find_initial_mutation(
            &mut tx,
            &organization_id,
            &actor.actor().id,
            client_mutation_id,
        )
        .await?
    {
        let conversation = sqlx::query(
            "SELECT preferred_agent_id::text AS preferred_agent_id,
                    routed_agent_id::text AS routed_agent_id
             FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(&organization_id)
        .bind(&conversation_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| http(404, "Chat conversation not found"))?;
        let selected_agent = conversation
            .try_get::<Option<String>, _>("preferred_agent_id")?
            .or(conversation.try_get::<Option<String>, _>("routed_agent_id")?);
        runtime_bindings::preauthorize_chat_target_read_tx(
            &mut tx,
            actor,
            &organization_id,
            &conversation_id,
            selected_agent.as_deref().unwrap_or(""),
        )
        .await?;
        let native_evidence =
            has_native_evidence(&mut tx, &organization_id, &conversation_id).await?;
        tx.commit().await?;
        // A duplicate non-Native initial key belongs to the existing Node
        // receipt. Never reinterpret it as a new Native Chat admission.
        return Ok(if native_evidence {
            SendAuthority::Native
        } else {
            SendAuthority::Legacy
        });
    }

    let selected_agent =
        resolve_first_send_agent(&mut tx, &organization_id, preferred_agent_id).await?;
    let runtime = agent_runtime(&mut tx, &organization_id, &selected_agent).await?;
    let authority = classify_runtime(&runtime)?;
    tx.commit().await?;
    Ok(authority)
}

async fn prepare_read(tx: &mut Transaction<'_, Postgres>) -> Result<()> {
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut **tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout = '5s'")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn validate_actor_org(actor: &impl NativeChatActor, organization_id: &str) -> Result<()> {
    if actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }
    if !matches!(actor.actor().kind.as_str(), "user" | "agent") {
        return Err(http(401, "Unauthorized"));
    }
    Ok(())
}

async fn has_native_evidence(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    conversation_id: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT
           EXISTS(SELECT 1 FROM chat_generations g
                  WHERE g.org_id=$1::uuid AND g.conversation_id=$2::uuid
                    AND g.execution_authority='native_rust')
           OR EXISTS(SELECT 1 FROM heartbeat_runs r
                     WHERE r.org_id=$1::uuid AND r.chat_conversation_id=$2::uuid
                       AND r.execution_authority='native_rust')
           OR EXISTS(SELECT 1 FROM runtime_bindings b
                     WHERE b.org_id=$1::uuid
                       AND (b.conversation_id=$2::uuid
                         OR (b.target_type='chat_conversation' AND b.target_id=$2))
                       AND b.runtime_type IN ('codex_local','hermes_local','pi_local',
                                              'claude_local','cursor','cursor_local','opencode_local'))",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_one(&mut **tx)
    .await?)
}

async fn has_legacy_context(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    conversation_id: &str,
) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM chat_messages m
                       WHERE m.org_id=$1::uuid AND m.conversation_id=$2::uuid)
           OR EXISTS(SELECT 1 FROM chat_generations g
                     WHERE g.org_id=$1::uuid AND g.conversation_id=$2::uuid)
           OR EXISTS(SELECT 1 FROM heartbeat_runs r
                     WHERE r.org_id=$1::uuid AND r.chat_conversation_id=$2::uuid)",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_one(&mut **tx)
    .await?)
}

async fn find_initial_mutation(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    user_id: &str,
    client_mutation_id: &str,
) -> Result<Option<String>> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id::text FROM chat_conversations
         WHERE org_id=$1::uuid AND created_by_user_id=$2
           AND initial_client_mutation_id=$3 LIMIT 2",
    )
    .bind(organization_id)
    .bind(user_id)
    .bind(client_mutation_id)
    .fetch_all(&mut **tx)
    .await?;
    match ids.as_slice() {
        [] => Ok(None),
        [id] => Ok(Some(id.clone())),
        _ => Err(http(409, "Initial mutation key is ambiguous")),
    }
}

async fn resolve_first_send_agent(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    preferred_agent_id: Option<&str>,
) -> Result<String> {
    if let Some(preferred_agent_id) = preferred_agent_id {
        let canonical = validation::canonical_uuid(preferred_agent_id, "Agent id")?;
        if canonical != preferred_agent_id {
            return Err(http(
                422,
                "Preferred Agent must be available in this organization",
            ));
        }
        let available = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM agents WHERE org_id=$1::uuid AND id=$2::uuid
                          AND status <> 'terminated')",
        )
        .bind(organization_id)
        .bind(preferred_agent_id)
        .fetch_one(&mut **tx)
        .await?;
        return available
            .then(|| preferred_agent_id.to_owned())
            .ok_or_else(|| {
                http(
                    422,
                    "Preferred Agent must be available in this organization",
                )
            });
    }

    let rows = sqlx::query(
        "SELECT id::text AS id, metadata, agent_runtime_type FROM agents
         WHERE org_id=$1::uuid AND status <> 'terminated'",
    )
    .bind(organization_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut selected: Option<(String, SendAuthority)> = None;
    for row in rows {
        let metadata: Option<Value> = row.try_get("metadata")?;
        let hidden = metadata
            .as_ref()
            .and_then(Value::as_object)
            .is_some_and(|metadata| {
                metadata.get("hidden").and_then(Value::as_bool) == Some(true)
                    || metadata.get("systemManaged").and_then(Value::as_str)
                        == Some("rudder_copilot")
            });
        if hidden {
            continue;
        }
        let runtime: String = row.try_get("agent_runtime_type")?;
        let authority = classify_runtime(&runtime)?;
        if selected
            .as_ref()
            .is_some_and(|(_, prior)| *prior != authority)
        {
            return Err(http(
                409,
                "Select an explicit Agent before sending a new Chat message",
            ));
        }
        if selected.is_none() {
            selected = Some((row.try_get("id")?, authority));
        }
    }
    match selected {
        Some((_, SendAuthority::Native)) => Err(http(
            422,
            "Select an explicit Agent before sending a new Native Chat message",
        )),
        Some((id, SendAuthority::Legacy)) => Ok(id),
        None => Err(http(422, "Chat requires an available Agent")),
    }
}

async fn agent_runtime(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: &str,
    agent_id: &str,
) -> Result<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT agent_runtime_type FROM agents WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(organization_id)
    .bind(agent_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(409, "Selected Agent is unavailable"))
}

fn classify_runtime(runtime_type: &str) -> Result<SendAuthority> {
    if NATIVE_RUNTIMES.contains(&runtime_type) {
        return Ok(SendAuthority::Native);
    }
    if LEGACY_RUNTIMES.contains(&runtime_type) {
        return Ok(SendAuthority::Legacy);
    }
    Err(http(409, "Selected Agent runtime is unsupported"))
}
