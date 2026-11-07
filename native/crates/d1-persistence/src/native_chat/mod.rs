//! Rust-owned ordinary Chat admission, execution fencing, and durable output reads.
//!
//! Public activation remains explicitly configured by the Rust host. Admission
//! persists source message, Generation, Run and Attempt atomically; it does not
//! accept caller-supplied history, Agent choice, or serialized auth fields.

use serde::Deserialize;
use serde_json::Value;
use sqlx::PgPool;

pub use crate::runtime_bindings::Error;
use crate::runtime_bindings::IdentityInput;

mod actor;
mod admission;
pub use admission::DispatchUnavailableRequest;
mod auth;
mod budget;
pub mod config;
pub mod control;
pub mod execution;
mod first_send;
mod locks;
mod validation;

pub(crate) use actor::BrowserCredentialKind;
pub use actor::{
    BrowserCredentialBinding, BrowserPrincipal, BrowserPrincipalError, NativeChatActor,
    NativeChatExecutionActor, NativeChatExecutionPrincipal,
};

type Result<T> = std::result::Result<T, Error>;

fn http(status: u16, message: impl Into<String>) -> Error {
    Error::Http(status, message.into())
}

fn binding_identity(config: &config::ResolvedCodexConfig) -> IdentityInput {
    IdentityInput {
        agent_id: config.identity.agent_id.clone(),
        host_id: Some(config.identity.host_id.clone()),
        profile_id: Some(config.identity.profile_id.clone()),
        workspace_binding_id: config.identity.workspace_binding_id.clone(),
        instructions_revision: Some(config.identity.instructions_revision.clone()),
        capability_revision: Some(config.identity.capability_revision.clone()),
    }
}

/// Strict private command. Organization and actor come from trusted Rust
/// authentication state (a verified envelope or request-scoped browser proof),
/// never from this JSON body.
// Deliberately omit `Debug`: this request contains the user's message body.
#[derive(Clone, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    SubmitNativeChatTurn {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        #[serde(rename = "clientMutationId")]
        client_mutation_id: String,
        body: String,
    },
}

/// Separate strict wire for first-send admission so existing conversation
/// request consumers remain exhaustive and source compatible.
// Deliberately omit `Debug`: this request contains the user's message body.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FirstSendRequest {
    #[serde(rename = "clientMutationId")]
    client_mutation_id: String,
    #[serde(rename = "preferredAgentId")]
    preferred_agent_id: Option<String>,
    #[serde(rename = "modelOverride")]
    model_override: Option<String>,
    #[serde(rename = "effortOverride")]
    effort_override: Option<String>,
    #[serde(rename = "issueCreationMode")]
    issue_creation_mode: Option<String>,
    #[serde(rename = "planMode")]
    plan_mode: Option<bool>,
    title: Option<String>,
    body: String,
}

/// Execute an organization-scoped admission command. Browser principals are
/// revalidated in D1 and remain request-scoped. This commits durable admission
/// only; the separately configured Foundation worker owns dispatch.
pub async fn execute(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    organization_id: &str,
    request: &Request,
    host: &config::LocalHostContext,
) -> Result<Value> {
    let organization_id = validation::canonical_uuid(organization_id, "organization id")?;
    if actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }

    match request {
        Request::SubmitNativeChatTurn {
            conversation_id,
            client_mutation_id,
            body,
        } => {
            let conversation_id = validation::canonical_uuid(conversation_id, "conversation id")?;
            let client_mutation_id = validation::client_mutation_id(client_mutation_id)?;
            let body = validation::body(body)?;
            admission::submit(
                pool,
                actor,
                &organization_id,
                &conversation_id,
                &client_mutation_id,
                &body,
                host,
            )
            .await
        }
    }
}

/// Authenticate and atomically admit an ordinary Chat's first text message.
/// Callers must reserve worker capacity before this operation and retain the
/// durable receipt if dispatch is subsequently unavailable.
pub async fn execute_first_send(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    organization_id: &str,
    request: &FirstSendRequest,
    host: &config::LocalHostContext,
) -> Result<Value> {
    let organization_id = validation::canonical_uuid(organization_id, "organization id")?;
    if actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }
    let client_mutation_id = validation::client_mutation_id(&request.client_mutation_id)?;
    let body = validation::body(&request.body)?;
    let preferred_agent_id = request
        .preferred_agent_id
        .as_deref()
        .map(|value| validation::canonical_uuid(value, "Agent id"))
        .transpose()?;
    let model_override = validation::optional_override(request.model_override.as_deref(), "model")?;
    let effort_override =
        validation::optional_override(request.effort_override.as_deref(), "effort")?;
    let issue_creation_mode =
        first_send::issue_creation_mode(request.issue_creation_mode.as_deref())?;
    if request.plan_mode == Some(true) {
        return Err(http(
            422,
            "Plan mode is not supported by Native Chat first-send admission",
        ));
    }
    let title = first_send::title(request.title.as_deref(), &body)?;
    let input = first_send::FirstSendInput {
        client_mutation_id: &client_mutation_id,
        preferred_agent_id: preferred_agent_id.as_deref(),
        model_override: model_override.as_deref(),
        effort_override: effort_override.as_deref(),
        issue_creation_mode: issue_creation_mode.as_deref(),
        title: &title,
        body: &body,
    };
    first_send::submit(pool, actor, &organization_id, &input, host).await
}

