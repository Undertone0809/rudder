use crate::session::PiSessionEntry;
use crate::strict_json::StrictValue;
use crate::{PiCleanupReceipt, PiSessionTree, PiTurnReceipt, PiTurnStatus};
use rudder_native_process_transport::{
    ConnectionIdentity, ConnectionLaunchPermit, HostCleanupProof, HostConnection, HostError,
    HostEvent, OwnedHost,
};
use rudder_native_protocol::{Command, ProtocolVersion, lines::LineDecoder};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MAX_PI_EVENT_QUEUE: usize = 128;
const MAX_PI_EVENT_JSON_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum PiTransportError {
    #[error("Pi process launch is invalid")]
    InvalidLaunch,
    #[error("Pi RPC transport is closed")]
    Closed,
    #[error("Pi RPC request is already in flight")]
    Busy,
    #[error("Pi RPC response does not match the active request")]
    MismatchedResponse,
    #[error("Pi RPC response rejected the request")]
    Rejected,
    #[error("Pi RPC stream is malformed or contains an unknown event")]
    InvalidMessage,
    #[error("Pi completed output contains content this adapter cannot project")]
    UnsupportedOutput,
    #[error("Pi RPC event buffer exceeded its limit")]
    OutputOverflow,
    #[error("Pi stdin write outcome is indeterminate")]
    WriteIndeterminate,
    #[error("Pi child exited before completing the RPC")]
    ProcessExited,
    #[error("Pi operation deadline expired")]
    Timeout,
}

impl From<rudder_native_protocol::lines::LineError> for PiTransportError {
    fn from(_: rudder_native_protocol::lines::LineError) -> Self {
        Self::InvalidMessage
    }
}

/// Trusted host-built process data. The child starts the installed Pi CLI
/// through its absolute Node executable so the process-host can keep the
/// provider environment isolated without depending on ambient PATH.
pub struct ProcessLaunch {
    pub node_executable: PathBuf,
    pub pi_cli_entry: PathBuf,
    pub process_host: PathBuf,
    pub runtime_root: PathBuf,
    pub isolated_home: PathBuf,
    pub session_dir: PathBuf,
    /// Exact persisted Pi session file on resume. A new session leaves this
    /// absent and consumes the committed StartPiSession effect first.
    pub resume_session_file: Option<PathBuf>,
    pub system_prompt_file: Option<PathBuf>,
    pub cwd: PathBuf,
    pub provider: String,
    pub model: String,
    pub thinking: Option<String>,
    pub run_id: String,
    pub attempt_id: String,
    pub owner_token: String,
    pub env: std::collections::BTreeMap<String, String>,
}

pub enum PiCommand<'a> {
    NewSession,
    SwitchSession(&'a str),
    GetState,
    GetMessages,
    SetModel {
        provider: &'a str,
        model_id: &'a str,
    },
    SetThinkingLevel(&'a str),
    Prompt(&'a str),
    Abort,
}

impl PiCommand<'_> {
    fn name(&self) -> &'static str {
        match self {
            Self::NewSession => "new_session",
            Self::SwitchSession(_) => "switch_session",
            Self::GetState => "get_state",
            Self::GetMessages => "get_messages",
            Self::SetModel { .. } => "set_model",
            Self::SetThinkingLevel(_) => "set_thinking_level",
            Self::Prompt(_) => "prompt",
            Self::Abort => "abort",
        }
    }

    fn fields(&self) -> Value {
        match self {
            Self::NewSession => json!({}),
            Self::SwitchSession(path) => json!({"sessionPath": path}),
            Self::GetState => json!({}),
            Self::GetMessages => json!({}),
            Self::SetModel { provider, model_id } => {
                json!({"provider": provider, "modelId": model_id})
            }
            Self::SetThinkingLevel(level) => json!({"level": level}),
            Self::Prompt(message) => json!({"message": message}),
            Self::Abort => json!({}),
        }
    }
}

pub struct PiResponse {
    id: String,
    command: String,
    success: bool,
    data: Option<Value>,
}

impl PiResponse {
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn command(&self) -> &str {
        &self.command
    }
    pub fn success(&self) -> bool {
        self.success
    }
    pub fn data(&self) -> Option<&Value> {
        self.data.as_ref()
    }
}

pub struct PiEvent {
    kind: String,
    value: Value,
}

impl PiEvent {
    pub fn kind(&self) -> &str {
        &self.kind
    }
    pub fn value(&self) -> &Value {
        &self.value
    }
}

pub enum PiRpcMessage {
    Response(PiResponse),
    Event(PiEvent),
}

