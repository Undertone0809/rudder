//! Organization- and owner-scoped persistence for Native Chat runtime bindings.
//!
//! This module owns the first immutable binding epoch and its initial pending
//! native segment. A later explicit rotation operation may replace the active
//! epoch; `ensure` never does so implicitly.

use crate::native_chat::NativeChatActor;
use crate::native_chat::{NativeChatExecutionActor, execution::ExecutionFence};
use rudder_auth_core::VerifiedActor;
use serde::Deserialize;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{1}")]
    Http(u16, String),
    #[error("Runtime binding database operation failed")]
    Database(#[from] sqlx::Error),
}

type Result<T> = std::result::Result<T, Error>;
type Tx<'a> = Transaction<'a, Postgres>;

fn http(status: u16, message: impl Into<String>) -> Error {
    Error::Http(status, message.into())
}

mod auth;
mod ensure;
mod locks;
mod native_chat;
mod projection;
mod reads;
mod validation;

pub(crate) use native_chat::{
    ensure_native_chat_binding_tx, lock_native_chat_target_tx, read_native_chat_binding_tx,
};

/// Strict wire contract for the private signed runtime-binding route.
///
/// Organization and principal scope are derived from verified server state;
/// callers cannot supply either value. Runtime type is read from the selected
/// Agent row. Native session IDs are returned unchanged as opaque provider
/// identifiers, while the untyped provider-state JSON column is never exposed.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Ensure {
        target: Target,
        identity: IdentityInput,
    },
    Current {
        target: Target,
    },
    PublicCurrent {
        target: Target,
    },
    PublicRead {
        #[serde(rename = "bindingId")]
        binding_id: String,
    },
    Read {
        #[serde(rename = "bindingId")]
        binding_id: String,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    #[serde(rename = "targetType")]
    pub target_type: TargetType,
    #[serde(rename = "targetId")]
    pub target_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TargetType {
    ChatConversation,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityInput {
    pub agent_id: String,
    #[serde(default)]
    pub host_id: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub workspace_binding_id: Option<String>,
    #[serde(default)]
    pub instructions_revision: Option<String>,
    #[serde(default)]
    pub capability_revision: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CanonicalIdentity {
    agent_id: String,
    runtime_type: String,
    host_id: String,
    profile_id: String,
    workspace_binding_id: Option<String>,
    instructions_revision: String,
    capability_revision: String,
    principal_scope_ref: String,
}

#[derive(Debug)]
struct Conversation {
    status: String,
    kind: String,
    side_chat_state: Option<String>,
    side_chat_expired: bool,
    owner_user_id: Option<String>,
    preferred_agent_id: Option<String>,
    routed_agent_id: Option<String>,
}

/// Execute a binding operation for a verified actor and signed route org.
///
/// `ensure` serializes per organization/target, creates the binding and its
/// first pending segment in one transaction, and returns the existing row only
/// when its complete canonical identity matches. `current` and `read` perform
/// only scoped SELECTs.
pub async fn execute(
    pool: &PgPool,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &Request,
) -> Result<Value> {
    let organization_id = validation::canonical_uuid(organization_id, "organization id")?;
    if actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }

    match request {
        Request::Ensure { target, identity } => {
            let target_id = validation::canonical_uuid(&target.target_id, "target id")?;
            ensure::ensure(pool, actor, &organization_id, &target_id, identity).await
        }
        Request::Current { target } => {
            let target_id = validation::canonical_uuid(&target.target_id, "target id")?;
            reads::current(pool, actor, &organization_id, &target_id).await
        }
        Request::Read { binding_id } => {
            let binding_id = validation::canonical_uuid(binding_id, "binding id")?;
            reads::read(pool, actor, &organization_id, &binding_id).await
        }
        Request::PublicCurrent { target } => {
            let target_id = validation::canonical_uuid(&target.target_id, "target id")?;
            let value = reads::current(pool, actor, &organization_id, &target_id).await?;
            Ok(projection::public_view(&value))
        }
        Request::PublicRead { binding_id } => {
            let binding_id = validation::canonical_uuid(binding_id, "binding id")?;
            let value = reads::read(pool, actor, &organization_id, &binding_id).await?;
            Ok(projection::public_view(&value))
        }
    }
}

/// Public projection only, in the caller's authorization snapshot. The caller
/// must revalidate its native credential in this same read-only transaction.
/// Private reads and mutation requests are deliberately rejected here.
pub async fn execute_public_read_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    actor: &VerifiedActor,
    organization_id: &str,
    request: &Request,
) -> Result<Value> {
    let organization_id = validation::canonical_uuid(organization_id, "organization id")?;
    if actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }
    let value = match request {
        Request::PublicCurrent { target } => {
            let id = validation::canonical_uuid(&target.target_id, "target id")?;
            reads::current_tx(tx, actor, &organization_id, &id).await?
        }
        Request::PublicRead { binding_id } => {
            let id = validation::canonical_uuid(binding_id, "binding id")?;
            reads::read_tx(tx, actor, &organization_id, &id).await?
        }
        _ => return Err(http(422, "Public runtime binding read required")),
    };
    Ok(projection::public_view(&value))
}

