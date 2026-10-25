//! Claude Code execution boundary.
//!
//! This module owns only one Claude Code process and the stream-json turn
//! receipt.  Durable admission, provider checkpoints, transcript projection,
//! and finalization remain in the shared Native Chat worker.

use crate::rudder_instructions::{
    RUDDER_AGENT_HEARTBEAT_INSTRUCTION, RUDDER_AGENT_OPERATING_CONTRACT,
};
use crate::{HostExecutionFailure, HostPaths, native_turn::cleanup_tick_budget_is_safe};
use rudder_claude_code::{
    ClaudeError, ClaudeEvent, ClaudeInvocation, ClaudeLaunch, ClaudeRuntimeProfile,
    ClaudeSessionMode, ClaudeSessionSelector, ClaudeTransport, ClaudeTransportEvent,
    ClaudeTurnReceipt,
};
use rudder_d1_persistence::native_chat::{
    config::{ClaudeLocalConfig, ResolvedCodexConfig},
    execution::StopIntent,
};
use rudder_native_process_transport::{
    ConnectionLaunchPermit, ConnectionReceipt, HostCleanupProof,
};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::runtime::Handle;
use uuid::Uuid;

const MAX_TURN_TIMEOUT: Duration = Duration::from_secs(3600);
const PROCESS_GRACE: Duration = Duration::from_secs(10);
const CLEANUP_RECEIPT_ALLOWANCE: Duration = Duration::from_secs(2);
const CLEANUP_TICK_INTERVAL: Duration = Duration::from_secs(5);
const CLEANUP_OPERATION_TIMEOUT: Duration = Duration::from_secs(5);
const CLEANUP_RECEIVE_QUANTUM: Duration = Duration::from_millis(200);
const MAX_FINAL_CLEANUP_DRAIN_EVENTS: usize = 128;

#[derive(Debug, Error)]
pub enum ClaudeExecutionError {
    #[error("Claude Code native configuration is invalid")]
    InvalidConfiguration,
    #[error(transparent)]
    Transport(#[from] ClaudeError),
    #[error("Claude Code durable execution fence rejected dispatch")]
    Persistence(#[from] rudder_d1_persistence::runtime_bindings::Error),
    #[error(transparent)]
    GoalRunPersistence(#[from] rudder_d1_persistence::goal_runs::GoalRunError),
    #[error("Goal Run execution ownership was lost")]
    GoalRunOwnershipLost,
    #[error("Claude Code requested an interactive control decision")]
    ControlRequest,
    #[error("Claude Code emitted an unknown stream event")]
    UnknownEvent,
    #[error("Claude Code did not emit a terminal result before the deadline")]
    Timeout,
    #[error("Claude Code process exited before a terminal result")]
    ProcessExited,
    #[error("Claude Code instruction context could not be prepared")]
    InstructionContext,
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
            Self::GoalRunPersistence(_) => "goal_run_persistence",
            Self::GoalRunOwnershipLost => "goal_run_ownership_lost",
            Self::InstructionContext => "claude_instruction_context",
        }
    }
}

/// Typed provider observation. The session and result IDs stay Claude-native
/// and are never converted into Codex Thread/Turn identifiers.
pub struct ClaudeExecutionObservation {
    pub session: ClaudeSessionSelector,
    pub turn: ClaudeTurnReceipt,
    pub connection: ConnectionReceipt,
    pub stop: Option<StopIntent>,
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
    extra_env: &std::collections::BTreeMap<String, String>,
    instruction_context_sections: &[String],
    include_goal_runtime_prefix: bool,
    on_spawned: impl FnOnce(&mut ClaudeTransport) -> Result<(), ClaudeExecutionError>,
    send_input: impl FnOnce(&mut ClaudeTransport) -> Result<(), ClaudeExecutionError>,
    mut poll_control: impl FnMut(
        &mut ClaudeTransport,
        bool,
        Option<Instant>,
    ) -> Result<bool, ClaudeExecutionError>,
    timeout: Duration,
) -> Result<ClaudeExecutionObservation, HostExecutionFailure<ClaudeExecutionError>> {
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
        return Err(ClaudeExecutionError::InvalidConfiguration.into());
    }
    if local
        .grace_sec
        .is_some_and(|seconds| !(1..=60).contains(&seconds))
        || local
            .max_turns_per_run
            .is_some_and(|turns| !(1..=1000).contains(&turns))
    {
        return Err(ClaudeExecutionError::InvalidConfiguration.into());
    }
    let timeout = local
        .timeout_sec
        .filter(|seconds| *seconds > 0)
        .map(Duration::from_secs)
        .map_or(timeout, |configured| timeout.min(configured));