struct PendingRequest {
    id: String,
    command: &'static str,
}

pub struct PiRpcTransport {
    host: OwnedHost,
    decoder: LineDecoder,
    messages: VecDeque<PiRpcMessage>,
    pending: Option<PendingRequest>,
    next_request_id: u64,
    next_write_id: u64,
    request_id: String,
    owner_token: String,
    spawned: bool,
    terminal: bool,
    host_failure: bool,
    cleanup_proof: Option<HostCleanupProof>,
    session_dir: PathBuf,
    active_session_id: Option<String>,
    active_session_file: Option<PathBuf>,
    prompt_requested: bool,
    prompt_accepted: bool,
    prompt_agent_started: bool,
    prompt_agent_ended: bool,
    turn_receipt_taken: bool,
}

impl PiRpcTransport {
    /// Consume the exact claim permit. Only the returned owner can create a
    /// Pi session, emit RPC receipts, or take host cleanup evidence.
    pub fn launch(
        launch: ProcessLaunch,
        permit: ConnectionLaunchPermit,
    ) -> Result<Self, PiTransportError> {
        let launch = validate_launch(launch)?;
        let session_dir = launch.session_dir.clone();
        let request_id = launch.attempt_id.clone();
        let owner_token = launch.owner_token.clone();
        let host = OwnedHost::launch_external(
            HostConnection {
                request_id: request_id.clone(),
                run_id: launch.run_id.clone(),
                attempt_id: launch.attempt_id.clone(),
                owner_token: owner_token.clone(),
            },
            &launch.process_host,
            Some(permit),
        )
        .map_err(map_host_error)?;

        let mut env = launch.env;
        env.insert(
            "HOME".into(),
            launch.isolated_home.to_string_lossy().into_owned(),
        );
        env.insert(
            "USERPROFILE".into(),
            launch.isolated_home.to_string_lossy().into_owned(),
        );
        env.insert(
            "PI_CODING_AGENT_DIR".into(),
            launch
                .isolated_home
                .join(".pi/agent")
                .to_string_lossy()
                .into_owned(),
        );
        env.insert(
            "PI_CODING_AGENT_SESSION_DIR".into(),
            launch.session_dir.to_string_lossy().into_owned(),
        );
        let mut argv = vec![
            launch.pi_cli_entry.to_string_lossy().into_owned(),
            "--mode".into(),
            "rpc".into(),
            "--provider".into(),
            launch.provider,
            "--model".into(),
            launch.model,
            "--session-dir".into(),
            launch.session_dir.to_string_lossy().into_owned(),
            "--no-skills".into(),
            "--no-tools".into(),
            "--no-extensions".into(),
            "--no-prompt-templates".into(),
            "--no-themes".into(),
            "--no-context-files".into(),
        ];
        if let Some(session_file) = launch.resume_session_file.as_ref() {
            argv.extend([
                "--session".into(),
                session_file.to_string_lossy().into_owned(),
            ]);
        }
        if let Some(path) = launch.system_prompt_file {
            argv.extend([
                "--append-system-prompt".into(),
                path.to_string_lossy().into_owned(),
            ]);
        }
        if let Some(thinking) = launch.thinking {
            argv.extend(["--thinking".into(), thinking]);
        }
        let start = Command::StartProcess {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(request_id.clone()),
            executable: launch.node_executable.to_string_lossy().into_owned(),
            argv,
            cwd: launch.cwd.to_string_lossy().into_owned(),
            env,
            owner_token: Some(owner_token.clone()),
            runtime_root: Some(launch.runtime_root.to_string_lossy().into_owned()),
            stdin: None,
            interactive_stdin: true,
            grace_ms: Some(500),
        };
        start
            .validate()
            .map_err(|_| PiTransportError::InvalidLaunch)?;
        host.send(start).map_err(map_host_error)?;
        Ok(Self {
            host,
            decoder: LineDecoder::default(),
            messages: VecDeque::new(),
            pending: None,
            next_request_id: 0,
            next_write_id: 0,
            request_id,
            owner_token,
            spawned: false,
            terminal: false,
            host_failure: false,
            cleanup_proof: None,
            session_dir,
            active_session_id: None,
            active_session_file: None,
            prompt_requested: false,
            prompt_accepted: false,
            prompt_agent_started: false,
            prompt_agent_ended: false,
            turn_receipt_taken: false,
        })
    }

    pub fn connection_identity(&self) -> ConnectionIdentity {
        self.host.connection_identity()
    }

