use super::{Result, http};
use rudder_auth_core::VerifiedActor;
use sqlx::{Postgres, Row, Transaction};

pub(super) type Tx<'a> = Transaction<'a, Postgres>;

pub(super) struct Conversation {
    pub status: String,
    pub kind: String,
    pub preferred_agent_id: Option<String>,
    pub routed_agent_id: Option<String>,
}

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
                "SELECT EXISTS (
                   SELECT 1 FROM organization_memberships
                   WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2 AND status='active'
                 ) OR EXISTS (
                   SELECT 1 FROM instance_user_roles WHERE user_id=$2 AND role='instance_admin'
                 )",
            )
            .bind(organization_id)
            .bind(&actor.actor().id)
            .fetch_one(&mut **tx)
            .await?
        }
        "agent" => {
            let agent_id = super::validation::canonical_uuid(&actor.actor().id, "agent actor id")
                .map_err(|_| http(401, "Agent authentication required"))?;
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (
                   SELECT 1 FROM agents
                   WHERE org_id=$1::uuid AND id=$2::uuid AND status NOT IN ('terminated','pending_approval')
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

pub(super) async fn lock_conversation(
    tx: &mut Tx<'_>,
    organization_id: &str,
    conversation_id: &str,
) -> Result<Conversation> {
    let row = sqlx::query(
        "SELECT status, conversation_kind, preferred_agent_id::text AS preferred_agent_id,
                routed_agent_id::text AS routed_agent_id
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
    })
}

pub(super) fn authorize_agent_actor(actor: &VerifiedActor, selected_agent_id: &str) -> Result<()> {
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