    let has_context_sections = instruction_context_sections
        .iter()
        .any(|section| !section.trim().is_empty());
    let generated_instruction_file = if include_goal_runtime_prefix || has_context_sections {
        Some(write_combined_instruction_context(
            paths,
            config,
            local,
            instruction_context_sections,
            include_goal_runtime_prefix,
        )?)
    } else {
        None
    };

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
            return Err(ClaudeExecutionError::InvalidConfiguration.into());
        }
        env.insert(key.clone(), value.clone());
    }
    // Agent-controlled runtime environment cannot forge Rudder Agent JWT
    // authentication. The context bridge may re-add this exact key only after
    // signing it from trusted identity/run state.
    env.remove("RUDDER_API_KEY");
    for (key, value) in extra_env {
        if matches!(key.as_str(), "HOME" | "USERPROFILE" | "CLAUDE_CONFIG_DIR")
            || key.is_empty()
            || key.contains('=')
            || key.contains('\0')
            || value.contains('\0')
        {
            return Err(ClaudeExecutionError::InvalidConfiguration.into());
        }
        env.insert(key.clone(), value.clone());
    }
    env.insert("PATH".into(), local.executable_search_path.clone());
    let session = match existing_session {
        Some(value) => ClaudeSessionMode::Resume {
            session_id: ClaudeSessionSelector::parse(value).map_err(ClaudeExecutionError::from)?,
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
    invocation.append_system_prompt_file = generated_instruction_file
        .as_ref()
        .map(|file| file.path.clone())
        .or_else(|| {
            claude_instruction_entry_path(
                config.instruction_source_path.as_deref(),
                &config.instruction_entry_file,
                config.instruction_content.is_some(),
            )
        });
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
    let mut transport = ClaudeTransport::launch_for_execution(launch, permit)
        .map_err(ClaudeExecutionError::from)?;
    let deadline = Instant::now() + timeout;
    let result = run_turn(
        &mut transport,
        on_spawned,
        send_input,
        &mut poll_control,
        deadline,
    );
    let connection = transport.connection_receipt();

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
    // Host shutdown begins here, so cleanup ticks may observe/renew authority
    // but may not dispatch any further provider effect, even if the turn ended
    // with an error instead of a typed provider terminal result.
    let mut next_cleanup_control_poll = Instant::now();
    while !cleanup_deadline
        .saturating_duration_since(Instant::now())
        .is_zero()
    {
        let now = Instant::now();
        if now >= next_cleanup_control_poll {
            let remaining = cleanup_deadline.saturating_duration_since(now);
            if cleanup_tick_budget_is_safe(remaining, CLEANUP_RECEIVE_QUANTUM) {
                // Preserve a host receive quantum after the longest bounded
                // D1 operation. Tick failure must never erase a typed turn
                // receipt or stop collection of the same-connection proof.
                let _ = poll_control(
                    &mut transport,
                    true,
                    Some(cleanup_deadline.min(now + CLEANUP_OPERATION_TIMEOUT)),
                );
            }
            next_cleanup_control_poll = Instant::now() + CLEANUP_TICK_INTERVAL;
        }
        let wait = remaining(cleanup_deadline, CLEANUP_RECEIVE_QUANTUM)
            .min(next_cleanup_control_poll.saturating_duration_since(Instant::now()));
        if wait.is_zero() {
            continue;
        }
        match transport.poll_cleanup(wait) {
            Ok(Some(ClaudeTransportEvent::Lifecycle(value)))
                if value.get("type").and_then(serde_json::Value::as_str) == Some("terminal") =>
            {
                break;
            }
            Ok(Some(_)) | Ok(None) => {}
            Err(_) => break,
        }
    }
    // A synchronous cleanup tick may have outlived its reserved budget. Drain
    // the finite host queue without blocking before deciding that cleanup
    // proof is missing. Never flush pending provider writes on this path.
    for _ in 0..MAX_FINAL_CLEANUP_DRAIN_EVENTS {
        match transport.poll_cleanup(Duration::ZERO) {
            Ok(Some(ClaudeTransportEvent::Lifecycle(value)))
                if value.get("type").and_then(serde_json::Value::as_str) == Some("terminal") =>
            {
                break;
            }
            Ok(Some(_)) => {}
            Ok(None) | Err(ClaudeError::Closed | ClaudeError::Timeout) => break,
            Err(_) => break,
        }
    }
    let cleanup = transport.take_cleanup_proof();
    if cleanup.is_some() {
        // The host proof is already captured, so this best-effort authority
        // refresh cannot consume the final host receive/drain window.
        let _ = poll_control(
            &mut transport,
            true,
            Some(Instant::now() + CLEANUP_OPERATION_TIMEOUT),
        );
    }
    let turn = match result {
        Ok(turn) => turn,
        Err(error) => {
            return Err(HostExecutionFailure {
                error,
                cleanup: cleanup.map(Box::new),
            });
        }
    };
    let session = turn.session_id().clone();
    Ok(ClaudeExecutionObservation {
        session,
        turn,
        connection,
        stop: None,
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

struct GeneratedInstructionContext {
    path: PathBuf,
}

impl Drop for GeneratedInstructionContext {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_file(&self.path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(event = "goal_instruction_context_cleanup_failed", error = %error);
        }
    }
}

fn write_combined_instruction_context(
    paths: &HostPaths,
    config: &ResolvedCodexConfig,
    local: &ClaudeLocalConfig,
    instruction_context_sections: &[String],
    include_goal_runtime_prefix: bool,
) -> Result<GeneratedInstructionContext, ClaudeExecutionError> {
    let contents = compose_instruction_context(
        config.instruction_content.as_deref(),
        config.instruction_source_path.as_deref(),
        &config.instruction_entry_file,
        &local.instruction_siblings,
        instruction_context_sections,
        include_goal_runtime_prefix,
    )?;
    let path = paths
        .runtime_root
        .join(format!("goal-instructions-{}.md", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| ClaudeExecutionError::InstructionContext)?;
    let generated = GeneratedInstructionContext { path };
    file.write_all(contents.as_bytes())
        .and_then(|()| file.flush())
        .map_err(|_| ClaudeExecutionError::InstructionContext)?;
    Ok(generated)
}

fn compose_instruction_context(
    instruction_content: Option<&str>,
    instruction_source_path: Option<&Path>,
    instruction_entry_file: &str,
    instruction_siblings: &[(String, String)],
    instruction_context_sections: &[String],
    include_goal_runtime_prefix: bool,
) -> Result<String, ClaudeExecutionError> {
    let mut sections = Vec::new();
    if include_goal_runtime_prefix {
        // The legacy TypeScript contract keeps one trailing space on this
        // internal line; mirror its exact Goal prefix bytes.
        let operating_contract = RUDDER_AGENT_OPERATING_CONTRACT.trim().replace(
            "for structured long-term memory.\n\nInvoke it whenever",
            "for structured long-term memory. \n\nInvoke it whenever",
        );
        sections.push(wrap_system_prompt_section(
            "rudder_agent_operating_contract",
            &format!(
                "{operating_contract}\n\nThe above Rudder agent operating contract was injected by Rudder at runtime."
            ),
        ));
    }
    let entry_path = instruction_source_path.map(|root| root.join(instruction_entry_file));
    let mut loaded_file_names = Vec::new();
    if let Some(instructions) = instruction_content
        .map(str::trim_end)
        .filter(|instructions| !instructions.trim().is_empty())
    {
        let file_name = entry_path
            .as_deref()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            .unwrap_or(instruction_entry_file);
        sections.push(instruction_file_section(
            instructions,
            file_name,
            entry_path.as_deref(),
            entry_path.as_deref(),
        ));
        loaded_file_names.push(file_name.to_owned());
    }

    if let Some(entry_path) = entry_path.as_deref() {
        let entry_relative_path = Path::new(instruction_entry_file);
        for (relative_path, contents) in instruction_siblings {
            let relative_path = Path::new(relative_path);
            if relative_path == entry_relative_path {
                continue;
            }
            let contents = contents.trim_end();
            if contents.trim().is_empty() {
                continue;
            }
            let Some(file_name) = relative_path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(source_root) = instruction_source_path else {
                continue;
            };
            let file_path = source_root.join(relative_path);
            sections.push(instruction_file_section(
                contents,
                file_name,
                Some(&file_path),
                Some(entry_path),
            ));
            loaded_file_names.push(file_name.to_owned());
        }

        if !loaded_file_names.is_empty()
            && let Some(instructions_dir) = entry_path.parent()
        {
            let display_dir = display_instruction_path(instructions_dir, entry_path);
            let display_dir_without_slash = display_dir.trim_end_matches('/');
            let display_dir_with_slash = format!("{display_dir_without_slash}/");
            let names = loaded_file_names.join(", ");
            let file_label = if loaded_file_names.len() == 1 {
                "file was"
            } else {
                "files were"
            };
            sections.push(format!(
                "The above {names} instruction {file_label} loaded from {display_dir_without_slash}.\nResolve any relative file references from {display_dir_with_slash}."
            ));
        }
    }

    sections.extend(
        instruction_context_sections
            .iter()
            .map(|section| section.trim())
            .filter(|section| !section.is_empty())
            .map(str::to_owned),
    );
    if include_goal_runtime_prefix {
        sections.push(wrap_system_prompt_section(
            "rudder_heartbeat_instruction",
            &format!(
                "{}\n\nThe above Rudder heartbeat instruction was injected by Rudder at runtime.",
                RUDDER_AGENT_HEARTBEAT_INSTRUCTION.trim()
            ),
        ));
    }

    if sections.is_empty() {
        return Err(ClaudeExecutionError::InstructionContext);
    }
    Ok(format!(
        "<rudder_agent_instruction>\n{}\n</rudder_agent_instruction>",
        sections.join("\n\n"),
    ))
}

fn wrap_system_prompt_section(tag: &str, content: &str) -> String {
    format!("<{tag}>\n{}\n</{tag}>", content.trim())
}

fn instruction_file_section(
    contents: &str,
    file_name: &str,
    file_path: Option<&Path>,
    instructions_file_path: Option<&Path>,
) -> String {
    if matches!(
        file_name,
        "AGENTS.md" | "SOUL.md" | "TOOLS.md" | "MEMORY.md"
    ) {
        format!("<{file_name}>\n{contents}\n</{file_name}>")
    } else if let (Some(file_path), Some(instructions_file_path)) =
        (file_path, instructions_file_path)
    {
        let display_path = display_instruction_path(file_path, instructions_file_path);
        format!(
            "<agent_instruction_file path=\"{}\">\n{contents}\n</agent_instruction_file>",
            escape_prompt_attribute(&display_path),
        )
    } else {
        format!("<agent_instruction_file>\n{contents}\n</agent_instruction_file>")
    }
}

fn display_instruction_path(path: &Path, instructions_file_path: &Path) -> String {
    if let Some(instructions_dir) = instructions_file_path.parent()
        && instructions_dir.file_name().and_then(|name| name.to_str()) == Some("instructions")
        && let Some(agent_home) = instructions_dir.parent()
        && let Ok(relative) = path.strip_prefix(agent_home)
    {
        return format!("$AGENT_HOME/{}", relative.to_string_lossy()).replace('\\', "/");
    }
    path.to_string_lossy().replace('\\', "/")
}

fn escape_prompt_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn run_turn(
    transport: &mut ClaudeTransport,
    on_spawned: impl FnOnce(&mut ClaudeTransport) -> Result<(), ClaudeExecutionError>,
    send_input: impl FnOnce(&mut ClaudeTransport) -> Result<(), ClaudeExecutionError>,
    poll_control: &mut impl FnMut(
        &mut ClaudeTransport,
        bool,
        Option<Instant>,
    ) -> Result<bool, ClaudeExecutionError>,
    deadline: Instant,
) -> Result<ClaudeTurnReceipt, ClaudeExecutionError> {
    transport.wait_spawned(remaining(deadline, Duration::from_secs(10)))?;
    on_spawned(transport)?;
    send_input(transport)?;
    let mut next_control_poll = Instant::now();
    loop {
        // Stop is polled on the same owned transport that received the one
        // admitted input. A true result only says a permit-backed interrupt
        // write was dispatched; terminal status still comes exclusively from
        // the matching Claude `result` event below.
        let now = Instant::now();
        if now >= next_control_poll {
            let _interrupt_dispatched = poll_control(transport, false, None)?;
            next_control_poll = Instant::now() + Duration::from_millis(250);
        }
        let wait = remaining(
            deadline,
            next_control_poll.saturating_duration_since(Instant::now()),
        );
        if wait.is_zero() {
            return Err(ClaudeExecutionError::Timeout);
        }
        match transport.poll(wait)? {
            Some(ClaudeTransportEvent::Provider(event)) => match event {
                ClaudeEvent::Result { .. } => {
                    // Take the typed terminal receipt before any cleanup-phase
                    // database work. The cleanup hook will observe a racing
                    // Stop without allowing a post-terminal interrupt.
                    return transport
                        .take_terminal()
                        .ok_or(ClaudeExecutionError::ProcessExited);
                }
                ClaudeEvent::ControlRequest(_) => return Err(ClaudeExecutionError::ControlRequest),
                ClaudeEvent::ControlResponse(_) => {
                    // The transport has correlated this ACK to the one
                    // interrupt request. It is not a terminal provider result.
                }
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
    use super::{claude_instruction_entry_path, compose_instruction_context};
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

    #[test]
    fn goal_instruction_prefix_matches_node_section_order() {
        let resources = "<recent_rudder_context>recent context</recent_rudder_context>".to_owned();
        let contents = compose_instruction_context(
            Some("Agent-specific instructions"),
            Some(Path::new("/agents/alpha/instructions")),
            "AGENTS.md",
            &[],
            &[resources],
            true,
        )
        .expect("compose trusted Goal instruction prefix");

        let operating = contents
            .find("<rudder_agent_operating_contract>")
            .expect("operating contract is included");
        let agent_instructions = contents
            .find("<AGENTS.md>")
            .expect("Agent instructions are included");
        let instruction_footer = contents
            .find("Resolve any relative file references from $AGENT_HOME/instructions/.")
            .expect("relative instruction path is preserved");
        let resources = contents
            .find("<recent_rudder_context>")
            .expect("resource context is included");
        let heartbeat = contents
            .find("<rudder_heartbeat_instruction>")
            .expect("heartbeat contract is included");

        assert!(operating < agent_instructions);
        assert!(agent_instructions < instruction_footer);
        assert!(instruction_footer < resources);
        assert!(resources < heartbeat);
        assert!(contents.starts_with("<rudder_agent_instruction>\n"));
        assert!(contents.ends_with("\n</rudder_agent_instruction>"));
    }

    #[test]
    fn goal_instruction_prefix_loads_custom_entry_and_available_siblings() {
        let root = tempfile::tempdir().expect("create fresh Agent home");
        let instructions = root.path().join("instructions");
        std::fs::create_dir_all(&instructions).expect("create instructions directory");
        std::fs::write(instructions.join("custom role.md"), "Keep this entry.\n")
            .expect("write custom entry");
        std::fs::write(instructions.join("SOUL.md"), "Use a warm voice.\n")
            .expect("write optional SOUL file");
        let entry_contents =
            std::fs::read_to_string(instructions.join("custom role.md")).expect("read entry");
        let siblings = vec![(
            "SOUL.md".to_owned(),
            std::fs::read_to_string(instructions.join("SOUL.md")).expect("read SOUL file"),
        )];
        let contents = compose_instruction_context(
            Some(&entry_contents),
            Some(instructions.as_path()),
            "custom role.md",
            &siblings,
            &["Recent resource context".to_owned()],
            true,
        )
        .expect("compose prompt using only the available optional sibling");

        let entry_index = contents
            .find("<agent_instruction_file path=\"$AGENT_HOME/instructions/custom role.md\">")
            .expect("custom entry is wrapped with its Agent-relative path");
        let soul_index = contents
            .find("<SOUL.md>\nUse a warm voice.\n</SOUL.md>")
            .expect("available SOUL file is included");
        let footer_index = contents
            .find("The above custom role.md, SOUL.md instruction files were loaded from $AGENT_HOME/instructions.")
            .expect("footer lists the available entry and sibling");
        let resource_index = contents
            .find("Recent resource context")
            .expect("resource context follows the file footer");
        let heartbeat_index = contents
            .find("<rudder_heartbeat_instruction>")
            .expect("Goal heartbeat prefix is included");
        assert!(entry_index < soul_index);
        assert!(soul_index < footer_index);
        assert!(footer_index < resource_index);
        assert!(resource_index < heartbeat_index);
        assert!(!contents.contains("<TOOLS.md>"));
        assert!(!contents.contains("<MEMORY.md>"));
        assert!(
            contents
                .contains("Resolve any relative file references from $AGENT_HOME/instructions/.")
        );
        // The captured Node prefix encodes its one legacy trailing space as
        // `\\u0020`, avoiding trailing-whitespace churn in the fixture file.
        let node_prefix = include_str!("../tests/fixtures/goal-instruction-prefix-node.txt")
            .replace(
                "for structured long-term memory.\\u0020\n",
                "for structured long-term memory. \n",
            );
        assert_eq!(
            contents, node_prefix,
            "the full Goal Claude prefix must match the frozen Node loader output",
        );
    }
}