    pub fn wait_spawned(&mut self, timeout: Duration) -> Result<(), PiTransportError> {
        if self.spawned {
            return Ok(());
        }
        let deadline = Instant::now() + timeout;
        while !self.spawned {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(PiTransportError::Timeout);
            }
            match self.host.receive(remaining) {
                Ok(HostEvent::Lifecycle(value)) => {
                    self.observe_lifecycle(&value)?;
                    if self.terminal {
                        return Err(PiTransportError::ProcessExited);
                    }
                }
                Ok(HostEvent::Stdout(bytes)) => self.decode_stdout(&bytes)?,
                Ok(HostEvent::Failure) => return Err(PiTransportError::Closed),
                Err(HostError::Timeout) => return Err(PiTransportError::Timeout),
                Err(HostError::OutputOverflow) => return Err(PiTransportError::OutputOverflow),
                Err(HostError::Closed) | Err(HostError::InvalidLaunch) => {
                    return Err(PiTransportError::Closed);
                }
            }
        }
        Ok(())
    }

    pub fn request(&mut self, command: PiCommand<'_>) -> Result<String, PiTransportError> {
        if self.pending.is_some() {
            return Err(PiTransportError::Busy);
        }
        if matches!(&command, PiCommand::Prompt(_))
            && (self.prompt_requested || self.turn_receipt_taken)
        {
            return Err(PiTransportError::Busy);
        }
        if !self.spawned || self.terminal || self.host_failure {
            return Err(PiTransportError::Closed);
        }
        let id = format!("rudder-pi-{}", self.next_request_id);
        self.next_request_id = self
            .next_request_id
            .checked_add(1)
            .ok_or(PiTransportError::InvalidMessage)?;
        let name = command.name();
        if name == "prompt" {
            self.prompt_requested = true;
            self.prompt_accepted = false;
            self.prompt_agent_started = false;
            self.prompt_agent_ended = false;
        }
        let mut value = command.fields();
        let object = value
            .as_object_mut()
            .ok_or(PiTransportError::InvalidMessage)?;
        object.insert("type".into(), Value::String(name.into()));
        object.insert("id".into(), Value::String(id.clone()));
        let bytes = serde_json::to_vec(&value).map_err(|_| PiTransportError::InvalidMessage)?;
        if bytes.len() > MAX_PI_EVENT_JSON_BYTES {
            return Err(PiTransportError::InvalidMessage);
        }
        let mut frame = String::from_utf8(bytes).map_err(|_| PiTransportError::InvalidMessage)?;
        frame.push('\n');
        self.pending = Some(PendingRequest {
            id: id.clone(),
            command: name,
        });
        // A write error after registration is conservatively treated as an
        // unresolved command. This connection cannot issue another request.
        self.write_frame(&frame)?;
        Ok(id)
    }

    pub fn receive(&mut self, timeout: Duration) -> Result<PiRpcMessage, PiTransportError> {
        if let Some(message) = self.messages.pop_front() {
            return Ok(message);
        }
        if self.host_failure {
            return Err(PiTransportError::Closed);
        }
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(PiTransportError::Timeout);
            }
            match self.host.receive(remaining) {
                Ok(HostEvent::Lifecycle(value)) => {
                    self.observe_lifecycle(&value)?;
                    if self.terminal {
                        return Err(PiTransportError::ProcessExited);
                    }
                }
                Ok(HostEvent::Stdout(bytes)) => self.decode_stdout(&bytes)?,
                Ok(HostEvent::Failure) => {
                    self.host_failure = true;
                    return Err(PiTransportError::Closed);
                }
                Err(HostError::Timeout) => return Err(PiTransportError::Timeout),
                Err(HostError::OutputOverflow) => return Err(PiTransportError::OutputOverflow),
                Err(HostError::Closed) | Err(HostError::InvalidLaunch) => {
                    self.host_failure = true;
                    return Err(PiTransportError::Closed);
                }
            }
            if let Some(message) = self.messages.pop_front() {
                return Ok(message);
            }
        }
    }

    pub fn take_cleanup_proof(&mut self) -> Option<HostCleanupProof> {
        self.cleanup_proof
            .take()
            .or_else(|| self.host.take_cleanup_proof())
    }

    /// Convert the exact persisted Pi tree into a terminal receipt only after
    /// this connection accepted one prompt and observed its agent_start/end
    /// pair. Session UUID/path and entry IDs must match this process and the
    /// exact prior leaf; no Codex identifiers are synthesized.
    pub fn take_turn_receipt(
        &mut self,
        tree: &PiSessionTree,
        prior_leaf_id: Option<&str>,
        input_text: &str,
    ) -> Result<PiTurnReceipt, PiTransportError> {
        if self.turn_receipt_taken
            || !self.prompt_requested
            || !self.prompt_accepted
            || !self.prompt_agent_started
            || !self.prompt_agent_ended
        {
            return Err(PiTransportError::InvalidMessage);
        }
        let view = tree.view();
        if self.active_session_id.as_deref() != Some(view.session_id.as_str())
            || self.active_session_file.as_deref() != Some(view.session_file.as_path())
            || !view.session_file.starts_with(&self.session_dir)
        {
            return Err(PiTransportError::InvalidMessage);
        }
        let (input, assistant, status, final_text) =
            project_exact_turn(tree, prior_leaf_id, input_text)?;
        let leaf_id = view
            .leaf_id
            .clone()
            .ok_or(PiTransportError::InvalidMessage)?;
        let input_digest = Sha256::digest(input_text.as_bytes());
        let input_fingerprint = format!(
            "native-chat-v1:{}",
            input_digest
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let identity = self.host.connection_identity().duplicate_identity();
        self.turn_receipt_taken = true;
        Ok(PiTurnReceipt::new(
            identity,
            view.session_id.clone(),
            view.session_file.to_string_lossy().into_owned(),
            prior_leaf_id.map(str::to_owned),
            input.id().to_owned(),
            input_fingerprint,
            assistant.id().to_owned(),
            leaf_id,
            status,
            final_text,
        ))
    }

    /// Wrap cleanup only when the owned host observed its exact terminal
    /// lifecycle receipt. This proof is tied to the same connection identity
    /// used by `take_turn_receipt`.
    pub fn take_cleanup_receipt(&mut self) -> Option<PiCleanupReceipt> {
        self.take_cleanup_proof().map(PiCleanupReceipt::new)
    }

    /// Ask the owned host to stop Pi and wait for its matching terminal
    /// lifecycle receipt. EOF/Drop cleanup is not promoted to proof here.
    pub fn stop(&mut self, timeout: Duration) -> Result<(), PiTransportError> {
        if self.terminal {
            self.cleanup_proof = self.host.take_cleanup_proof();
            return self
                .cleanup_proof
                .as_ref()
                .map(|_| ())
                .ok_or(PiTransportError::Closed);
        }
        self.host
            .send(Command::Stop {
                protocol_version: Some(ProtocolVersion::default()),
                request_id: Some(self.request_id.clone()),
                grace_ms: Some(500),
            })
            .map_err(map_host_error)?;
        let deadline = Instant::now() + timeout;
        while !self.terminal {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(PiTransportError::Timeout);
            }
            match self.host.receive(remaining) {
                Ok(HostEvent::Lifecycle(value)) => self.observe_lifecycle(&value)?,
                Ok(HostEvent::Stdout(bytes)) => self.decode_stdout(&bytes)?,
                Ok(HostEvent::Failure) => return Err(PiTransportError::Closed),
                Err(HostError::Timeout) => return Err(PiTransportError::Timeout),
                Err(HostError::OutputOverflow) => return Err(PiTransportError::OutputOverflow),
                Err(HostError::Closed) | Err(HostError::InvalidLaunch) => {
                    return Err(PiTransportError::Closed);
                }
            }
        }
        self.cleanup_proof = self.host.take_cleanup_proof();
        self.cleanup_proof
            .as_ref()
            .map(|_| ())
            .ok_or(PiTransportError::Closed)
    }

    pub fn close(&mut self) {
        self.host.close();
    }

    fn write_frame(&mut self, frame: &str) -> Result<(), PiTransportError> {
        self.next_write_id = self
            .next_write_id
            .checked_add(1)
            .ok_or(PiTransportError::InvalidMessage)?;
        let write_id = format!("pi-write-{}", self.next_write_id);
        self.host
            .send(Command::WriteStdin {
                protocol_version: Some(ProtocolVersion::default()),
                request_id: Some(self.request_id.clone()),
                owner_token: Some(self.owner_token.clone()),
                write_id: Some(write_id.clone()),
                data: frame.to_owned(),
            })
            .map_err(map_host_error)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(PiTransportError::WriteIndeterminate);
            }
            match self.host.receive(remaining) {
                Ok(HostEvent::Lifecycle(value)) => {
                    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
                    if value.get("requestId").and_then(Value::as_str) != Some(&self.request_id)
                        || value.get("ownerToken").and_then(Value::as_str)
                            != Some(&self.owner_token)
                    {
                        return Err(PiTransportError::InvalidMessage);
                    }
                    if kind == "stdin-write-complete"
                        && value.get("writeId").and_then(Value::as_str) == Some(&write_id)
                        && value.get("bytesWritten").and_then(Value::as_u64)
                            == Some(frame.len() as u64)
                    {
                        return Ok(());
                    }
                    if kind == "stdin-write-rejected"
                        && value.get("writeId").and_then(Value::as_str) == Some(&write_id)
                    {
                        return Err(PiTransportError::Rejected);
                    }
                    if kind == "stdin-write-failed"
                        && value.get("writeId").and_then(Value::as_str) == Some(&write_id)
                    {
                        return Err(PiTransportError::WriteIndeterminate);
                    }
                    self.observe_lifecycle(&value)?;
                }
                Ok(HostEvent::Stdout(bytes)) => self.decode_stdout(&bytes)?,
                Ok(HostEvent::Failure) => return Err(PiTransportError::Closed),
                Err(HostError::Timeout) => return Err(PiTransportError::WriteIndeterminate),
                Err(HostError::OutputOverflow) => return Err(PiTransportError::OutputOverflow),
                Err(HostError::Closed) | Err(HostError::InvalidLaunch) => {
                    return Err(PiTransportError::Closed);
                }
            }
        }
    }

    fn observe_lifecycle(&mut self, value: &Value) -> Result<(), PiTransportError> {
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        // The shared owned-host layer validates the one startup handshake
        // (including its protocol version and capabilities) before exposing
        // it. It is deliberately scoped to `bootstrap`, so it is not a Pi
        // process lifecycle event and has no claim identity to compare here.
        if kind == "handshake" {
            return Ok(());
        }
        if value.get("requestId").and_then(Value::as_str) != Some(&self.request_id)
            || value.get("ownerToken").and_then(Value::as_str) != Some(&self.owner_token)
        {
            return Err(PiTransportError::InvalidMessage);
        }
        match kind {
            // The host announces acceptance before it spawns the child. Like
            // Codex transport, keep this informational and wait for the
            // separate `spawned` event before permitting RPC writes.
            "accepted" if !self.spawned && !self.terminal => (),
            "spawned" if !self.spawned && !self.terminal => self.spawned = true,
            "stop-accepted" if self.spawned && !self.terminal => (),
            "stopped" if self.spawned && !self.terminal => (),
            // This reports the child process exit. The host still must emit
            // its separate terminal receipt before cleanup can be proven.
            "app-exit" if self.spawned && !self.terminal => (),
            "terminal" if self.spawned && !self.terminal => self.terminal = true,
            "stdin-write-complete" | "stdin-write-rejected" | "stdin-write-failed" => (),
            _ => return Err(PiTransportError::InvalidMessage),
        }
        Ok(())
    }

    fn decode_stdout(&mut self, bytes: &[u8]) -> Result<(), PiTransportError> {
        let parsed = self.decoder.push(bytes, |frame| {
            let StrictValue(value) =
                serde_json::from_slice(frame).map_err(|_| PiTransportError::InvalidMessage)?;
            parse_message(value)
        })?;
        if self.messages.len().saturating_add(parsed.len()) > MAX_PI_EVENT_QUEUE {
            return Err(PiTransportError::OutputOverflow);
        }
        for message in parsed {
            if let PiRpcMessage::Response(response) = &message {
                let Some(pending) = &self.pending else {
                    return Err(PiTransportError::MismatchedResponse);
                };
                if response.id != pending.id || response.command != pending.command {
                    return Err(PiTransportError::MismatchedResponse);
                }
                if response.command == "prompt" {
                    self.prompt_accepted = response.success;
                }
                if response.command == "get_state"
                    && response.success
                    && let Some(data) = response
                        .data
                        .as_ref()
                        .and_then(serde_json::Value::as_object)
                {
                    let session_id = data.get("sessionId").and_then(serde_json::Value::as_str);
                    let session_file = data.get("sessionFile").and_then(serde_json::Value::as_str);
                    if let (Some(session_id), Some(session_file)) = (session_id, session_file) {
                        let path = PathBuf::from(session_file);
                        if let Ok(path) = path.canonicalize()
                            && path.starts_with(&self.session_dir)
                        {
                            self.active_session_id = Some(session_id.to_owned());
                            self.active_session_file = Some(path);
                        }
                    }
                }
                self.pending = None;
            }
            if let PiRpcMessage::Event(event) = &message {
                match event.kind() {
                    "agent_start" if self.prompt_requested && !self.prompt_agent_started => {
                        self.prompt_agent_started = true;
                    }
                    "agent_end" if self.prompt_agent_started && !self.prompt_agent_ended => {
                        self.prompt_agent_ended = true;
                    }
                    _ => (),
                }
            }
            self.messages.push_back(message);
        }
        Ok(())
    }
}

