use super::execution::ExecutionFence;
use super::{NativeChatActor, NativeChatExecutionActor};
use super::{Result, http};
use sqlx::{Postgres, Row, Transaction};

pub(super) type Tx<'a> = Transaction<'a, Postgres>;

pub(super) struct Conversation {
    pub status: String,
    pub kind: String,
    pub preferred_agent_id: Option<String>,
    pub routed_agent_id: Option<String>,
    pub primary_issue_id: Option<String>,
}

pub(super) async fn authorize_org(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatActor,
    organization_id: &str,
) -> Result<()> {
    crate::runtime_bindings::authorize_native_chat_actor_org_tx(tx, actor, organization_id).await
}

pub(super) async fn preauthorize_org(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatActor,
    organization_id: &str,
) -> Result<()> {
    crate::runtime_bindings::preauthorize_native_chat_actor_org_tx(tx, actor, organization_id).await
}

pub(super) async fn authorize_execution_org(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
) -> Result<()> {
    crate::runtime_bindings::authorize_native_chat_execution_actor_org_tx(
        tx,
        actor,
        fence.identity().organization_id,
        fence,
    )
    .await
}

pub(super) async fn preauthorize_execution_org(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    fence: &ExecutionFence,
) -> Result<()> {
    crate::runtime_bindings::preauthorize_native_chat_execution_actor_org_tx(
        tx,
        actor,
        fence.identity().organization_id,
        fence,
    )
    .await
}

pub(super) async fn lock_conversation(
    tx: &mut Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
) -> Result<Conversation> {
    let row = sqlx::query(
        "SELECT status, conversation_kind, preferred_agent_id::text AS preferred_agent_id,
                routed_agent_id::text AS routed_agent_id,
                primary_issue_id::text AS primary_issue_id
         FROM chat_conversations
         WHERE org_id=$1::uuid AND id=$2::uuid
         FOR UPDATE",
    )
    .bind(organization_id)
    .bind(conversation_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Chat conversation not found"))?;
    Ok(Conversation {
        status: row.try_get("status")?,
        kind: row.try_get("conversation_kind")?,
        preferred_agent_id: row.try_get("preferred_agent_id")?,
        routed_agent_id: row.try_get("routed_agent_id")?,
        primary_issue_id: row.try_get("primary_issue_id")?,
    })
}

pub(super) fn authorize_agent_actor(
    actor: &impl NativeChatActor,
    selected_agent_id: &str,
) -> Result<()> {
    if actor.actor().kind == "agent" && actor.actor().id != selected_agent_id {
        return Err(http(403, "Chat conversation access denied"));
    }
    if actor.actor().kind != "agent" && actor.actor().kind != "user" {
        return Err(http(401, "Unauthorized"));
    }
    if actor.actor().kind == "user"
        && actor.actor().id == "local-board"
        && actor.session_id() != "local-implicit"
    {
        return Err(http(403, "Chat conversation access denied"));
    }
    Ok(())
}