/// Central D1 organization authorization used by Native Chat. Browser evidence
/// is revalidated against the live credential row and user in this transaction.
pub(crate) async fn authorize_native_chat_actor_org_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor: &impl NativeChatActor,
    organization_id: &str,
) -> std::result::Result<(), Error> {
    auth::authorize_org(tx, actor, organization_id).await
}

/// Nonlocking authorization precheck used before Native Chat waits on its
/// target advisory lock. Browser evidence is checked without retaining row
/// locks, then fully locked and revalidated after target serialization.
pub(crate) async fn preauthorize_native_chat_actor_org_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor: &impl NativeChatActor,
    organization_id: &str,
) -> std::result::Result<(), Error> {
    auth::preauthorize_org(tx, actor, organization_id).await
}

/// Revalidate the original request identity for an already claimed worker.
/// This is separate from request authorization: the execution principal is
/// move-only and must match the exact owner fence before it is accepted.
pub(crate) async fn authorize_native_chat_execution_actor_org_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor: &impl NativeChatExecutionActor,
    organization_id: &str,
    fence: &ExecutionFence,
) -> std::result::Result<(), Error> {
    auth::authorize_execution_org(tx, actor, organization_id, fence).await
}

pub(crate) async fn preauthorize_native_chat_execution_actor_org_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor: &impl NativeChatExecutionActor,
    organization_id: &str,
    fence: &ExecutionFence,
) -> std::result::Result<(), Error> {
    auth::preauthorize_execution_org(tx, actor, organization_id, fence).await
}

/// Nonlocking execution precheck before the target advisory lock. The caller
/// must reauthorize after waiting, while holding target serialization, before
/// it can commit any mutation.
pub(crate) async fn preauthorize_chat_execution_target_read_tx(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    organization_id: &str,
    conversation_id: &str,
    selected_agent_id: &str,
    fence: &ExecutionFence,
) -> Result<String> {
    auth::preauthorize_execution_org(tx, actor, organization_id, fence).await?;
    let conversation = auth::conversation(tx, organization_id, conversation_id, false)
        .await?
        .ok_or_else(|| http(404, "Chat conversation not found"))?;
    let principal = auth::authorize_execution_conversation(
        actor,
        organization_id,
        &conversation,
        Some(selected_agent_id),
    )?;
    auth::ensure_conversation_readable(&conversation)?;
    Ok(principal)
}

/// Reauthorize a historical execution-target read after target serialization.
/// Closed ordinary Chats remain readable for exact finalization retries.
pub(crate) async fn authorize_chat_execution_target_read_locked_tx(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    organization_id: &str,
    conversation_id: &str,
    selected_agent_id: &str,
    fence: &ExecutionFence,
) -> Result<String> {
    // Callers perform a nonlocking precheck before the target advisory lock.
    // Once serialized, lock Conversation before credential/membership rows so
    // revocation can commit while this transaction waits on Conversation; the
    // fresh authorization below then observes that revocation.
    auth::preauthorize_execution_org(tx, actor, organization_id, fence).await?;
    let conversation = auth::conversation(tx, organization_id, conversation_id, true)
        .await?
        .ok_or_else(|| http(404, "Chat conversation not found"))?;
    auth::authorize_execution_org(tx, actor, organization_id, fence).await?;
    let principal = auth::authorize_execution_conversation(
        actor,
        organization_id,
        &conversation,
        Some(selected_agent_id),
    )?;
    auth::ensure_conversation_readable(&conversation)?;
    Ok(principal)
}

