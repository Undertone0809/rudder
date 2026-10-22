//! Cursor ACP execution boundary.
//!
//! This adapter owns ACP process/session I/O and returns provider-native
//! session evidence. D1 claims, checkpoint persistence, and terminal billing
//! stay in the shared worker.

use crate::{
    HostExecutionFailure, HostPaths,
    native_turn::{NativeTurnAuthority, cleanup_tick_budget_is_safe},
};
use rudder_cursor_acp_adapter::{
    AuthenticateParams, CursorAcpCommand, CursorAcpHome, CursorAcpMessage, CursorAcpProcessLaunch,
    CursorAcpSession, CursorAcpTransport, CursorAcpTransportError, CursorManagedInstructionRule,
    InitializeParams, RequestId, SessionId, SessionLoadParams, SessionNewParams,
    SessionPromptParams, SessionSetModeParams,
};
use rudder_d1_persistence::native_chat::{
    config::{CursorLocalConfig, ResolvedCodexConfig},
    execution::{NativeInterruptTarget, StopIntent},
};
use rudder_native_process_transport::{
    ConnectionLaunchPermit, ConnectionReceipt, HostCleanupProof,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use thiserror::Error;

const MAX_TURN_TIMEOUT: Duration = Duration::from_secs(3600);
const MAX_LOAD_UPDATES: u64 = 8192;
const MAX_LOAD_UPDATE_BYTES: usize = 8 * 1024 * 1024;
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);
const PROCESS_GRACE: Duration = Duration::from_millis(500);
const CLEANUP_RECEIPT_ALLOWANCE: Duration = Duration::from_secs(2);
const CLEANUP_TICK_INTERVAL: Duration = Duration::from_secs(4);
const CLEANUP_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const CLEANUP_RECEIVE_QUANTUM: Duration = Duration::from_millis(200);

#[derive(Debug, Error)]
pub enum CursorExecutionError {
    #[error("Cursor ACP native configuration is invalid")]
    InvalidConfiguration,
    #[error(transparent)]
    Transport(#[from] CursorAcpTransportError),
    #[error("Cursor ACP durable execution fence rejected dispatch")]
    Persistence(#[from] rudder_d1_persistence::runtime_bindings::Error),
    #[error("Cursor ACP returned an invalid session identity")]
    InvalidSession,
    #[error("Cursor ACP requested an interactive control decision")]
    ControlRequest,
    #[error("Cursor ACP turn response did not arrive before the deadline")]
    Timeout,
    #[error("Cursor ACP process cleanup proof was not observed")]
    CleanupUnavailable,
}

impl CursorExecutionError {
    pub(crate) fn diagnostic_code(&self) -> &'static str {
        match self {
            Self::InvalidConfiguration => "cursor_invalid_configuration",
            Self::InvalidSession => "cursor_invalid_session",
            Self::ControlRequest => "cursor_control_request",
            Self::Timeout | Self::Transport(CursorAcpTransportError::Timeout) => "cursor_timeout",
            Self::CleanupUnavailable => "cursor_cleanup_unavailable",
            Self::Transport(CursorAcpTransportError::InstructionRuleUnavailable) => {
                "cursor_instruction_rule_unavailable"
            }
            Self::Transport(CursorAcpTransportError::InvalidLaunch) => "cursor_invalid_launch",
            Self::Transport(CursorAcpTransportError::Closed) => "cursor_closed",
            Self::Transport(CursorAcpTransportError::Rejected) => "cursor_rejected",
            Self::Transport(CursorAcpTransportError::InvalidMessage) => "cursor_invalid_message",
            Self::Transport(CursorAcpTransportError::MismatchedResponse) => {
                "cursor_mismatched_response"
            }
            Self::Transport(CursorAcpTransportError::OutputOverflow) => "cursor_output_overflow",
            Self::Transport(CursorAcpTransportError::WriteIndeterminate) => {
                "cursor_write_indeterminate"
            }
            Self::Transport(CursorAcpTransportError::ProcessExited) => "cursor_process_exited",
            Self::Transport(CursorAcpTransportError::Busy) => "cursor_busy",
            Self::Persistence(_) => "cursor_persistence_conflict",
        }
    }
}

/// Provider-native ACP observation. The response and session ID are kept
/// opaque to the shared Codex finalizer.
pub struct CursorExecutionObservation {
    pub session: SessionId,
    /// The ACP request id for the terminal `session/prompt` response. It is a
    /// provider-native correlation key and must not be projected as a Codex
    /// turn id.
    pub request_id: String,
    /// Concatenated bounded `agent_message_chunk` text observed during the
    /// prompt. ACP may return the answer in notifications instead of the JSON
    /// RPC result, so retaining this provider-native text is part of the typed
    /// terminal receipt.
    pub final_text: Option<String>,
    pub response: Value,
    pub stop_reason: String,
    pub update_count: u64,
    pub connection: ConnectionReceipt,
    pub cleanup: HostCleanupProof,
    pub stop: Option<StopIntent>,
}

/// Session/load replays belong to history, never to the next prompt. Consume
/// them under the selected session and a separate budget without retaining text.
struct CursorLoadUpdates {
    session: CursorAcpSession,
    bytes: usize,
}

impl CursorLoadUpdates {
    fn new(session_id: SessionId) -> Result<Self, CursorExecutionError> {
        let mut session = CursorAcpSession::new();
        session
            .observe_session_load(session_id)
            .map_err(|_| CursorExecutionError::InvalidSession)?;
        Ok(Self { session, bytes: 0 })
    }

