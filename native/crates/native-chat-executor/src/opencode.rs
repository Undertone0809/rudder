//! OpenCode Server turn execution boundary.
//!
//! This module owns only the provider HTTP/session protocol. D1 admission,
//! checkpoint transitions, authorization, and finalization remain outside it.
//! In particular, a 204 from `prompt_async` is not a terminal observation;
//! callers receive a receipt only after a matching completed assistant message
//! is read back from the same Session.

use crate::HostPaths;
use rudder_d1_persistence::native_chat::config::OpenCodeLocalConfig;
use rudder_native_process_transport::{
    ConnectionLaunchPermit, HostCleanupProof, HostConnection, HostError, HostEvent, OwnedHost,
};
use rudder_native_protocol::{Command, ProtocolVersion};
use rudder_opencode_native::{
    AsyncPromptOutcome, CreateSessionBody, CreateSessionRequest, MessageInfo, MessageListQuery,
    OpenCodeClient, OpenCodeError, OpenCodeSessionSelector, OpenCodeTurnReceipt, OpenCodeWaitError,
    Prompt, PromptPart, PromptQuery, SessionModel,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    net::TcpListener,
    time::{Duration, Instant},
};
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
    #[error("OpenCode Server host lifecycle failed: {0}")]
    Host(#[from] HostError),
    #[error("OpenCode Server did not become ready before the deadline")]
    ServerNotReady,
    #[error("OpenCode Server cleanup proof was not observed")]
    CleanupUnavailable,
}

pub struct OpenCodeExecutionObservation {
    pub session: OpenCodeSessionSelector,
    pub turn: OpenCodeTurnReceipt,
    pub cleanup: HostCleanupProof,
}

/// Execute one OpenCode input from a trusted resolved configuration. The
/// function is synchronous at the worker boundary so it can run on the same
/// blocking executor as Codex/Hermes/Pi while using Tokio for HTTP polling.
#[allow(clippy::too_many_arguments)]
pub fn execute_turn(
    handle: &Handle,
    config: &OpenCodeLocalConfig,
    paths: &HostPaths,
    permit: ConnectionLaunchPermit,
    run_id: &str,
    attempt_id: &str,
    owner_token: &str,
    existing_session: Option<&str>,
    body: &str,
    timeout: Duration,
) -> Result<OpenCodeExecutionObservation, OpenCodeExecutionError> {
    if !config.endpoint_is_valid()
        || body.trim().is_empty()
        || timeout.is_zero()
        || timeout > MAX_TURN_TIMEOUT
        || !paths.process_host.is_file()
        || !paths.runtime_root.is_dir()
        || !paths.isolated_home.is_dir()
        || run_id.is_empty()
        || attempt_id.is_empty()
        || owner_token.is_empty()
    {
        return Err(OpenCodeExecutionError::InvalidConfiguration);
    }
    // Validate the provider selection before launching any child. A malformed
    // model must never create an owned Server that can only be cleaned up via
    // an unproven Drop path.
    let model = config.model.as_deref().map(parse_model).transpose()?;
    // The persisted provider-native session locator is also validated before
    // launch. This keeps corrupt durable state from starting a Server that
    // cannot produce a terminal turn receipt.
    if let Some(value) = existing_session {
        OpenCodeSessionSelector::from_persisted(value)
            .map_err(|_| OpenCodeExecutionError::InvalidSession)?;
    }
    let mut server = OpenCodeServerHost::start(
        handle,
        config,
        paths,
        permit,
        run_id,
        attempt_id,
        owner_token,
        timeout,
    )?;
    let client = OpenCodeClient::new(
        server.url().clone(),
        config.bearer_token().map(str::to_owned),
    )?
    .with_timeout(timeout.min(Duration::from_secs(30)));
    let result = handle.block_on(async {
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
    });
    let cleanup = server.stop(Duration::from_secs(10))?;
    let (session, turn) = result?;
    Ok(OpenCodeExecutionObservation {
        session,
        turn,
        cleanup,
    })
}

/// A host-owned OpenCode Server. The Server is started as the process-host's
/// one child for this execution and is stopped before the observation can
/// leave the executor. Its cleanup proof is minted only after the process-host
/// terminal receipt, so a successful HTTP response or a 204 cannot release a
/// D1 admission hold by itself.
struct OpenCodeServerHost {
    host: OwnedHost,
    url: url::Url,
    request_id: String,
}

