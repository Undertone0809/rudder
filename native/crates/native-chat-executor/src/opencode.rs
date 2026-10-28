//! OpenCode Server turn execution boundary.
//!
//! This module owns only the provider HTTP/session protocol. D1 admission,
//! checkpoint transitions, authorization, and finalization remain outside it.
//! In particular, a 204 from `prompt_async` is not a terminal observation;
//! callers receive a receipt only after a matching completed assistant message
//! is read back from the same Session.

use crate::{
    HostExecutionFailure, HostPaths,
    native_turn::{NativeTurnAuthority, cleanup_tick_budget_is_safe},
};
use rudder_d1_persistence::{
    native_chat::{
        config::OpenCodeLocalConfig,
        execution::{NativeInterruptTarget, StopIntent},
    },
    runtime_bindings,
};
use rudder_native_process_transport::{
    ConnectionLaunchPermit, ConnectionReceipt, HostCleanupProof, HostConnection, HostError,
    HostEvent, OwnedHost,
};
use rudder_native_protocol::{Command, ProtocolVersion};
use rudder_opencode_native::{
    AsyncPromptOutcome, CreateSessionBody, CreateSessionRequest, MessageInfo, MessageListQuery,
    OpenCodeClient, OpenCodeError, OpenCodeInputProgress, OpenCodeInputTerminal,
    OpenCodeSessionSelector, OpenCodeWaitError, Prompt, PromptPart, PromptQuery, SessionModel,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    future::Future,
    net::TcpListener,
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::runtime::Runtime;
use tokio::task::LocalSet;
use uuid::Uuid;

const POLL_INTERVAL: Duration = Duration::from_millis(200);
const MAX_TURN_TIMEOUT: Duration = Duration::from_secs(3600);
const CLEANUP_TICK_INTERVAL: Duration = Duration::from_secs(4);
const CLEANUP_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const CLEANUP_RECEIVE_QUANTUM: Duration = Duration::from_millis(100);
const MAX_FINAL_HOST_DRAIN_EVENTS: usize = 128;

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
    #[error("OpenCode durable execution fence rejected dispatch")]
    Persistence(#[from] runtime_bindings::Error),
    #[error("OpenCode asynchronous prompt was not accepted")]
    PromptNotAccepted,
    #[error("OpenCode Server host lifecycle failed: {0}")]
    Host(#[from] HostError),
    #[error("OpenCode Server did not become ready before the deadline")]
    ServerNotReady,
    #[error("OpenCode Server cleanup proof was not observed")]
    CleanupUnavailable,
    #[error("OpenCode HTTP worker runtime is unavailable")]
    HttpRuntimeUnavailable,
}

impl OpenCodeExecutionError {
    pub(crate) fn diagnostic_code(&self) -> &'static str {
        match self {
            Self::InvalidConfiguration => "opencode_invalid_configuration",
            Self::InvalidSession => "opencode_invalid_session",
            Self::Transport(OpenCodeError::Http { status: 400, .. }) => "opencode_http_bad_request",
            Self::Transport(OpenCodeError::Http {
                status: 401 | 403, ..
            }) => "opencode_http_access_denied",
            Self::Transport(OpenCodeError::Http { .. }) => "opencode_http_response",
            Self::Transport(OpenCodeError::Decode(_)) => "opencode_response_decode",
            Self::Transport(_) => "opencode_transport",
            Self::Wait(_) => "opencode_terminal_wait",
            Self::Persistence(_) => "opencode_persistence_conflict",
            Self::PromptNotAccepted => "opencode_prompt_not_accepted",
            Self::Host(_) => "opencode_host",
            Self::ServerNotReady => "opencode_server_not_ready",
            Self::CleanupUnavailable => "opencode_cleanup_unavailable",
            Self::HttpRuntimeUnavailable => "opencode_http_runtime_unavailable",
        }
    }
}

pub struct OpenCodeExecutionObservation {
    pub session: OpenCodeSessionSelector,
    /// The native `msg_...` identifier assigned to the submitted user input.
    /// This is the D1 request correlation key; the assistant message ID remains
    /// separate provider evidence in `terminal`.
    pub request_id: String,
    pub terminal: OpenCodeInputTerminal,
    pub connection: ConnectionReceipt,
    pub cleanup: HostCleanupProof,
    pub stop: Option<StopIntent>,
    /// Provider abort acknowledgment is evidence only; it is not a terminal.
    pub cancel_acknowledged: Option<bool>,
}

/// Execute one OpenCode input from a trusted resolved configuration. The
/// function is synchronous at the worker boundary so it can run on the same
/// blocking executor as Codex/Hermes/Pi while using Tokio for HTTP polling.
#[allow(clippy::too_many_arguments)]
pub(crate) fn execute_turn(
    config: &OpenCodeLocalConfig,
    paths: &HostPaths,
    permit: ConnectionLaunchPermit,
    run_id: &str,
    attempt_id: &str,
    owner_token: &str,
    authority: &mut NativeTurnAuthority<'_>,
    timeout: Duration,
) -> Result<OpenCodeExecutionObservation, HostExecutionFailure<OpenCodeExecutionError>> {
    let prepared = (|| -> Result<_, OpenCodeExecutionError> {
        if !config.endpoint_is_valid()
            || timeout.is_zero()
            || timeout > MAX_TURN_TIMEOUT
            || !paths.process_host.is_file()
            || !paths.runtime_root.is_dir()
            || !paths.isolated_home.is_dir()
            || run_id.is_empty()
            || attempt_id.is_empty()
            || owner_token.is_empty()
        {
            return Err(OpenCodeExecutionError::InvalidConfiguration.into());
        }
        // Validate the provider selection before launching any child. A malformed
        // model must never create an owned Server that can only be cleaned up via
        // an unproven Drop path.
        let timeout = config
            .timeout_sec
            .filter(|seconds| *seconds > 0)
            .map(Duration::from_secs)
            .map_or(timeout, |configured| timeout.min(configured));
        let deadline = Instant::now() + timeout;
        let mut model = config.model.as_deref().map(parse_model).transpose()?;
        if let Some(model) = model.as_mut() {
            model.variant = config.variant.clone();
        }
        // The persisted provider-native session locator is also validated before
        // launch. This keeps corrupt durable state from starting a Server that
        // cannot produce a terminal turn receipt.
        let existing_session = authority.existing_session().map(str::to_owned);
        if let Some(value) = existing_session.as_deref() {
            OpenCodeSessionSelector::from_persisted(value)
                .map_err(|_| OpenCodeExecutionError::InvalidSession)?;
        }
        // Foundation may use a LocalRuntime owned by its listener thread. Its
        // runtime cannot spawn local HTTP tasks on this blocking worker, even with
        // a LocalSet entered. Own a current-thread runtime here and keep its one
        // LocalSet alive during client construction, polling and drop. D1 authority
        // retains its separate caller runtime.
        let http_runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| OpenCodeExecutionError::HttpRuntimeUnavailable)?;
        Ok((model, existing_session, http_runtime, timeout, deadline))
    })();
    let (model, existing_session, http_runtime, timeout, deadline) = match prepared {
        Ok(value) => value,
        Err(error) => {
            return Err(HostExecutionFailure {
                error,
                cleanup: None,
                unspent_launch_permit: Some(permit),
            });
        }
    };
    let runtime = &http_runtime;
    let local = LocalSet::new();
    let _runtime_guard = runtime.enter();
    let _local_guard = local.enter();
    let mut server =
        OpenCodeServerHost::launch(config, paths, permit, run_id, attempt_id, owner_token)
            .map_err(HostExecutionFailure::from)?;
    let connection = server.host.connection_identity().connection_receipt();
    let connection_id = connection.connection_receipt_id().to_owned();
    if let Err(error) = authority.register_connection(connection) {
        let mut next_cleanup_tick = Instant::now();
        let cleanup_result = server.stop_with_tick(config.cleanup_grace, |remaining| {
            let now = Instant::now();
            if now >= next_cleanup_tick {
                if cleanup_tick_budget_is_safe(remaining, CLEANUP_RECEIVE_QUANTUM) {
                    let _ = authority.cleanup_tick(now + CLEANUP_OPERATION_TIMEOUT);
                }
                next_cleanup_tick = Instant::now() + CLEANUP_TICK_INTERVAL;
            }
        });
        let cleanup = cleanup_result.ok();
        let _ = authority.cleanup_tick(Instant::now() + CLEANUP_OPERATION_TIMEOUT);
        return Err(HostExecutionFailure {
            unspent_launch_permit: None,
            error: OpenCodeExecutionError::Persistence(error),
            cleanup: cleanup.map(Box::new),
        });
    }

    let result = (|| {
        server.wait_ready(runtime, &local, config, authority, deadline)?;
        let client = OpenCodeClient::new(
            server.url().clone(),
            config.bearer_token().map(str::to_owned),
        )?
        .with_timeout(timeout.min(Duration::from_secs(30)));
        let session = if let Some(value) = existing_session.as_deref() {
            OpenCodeSessionSelector::from_persisted(value)
                .map_err(|_| OpenCodeExecutionError::InvalidSession)?
        } else {
            ensure_not_stopped(authority)?;
            let created = authority.start_session(|| {
                block_on_local(runtime, &local, async {
                    client
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
                        .await
                })
            })??;
            let session = OpenCodeSessionSelector::from_persisted(&created.id)
                .map_err(|_| OpenCodeExecutionError::InvalidSession)?;
            authority
                .record_session(session.as_str())
                .map_err(OpenCodeExecutionError::from)?;
            session
        };
        if existing_session.is_some() {
            authority
                .record_session(session.as_str())
                .map_err(OpenCodeExecutionError::from)?;
        }
        ensure_not_stopped(authority)?;
        let directory = configured_directory(config);
        let known_assistant_ids = block_on_local(
            runtime,
            &local,
            client
                .clone()
                .with_timeout(timeout.min(Duration::from_secs(2)))
                .get_messages(
                    session.as_str(),
                    MessageListQuery {
                        directory: Some(directory.as_str()),
                        workspace: config.workspace.as_deref(),
                        limit: Some(256),
                        before: None,
                    },
                ),
        )?
        .into_iter()
        .filter_map(|message| match message.info {
            MessageInfo::Assistant(assistant) => Some(assistant.id),
            MessageInfo::User(_) => None,
        })
        .collect::<Vec<_>>();
        let request_id = format!("msg_{}", Uuid::new_v4().simple());
        // This read-only guard prevents a Stop already visible at this
        // boundary from dispatching another input. If Stop races the D1
        // one-use input authorization below, that single authorized request
        // remains bound to this exact ID and is cancelled after acceptance.
        ensure_not_stopped(authority)?;
        let outcome = authority.submit(&request_id, |body| {
            block_on_local(runtime, &local, async {
                client
                    .prompt_async(
                        session.as_str(),
                        &PromptRequestBuilder {
                            directory: configured_directory(config),
                            workspace: config.workspace.clone(),
                            prompt: Prompt {
                                system: config.system_instructions().map(str::to_owned),
                                message_id: Some(request_id.clone()),
                                model: model.as_ref().map(|model| {
                                    rudder_opencode_native::ModelSelection {
                                        provider_id: model.provider_id.clone(),
                                        model_id: model.id.clone(),
                                    }
                                }),
                                agent: config.agent.clone(),
                                variant: config.variant.clone(),
                                parts: vec![PromptPart::Text {
                                    id: None,
                                    text: body.to_owned(),
                                }],
                                ..Prompt::default()
                            },
                        }
                        .build(),
                    )
                    .await
            })
        })??;
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
        let (terminal, cancel_acknowledged) = wait_for_input_terminal(
            runtime,
            &local,
            &client,
            authority,
            &session,
            &request_id,
            &known_refs,
            deadline,
        )?;
        Ok::<_, OpenCodeExecutionError>((session, request_id, terminal, cancel_acknowledged))
    })();
    let mut next_cleanup_tick = Instant::now();
    let cleanup_result = server.stop_with_tick(config.cleanup_grace, |remaining| {
        let now = Instant::now();
        if now >= next_cleanup_tick {
            if cleanup_tick_budget_is_safe(remaining, CLEANUP_RECEIVE_QUANTUM) {
                let _ = authority.cleanup_tick(now + CLEANUP_OPERATION_TIMEOUT);
            }
            next_cleanup_tick = Instant::now() + CLEANUP_TICK_INTERVAL;
        }
    });
    // This final bounded probe captures a Stop which raced the last lifecycle
    // event. A DB tick failure must not discard the already-observed terminal
    // message or the host cleanup proof; the fenced finalizer decides whether
    // authority is still valid.
    let _ = authority.cleanup_tick(Instant::now() + CLEANUP_OPERATION_TIMEOUT);
    let cleanup = match cleanup_result {
        Ok(cleanup) if cleanup.connection_receipt_id() == connection_id => cleanup,
        Ok(_) => {
            return Err(HostExecutionFailure {
                unspent_launch_permit: None,
                error: OpenCodeExecutionError::CleanupUnavailable,
                cleanup: None,
            });
        }
        Err(error) => {
            return Err(HostExecutionFailure {
                unspent_launch_permit: None,
                error,
                cleanup: None,
            });
        }
    };
    let (session, request_id, terminal, cancel_acknowledged) = match result {
        Ok(result) => result,
        Err(error) => {
            return Err(HostExecutionFailure {
                unspent_launch_permit: None,
                error,
                cleanup: Some(Box::new(cleanup)),
            });
        }
    };
    // The cleanup hook above used a fresh DB deadline and only observes/binds
    // Stop; do not use the possibly expired input deadline here and discard
    // the exact provider terminal if this best-effort refresh failed.
    let connection = match authority.take_connection() {
        Ok(connection) if connection.connection_receipt_id() == connection_id => connection,
        Ok(_) => {
            return Err(HostExecutionFailure {
                unspent_launch_permit: None,
                error: OpenCodeExecutionError::CleanupUnavailable,
                cleanup: Some(Box::new(cleanup)),
            });
        }
        Err(error) => {
            return Err(HostExecutionFailure {
                unspent_launch_permit: None,
                error: OpenCodeExecutionError::Persistence(error),
                cleanup: Some(Box::new(cleanup)),
            });
        }
    };
    Ok(OpenCodeExecutionObservation {
        session,
        request_id,
        terminal,
        connection,
        cleanup,
        stop: authority.stop().cloned(),
        cancel_acknowledged,
    })
}