fn project_terminal_output(
    assistant: &PiSessionEntry,
) -> Result<(PiTurnStatus, Option<String>), PiTransportError> {
    let status = match assistant.stop_reason() {
        Some("stop" | "length") => PiTurnStatus::Completed,
        Some("aborted") => PiTurnStatus::Interrupted,
        Some("error") => PiTurnStatus::Failed,
        Some("toolUse") => return Err(PiTransportError::UnsupportedOutput),
        _ => return Err(PiTransportError::InvalidMessage),
    };
    let final_text = if status == PiTurnStatus::Completed {
        let text = assistant
            .final_text()
            .map_err(|_| PiTransportError::UnsupportedOutput)?;
        if text.is_empty() {
            return Err(PiTransportError::UnsupportedOutput);
        }
        Some(text.to_owned())
    } else {
        None
    };
    Ok((status, final_text))
}

fn project_exact_turn<'a>(
    tree: &'a PiSessionTree,
    prior_leaf_id: Option<&str>,
    input_text: &str,
) -> Result<
    (
        &'a PiSessionEntry,
        &'a PiSessionEntry,
        PiTurnStatus,
        Option<String>,
    ),
    PiTransportError,
> {
    let (input, assistant) = tree
        .exact_completed_turn(prior_leaf_id, input_text)
        .ok_or(PiTransportError::InvalidMessage)?;
    if tree.has_tool_content_between(input, assistant) {
        return Err(PiTransportError::UnsupportedOutput);
    }
    let (status, final_text) = project_terminal_output(assistant)?;
    Ok((input, assistant, status, final_text))
}