    fn observe(&mut self, message: &CursorAcpMessage) -> Result<bool, CursorAcpTransportError> {
        let CursorAcpMessage::Notification(
            rudder_cursor_acp_adapter::CursorAcpNotification::SessionUpdate(update),
        ) = message
        else {
            // Preserve responses and interactive requests for normal correlation;
            // loading history grants no permission or execution decision.
            return Ok(false);
        };
        let count = self
            .session
            .observe_update(update)
            .map_err(|_| CursorAcpTransportError::InvalidMessage)?;
        let bytes = serde_json::to_vec(&update.raw)
            .map_err(|_| CursorAcpTransportError::InvalidMessage)?
            .len();
        self.bytes = self.bytes.saturating_add(bytes);
        if count > MAX_LOAD_UPDATES || self.bytes > MAX_LOAD_UPDATE_BYTES {
            return Err(CursorAcpTransportError::InvalidMessage);
        }
        Ok(true)
    }
}

/// Bounded state retained while a single Cursor prompt is pending. ACP update
/// notifications are reduced as they arrive so transport buffering cannot
/// grow with the provider's stream length.
struct CursorPromptUpdates {
    session: CursorAcpSession,
    count: u64,
    final_text: String,
}

impl CursorPromptUpdates {
    fn new(session_id: SessionId) -> Result<Self, CursorExecutionError> {
        let mut session = CursorAcpSession::new();
        session
            .observe_session_load(session_id)
            .map_err(|_| CursorExecutionError::InvalidSession)?;
        Ok(Self {
            session,
            count: 0,
            final_text: String::new(),
        })
    }