fn ensure_not_stopped(
    authority: &mut NativeTurnAuthority<'_>,
) -> Result<(), OpenCodeExecutionError> {
    let _ = authority
        .poll_stop()
        .map_err(OpenCodeExecutionError::from)?;
    if authority.stop().is_some() {
        return Err(OpenCodeExecutionError::Persistence(
            runtime_bindings::Error::Http(409, "Native OpenCode execution is stopping".into()),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn wait_for_input_terminal(
    runtime: &Runtime,
    local: &LocalSet,
    client: &OpenCodeClient,
    authority: &mut NativeTurnAuthority<'_>,
    session: &OpenCodeSessionSelector,
    request_id: &str,
    known_assistant_ids: &[&str],
    deadline: Instant,
) -> Result<(OpenCodeInputTerminal, Option<bool>), OpenCodeExecutionError> {
    let target = NativeInterruptTarget::OpenCode {
        session_id: session.as_str().to_owned(),
        request_id: request_id.to_owned(),
    };
    let mut cancel_acknowledged = None;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(OpenCodeWaitError::Deadline.into());
        }
        // Read terminal state before reserving an interrupt. A provider
        // completion that wins this race is authoritative and needs no abort.
        let progress = block_on_local(
            runtime,
            local,
            client
                .clone()
                .with_timeout(remaining.min(Duration::from_secs(2)))
                .poll_input_terminal(session.as_str(), known_assistant_ids, request_id),
        )?;
        if let OpenCodeInputProgress::Terminal(terminal) = progress {
            validate_terminal_identity(&terminal, session.as_str(), request_id)?;
            authority
                .terminal(session.as_str(), request_id)
                .map_err(OpenCodeExecutionError::from)?;
            return Ok((terminal, cancel_acknowledged));
        }

        if let Some(permit) = authority
            .poll_stop()
            .map_err(OpenCodeExecutionError::from)?
        {
            let connection = authority
                .connection()
                .ok_or(OpenCodeExecutionError::InvalidSession)?;
            cancel_acknowledged = Some(
                permit
                    .dispatch(connection, &target, || {
                        block_on_local(
                            runtime,
                            local,
                            client
                                .clone()
                                .with_timeout(remaining.min(Duration::from_secs(2)))
                                .abort(session.as_str()),
                        )
                    })
                    .map_err(OpenCodeExecutionError::from)??,
            );
        }

        let sleep = POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now()));
        if sleep.is_zero() {
            return Err(OpenCodeWaitError::Deadline.into());
        }
        std::thread::sleep(sleep);
    }
}