/// Lock and reauthorize an exact claimed execution target. This is the
/// post-advisory path and intentionally repeats the full owner-fence check.
pub(crate) async fn authorize_chat_execution_target_run_mutation_tx(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatExecutionActor,
    organization_id: &str,
    conversation_id: &str,
    selected_agent_id: &str,
    run_id: &str,
    fence: &ExecutionFence,
) -> Result<String> {
    // Keep the shared order target advisory -> Conversation -> credential and
    // membership locks. A nonlocking precheck avoids taking the Conversation
    // lock for an actor that is already known to be unauthorized.
    auth::preauthorize_execution_org(tx, actor, organization_id, fence).await?;
    let conversation = auth::conversation(tx, organization_id, conversation_id, true)
        .await?
        .ok_or_else(|| http(404, "Chat conversation not found"))?;
    auth::authorize_execution_org(tx, actor, organization_id, fence).await?;
    let principal_scope_ref = auth::authorize_execution_conversation(
        actor,
        organization_id,
        &conversation,
        Some(selected_agent_id),
    )?;
    let admitted_before_expiry = if conversation.kind == "side_chat"
        && conversation.side_chat_state.as_deref() == Some("active")
        && conversation.side_chat_expired
    {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
               SELECT 1 FROM heartbeat_runs r
               JOIN chat_conversations c
                 ON c.org_id=r.org_id AND c.id=r.chat_conversation_id
               WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND c.id=$3::uuid
                 AND r.started_at IS NOT NULL AND c.side_chat_expires_at IS NOT NULL
                 AND r.started_at <= c.side_chat_expires_at
             )",
        )
        .bind(organization_id)
        .bind(run_id)
        .bind(conversation_id)
        .fetch_one(&mut **tx)
        .await?
    } else {
        false
    };
    auth::ensure_conversation_mutable_for_run(&conversation, admitted_before_expiry)?;
    Ok(principal_scope_ref)
}

/// Nonlocking read/precheck for a request-scoped Native Chat browser actor.
/// Mutations must still reauthorize with credential/grant locks after target serialization.
pub(crate) async fn preauthorize_chat_target_read_tx(
    tx: &mut Tx<'_>,
    actor: &impl NativeChatActor,
    organization_id: &str,
    conversation_id: &str,
    selected_agent_id: &str,
) -> Result<String> {
    auth::preauthorize_org(tx, actor, organization_id).await?;
    let conversation = auth::conversation(tx, organization_id, conversation_id, false)
        .await?
        .ok_or_else(|| http(404, "Chat conversation not found"))?;
    let principal = auth::authorize_conversation(
        actor,
        organization_id,
        &conversation,
        Some(selected_agent_id),
    )?;
    auth::ensure_conversation_readable(&conversation)?;
    Ok(principal)
}

/// Reauthorize an existing Chat target for a historical read in its caller's transaction.
pub(crate) async fn authorize_chat_target_read_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor: &impl NativeChatActor,
    organization_id: &str,
    conversation_id: &str,
    selected_agent_id: &str,
) -> std::result::Result<String, Error> {
    // Historical readers run in a PostgreSQL READ ONLY transaction. Reuse the
    // nonlocking authorization path so membership checks do not issue FOR
    // SHARE, which PostgreSQL rejects in a read-only transaction. The
    // repeatable-read snapshot still keeps this historical authorization
    // decision consistent with the message rows below.
    auth::preauthorize_org(tx, actor, organization_id).await?;
    let conversation = auth::conversation(tx, organization_id, conversation_id, false)
        .await?
        .ok_or_else(|| http(404, "Chat conversation not found"))?;
    let principal_scope_ref = auth::authorize_conversation(
        actor,
        organization_id,
        &conversation,
        Some(selected_agent_id),
    )?;
    auth::ensure_conversation_readable(&conversation)?;
    Ok(principal_scope_ref)
}