/// Read an exact durable retry receipt without resolving mutable Agent config
/// or reserving process capacity. A miss does not admit anything; the caller
/// must reserve before invoking `execute`, which repeats the lookup atomically.
pub async fn lookup_submission(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    organization_id: &str,
    request: &Request,
) -> Result<Option<Value>> {
    let organization_id = validation::canonical_uuid(organization_id, "organization id")?;
    if actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }
    match request {
        Request::SubmitNativeChatTurn {
            conversation_id,
            client_mutation_id,
            body,
        } => {
            admission::lookup_submission(
                pool,
                actor,
                &organization_id,
                conversation_id,
                client_mutation_id,
                body,
            )
            .await
        }
    }
}

/// Read the exact first-send receipt before worker reservation. A miss is a
/// non-authoritative hint; `execute_first_send` repeats lookup in its write
/// transaction.
pub async fn lookup_first_send_submission(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    organization_id: &str,
    request: &FirstSendRequest,
) -> Result<Option<Value>> {
    let organization_id = validation::canonical_uuid(organization_id, "organization id")?;
    if actor.organization_id() != organization_id {
        return Err(http(403, "Organization access denied"));
    }
    let client_mutation_id = validation::client_mutation_id(&request.client_mutation_id)?;
    let body = validation::body(&request.body)?;
    let preferred_agent_id = request
        .preferred_agent_id
        .as_deref()
        .map(|value| validation::canonical_uuid(value, "Agent id"))
        .transpose()?;
    let model_override = validation::optional_override(request.model_override.as_deref(), "model")?;
    let effort_override =
        validation::optional_override(request.effort_override.as_deref(), "effort")?;
    let issue_creation_mode =
        first_send::issue_creation_mode(request.issue_creation_mode.as_deref())?;
    if request.plan_mode == Some(true) {
        return Err(http(
            422,
            "Plan mode is not supported by Native Chat first-send admission",
        ));
    }
    let title = first_send::title(request.title.as_deref(), &body)?;
    let input = first_send::FirstSendInput {
        client_mutation_id: &client_mutation_id,
        preferred_agent_id: preferred_agent_id.as_deref(),
        model_override: model_override.as_deref(),
        effort_override: effort_override.as_deref(),
        issue_creation_mode: issue_creation_mode.as_deref(),
        title: &title,
        body: &body,
    };
    first_send::lookup_submission(pool, actor, &organization_id, &input).await
}

/// Quarantine a committed admission only when the supervisor definitively
/// refuses to start its reserved worker. This never authorizes redispatch.
pub async fn record_dispatch_unavailable(
    pool: &PgPool,
    actor: &impl NativeChatActor,
    request: &DispatchUnavailableRequest,
) -> Result<()> {
    admission::record_dispatch_unavailable(pool, actor, request).await
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn command_wire_is_strict_and_contains_only_user_input_identity() {
        let parsed: Request = serde_json::from_value(json!({
            "operation":"submit_native_chat_turn",
            "conversationId":"21000000-0000-4000-8000-000000000001",
            "clientMutationId":"mutation-1",
            "body":"hello"
        }))
        .unwrap();
        assert!(matches!(parsed, Request::SubmitNativeChatTurn { .. }));

        let first_send: FirstSendRequest = serde_json::from_value(json!({
            "clientMutationId":"first-mutation",
            "body":"hello",
            "preferredAgentId":"21000000-0000-4000-8000-000000000001",
            "modelOverride":"provider/custom-model",
            "effortOverride":"high",
            "issueCreationMode":"manual_approval",
            "planMode":false,
            "title":"A first chat"
        }))
        .unwrap();
        assert_eq!(first_send.client_mutation_id, "first-mutation");
        assert_eq!(
            first_send.preferred_agent_id.as_deref(),
            Some("21000000-0000-4000-8000-000000000001")
        );

        for invalid in [
            json!({"operation":"submit_native_chat_turn","conversationId":"x","clientMutationId":"m","body":"hi","orgId":"other"}),
            json!({"operation":"submit_native_chat_turn","conversationId":"x","clientMutationId":"m","body":"hi","agentId":"caller-selected"}),
            json!({"operation":"submit_native_chat_turn","conversationId":"x","clientMutationId":"m","body":"hi","history":["private"]}),
            json!({"operation":"execute_terminal","conversationId":"x"}),
        ] {
            assert!(serde_json::from_value::<Request>(invalid).is_err());
        }

        for invalid in [
            json!({"clientMutationId":"m","body":"hi","conversationId":"caller-id"}),
            json!({"clientMutationId":"m","body":"hi","orgId":"caller-org"}),
            json!({"clientMutationId":"m","body":"hi","runId":"caller-run"}),
            json!({"clientMutationId":"m","body":"hi","contextLinks":[]}),
            json!({"clientMutationId":"m","body":"hi","inlineAnnotations":[]}),
            json!({"clientMutationId":"m","body":"hi","files":[]}),
        ] {
            assert!(serde_json::from_value::<FirstSendRequest>(invalid).is_err());
        }
        assert!(
            serde_json::from_value::<FirstSendRequest>(json!({
                "clientMutationId":"m", "body":"hi", "planMode":true
            }))
            .is_ok()
        );
    }
}