fn validate_terminal_identity(
    terminal: &OpenCodeInputTerminal,
    session_id: &str,
    request_id: &str,
) -> Result<(), OpenCodeExecutionError> {
    let matches = match terminal {
        OpenCodeInputTerminal::Completed(receipt) => {
            receipt.session_id == session_id
                && receipt.user_message_id.as_deref() == Some(request_id)
        }
        OpenCodeInputTerminal::Failed(receipt) => {
            receipt.session_id == session_id && receipt.user_message_id == request_id
        }
    };
    if matches {
        Ok(())
    } else {
        Err(OpenCodeExecutionError::PromptNotAccepted)
    }
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
    fn launch(
        config: &OpenCodeLocalConfig,
        paths: &HostPaths,
        permit: ConnectionLaunchPermit,
        run_id: &str,
        attempt_id: &str,
        owner_token: &str,
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
        let host = OwnedHost::launch_external(
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
        let home = config.profile_home().unwrap_or(&paths.isolated_home);
        let mut env = BTreeMap::new();
        env.insert("HOME".to_owned(), home.to_string_lossy().into_owned());
        env.insert(
            "USERPROFILE".to_owned(),
            home.to_string_lossy().into_owned(),
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
        Ok(Self {
            host,
            url,
            request_id,
        })
    }

    fn wait_ready(
        &mut self,
        runtime: &Runtime,
        local: &LocalSet,
        config: &OpenCodeLocalConfig,
        authority: &mut NativeTurnAuthority<'_>,
        turn_deadline: Instant,
    ) -> Result<(), OpenCodeExecutionError> {
        let deadline = turn_deadline.min(Instant::now() + Duration::from_secs(30));
        let mut spawned = false;
        while Instant::now() < deadline {
            ensure_not_stopped(authority)?;
            match self.host.receive(Duration::from_millis(100)) {
                Ok(HostEvent::Lifecycle(value)) => {
                    match value.get("type").and_then(Value::as_str) {
                        Some("spawned") => spawned = true,
                        Some("listener-verified")
                            if value.get("port")
                                == Some(&Value::from(
                                    self.url.port_or_known_default().unwrap_or(0),
                                )) =>
                        {
                            spawned = true;
                        }
                        Some("terminal") | Some("error") => {
                            return Err(OpenCodeExecutionError::ServerNotReady);
                        }
                        _ => {}
                    }
                }
                Ok(HostEvent::Stdout(_)) | Ok(HostEvent::Stderr(_)) => {}
                Ok(HostEvent::Failure) => return Err(OpenCodeExecutionError::ServerNotReady),
                Err(HostError::Timeout) => {}
                Err(error) => return Err(OpenCodeExecutionError::Host(error)),
            }
            if !spawned {
                continue;
            }
            let client =
                OpenCodeClient::new(self.url.clone(), config.bearer_token().map(str::to_owned))
                    .map_err(OpenCodeExecutionError::Transport)?;
            let ready = block_on_local(runtime, local, async {
                tokio::time::timeout(Duration::from_millis(250), client.probe())
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .is_some()
            });
            if ready {
                return Ok(());
            }
        }
        Err(OpenCodeExecutionError::ServerNotReady)
    }

    fn url(&self) -> &url::Url {
        &self.url
    }

    fn stop_with_tick(
        &mut self,
        timeout: Duration,
        mut cleanup_tick: impl FnMut(Duration),
    ) -> Result<HostCleanupProof, OpenCodeExecutionError> {
        // Readiness may already have observed the exact terminal receipt.
        // Preserve that opaque proof instead of sending to a closed host.
        if let Some(proof) = self.host.take_cleanup_proof() {
            return Ok(proof);
        }
        self.host.send(Command::Stop {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(self.request_id.clone()),
            grace_ms: Some(timeout.as_millis().clamp(1, u64::MAX as u128) as u64),
        })?;
        let deadline = Instant::now() + timeout + Duration::from_secs(2);
        cleanup_tick(deadline.saturating_duration_since(Instant::now()));
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.host.receive(remaining.min(CLEANUP_RECEIVE_QUANTUM)) {
                Ok(HostEvent::Lifecycle(value))
                    if value.get("type").and_then(Value::as_str) == Some("terminal") =>
                {
                    return self
                        .host
                        .take_cleanup_proof()
                        .ok_or(OpenCodeExecutionError::CleanupUnavailable);
                }
                Ok(HostEvent::Lifecycle(_))
                | Ok(HostEvent::Stdout(_))
                | Ok(HostEvent::Stderr(_)) => {}
                Ok(HostEvent::Failure) => {
                    return Err(OpenCodeExecutionError::CleanupUnavailable);
                }
                Err(HostError::Timeout) => {}
                Err(_) => return Err(OpenCodeExecutionError::CleanupUnavailable),
            }
            cleanup_tick(deadline.saturating_duration_since(Instant::now()));
        }
        // A bounded authority callback may still overrun. Recover a terminal
        // lifecycle already queued while it was blocked before reporting a
        // missing cleanup receipt.
        for _ in 0..MAX_FINAL_HOST_DRAIN_EVENTS {
            match self.host.receive(Duration::ZERO) {
                Ok(HostEvent::Lifecycle(value))
                    if value.get("type").and_then(Value::as_str) == Some("terminal") =>
                {
                    return self
                        .host
                        .take_cleanup_proof()
                        .ok_or(OpenCodeExecutionError::CleanupUnavailable);
                }
                Ok(HostEvent::Lifecycle(_))
                | Ok(HostEvent::Stdout(_))
                | Ok(HostEvent::Stderr(_)) => {}
                Ok(HostEvent::Failure) => {
                    return Err(OpenCodeExecutionError::CleanupUnavailable);
                }
                Err(HostError::Timeout) => break,
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

fn block_on_local<T>(runtime: &Runtime, local: &LocalSet, future: impl Future<Output = T>) -> T {
    runtime.block_on(local.run_until(future))
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

    #[test]
    fn http_diagnostics_classify_status_without_retaining_response_text() {
        for (status, expected) in [
            (400, "opencode_http_bad_request"),
            (401, "opencode_http_access_denied"),
            (403, "opencode_http_access_denied"),
            (500, "opencode_http_response"),
        ] {
            let error = OpenCodeExecutionError::Transport(OpenCodeError::Http {
                status,
                body: "private provider response".into(),
            });
            assert_eq!(error.diagnostic_code(), expected);
        }
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "requires RUDDER_TEST_PROCESS_HOST and a synthetic local child only"]
    fn stop_drains_terminal_after_cleanup_hook_outlives_deadline() {
        use std::{os::unix::fs::PermissionsExt, path::PathBuf, time::Instant};
        use tempfile::tempdir;

        let process_host = std::env::var_os("RUDDER_TEST_PROCESS_HOST")
            .expect("set RUDDER_TEST_PROCESS_HOST to the Rust process-host binary");
        let process_host = PathBuf::from(process_host)
            .canonicalize()
            .expect("canonical process host");
        let root = tempdir().unwrap();
        let runtime_root = root.path().join("runtime");
        let cwd = root.path().join("cwd");
        std::fs::create_dir_all(&runtime_root).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let executable = root.path().join("synthetic-opencode-server");
        std::fs::write(
            &executable,
            b"#!/bin/sh\ntrap '' TERM\nwhile :; do /bin/sleep 1; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();

        let run_id = "slow-opencode-cleanup-run".to_owned();
        let attempt_id = "slow-opencode-cleanup-attempt".to_owned();
        let owner_token = "slow-opencode-cleanup-owner".to_owned();
        let mut host = OwnedHost::launch_external(
            HostConnection {
                request_id: attempt_id.clone(),
                run_id: run_id.clone(),
                attempt_id: attempt_id.clone(),
                owner_token: owner_token.clone(),
            },
            &process_host,
            Some(ConnectionLaunchPermit::from_claim(
                run_id.clone(),
                attempt_id.clone(),
                owner_token.clone(),
                1,
                "slow-opencode-cleanup-claim".into(),
            )),
        )
        .expect("launch owned synthetic host");
        host.send(Command::StartProcess {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(attempt_id.clone()),
            executable: executable.to_string_lossy().into_owned(),
            argv: Vec::new(),
            cwd: cwd.to_string_lossy().into_owned(),
            env: BTreeMap::new(),
            owner_token: Some(owner_token.clone()),
            runtime_root: Some(runtime_root.to_string_lossy().into_owned()),
            stdin: None,
            interactive_stdin: false,
            grace_ms: Some(500),
        })
        .expect("start synthetic child");
        loop {
            match host
                .receive(Duration::from_secs(5))
                .expect("host lifecycle")
            {
                HostEvent::Lifecycle(value)
                    if value.get("type").and_then(Value::as_str) == Some("spawned") =>
                {
                    break;
                }
                HostEvent::Failure => panic!("owned host failed before spawn"),
                HostEvent::Lifecycle(_) | HostEvent::Stdout(_) | HostEvent::Stderr(_) => {}
            }
        }
        let mut server = OpenCodeServerHost {
            host,
            url: url::Url::parse("http://127.0.0.1:1/").unwrap(),
            request_id: attempt_id.clone(),
        };

        let started = Instant::now();
        let mut hook_called = false;
        let cleanup = server.stop_with_tick(Duration::from_millis(100), |remaining| {
            assert!(!remaining.is_zero());
            if !hook_called {
                hook_called = true;
                // The host kills the TERM-ignoring child during this blocked
                // authority callback; the final zero-time drain must retain
                // its exact matching cleanup receipt.
                std::thread::sleep(Duration::from_millis(2_300));
            }
        });
        assert!(hook_called);
        assert!(started.elapsed() >= Duration::from_millis(2_300));
        let proof = cleanup.expect("final drain sees terminal queued during hook");
        assert!(proof.matches_execution(&run_id, &attempt_id, &owner_token));
    }
}