    fn observe(&mut self, message: &CursorAcpMessage) -> Result<bool, CursorAcpTransportError> {
        let CursorAcpMessage::Notification(notification) = message else {
            return Ok(false);
        };
        let rudder_cursor_acp_adapter::CursorAcpNotification::SessionUpdate(update) = notification
        else {
            // The pre-reducer drain ignored non-session notifications. Consume
            // them here as well instead of retaining an unbounded event log.
            return Ok(true);
        };
        self.count = self
            .session
            .observe_update(update)
            .map_err(|_| CursorAcpTransportError::InvalidMessage)?;
        if matches!(
            update.kind,
            rudder_cursor_acp_adapter::SessionUpdateKind::AgentMessageChunk
        ) && let Some(text) = update
            .raw
            .get("content")
            .and_then(|content| content.get("text"))
            .and_then(Value::as_str)
            .or_else(|| update.raw.get("text").and_then(Value::as_str))
            .or_else(|| update.raw.get("delta").and_then(Value::as_str))
        {
            if self.final_text.len().saturating_add(text.len()) > 256 * 1024 {
                return Err(CursorAcpTransportError::InvalidMessage);
            }
            self.final_text.push_str(text);
        }
        Ok(true)
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn execute_turn(
    config: &ResolvedCodexConfig,
    local: &CursorLocalConfig,
    paths: &HostPaths,
    permit: ConnectionLaunchPermit,
    run_id: &str,
    attempt_id: &str,
    owner_token: &str,
    authority: &mut NativeTurnAuthority<'_>,
    timeout: Duration,
) -> Result<CursorExecutionObservation, HostExecutionFailure<CursorExecutionError>> {
    if config.identity.runtime_type != "cursor" && config.identity.runtime_type != "cursor_local"
        || timeout.is_zero()
        || timeout > MAX_TURN_TIMEOUT
        || !config.cwd.is_dir()
        || !local.home.is_dir()
        || local.instruction_agent_id != config.identity.agent_id
        || local.instruction_revision != config.identity.instructions_revision
        || !local.profile_revision_matches()
        || !paths.process_host.is_file()
        || !paths.runtime_root.is_dir()
        || !paths.isolated_home.is_dir()
        || local.timeout_sec.is_some_and(|seconds| seconds > 3600)
        || local
            .grace_sec
            .is_some_and(|seconds| !(1..=60).contains(&seconds))
        || run_id.is_empty()
        || attempt_id.is_empty()
        || owner_token.is_empty()
    {
        return Err(CursorExecutionError::InvalidConfiguration.into());
    }
    let timeout = local
        .timeout_sec
        .filter(|seconds| *seconds > 0)
        .map(Duration::from_secs)
        .map_or(timeout, |configured| timeout.min(configured));
    let mut env = BTreeMap::new();
    for (key, value) in &local.env {
        if matches!(key.as_str(), "HOME" | "USERPROFILE")
            || key.is_empty()
            || key.contains('=')
            || key.contains('\0')
            || value.contains('\0')
        {
            return Err(CursorExecutionError::InvalidConfiguration.into());
        }
        env.insert(key.clone(), value.clone());
    }
    env.insert("PATH".into(), local.executable_search_path.clone());
    let instruction_rule = if local.managed_instruction_workspace {
        Some(CursorManagedInstructionRule {
            agent_id: local.instruction_agent_id.clone(),
            revision: local.instruction_revision.clone(),
            content: config.instruction_content.clone(),
        })
    } else {
        if config
            .instruction_content
            .as_ref()
            .is_some_and(|content| !content.is_empty())
        {
            return Err(CursorExecutionError::InvalidConfiguration.into());
        }
        None
    };
    let mut transport = CursorAcpTransport::launch(
        CursorAcpProcessLaunch {
            executable: config.executable.clone(),
            process_host: paths.process_host.clone(),
            runtime_root: paths.runtime_root.clone(),
            model: local.cli_model.clone(),
            home: if local.profile_id == "operator-default" {
                CursorAcpHome::OperatorProfile(local.home.clone())
            } else {
                // Preserve the existing isolated Cursor process home for
                // managed profiles. Only explicit operator-default opts into
                // provider-owned state in place.
                CursorAcpHome::IsolatedRuntime(paths.isolated_home.clone())
            },
            cwd: config.cwd.clone(),
            instruction_rule,
            run_id: run_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            owner_token: owner_token.to_owned(),
            env,
        },
        permit,
    )
    .map_err(CursorExecutionError::from)?;
    let connection = transport.connection_receipt();
    let deadline = Instant::now() + timeout;
    let result = (|| {
        authority
            .register_connection(connection)
            .map_err(CursorExecutionError::from)?;
        ensure_not_stopped(authority)?;
        run_turn(&mut transport, config, local, authority, deadline)
    })();
    let process_grace = local
        .grace_sec
        .map(Duration::from_secs)
        .unwrap_or(PROCESS_GRACE);
    let cleanup_wait = if local.grace_sec.is_some() {
        process_grace + CLEANUP_RECEIPT_ALLOWANCE
    } else {
        CLEANUP_TIMEOUT
    };
    let mut next_cleanup_tick = Instant::now();
    let cleanup_result = transport
        .stop_with_grace_hook(process_grace, cleanup_wait, |remaining| {
            let now = Instant::now();
            if now >= next_cleanup_tick {
                // Reserve the maximum D1 operation time and one host receive
                // quantum for terminal lifecycle collection. The transport
                // performs a final nonblocking drain if a tick nevertheless
                // overruns its bound.
                if cleanup_tick_budget_is_safe(remaining, CLEANUP_RECEIVE_QUANTUM) {
                    let _ = authority.cleanup_tick(now + CLEANUP_OPERATION_TIMEOUT);
                }
                next_cleanup_tick = Instant::now() + CLEANUP_TICK_INTERVAL;
            }
        })
        .ok();
    let cleanup = cleanup_result.and_then(|_| transport.take_cleanup_proof());
    // Capture a Stop that raced the last host lifecycle event. This bounded
    // cleanup-authority probe uses a fresh DB deadline; its failure must not
    // discard an already-proven provider terminal or host cleanup receipt.
    let _ = authority.cleanup_tick(Instant::now() + CLEANUP_OPERATION_TIMEOUT);
    match result {
        Ok((session, request_id, final_text, response, stop_reason, update_count)) => {
            let Some(cleanup) = cleanup else {
                return Err(HostExecutionFailure {
                    error: CursorExecutionError::CleanupUnavailable,
                    cleanup: None,
                });
            };
            let connection = match authority.take_connection() {
                Ok(connection) => connection,
                Err(error) => {
                    return Err(HostExecutionFailure {
                        error: CursorExecutionError::from(error),
                        cleanup: Some(Box::new(cleanup)),
                    });
                }
            };
            Ok(CursorExecutionObservation {
                session,
                request_id,
                final_text,
                response,
                stop_reason,
                update_count,
                connection,
                cleanup,
                stop: authority.stop().cloned(),
            })
        }
        Err(error) => Err(HostExecutionFailure {
            error,
            cleanup: cleanup.map(Box::new),
        }),
    }
}

type CursorTurnObservation = (SessionId, String, Option<String>, Value, String, u64);

fn run_turn(
    transport: &mut CursorAcpTransport,
    config: &ResolvedCodexConfig,
    local: &CursorLocalConfig,
    authority: &mut NativeTurnAuthority<'_>,
    deadline: Instant,
) -> Result<CursorTurnObservation, CursorExecutionError> {
    transport.wait_spawned(remaining(deadline, Duration::from_secs(10)))?;
    request_and_wait(
        transport,
        CursorAcpCommand::Initialize {
            params: InitializeParams::new(
                "rudder-native-chat",
                Some(env!("CARGO_PKG_VERSION").into()),
            )
            .map_err(|_| CursorExecutionError::InvalidConfiguration)?,
        },
        remaining(deadline, Duration::from_secs(10)),
    )?;
    request_and_wait(
        transport,
        CursorAcpCommand::Authenticate {
            params: AuthenticateParams::cursor_login(),
        },
        remaining(deadline, Duration::from_secs(10)),
    )?;

    let session = if let Some(value) = authority.existing_session() {
        let expected = SessionId::new(value).map_err(|_| CursorExecutionError::InvalidSession)?;
        let params = SessionLoadParams::new(expected.clone(), path_string(&config.cwd)?)
            .map_err(|_| CursorExecutionError::InvalidConfiguration)?;
        let load_response = load_session_and_wait(
            transport,
            params,
            remaining(deadline, Duration::from_secs(10)),
        )?;
        // The installed Cursor ACP session/load result legitimately omits
        // sessionId. In that case retain the exact session selected by D1;
        // if the provider does return one, it must match exactly.
        let loaded = session_from_load_response(&load_response, &expected)?;
        if let Some(mode) = local.mode.as_deref() {
            request_and_wait(
                transport,
                CursorAcpCommand::SessionSetMode {
                    params: SessionSetModeParams::new(loaded.clone(), mode)
                        .map_err(|_| CursorExecutionError::InvalidConfiguration)?,
                },
                remaining(deadline, Duration::from_secs(10)),
            )?;
        }
        loaded
    } else {
        let mut params = SessionNewParams::new(path_string(&config.cwd)?)
            .map_err(|_| CursorExecutionError::InvalidConfiguration)?;
        params.mode = local.mode.clone();
        let response = authority.start_session(|| {
            request_and_wait(
                transport,
                CursorAcpCommand::SessionNew { params },
                remaining(deadline, Duration::from_secs(10)),
            )
        })??;
        session_from_response(&response)?
    };
    authority.record_session(session.as_str())?;
    let mut prompt_updates = CursorPromptUpdates::new(session.clone())?;
    let reserved = transport.reserve_request()?;
    let request_id = reserved.as_string();
    let sent = authority.submit(&request_id, |input| {
        let prompt = CursorAcpCommand::SessionPrompt {
            params: SessionPromptParams::new(session.clone(), input)
                .map_err(|_| CursorExecutionError::InvalidConfiguration)?,
        };
        let mut observe = |message: &CursorAcpMessage| prompt_updates.observe(message);
        transport
            .request_reserved_with_observer(prompt, &mut observe)
            .map_err(CursorExecutionError::from)
    })??;
    if sent != reserved {
        return Err(CursorExecutionError::InvalidSession);
    }
    let response = wait_prompt_response(
        transport,
        authority,
        &session,
        &reserved,
        &mut prompt_updates,
        deadline,
    )?;
    if response.error.is_some() {
        return Err(CursorExecutionError::Transport(
            CursorAcpTransportError::Rejected,
        ));
    }
    let stop_reason = prompt_stop_reason(&response)?;
    let (updates, final_text) = drain_updates(transport, &mut prompt_updates)?;
    authority.terminal(session.as_str(), &request_id)?;
    Ok((
        session,
        request_id,
        final_text,
        response.result.unwrap_or(Value::Null),
        stop_reason,
        updates,
    ))
}

fn wait_prompt_response(
    transport: &mut CursorAcpTransport,
    authority: &mut NativeTurnAuthority<'_>,
    session: &SessionId,
    request_id: &RequestId,
    prompt_updates: &mut CursorPromptUpdates,
    deadline: Instant,
) -> Result<rudder_cursor_acp_adapter::JsonRpcResponse, CursorExecutionError> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(CursorExecutionError::Timeout);
        }
        let slice = remaining.min(Duration::from_millis(100));
        let mut observe = |message: &CursorAcpMessage| prompt_updates.observe(message);
        match transport.wait_response_with(request_id, slice, &mut observe) {
            Ok(response) => return Ok(response),
            Err(CursorAcpTransportError::Timeout) => {}
            Err(error) => return Err(error.into()),
        }
        let Some(permit) = authority.poll_stop()? else {
            continue;
        };
        let connection = authority
            .connection()
            .ok_or(CursorExecutionError::InvalidSession)?;
        let target = NativeInterruptTarget::Cursor {
            session_id: session.as_str().to_owned(),
            request_id: request_id.as_string(),
        };
        permit.dispatch(connection, &target, || {
            let mut observe = |message: &CursorAcpMessage| prompt_updates.observe(message);
            transport.cancel_prompt_with_observer(session.clone(), request_id, &mut observe)
        })??;
        // ACP cancellation is a notification only. Keep waiting on the one
        // original prompt request and accept only its typed stopReason.
    }
}

