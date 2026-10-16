//! Disabled D1 admission groundwork for Rust-owned ordinary Chat turns.
//!
//! This module inserts the source message, Generation, Run, and initial Attempt
//! in one transaction. It is not wired to a public route and does not launch a
//! provider. No caller-supplied prompt history, Agent choice, or auth material
//! crosses this boundary.

use rudder_auth_core::VerifiedActor;
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgPool;

pub use crate::runtime_bindings::Error;
use crate::runtime_bindings::IdentityInput;

mod admission;
mod auth;
mod budget;
pub mod config;
pub mod execution;
mod locks;
mod validation;

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

/// Strict private command. Organization and actor are supplied only by the
/// verified internal envelope, never by this JSON body.
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

/// Execute a private, organization-scoped admission command. Public route
/// activation remains disabled until provider transport, recovery, and legacy
/// writer exclusion are implemented.
pub async fn execute(
    pool: &PgPool,
    actor: &VerifiedActor,
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

        for invalid in [
            json!({"operation":"submit_native_chat_turn","conversationId":"x","clientMutationId":"m","body":"hi","orgId":"other"}),
            json!({"operation":"submit_native_chat_turn","conversationId":"x","clientMutationId":"m","body":"hi","agentId":"caller-selected"}),
            json!({"operation":"submit_native_chat_turn","conversationId":"x","clientMutationId":"m","body":"hi","history":["private"]}),
            json!({"operation":"execute_terminal","conversationId":"x"}),
        ] {
            assert!(serde_json::from_value::<Request>(invalid).is_err());
        }
    }
}