fn validate_launch(mut launch: ProcessLaunch) -> Result<ProcessLaunch, PiTransportError> {
    for path in [
        &mut launch.node_executable,
        &mut launch.pi_cli_entry,
        &mut launch.process_host,
        &mut launch.runtime_root,
        &mut launch.isolated_home,
        &mut launch.session_dir,
        &mut launch.cwd,
    ] {
        if !path.is_absolute() {
            return Err(PiTransportError::InvalidLaunch);
        }
    }
    if launch.run_id.is_empty()
        || launch.attempt_id.is_empty()
        || launch.owner_token.is_empty()
        || launch.provider.is_empty()
        || launch.model.is_empty()
        || launch.env.keys().any(|name| {
            name.is_empty()
                || name.contains('=')
                || name.chars().any(char::is_control)
                || matches!(
                    name.as_str(),
                    "HOME" | "USERPROFILE" | "PI_CODING_AGENT_DIR" | "PI_CODING_AGENT_SESSION_DIR"
                )
        })
    {
        return Err(PiTransportError::InvalidLaunch);
    }
    for (path, file_expected) in [
        (&mut launch.node_executable, true),
        (&mut launch.pi_cli_entry, true),
        (&mut launch.process_host, true),
        (&mut launch.runtime_root, false),
        (&mut launch.isolated_home, false),
        (&mut launch.session_dir, false),
        (&mut launch.cwd, false),
    ] {
        *path = path
            .canonicalize()
            .map_err(|_| PiTransportError::InvalidLaunch)?;
        if file_expected && !path.is_file() || !file_expected && !path.is_dir() {
            return Err(PiTransportError::InvalidLaunch);
        }
    }
    if !launch.session_dir.starts_with(&launch.isolated_home) {
        return Err(PiTransportError::InvalidLaunch);
    }
    if let Some(path) = &mut launch.resume_session_file {
        if !path.is_absolute() {
            return Err(PiTransportError::InvalidLaunch);
        }
        *path = path
            .canonicalize()
            .map_err(|_| PiTransportError::InvalidLaunch)?;
        if !path.is_file() || path.parent() != Some(launch.session_dir.as_path()) {
            return Err(PiTransportError::InvalidLaunch);
        }
    }
    if let Some(path) = &mut launch.system_prompt_file {
        if !path.is_absolute() {
            return Err(PiTransportError::InvalidLaunch);
        }
        *path = path
            .canonicalize()
            .map_err(|_| PiTransportError::InvalidLaunch)?;
        if !path.is_file() || !path.starts_with(&launch.isolated_home) {
            return Err(PiTransportError::InvalidLaunch);
        }
    }
    Ok(launch)
}

