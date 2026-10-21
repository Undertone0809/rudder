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
const CLEANUP_RECEIPT_ALLOWANCE: Duration = Duration::from_secs(2);

#[derive(Debug, Error)]
pub enum ClaudeExecutionError {
    #[error("Claude Code native configuration is invalid")]
    InvalidConfiguration,
    #[error(transparent)]
    Transport(#[from] ClaudeError),
    #[error("Claude Code durable execution fence rejected dispatch")]
    Persistence(#[from] rudder_d1_persistence::runtime_bindings::Error),
    #[error("Claude Code requested an interactive control decision")]
    ControlRequest,
    #[error("Claude Code emitted an unknown stream event")]
    UnknownEvent,
    #[error("Claude Code did not emit a terminal result before the deadline")]
    Timeout,
    #[error("Claude Code process exited before a terminal result")]
    ProcessExited,
}

impl ClaudeExecutionError {
    pub(crate) fn diagnostic_code(&self) -> &'static str {
        match self {
            Self::InvalidConfiguration => "claude_invalid_configuration",
            Self::Transport(ClaudeError::InvalidLaunch) => "claude_invalid_launch",
            Self::Transport(ClaudeError::InvalidSession) => "claude_invalid_session",
            Self::Transport(ClaudeError::Closed) => "claude_closed",
            Self::Transport(ClaudeError::Timeout) | Self::Timeout => "claude_timeout",
            Self::Transport(ClaudeError::OutputOverflow) => "claude_output_overflow",
            Self::Transport(ClaudeError::WriteIndeterminate) => "claude_write_indeterminate",
            Self::Transport(ClaudeError::InvalidEvent) => "claude_invalid_event",
            Self::Transport(ClaudeError::Framing | ClaudeError::Json(_)) => "claude_framing",
            Self::Transport(_) => "claude_transport",
            Self::ControlRequest => "claude_control_request",
            Self::UnknownEvent => "claude_unknown_event",
            Self::ProcessExited => "claude_process_exited",
            Self::Persistence(_) => "claude_persistence_conflict",
        }
    }
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
pub(crate) fn execute_turn(
    _handle: &Handle,
    config: &ResolvedCodexConfig,
    local: &ClaudeLocalConfig,
    paths: &HostPaths,
    permit: ConnectionLaunchPermit,
    run_id: &str,
    attempt_id: &str,
    owner_token: &str,
    existing_session: Option<&str>,
    send_input: impl FnOnce(&mut ClaudeTransport) -> Result<(), ClaudeExecutionError>,
    timeout: Duration,
) -> Result<ClaudeExecutionObservation, ClaudeExecutionError> {
    if config.identity.runtime_type != "claude_local"
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
    if local
        .grace_sec
        .is_some_and(|seconds| !(1..=60).contains(&seconds))
        || local
            .max_turns_per_run
            .is_some_and(|turns| !(1..=1000).contains(&turns))
    {
        return Err(ClaudeExecutionError::InvalidConfiguration);
    }
    let timeout = local
        .timeout_sec
        .filter(|seconds| *seconds > 0)
        .map(Duration::from_secs)
        .map_or(timeout, |configured| timeout.min(configured));

    let profile = if local.profile_id == "operator-default" {
        ClaudeRuntimeProfile::operator_default(config.operator_home.clone())
    } else {
        ClaudeRuntimeProfile::new(config.operator_home.clone(), local.home.clone())
    }
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
    env.insert("PATH".into(), local.executable_search_path.clone());
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
    invocation.permission_mode = local.permission_mode.clone();
    invocation.max_turns = local.max_turns_per_run;
    invocation.append_system_prompt_file = claude_instruction_entry_path(
        config.instruction_source_path.as_deref(),
        &config.instruction_entry_file,
        config.instruction_content.is_some(),
    );
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
    let result = run_turn(&mut transport, send_input, deadline);

    // A result is a provider receipt; the process remains owned until the
    // host emits its matching terminal cleanup lifecycle.
    let process_grace = local
        .grace_sec
        .map(Duration::from_secs)
        .unwrap_or(PROCESS_GRACE);
    let _ = transport.stop(process_grace.as_millis() as u64);
    let cleanup_wait = if local.grace_sec.is_some() {
        process_grace + CLEANUP_RECEIPT_ALLOWANCE
    } else {
        PROCESS_GRACE
    };
    let cleanup_deadline = Instant::now() + cleanup_wait;
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

fn claude_instruction_entry_path(
    source_root: Option<&std::path::Path>,
    entry_file: &str,
    has_content: bool,
) -> Option<std::path::PathBuf> {
    if !has_content {
        return None;
    }
    source_root.map(|root| root.join(entry_file))
}

fn run_turn(
    transport: &mut ClaudeTransport,
    send_input: impl FnOnce(&mut ClaudeTransport) -> Result<(), ClaudeExecutionError>,
    deadline: Instant,
) -> Result<ClaudeTurnReceipt, ClaudeExecutionError> {
    transport.wait_spawned(remaining(deadline, Duration::from_secs(10)))?;
    send_input(transport)?;
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

#[cfg(test)]
mod tests {
    use super::claude_instruction_entry_path;
    use std::path::Path;

    #[test]
    fn instruction_append_path_targets_entry_file_not_bundle_directory() {
        let path = claude_instruction_entry_path(
            Some(Path::new("/trusted/agent/instructions")),
            "SOUL.md",
            true,
        );
        assert_eq!(
            path,
            Some(Path::new("/trusted/agent/instructions/SOUL.md").into())
        );
        assert_eq!(
            claude_instruction_entry_path(
                Some(Path::new("/trusted/agent/instructions")),
                "HEARTBEAT.md",
                false,
            ),
            None,
            "ignored heartbeat content is not passed as an instruction file"
        );
    }
}
