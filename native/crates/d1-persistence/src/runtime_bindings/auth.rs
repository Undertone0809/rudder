use super::{Conversation, Result, Tx, VerifiedActor, http};
use sqlx::Row;

use super::validation::canonical_uuid;

pub(super) async fn authorize_org(
    tx: &mut Tx<'_>,
    actor: &VerifiedActor,
    organization_id: &str,
) -> Result<()> {
    let local_implicit = actor.actor().kind == "user"
        && actor.actor().id == "local-board"
        && actor.session_id() == "local-implicit";
    if local_implicit {
        return Ok(());
    }
    let allowed = match actor.actor().kind.as_str() {
        "user" => {
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                   SELECT 1 FROM organization_memberships
                   WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2 AND status='active'
                 ) OR EXISTS(
                   SELECT 1 FROM instance_user_roles WHERE user_id=$2 AND role='instance_admin'
                 )",
            )
            .bind(organization_id)
            .bind(&actor.actor().id)
            .fetch_one(&mut **tx)
            .await?
        }
        "agent" => {
            let agent_id = canonical_uuid(&actor.actor().id, "agent actor id")
                .map_err(|_| http(401, "Agent authentication required"))?;
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(
                   SELECT 1 FROM agents
                   WHERE org_id=$1::uuid AND id=$2::uuid
                     AND status NOT IN ('terminated','pending_approval')
                 )",
            )
            .bind(organization_id)
            .bind(agent_id)
            .fetch_one(&mut **tx)
            .await?
        }
        _ => return Err(http(401, "Unauthorized")),
    };
    if allowed {
        Ok(())
    } else {
        Err(http(403, "Organization access denied"))
    }
}

pub(super) fn authorize_conversation(
    actor: &VerifiedActor,
    organization_id: &str,
    conversation: &Conversation,
    selected_agent_id: Option<&str>,
) -> Result<String> {
    let owner = conversation
        .owner_user_id
        .as_deref()
        .filter(|value| !value.is_empty());
    let local_implicit = actor.actor().kind == "user"
        && actor.actor().id == "local-board"
        && actor.session_id() == "local-implicit";
    let principal_scope_ref = if conversation.kind == "side_chat" {
        let owner = owner.ok_or_else(|| http(404, "Chat conversation not found"))?;
        format!("user:{owner}")
    } else {
        format!("org:{organization_id}")
    };
    match actor.actor().kind.as_str() {
        "user" => {
            if conversation.kind == "side_chat" && owner != Some(actor.actor().id.as_str()) {
                return Err(http(404, "Chat conversation not found"));
            }
            if actor.actor().id == "local-board" && !local_implicit {
                return Err(http(403, "Chat conversation access denied"));
            }
        }
        "agent" => {
            if conversation.kind == "side_chat"
                || selected_agent_id != Some(actor.actor().id.as_str())
            {
                return Err(http(403, "Chat conversation access denied"));
            }
        }
        _ => return Err(http(401, "Unauthorized")),
    }
    Ok(principal_scope_ref)
}

pub(super) fn ensure_conversation_mutable(conversation: &Conversation) -> Result<()> {
    ensure_conversation_mutable_for_run(conversation, false)
}

pub(super) fn ensure_conversation_mutable_for_run(
    conversation: &Conversation,
    run_admitted_before_expiry: bool,
) -> Result<()> {
    if !matches!(conversation.kind.as_str(), "chat" | "side_chat") {
        return Err(http(404, "Chat conversation not found"));
    }
    if conversation.status != "active"
        || (conversation.kind == "side_chat"
            && !matches!(
                conversation.side_chat_state.as_deref(),
                Some("active" | "kept")
            ))
    {
        return Err(http(409, "Chat conversation is not active"));
    }
    if conversation.kind == "side_chat"
        && conversation.side_chat_state.as_deref() == Some("active")
        && conversation.side_chat_expired
        && !run_admitted_before_expiry
    {
        return Err(http(409, "Side Chat expired"));
    }
    Ok(())
}

pub(super) fn ensure_conversation_readable(conversation: &Conversation) -> Result<()> {
    if matches!(conversation.kind.as_str(), "chat" | "side_chat") {
        Ok(())
    } else {
        Err(http(404, "Chat conversation not found"))
    }
}

pub(super) async fn conversation(
    tx: &mut Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
    lock: bool,
) -> Result<Option<Conversation>> {
    let suffix = if lock { " FOR UPDATE" } else { "" };
    let query = format!(
        "SELECT status, conversation_kind, side_chat_state, created_by_user_id,
                (side_chat_expires_at IS NULL OR side_chat_expires_at <= clock_timestamp()) AS side_chat_expired,
                preferred_agent_id::text AS preferred_agent_id,
                routed_agent_id::text AS routed_agent_id
         FROM chat_conversations
         WHERE org_id=$1::uuid AND id=$2::uuid{suffix}"
    );
    let Some(row) = sqlx::query(&query)
        .bind(organization_id)
        .bind(conversation_id)
        .fetch_optional(&mut **tx)
        .await?
    else {
        return Ok(None);
    };
    Ok(Some(Conversation {
        status: row.try_get("status")?,
        kind: row.try_get("conversation_kind")?,
        side_chat_state: row.try_get("side_chat_state")?,
        side_chat_expired: row.try_get("side_chat_expired")?,
        owner_user_id: row.try_get("created_by_user_id")?,
        preferred_agent_id: row.try_get("preferred_agent_id")?,
        routed_agent_id: row.try_get("routed_agent_id")?,
    }))
}
