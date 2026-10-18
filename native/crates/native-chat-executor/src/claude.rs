//! Claude Code execution boundary.
//!
//! This module owns only one Claude Code process and the stream-json turn
//! receipt.  Durable admission, provider checkpoints, transcript projection,
//! and finalization remain in the shared Native Chat worker.

use crate::HostPaths;
use rudder_claude_code::{
    ClaudeError, ClaudeEvent, ClaudeInvocation, ClaudeLaunch, ClaudeRuntimeProfile,
    ClaudeSessionMode, ClaudeSessionSelector, ClaudeTransport, ClaudeTransportEvent,
    ClaudeTurnReceipt,
};
use rudder_d1_persistence::native_chat::config::{ClaudeLocalConfig, ResolvedCodexConfig};
use rudder_native_process_transport::{ConnectionLaunchPermit, HostCleanupProof};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::runtime::Handle;

const MAX_TURN_TIMEOUT: Duration = Duration::from_secs(3600);
const PROCESS_GRACE: Duration = Duration::from_secs(10);

#[derive(Debug, Error)]
pub enum ClaudeExecutionError {
    #[error("Claude Code native configuration is invalid")]
    InvalidConfiguration,
    #[error(transparent)]
    Transport(#[from] ClaudeError),
    #[error("Claude Code requested an interactive control decision")]
    ControlRequest,
    #[error("Claude Code emitted an unknown stream event")]
    UnknownEvent,
    #[error("Claude Code did not emit a terminal result before the deadline")]
    Timeout,
    #[error("Claude Code process exited before a terminal result")]
    ProcessExited,
}

/// Typed provider observation. The session and result IDs stay Claude-native
/// and are never converted into Codex Thread/Turn identifiers.
pub struct ClaudeExecutionObservation {
    pub session: ClaudeSessionSelector,
    pub turn: ClaudeTurnReceipt,
    pub cleanup: Option<HostCleanupProof>,
}

/// Run one stream-json input using a previously admitted and trusted config.
/// The caller supplies D1-owned identity strings and the one-use process-host
/// permit; this function never reads request data or ambient credentials.
#[allow(clippy::too_many_arguments)]
pub fn execute_turn(
    _handle: &Handle,
    config: &ResolvedCodexConfig,
    local: &ClaudeLocalConfig,
    paths: &HostPaths,
    permit: ConnectionLaunchPermit,
    run_id: &str,
    attempt_id: &str,
    owner_token: &str,
    existing_session: Option<&str>,
    input: &str,
    timeout: Duration,
) -> Result<ClaudeExecutionObservation, ClaudeExecutionError> {
    if config.identity.runtime_type != "claude_local"
        || input.trim().is_empty()
        || timeout.is_zero()
        || timeout > MAX_TURN_TIMEOUT
        || !config.cwd.is_dir()
        || !local.home.is_dir()
        || !local.profile_revision_matches()
        || !paths.process_host.is_file()
        || !paths.runtime_root.is_dir()
        || !paths.isolated_home.is_dir()
        || run_id.is_empty()
        || attempt_id.is_empty()
        || owner_token.is_empty()
    {
        return Err(ClaudeExecutionError::InvalidConfiguration);
    }

    let profile = ClaudeRuntimeProfile::new(config.operator_home.clone(), local.home.clone())
        .map_err(|_| ClaudeExecutionError::InvalidConfiguration)?;
    let mut env = profile
        .environment()
        .map_err(|_| ClaudeExecutionError::InvalidConfiguration)?;
    for (key, value) in &local.env {
        if matches!(key.as_str(), "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR")
            || key.is_empty()
            || key.contains('=')
            || key.contains('\0')
            || value.contains('\0')
        {
            return Err(ClaudeExecutionError::InvalidConfiguration);
        }
        env.insert(key.clone(), value.clone());
    }
    let session = match existing_session {
        Some(value) => ClaudeSessionMode::Resume {
            session_id: ClaudeSessionSelector::parse(value)?,
        },
        None => ClaudeSessionMode::New {
            session_id: Some(ClaudeSessionSelector::new()),
        },
    };
    let mut invocation = ClaudeInvocation::new(session);
    invocation.model = config.model.clone();
    invocation.effort = config.reasoning_effort.clone();
    invocation.append_system_prompt_file = config.instruction_source_path.clone();
    let launch = ClaudeLaunch {
        executable: config.executable.clone(),
        cwd: config.cwd.clone(),
        env,
        process_host: paths.process_host.clone(),
        runtime_root: paths.runtime_root.clone(),
        run_id: run_id.to_owned(),
        attempt_id: attempt_id.to_owned(),
        owner_token: owner_token.to_owned(),
        invocation,
    };
    let mut transport = ClaudeTransport::launch_for_execution(launch, permit)?;
    let deadline = Instant::now() + timeout;
    let result = run_turn(&mut transport, input, deadline);

    // A result is a provider receipt; the process remains owned until the
    // host emits its matching terminal cleanup lifecycle.
    let _ = transport.stop(PROCESS_GRACE.as_millis() as u64);
    let cleanup_deadline = Instant::now() + PROCESS_GRACE;
    while !cleanup_deadline
        .saturating_duration_since(Instant::now())
        .is_zero()
    {
        match transport.poll(Duration::from_millis(100)) {
            Ok(Some(ClaudeTransportEvent::Lifecycle(value)))
                if value.get("type").and_then(serde_json::Value::as_str) == Some("terminal") =>
            {
                break;
            }
            Ok(Some(_)) | Ok(None) => {}
            Err(_) => break,
        }
    }
    let turn = result?;
    let session = turn.session_id().clone();
    let cleanup = transport.take_cleanup_proof();
    Ok(ClaudeExecutionObservation {
        session,
        turn,
        cleanup,
    })
}

fn run_turn(
    transport: &mut ClaudeTransport,
    input: &str,
    deadline: Instant,
) -> Result<ClaudeTurnReceipt, ClaudeExecutionError> {
    transport.wait_spawned(remaining(deadline, Duration::from_secs(10)))?;
    transport.send_user_message(input)?;
    loop {
        let wait = remaining(deadline, Duration::from_millis(250));
        if wait.is_zero() {
            return Err(ClaudeExecutionError::Timeout);
        }
        match transport.poll(wait)? {
            Some(ClaudeTransportEvent::Provider(event)) => match event {
                ClaudeEvent::Result { .. } => {
                    return transport
                        .take_terminal()
                        .ok_or(ClaudeExecutionError::ProcessExited);
                }
                ClaudeEvent::ControlRequest(_) => return Err(ClaudeExecutionError::ControlRequest),
                ClaudeEvent::Unknown { .. } => return Err(ClaudeExecutionError::UnknownEvent),
                ClaudeEvent::SystemInit { .. }
                | ClaudeEvent::Assistant { .. }
                | ClaudeEvent::UserEcho { .. } => {}
            },
            Some(ClaudeTransportEvent::Lifecycle(value))
                if value.get("type").and_then(serde_json::Value::as_str) == Some("terminal") =>
            {
                return Err(ClaudeExecutionError::ProcessExited);
            }
            Some(ClaudeTransportEvent::Lifecycle(_)) | None => {}
        }
    }
}

fn remaining(deadline: Instant, cap: Duration) -> Duration {
    deadline.saturating_duration_since(Instant::now()).min(cap)
}