fn load_session_and_wait(
    transport: &mut CursorAcpTransport,
    params: SessionLoadParams,
    timeout: Duration,
) -> Result<rudder_cursor_acp_adapter::JsonRpcResponse, CursorExecutionError> {
    let mut history = CursorLoadUpdates::new(params.session_id.clone())?;
    let mut observe = |message: &CursorAcpMessage| history.observe(message);
    transport.reserve_request()?;
    let id = transport
        .request_reserved_with_observer(CursorAcpCommand::SessionLoad { params }, &mut observe)?;
    // Observe replay even when it arrives before the owned stdin-write ACK.
    // The response is the load-history boundary; the prompt reducer is created
    // only afterward, so historical chunks cannot become its final answer.
    Ok(transport.wait_response_with(&id, timeout, &mut observe)?)
}

fn request_and_wait(
    transport: &mut CursorAcpTransport,
    command: CursorAcpCommand,
    timeout: Duration,
) -> Result<rudder_cursor_acp_adapter::JsonRpcResponse, CursorExecutionError> {
    let id = transport.request(command)?;
    let response = transport.wait_response(&id, timeout)?;
    if response.error.is_some() {
        return Err(CursorExecutionError::Transport(
            CursorAcpTransportError::Rejected,
        ));
    }
    Ok(response)
}