/// Recheck historical read entitlement after target serialization. Conversation
/// ownership/selection cannot change until commit, and organization access is
/// checked again after any wait for the row lock.
pub(crate) async fn authorize_chat_target_read_locked_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor: &impl NativeChatActor,
    organization_id: &str,
    conversation_id: &str,
    selected_agent_id: &str,
) -> std::result::Result<String, Error> {
    // The nonlocking precheck happens before target serialization. Do not hold
    // membership/credential locks while waiting for the Conversation row.
    auth::preauthorize_org(tx, actor, organization_id).await?;
    let conversation = auth::conversation(tx, organization_id, conversation_id, true)
        .await?
        .ok_or_else(|| http(404, "Chat conversation not found"))?;
    auth::authorize_org(tx, actor, organization_id).await?;
    let principal = auth::authorize_conversation(
        actor,
        organization_id,
        &conversation,
        Some(selected_agent_id),
    )?;
    auth::ensure_conversation_readable(&conversation)?;
    Ok(principal)
}

/// Reauthorize a write attached to a Run admitted before its Side Chat TTL.
/// This never updates conversation lifecycle or expiry fields.
pub(crate) async fn authorize_chat_target_run_mutation_tx(
    tx: &mut Transaction<'_, Postgres>,
    actor: &impl NativeChatActor,
    organization_id: &str,
    conversation_id: &str,
    selected_agent_id: &str,
    run_id: &str,
) -> std::result::Result<String, Error> {
    // Lock order is target advisory -> Conversation -> credential/membership.
    // Fresh locked authorization below runs only after the Conversation wait.
    auth::preauthorize_org(tx, actor, organization_id).await?;
    let conversation = auth::conversation(tx, organization_id, conversation_id, true)
        .await?
        .ok_or_else(|| http(404, "Chat conversation not found"))?;
    auth::authorize_org(tx, actor, organization_id).await?;
    let principal_scope_ref = auth::authorize_conversation(
        actor,
        organization_id,
        &conversation,
        Some(selected_agent_id),
    )?;
    let run_admitted_before_expiry = if conversation.kind == "side_chat"
        && conversation.side_chat_state.as_deref() == Some("active")
        && conversation.side_chat_expired
    {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(
               SELECT 1 FROM heartbeat_runs r
               JOIN chat_conversations c
                 ON c.org_id=r.org_id AND c.id=r.chat_conversation_id
               WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND c.id=$3::uuid
                 AND r.started_at IS NOT NULL AND c.side_chat_expires_at IS NOT NULL
                 AND r.started_at <= c.side_chat_expires_at
             )",
        )
        .bind(organization_id)
        .bind(run_id)
        .bind(conversation_id)
        .fetch_one(&mut **tx)
        .await?
    } else {
        false
    };
    auth::ensure_conversation_mutable_for_run(&conversation, run_admitted_before_expiry)?;
    Ok(principal_scope_ref)
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_is_tagged_strict_and_camel_case() {
        let request: Request = serde_json::from_value(json!({
            "operation":"ensure",
            "target":{"targetType":"chat_conversation","targetId":"20000000-0000-4000-8000-000000000001"},
            "identity":{"agentId":"50000000-0000-4000-8000-000000000001"}
        }))
        .unwrap();
        assert!(matches!(request, Request::Ensure { .. }));

        for invalid in [
            json!({"operation":"ensure","target":{"targetType":"issue","targetId":"x"},"identity":{"agentId":"x"}}),
            json!({"operation":"read","bindingId":"x","target":{"targetType":"chat_conversation","targetId":"x"}}),
            json!({"operation":"current","target":{"targetType":"chat_conversation","targetId":"x"},"principalScopeRef":"org:fake"}),
            json!({"operation":"ensure","target":{"targetType":"chat_conversation","targetId":"x"},"identity":{"agentId":"x","runtimeType":"process"}}),
        ] {
            assert!(serde_json::from_value::<Request>(invalid).is_err());
        }
    }

    #[test]
    fn opaque_host_and_profile_refs_reject_paths_and_empty_values_default() {
        assert_eq!(
            validation::canonical_ref(None, "local", "host id").unwrap(),
            "local"
        );
        assert_eq!(
            validation::canonical_ref(Some(" codex-main "), "local", "host id").unwrap(),
            "codex-main"
        );
        assert!(
            validation::canonical_ref(Some("/Users/alice/.config"), "local", "host id").is_err()
        );
        assert!(
            validation::canonical_ref(Some("C:\\Users\\alice"), "local", "profile id").is_err()
        );
    }
}