fn parse_message(value: Value) -> Result<PiRpcMessage, PiTransportError> {
    let object = value.as_object().ok_or(PiTransportError::InvalidMessage)?;
    match object.get("type").and_then(Value::as_str) {
        Some("response") => {
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 128)
                .ok_or(PiTransportError::InvalidMessage)?;
            let command = object
                .get("command")
                .and_then(Value::as_str)
                .filter(|value| value.len() <= 64)
                .ok_or(PiTransportError::InvalidMessage)?;
            let success = object
                .get("success")
                .and_then(Value::as_bool)
                .ok_or(PiTransportError::InvalidMessage)?;
            Ok(PiRpcMessage::Response(PiResponse {
                id: id.to_owned(),
                command: command.to_owned(),
                success,
                data: object.get("data").cloned(),
            }))
        }
        Some(kind) if is_known_event(kind) => {
            if kind != "extension_ui_request" && object.contains_key("id") {
                return Err(PiTransportError::InvalidMessage);
            }
            if object.len() > 64 {
                return Err(PiTransportError::InvalidMessage);
            }
            Ok(PiRpcMessage::Event(PiEvent {
                kind: kind.to_owned(),
                value,
            }))
        }
        _ => Err(PiTransportError::InvalidMessage),
    }
}

fn is_known_event(kind: &str) -> bool {
    matches!(
        kind,
        "agent_start"
            | "session"
            | "agent_end"
            | "turn_start"
            | "turn_end"
            | "message_start"
            | "message_update"
            | "message_end"
            | "tool_execution_start"
            | "tool_execution_update"
            | "tool_execution_end"
            | "queue_update"
            | "compaction_start"
            | "compaction_end"
            | "auto_retry_start"
            | "auto_retry_end"
            | "extension_error"
            | "extension_ui_request"
    )
}

