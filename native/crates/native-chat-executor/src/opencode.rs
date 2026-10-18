//! OpenCode Server turn execution boundary.
//!
//! This module owns only the provider HTTP/session protocol. D1 admission,
//! checkpoint transitions, authorization, and finalization remain outside it.
//! In particular, a 204 from `prompt_async` is not a terminal observation;
//! callers receive a receipt only after a matching completed assistant message
//! is read back from the same Session.

use rudder_d1_persistence::native_chat::config::OpenCodeLocalConfig;
use rudder_opencode_native::{
    AsyncPromptOutcome, CreateSessionBody, CreateSessionRequest, MessageInfo, MessageListQuery,
    OpenCodeClient, OpenCodeError, OpenCodeSessionSelector, OpenCodeTurnReceipt, OpenCodeWaitError,
    Prompt, PromptPart, PromptQuery, SessionModel,
};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::runtime::Handle;

const POLL_INTERVAL: Duration = Duration::from_millis(200);
const MAX_TURN_TIMEOUT: Duration = Duration::from_secs(3600);

#[derive(Debug, Error)]
pub enum OpenCodeExecutionError {
    #[error("OpenCode native configuration is invalid")]
    InvalidConfiguration,
    #[error("OpenCode session selector is invalid")]
    InvalidSession,
    #[error(transparent)]
    Transport(#[from] OpenCodeError),
    #[error("OpenCode provider did not reach a terminal assistant message: {0}")]
    Wait(#[from] OpenCodeWaitError),
    #[error("OpenCode asynchronous prompt was not accepted")]
    PromptNotAccepted,
}

/// Cleanup remains explicit until the Rust host owns the OpenCode Server
/// process. The current managed Server boundary can prove HTTP/session
/// identity, but not process quiescence after an abort or timeout.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenCodeCleanupStatus {
    UnownedServer,
}

pub struct OpenCodeExecutionObservation {
    pub session: OpenCodeSessionSelector,
    pub turn: OpenCodeTurnReceipt,
    pub cleanup: OpenCodeCleanupStatus,
}

/// Execute one OpenCode input from a trusted resolved configuration. The
/// function is synchronous at the worker boundary so it can run on the same
/// blocking executor as Codex/Hermes/Pi while using Tokio for HTTP polling.
pub fn execute_turn(
    handle: &Handle,
    config: &OpenCodeLocalConfig,
    existing_session: Option<&str>,
    body: &str,
    timeout: Duration,
) -> Result<OpenCodeExecutionObservation, OpenCodeExecutionError> {
    if !config.endpoint_is_valid()
        || body.trim().is_empty()
        || timeout.is_zero()
        || timeout > MAX_TURN_TIMEOUT
    {
        return Err(OpenCodeExecutionError::InvalidConfiguration);
    }
    let client = OpenCodeClient::new(
        config.server_url().clone(),
        config.bearer_token().map(str::to_owned),
    )?
    .with_timeout(timeout.min(Duration::from_secs(30)));
    let model = config.model.as_deref().map(parse_model).transpose()?;
    let (session, turn) = handle.block_on(async {
        let session = if let Some(value) = existing_session {
            OpenCodeSessionSelector::from_persisted(value)
                .map_err(|_| OpenCodeExecutionError::InvalidSession)?
        } else {
            let created = client
                .create_session(&CreateSessionRequest {
                    query: rudder_opencode_native::SessionCreateQuery {
                        directory: Some(configured_directory(config)),
                        workspace: config.workspace.clone(),
                    },
                    body: CreateSessionBody {
                        agent: config.agent.clone(),
                        model: model.clone(),
                        ..CreateSessionBody::default()
                    },
                })
                .await?;
            OpenCodeSessionSelector::from_persisted(&created.id)
                .map_err(|_| OpenCodeExecutionError::InvalidSession)?
        };
        let directory = configured_directory(config);
        let known_assistant_ids = client
            .get_messages(
                session.as_str(),
                MessageListQuery {
                    directory: Some(directory.as_str()),
                    workspace: config.workspace.as_deref(),
                    limit: Some(256),
                    before: None,
                },
            )
            .await?
            .into_iter()
            .filter_map(|message| match message.info {
                MessageInfo::Assistant(assistant) => Some(assistant.id),
                MessageInfo::User(_) => None,
            })
            .collect::<Vec<_>>();
        let outcome = client
            .prompt_async(
                session.as_str(),
                &PromptRequestBuilder {
                    directory: configured_directory(config),
                    workspace: config.workspace.clone(),
                    prompt: Prompt {
                        model: model
                            .as_ref()
                            .map(|model| rudder_opencode_native::ModelSelection {
                                provider_id: model.provider_id.clone(),
                                model_id: model.id.clone(),
                                variant: model.variant.clone(),
                            }),
                        agent: config.agent.clone(),
                        parts: vec![PromptPart::Text {
                            id: None,
                            text: body.to_owned(),
                        }],
                        ..Prompt::default()
                    },
                }
                .build(),
            )
            .await?;
        if !matches!(
            outcome,
            AsyncPromptOutcome::Accepted {
                terminal: false,
                ..
            }
        ) {
            return Err(OpenCodeExecutionError::PromptNotAccepted);
        }
        let known_refs = known_assistant_ids
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let turn = client
            .wait_for_completed_assistant(
                session.as_str(),
                &known_refs,
                Instant::now() + timeout,
                POLL_INTERVAL,
            )
            .await?;
        Ok::<_, OpenCodeExecutionError>((session, turn))
    })?;
    Ok(OpenCodeExecutionObservation {
        session,
        turn,
        cleanup: OpenCodeCleanupStatus::UnownedServer,
    })
}

fn configured_directory(config: &OpenCodeLocalConfig) -> String {
    // The D1 resolver's effective CWD is the provider workspace authority. It
    // is not accepted from the request body and is carried by the common
    // resolved configuration for the executor.
    config.cwd.to_string_lossy().into_owned()
}

fn parse_model(value: &str) -> Result<SessionModel, OpenCodeExecutionError> {
    let Some((provider_id, model_id)) = value.split_once('/') else {
        return Err(OpenCodeExecutionError::InvalidConfiguration);
    };
    if provider_id.is_empty() || model_id.is_empty() {
        return Err(OpenCodeExecutionError::InvalidConfiguration);
    }
    Ok(SessionModel {
        id: model_id.to_owned(),
        provider_id: provider_id.to_owned(),
        variant: None,
    })
}

struct PromptRequestBuilder {
    directory: String,
    workspace: Option<String>,
    prompt: Prompt,
}

impl PromptRequestBuilder {
    fn build(self) -> rudder_opencode_native::PromptRequest {
        rudder_opencode_native::PromptRequest {
            query: PromptQuery {
                directory: Some(self.directory),
                workspace: self.workspace,
            },
            prompt: self.prompt,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_selection_requires_provider_and_model() {
        assert!(parse_model("openai/gpt-5").is_ok());
        assert!(parse_model("gpt-5").is_err());
        assert!(parse_model("/gpt-5").is_err());
    }
}
