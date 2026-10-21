//! Cursor ACP execution boundary.
//!
//! This adapter owns ACP process/session I/O and returns provider-native
//! session evidence. D1 claims, checkpoint persistence, and terminal billing
//! stay in the shared worker.

use crate::HostPaths;
use rudder_cursor_acp_adapter::{
    AuthenticateParams, CursorAcpCommand, CursorAcpHome, CursorAcpMessage, CursorAcpProcessLaunch,
    CursorAcpSession, CursorAcpTransport, CursorAcpTransportError, InitializeParams, SessionId,
    SessionLoadParams, SessionNewParams, SessionPromptParams,
};
use rudder_d1_persistence::native_chat::config::{CursorLocalConfig, ResolvedCodexConfig};
use rudder_native_process_transport::{ConnectionLaunchPermit, HostCleanupProof};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
use thiserror::Error;

const MAX_TURN_TIMEOUT: Duration = Duration::from_secs(3600);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);
const PROCESS_GRACE: Duration = Duration::from_millis(500);
const CLEANUP_RECEIPT_ALLOWANCE: Duration = Duration::from_secs(2);

#[derive(Debug, Error)]
pub enum CursorExecutionError {
    #[error("Cursor ACP native configuration is invalid")]
    InvalidConfiguration,
    #[error(transparent)]
    Transport(#[from] CursorAcpTransportError),
    #[error("Cursor ACP returned an invalid session identity")]
    InvalidSession,
    #[error("Cursor ACP requested an interactive control decision")]
    ControlRequest,
    #[error("Cursor ACP turn response did not arrive before the deadline")]
    Timeout,
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
    pub update_count: u64,
    pub cleanup: Option<HostCleanupProof>,
}

#[allow(clippy::too_many_arguments)]
pub fn execute_turn(
    config: &ResolvedCodexConfig,
    local: &CursorLocalConfig,
    paths: &HostPaths,
    permit: ConnectionLaunchPermit,
    run_id: &str,
    attempt_id: &str,
    owner_token: &str,
    existing_session: Option<&str>,
    input: &str,
    timeout: Duration,
) -> Result<CursorExecutionObservation, CursorExecutionError> {
    if config.identity.runtime_type != "cursor" && config.identity.runtime_type != "cursor_local"
        || input.trim().is_empty()
        || timeout.is_zero()
        || timeout > MAX_TURN_TIMEOUT
        || !config.cwd.is_dir()
        || !local.home.is_dir()
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
        return Err(CursorExecutionError::InvalidConfiguration);
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
            return Err(CursorExecutionError::InvalidConfiguration);
        }
        env.insert(key.clone(), value.clone());
    }
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
            run_id: run_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            owner_token: owner_token.to_owned(),
            env,
        },
        permit,
    )?;
    let deadline = Instant::now() + timeout;
    let result = run_turn(
        &mut transport,
        config,
        local,
        existing_session,
        input,
        deadline,
    );
    let process_grace = local
        .grace_sec
        .map(Duration::from_secs)
        .unwrap_or(PROCESS_GRACE);
    let cleanup_wait = if local.grace_sec.is_some() {
        process_grace + CLEANUP_RECEIPT_ALLOWANCE
    } else {
        CLEANUP_TIMEOUT
    };
    let cleanup = transport
        .stop_with_grace(process_grace, cleanup_wait)
        .ok()
        .and_then(|_| transport.take_cleanup_proof());
    let (session, request_id, final_text, response, update_count) = result?;
    Ok(CursorExecutionObservation {
        session,
        request_id,
        final_text,
        response,
        update_count,
        cleanup,
    })
}

fn run_turn(
    transport: &mut CursorAcpTransport,
    config: &ResolvedCodexConfig,
    local: &CursorLocalConfig,
    existing_session: Option<&str>,
    input: &str,
    deadline: Instant,
) -> Result<(SessionId, String, Option<String>, Value, u64), CursorExecutionError> {
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

    let session_command = if let Some(value) = existing_session {
        let session = SessionId::new(value).map_err(|_| CursorExecutionError::InvalidSession)?;
        CursorAcpCommand::SessionLoad {
            params: {
                let mut params = SessionLoadParams::new(session, path_string(&config.cwd)?)
                    .map_err(|_| CursorExecutionError::InvalidConfiguration)?;
                params.mode = local.mode.clone();
                params
            },
        }
    } else {
        CursorAcpCommand::SessionNew {
            params: {
                let mut params = SessionNewParams::new(path_string(&config.cwd)?)
                    .map_err(|_| CursorExecutionError::InvalidConfiguration)?;
                params.mode = local.mode.clone();
                params
            },
        }
    };
    let session_response = request_and_wait(
        transport,
        session_command,
        remaining(deadline, Duration::from_secs(10)),
    )?;
    let session = session_from_response(&session_response)?;
    let prompt = CursorAcpCommand::SessionPrompt {
        params: SessionPromptParams::new(session.clone(), input)
            .map_err(|_| CursorExecutionError::InvalidConfiguration)?,
    };
    let response = request_and_wait(
        transport,
        prompt,
        remaining(deadline, Duration::from_secs(60)),
    )?;
    let request_id = response.id.as_string();
    let (updates, final_text) = drain_updates(transport, &session)?;
    Ok((
        session,
        request_id,
        final_text,
        response.result.unwrap_or(Value::Null),
        updates,
    ))
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

fn drain_updates(
    transport: &mut CursorAcpTransport,
    session: &SessionId,
) -> Result<(u64, Option<String>), CursorExecutionError> {
    let mut reducer = CursorAcpSession::new();
    reducer
        .observe_session_load(session.clone())
        .map_err(|_| CursorExecutionError::InvalidSession)?;
    let mut count: u64 = 0;
    let mut final_text = String::new();
    loop {
        match transport.receive(Duration::ZERO) {
            Ok(CursorAcpMessage::Notification(
                rudder_cursor_acp_adapter::CursorAcpNotification::SessionUpdate(update),
            )) => {
                reducer
                    .observe_update(&update)
                    .map_err(|_| CursorExecutionError::InvalidSession)?;
                count = count.saturating_add(1);
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
                    if final_text.len().saturating_add(text.len()) > 256 * 1024 {
                        return Err(CursorExecutionError::InvalidSession);
                    }
                    final_text.push_str(text);
                }
            }
            Ok(CursorAcpMessage::Request(_)) => return Err(CursorExecutionError::ControlRequest),
            Ok(CursorAcpMessage::Notification(_)) => {}
            Ok(CursorAcpMessage::Response(_)) => return Err(CursorExecutionError::InvalidSession),
            Err(CursorAcpTransportError::Timeout) => break,
            Err(CursorAcpTransportError::Closed) => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok((count, (!final_text.is_empty()).then_some(final_text)))
}

fn path_string(path: &std::path::Path) -> Result<String, CursorExecutionError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or(CursorExecutionError::InvalidConfiguration)
}

fn remaining(deadline: Instant, cap: Duration) -> Duration {
    deadline.saturating_duration_since(Instant::now()).min(cap)
}