fn map_host_error(error: HostError) -> PiTransportError {
    match error {
        HostError::InvalidLaunch => PiTransportError::InvalidLaunch,
        HostError::Closed => PiTransportError::Closed,
        HostError::Timeout => PiTransportError::Timeout,
        HostError::OutputOverflow => PiTransportError::OutputOverflow,
    }
}

#[allow(dead_code)]
fn _is_absolute(path: &Path) -> bool {
    path.is_absolute()
}

#[cfg(test)]
mod tests {
    use super::{
        PiCommand, PiRpcMessage, PiTransportError, parse_message, project_exact_turn,
        project_terminal_output,
    };
    use crate::{PiSessionTree, PiSessionTreeError, PiTurnStatus};
    use serde_json::json;

    fn fixture_session_header() -> String {
        json!({
            "type": "session",
            "version": 3,
            "id": "session-uuid",
            "cwd": std::env::current_dir()
                .expect("test working directory")
                .to_string_lossy()
                .into_owned(),
        })
        .to_string()
    }

    fn assistant_entry(content: &str, stop_reason: &str) -> (tempfile::TempDir, PiSessionTree) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        let header = fixture_session_header();
        std::fs::write(
            &path,
            format!(
                "{header}\n{{\"type\":\"message\",\"id\":\"aaaaaaaa\",\"parentId\":null,\"message\":{{\"role\":\"assistant\",\"content\":{content},\"stopReason\":\"{stop_reason}\"}}}}\n"
            ),
        )
        .unwrap();
        let tree = PiSessionTree::read(&path, directory.path()).unwrap();
        (directory, tree)
    }

    #[test]
    fn terminal_projection_strips_thinking_and_rejects_tool_use_and_mixed_blocks() {
        let (_directory, tree) = assistant_entry(
            r#"[{"type":"thinking","thinking":"private"},{"type":"text","text":"answer"}]"#,
            "stop",
        );
        let (status, text) = project_terminal_output(tree.entry("aaaaaaaa").unwrap()).unwrap();
        assert_eq!(status, PiTurnStatus::Completed);
        assert_eq!(text.as_deref(), Some("answer"));

        let (_directory, tree) = assistant_entry(
            r#"[{"type":"text","text":"visible"},{"type":"image","data":"AQID","mimeType":"image/png"}]"#,
            "stop",
        );
        assert_eq!(
            project_terminal_output(tree.entry("aaaaaaaa").unwrap()),
            Err(PiTransportError::UnsupportedOutput)
        );

        let (_directory, tree) = assistant_entry(
            r#"[{"type":"text","text":"before tool"},{"type":"toolCall","id":"c1","name":"read","arguments":{}}]"#,
            "toolUse",
        );
        assert_eq!(
            project_terminal_output(tree.entry("aaaaaaaa").unwrap()),
            Err(PiTransportError::UnsupportedOutput)
        );
    }

    #[test]
    fn tool_call_and_tool_result_on_the_submitted_turn_cannot_be_flattened_to_text() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        let mut fixture = fixture_session_header();
        fixture.push('\n');
        fixture.push_str(concat!(
            "{\"type\":\"message\",\"id\":\"bbbbbbbb\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"x\"}}\n",
            "{\"type\":\"message\",\"id\":\"cccccccc\",\"parentId\":\"bbbbbbbb\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"c1\",\"name\":\"read\",\"arguments\":{}}],\"stopReason\":\"toolUse\"}}\n",
            "{\"type\":\"message\",\"id\":\"dddddddd\",\"parentId\":\"cccccccc\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"c1\",\"content\":[{\"type\":\"text\",\"text\":\"result\"}],\"isError\":false}}\n",
            "{\"type\":\"message\",\"id\":\"eeeeeeee\",\"parentId\":\"dddddddd\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"answer\"}],\"stopReason\":\"stop\"}}\n"
        ));
        std::fs::write(&path, fixture).unwrap();
        let tree = PiSessionTree::read(&path, directory.path()).unwrap();
        assert_eq!(
            project_exact_turn(&tree, None, "x").map(|(_, _, status, text)| (status, text)),
            Err(PiTransportError::UnsupportedOutput)
        );
    }

    #[test]
    fn unknown_content_blocks_fail_closed_before_terminal_projection() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        let mut fixture = fixture_session_header();
        fixture.push('\n');
        fixture.push_str(concat!(
            "{\"type\":\"message\",\"id\":\"aaaaaaaa\",\"parentId\":null,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"visible\"},{\"type\":\"future_audio\",\"data\":\"hidden\"}],\"stopReason\":\"stop\"}}\n"
        ));
        std::fs::write(&path, fixture).unwrap();
        assert_eq!(
            PiSessionTree::read(&path, directory.path()).err(),
            Some(PiSessionTreeError::UnsupportedContent)
        );
    }

    #[test]
    fn rpc_command_wire_uses_installed_pi_names_and_fields() {
        let cases = [
            (PiCommand::NewSession, json!({"type":"new_session"})),
            (
                PiCommand::SwitchSession("/private/session.jsonl"),
                json!({"type":"switch_session","sessionPath":"/private/session.jsonl"}),
            ),
            (PiCommand::GetState, json!({"type":"get_state"})),
            (
                PiCommand::SetModel {
                    provider: "openrouter",
                    model_id: "vendor/model",
                },
                json!({"type":"set_model","provider":"openrouter","modelId":"vendor/model"}),
            ),
            (
                PiCommand::SetThinkingLevel("high"),
                json!({"type":"set_thinking_level","level":"high"}),
            ),
            (
                PiCommand::Prompt("synthetic"),
                json!({"type":"prompt","message":"synthetic"}),
            ),
            (PiCommand::Abort, json!({"type":"abort"})),
        ];
        for (command, expected) in cases {
            assert_eq!(command.name(), expected["type"]);
            assert_eq!(command.fields(), ObjectWithoutType::take(expected));
        }
    }

    struct ObjectWithoutType;
    impl ObjectWithoutType {
        fn take(mut value: serde_json::Value) -> serde_json::Value {
            value.as_object_mut().unwrap().remove("type");
            value
        }
    }

    #[test]
    fn rpc_responses_events_and_unknown_shapes_are_checked() {
        match parse_message(json!({"type":"response","id":"rudder-pi-0","command":"get_state","success":true,"data":{"sessionId":"pi-session"}})).unwrap() {
            PiRpcMessage::Response(response) => {
                assert_eq!(response.id(), "rudder-pi-0");
                assert_eq!(response.command(), "get_state");
                assert_eq!(response.data().unwrap()["sessionId"], "pi-session");
            }
            PiRpcMessage::Event(_) => panic!("response classified as event"),
        }
        // Events are explicitly id-free in the installed RPC contract.
        match parse_message(json!({"type":"session","sessionId":"pi-session","cwd":"/managed"}))
            .unwrap()
        {
            PiRpcMessage::Event(event) => assert_eq!(event.kind(), "session"),
            PiRpcMessage::Response(_) => panic!("session classified as response"),
        }
        for value in [
            json!({"type":"mystery_event"}),
            json!({"type":"response","id":"x","command":"get_state","success":"yes"}),
            json!({"type":"message_update","id":"not-an-event-id"}),
        ] {
            assert!(parse_message(value).is_err());
        }
    }
}