fn session_from_response(
    response: &rudder_cursor_acp_adapter::JsonRpcResponse,
) -> Result<SessionId, CursorExecutionError> {
    let result = response
        .result
        .as_ref()
        .ok_or(CursorExecutionError::InvalidSession)?;
    let value = result
        .get("sessionId")
        .or_else(|| result.get("session_id"))
        .and_then(Value::as_str)
        .ok_or(CursorExecutionError::InvalidSession)?;
    SessionId::new(value).map_err(|_| CursorExecutionError::InvalidSession)
}

fn session_from_load_response(
    response: &rudder_cursor_acp_adapter::JsonRpcResponse,
    expected: &SessionId,
) -> Result<SessionId, CursorExecutionError> {
    let result = response
        .result
        .as_ref()
        .and_then(Value::as_object)
        .ok_or(CursorExecutionError::InvalidSession)?;
    let returned = result.get("sessionId").or_else(|| result.get("session_id"));
    match returned {
        None => Ok(expected.clone()),
        Some(Value::String(value)) => {
            let returned =
                SessionId::new(value.clone()).map_err(|_| CursorExecutionError::InvalidSession)?;
            if &returned == expected {
                Ok(returned)
            } else {
                Err(CursorExecutionError::InvalidSession)
            }
        }
        Some(_) => Err(CursorExecutionError::InvalidSession),
    }
}