impl OpenCodeServerHost {
    #[allow(clippy::too_many_arguments)]
    fn start(
        handle: &Handle,
        config: &OpenCodeLocalConfig,
        paths: &HostPaths,
        permit: ConnectionLaunchPermit,
        run_id: &str,
        attempt_id: &str,
        owner_token: &str,
        timeout: Duration,
    ) -> Result<Self, OpenCodeExecutionError> {
        let executable = config
            .executable()
            .ok_or(OpenCodeExecutionError::InvalidConfiguration)?;
        // `serve` is launched without a TLS certificate/key. A loopback HTTPS
        // URL would therefore be a mismatched endpoint, not an owned Server.
        if config.server_url().scheme() != "http" {
            return Err(OpenCodeExecutionError::InvalidConfiguration);
        }
        let parsed_host = config
            .server_url()
            .host()
            .ok_or(OpenCodeExecutionError::InvalidConfiguration)?;
        let loopback = match parsed_host {
            url::Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
            url::Host::Ipv4(address) => address.is_loopback(),
            url::Host::Ipv6(address) => address.is_loopback(),
        };
        if !loopback {
            return Err(OpenCodeExecutionError::InvalidConfiguration);
        }
        let port = reserve_port().ok_or(OpenCodeExecutionError::InvalidConfiguration)?;
        let mut url = config.server_url().clone();
        if url.set_port(Some(port)).is_err() {
            return Err(OpenCodeExecutionError::InvalidConfiguration);
        }
        if url.path() != "/" && !url.path().is_empty() {
            return Err(OpenCodeExecutionError::InvalidConfiguration);
        }
        url.set_path("/");

        let request_id = attempt_id.to_owned();
        let mut host = OwnedHost::launch_external(
            HostConnection {
                request_id: request_id.clone(),
                run_id: run_id.to_owned(),
                attempt_id: attempt_id.to_owned(),
                owner_token: owner_token.to_owned(),
            },
            &paths.process_host,
            Some(permit),
        )?;
        let runtime_root = paths.runtime_root.to_string_lossy().into_owned();
        let cwd = config.cwd.to_string_lossy().into_owned();
        let mut env = BTreeMap::new();
        env.insert(
            "HOME".to_owned(),
            paths.isolated_home.to_string_lossy().into_owned(),
        );
        env.insert(
            "USERPROFILE".to_owned(),
            paths.isolated_home.to_string_lossy().into_owned(),
        );
        env.insert("PATH".to_owned(), config.executable_search_path.clone());
        let command = Command::Start {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(request_id.clone()),
            executable: executable.to_string_lossy().into_owned(),
            argv: vec![
                "serve".to_owned(),
                "--hostname".to_owned(),
                "127.0.0.1".to_owned(),
                "--port".to_owned(),
                port.to_string(),
                "--log-level".to_owned(),
                "ERROR".to_owned(),
            ],
            cwd,
            env,
            owner_token: Some(owner_token.to_owned()),
            port: Some(port),
            runtime_root: Some(runtime_root),
        };
        host.send(command)?;
        let deadline = Instant::now() + timeout.min(Duration::from_secs(30));
        let mut spawned = false;
        while Instant::now() < deadline {
            match host.receive(Duration::from_millis(100)) {
                Ok(HostEvent::Lifecycle(value)) => {
                    match value.get("type").and_then(Value::as_str) {
                        Some("spawned") => spawned = true,
                        Some("listener-verified")
                            if value.get("port") == Some(&Value::from(port)) =>
                        {
                            spawned = true;
                        }
                        Some("terminal") | Some("error") => {
                            return Err(OpenCodeExecutionError::ServerNotReady);
                        }
                        _ => {}
                    }
                }
                Ok(HostEvent::Stdout(_)) => {}
                Ok(HostEvent::Failure) => return Err(OpenCodeExecutionError::ServerNotReady),
                Err(HostError::Timeout) => {}
                Err(error) => return Err(OpenCodeExecutionError::Host(error)),
            }
            if !spawned {
                continue;
            }
            let client = OpenCodeClient::new(url.clone(), config.bearer_token().map(str::to_owned))
                .map_err(OpenCodeExecutionError::Transport)?;
            let ready = handle.block_on(async {
                tokio::time::timeout(Duration::from_millis(250), client.probe())
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .is_some()
            });
            if ready {
                return Ok(Self {
                    host,
                    url,
                    request_id,
                });
            }
        }
        Err(OpenCodeExecutionError::ServerNotReady)
    }

    fn url(&self) -> &url::Url {
        &self.url
    }

    fn stop(&mut self, timeout: Duration) -> Result<HostCleanupProof, OpenCodeExecutionError> {
        self.host.send(Command::Stop {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(self.request_id.clone()),
            grace_ms: Some(timeout.as_millis().clamp(1, u64::MAX as u128) as u64),
        })?;
        let deadline = Instant::now() + timeout + Duration::from_secs(2);
        while Instant::now() < deadline {
            match self.host.receive(Duration::from_millis(100)) {
                Ok(HostEvent::Lifecycle(value))
                    if value.get("type").and_then(Value::as_str) == Some("terminal") =>
                {
                    return self
                        .host
                        .take_cleanup_proof()
                        .ok_or(OpenCodeExecutionError::CleanupUnavailable);
                }
                Ok(HostEvent::Lifecycle(_)) | Ok(HostEvent::Stdout(_)) => {}
                Ok(HostEvent::Failure) => {
                    return Err(OpenCodeExecutionError::CleanupUnavailable);
                }
                Err(HostError::Timeout) => {}
                Err(_) => return Err(OpenCodeExecutionError::CleanupUnavailable),
            }
        }
        Err(OpenCodeExecutionError::CleanupUnavailable)
    }
}

fn reserve_port() -> Option<u16> {
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok())
        .map(|address| address.port())
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