fn prompt_stop_reason(
    response: &rudder_cursor_acp_adapter::JsonRpcResponse,
) -> Result<String, CursorExecutionError> {
    response
        .result
        .as_ref()
        .and_then(|result| result.get("stopReason"))
        .and_then(Value::as_str)
        .filter(|reason| {
            matches!(
                *reason,
                "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
            )
        })
        .map(str::to_owned)
        .ok_or(CursorExecutionError::Transport(
            CursorAcpTransportError::InvalidMessage,
        ))
}

fn drain_updates(
    transport: &mut CursorAcpTransport,
    prompt_updates: &mut CursorPromptUpdates,
) -> Result<(u64, Option<String>), CursorExecutionError> {
    loop {
        match transport.receive(Duration::ZERO) {
            Ok(message) => {
                if prompt_updates.observe(&message)? {
                    continue;
                }
                match message {
                    CursorAcpMessage::Request(_) => {
                        return Err(CursorExecutionError::ControlRequest);
                    }
                    CursorAcpMessage::Response(_) => {
                        return Err(CursorExecutionError::InvalidSession);
                    }
                    CursorAcpMessage::Notification(_) => {
                        unreachable!("the prompt reducer consumes all provider notifications")
                    }
                }
            }
            Err(CursorAcpTransportError::Timeout) => break,
            Err(CursorAcpTransportError::Closed) => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok((
        prompt_updates.count,
        (!prompt_updates.final_text.is_empty())
            .then(|| std::mem::take(&mut prompt_updates.final_text)),
    ))
}

fn path_string(path: &std::path::Path) -> Result<String, CursorExecutionError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or(CursorExecutionError::InvalidConfiguration)
}

fn ensure_not_stopped(authority: &mut NativeTurnAuthority<'_>) -> Result<(), CursorExecutionError> {
    let _ = authority.poll_stop()?;
    if authority.stop().is_some() {
        return Err(CursorExecutionError::Persistence(
            rudder_d1_persistence::runtime_bindings::Error::Http(
                409,
                "Native Cursor execution is stopping".into(),
            ),
        ));
    }
    Ok(())
}

fn remaining(deadline: Instant, cap: Duration) -> Duration {
    deadline.saturating_duration_since(Instant::now()).min(cap)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_prompt_requires_one_known_terminal_stop_reason() {
        for reason in [
            "end_turn",
            "max_tokens",
            "max_turn_requests",
            "refusal",
            "cancelled",
        ] {
            let response: rudder_cursor_acp_adapter::JsonRpcResponse =
                serde_json::from_value(serde_json::json!({
                    "jsonrpc":"2.0",
                    "id":1,
                    "result":{"stopReason":reason}
                }))
                .expect("typed ACP response");
            assert_eq!(prompt_stop_reason(&response).unwrap(), reason);
        }

        for value in [
            serde_json::json!({"jsonrpc":"2.0","id":1,"result":{}}),
            serde_json::json!({"jsonrpc":"2.0","id":1,"result":{"stopReason":"other"}}),
            serde_json::json!({"jsonrpc":"2.0","id":1,"result":{"stopReason":"future"}}),
        ] {
            let response: rudder_cursor_acp_adapter::JsonRpcResponse =
                serde_json::from_value(value).expect("typed ACP response");
            assert!(matches!(
                prompt_stop_reason(&response),
                Err(CursorExecutionError::Transport(
                    CursorAcpTransportError::InvalidMessage
                ))
            ));
        }
    }

    #[test]
    fn cursor_load_uses_the_selected_session_when_response_omits_it() {
        let expected = SessionId::new("cursor-session-1").unwrap();
        for result in [
            serde_json::json!({"modes":{"available":[]}}),
            serde_json::json!({"sessionId":"cursor-session-1"}),
        ] {
            let response: rudder_cursor_acp_adapter::JsonRpcResponse =
                serde_json::from_value(serde_json::json!({
                    "jsonrpc":"2.0",
                    "id":1,
                    "result":result
                }))
                .expect("typed session/load response");
            assert_eq!(
                session_from_load_response(&response, &expected).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn fresh_cursor_session_still_requires_the_provider_session_id() {
        let response: rudder_cursor_acp_adapter::JsonRpcResponse =
            serde_json::from_value(serde_json::json!({
                "jsonrpc":"2.0",
                "id":1,
                "result":{"modes":{"available":[]}}
            }))
            .expect("typed session/new response");
        assert!(matches!(
            session_from_response(&response),
            Err(CursorExecutionError::InvalidSession)
        ));
    }

    #[test]
    fn cursor_load_rejects_a_provider_session_different_from_the_selected_session() {
        let expected = SessionId::new("cursor-session-1").unwrap();
        for value in [
            serde_json::json!({
                "jsonrpc":"2.0",
                "id":1,
                "result":{"sessionId":"other-session"}
            }),
            serde_json::json!({
                "jsonrpc":"2.0",
                "id":1,
                "result":{"sessionId":null}
            }),
        ] {
            let response: rudder_cursor_acp_adapter::JsonRpcResponse =
                serde_json::from_value(value).expect("typed session/load response");
            assert!(matches!(
                session_from_load_response(&response, &expected),
                Err(CursorExecutionError::InvalidSession)
            ));
        }
    }

    #[test]
    fn cursor_load_requires_an_object_result_before_another_input() {
        let expected = SessionId::new("cursor-session-1").unwrap();
        for result in [
            serde_json::json!(null),
            serde_json::json!([]),
            serde_json::json!("unexpected"),
            serde_json::json!(false),
            serde_json::json!(42),
        ] {
            let response: rudder_cursor_acp_adapter::JsonRpcResponse =
                serde_json::from_value(serde_json::json!({
                    "jsonrpc":"2.0", "id":1, "result":result
                }))
                .expect("typed malformed load response");
            assert!(matches!(
                session_from_load_response(&response, &expected),
                Err(CursorExecutionError::InvalidSession)
            ));
        }
    }

    fn load_update(session: &str, text: &str) -> CursorAcpMessage {
        rudder_cursor_acp_adapter::parse_message(
            &serde_json::to_vec(&serde_json::json!({
                "jsonrpc":"2.0", "method":"session/update",
                "params":{"sessionId":session,"update":{
                    "sessionUpdate":"agent_message_chunk",
                    "content":{"type":"text","text":text}
                }}
            }))
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn load_history_is_consumed_without_retaining_text_or_other_session_updates() {
        let mut history =
            CursorLoadUpdates::new(SessionId::new("selected-session").unwrap()).unwrap();
        assert_eq!(
            history.observe(&load_update("selected-session", "old answer 雪🧭")),
            Ok(true)
        );
        assert_eq!(
            history.observe(&load_update("other-session", "wrong history")),
            Err(CursorAcpTransportError::InvalidMessage)
        );
        let response =
            rudder_cursor_acp_adapter::parse_message(br#"{"jsonrpc":"2.0","id":1,"result":{}}"#)
                .unwrap();
        assert_eq!(history.observe(&response), Ok(false));
    }

    #[test]
    fn load_history_has_separate_count_and_byte_budgets() {
        let update = load_update("selected-session", "old");
        let mut history =
            CursorLoadUpdates::new(SessionId::new("selected-session").unwrap()).unwrap();
        for _ in 0..MAX_LOAD_UPDATES {
            assert_eq!(history.observe(&update), Ok(true));
        }
        assert_eq!(
            history.observe(&update),
            Err(CursorAcpTransportError::InvalidMessage)
        );
        let update = load_update("selected-session", &"x".repeat(128 * 1024));
        let mut history =
            CursorLoadUpdates::new(SessionId::new("selected-session").unwrap()).unwrap();
        for _ in 0..64 {
            if history.observe(&update).is_err() {
                assert!(history.bytes > MAX_LOAD_UPDATE_BYTES);
                return;
            }
        }
        panic!("replay byte bound must reject before 64 large chunks");
    }

    #[test]
    fn prompt_update_reducer_rejects_notifications_for_another_session() {
        let mut updates =
            CursorPromptUpdates::new(SessionId::new("selected-session").unwrap()).unwrap();
        let message = rudder_cursor_acp_adapter::parse_message(
            br#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"other-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}}}"#,
        )
        .expect("well-formed update for a different session");
        assert_eq!(
            updates.observe(&message),
            Err(CursorAcpTransportError::InvalidMessage)
        );
    }
}
