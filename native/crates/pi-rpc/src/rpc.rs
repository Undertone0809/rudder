use crate::session::PiSessionEntry;
use crate::strict_json::StrictValue;
use crate::{PiCleanupReceipt, PiSessionTree, PiTurnReceipt, PiTurnStatus};
use rudder_native_process_transport::{
    ConnectionIdentity, ConnectionLaunchPermit, ConnectionReceipt, HostCleanupProof,
    HostConnection, HostError, HostEvent, OwnedHost,
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
// A Pi authority hook is backed by a bounded D1 operation of at most one
// second. Keep one full receive interval after the last possible hook so a
// terminal lifecycle event emitted while that hook is running can be drained.
const PI_CLEANUP_HOOK_BUDGET: Duration = Duration::from_secs(1);
const PI_CLEANUP_TERMINAL_DRAIN_RESERVE: Duration = Duration::from_secs(1);

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
    #[error("Pi RPC message failed static validation")]
    InvalidMessageAt(PiInvalidMessageStage),
    /// The owned process host reported a launch/runtime failure. This does
    /// not state whether a provider received an input; the caller still needs
    /// the independent terminal and cleanup receipts for that conclusion.
    #[error("Pi process host reported a failure")]
    HostFailure,
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

/// Payload-free location for a Pi transport validation failure.
///
/// These categories deliberately do not retain or format provider frames,
/// event names, session identifiers, or host error details.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PiInvalidMessageStage {
    HostIdentity,
    HostKind,
    HostState,
    HostFields,
    StdoutFrame,
    StdoutJson,
    RpcShape,
    RpcResponseFields,
    RpcUnknownEvent,
    RpcEventFields,
    SessionBinding,
    ControlState,
    OutboundFrame,
    TurnObservation,
    TerminalShape,
}

impl PiInvalidMessageStage {
    /// Stable lower-case diagnostic identifier suitable for bounded run
    /// metadata. It contains no observed input.
    pub const fn diagnostic_code(self) -> &'static str {
        match self {
            Self::HostIdentity => "pi_invalid_host_identity",
            Self::HostKind => "pi_invalid_host_kind",
            Self::HostState => "pi_invalid_host_state",
            Self::HostFields => "pi_invalid_host_fields",
            Self::StdoutFrame => "pi_invalid_stdout_frame",
            Self::StdoutJson => "pi_invalid_stdout_json",
            Self::RpcShape => "pi_invalid_rpc_shape",
            Self::RpcResponseFields => "pi_invalid_rpc_response_fields",
            Self::RpcUnknownEvent => "pi_invalid_rpc_unknown_event",
            Self::RpcEventFields => "pi_invalid_rpc_event_fields",
            Self::SessionBinding => "pi_invalid_session_binding",
            Self::ControlState => "pi_invalid_control_state",
            Self::OutboundFrame => "pi_invalid_outbound_frame",
            Self::TurnObservation => "pi_invalid_turn_observation",
            Self::TerminalShape => "pi_invalid_terminal_shape",
        }
    }
}

impl PiTransportError {
    /// Stable diagnostic mapping. Detailed invalid-message categories are
    /// static enum values; no observed data is included.
    pub const fn diagnostic_code(self) -> &'static str {
        match self {
            Self::InvalidLaunch => "pi_invalid_launch",
            Self::Closed => "pi_transport_closed",
            Self::Busy => "pi_transport_busy",
            Self::MismatchedResponse => "pi_mismatched_response",
            Self::Rejected => "pi_transport_rejected",
            Self::InvalidMessage => "pi_invalid_message",
            Self::InvalidMessageAt(stage) => stage.diagnostic_code(),
            Self::HostFailure => "pi_process_host_failure",
            Self::UnsupportedOutput => "pi_unsupported_output",
            Self::OutputOverflow => "pi_output_overflow",
            Self::WriteIndeterminate => "pi_write_indeterminate",
            Self::ProcessExited => "pi_process_exited",
            Self::Timeout => "pi_transport_timeout",
        }
    }
}

impl From<rudder_native_protocol::lines::LineError> for PiTransportError {
    fn from(_: rudder_native_protocol::lines::LineError) -> Self {
        Self::InvalidMessageAt(PiInvalidMessageStage::StdoutFrame)
    }
}

/// Trusted host-built process data. The child starts the installed Pi CLI
/// through its absolute Node executable so the process-host can keep the
/// provider environment isolated without depending on ambient PATH.
pub enum PiProfileMode {
    Managed,
    /// Managed Pi profile whose one system-prompt entry was resolved and
    /// authorized by the Rust host. The provider session remains confined to
    /// the isolated home; only this exact prompt file may live outside it.
    ManagedWithInstructions {
        instruction_file: PathBuf,
    },
    /// The host supplies an instance-owned session root independently of the
    /// operator HOME. Neither path is deserialized from a provider request.
    OperatorNative {
        session_root: PathBuf,
        /// Exact instruction entry resolved and authorized by the Rust host.
        instruction_file: Option<PathBuf>,
    },
}

pub struct ProcessLaunch {
    pub node_executable: PathBuf,
    pub pi_cli_entry: PathBuf,
    pub process_host: PathBuf,
    pub runtime_root: PathBuf,
    pub isolated_home: PathBuf,
    pub session_dir: PathBuf,
    pub profile_mode: PiProfileMode,
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
    host_reported_failure: bool,
    cleanup_proof: Option<HostCleanupProof>,
    session_dir: PathBuf,
    active_session_id: Option<String>,
    active_session_file: Option<PathBuf>,
    active_session_persisted: bool,
    prompt_requested: bool,
    prompt_accepted: bool,
    prompt_agent_started: bool,
    prompt_agent_ended: bool,
    abort_requested: bool,
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
            host_reported_failure: false,
            cleanup_proof: None,
            session_dir,
            active_session_id: None,
            active_session_file: None,
            active_session_persisted: false,
            prompt_requested: false,
            prompt_accepted: false,
            prompt_agent_started: false,
            prompt_agent_ended: false,
            abort_requested: false,
            turn_receipt_taken: false,
        })
    }

    pub fn connection_identity(&self) -> ConnectionIdentity {
        self.host.connection_identity()
    }

    /// Non-authoritative identity for binding a Stop action to this exact
    /// Pi process-host connection. Cleanup and terminal authority remain
    /// available only through their typed receipts.
    pub fn connection_receipt(&self) -> ConnectionReceipt {
        self.host.connection_identity().connection_receipt()
    }

    /// Bind a validated response from this owned RPC connection. A newly
    /// allocated native path is not persistence proof; only a later strict
    /// observation of the same file can authorize a terminal receipt.
    pub fn bind_session_state(
        &mut self,
        session_id: &str,
        session_file: &Path,
        persisted: bool,
    ) -> Result<(), PiTransportError> {
        if !self.spawned
            || self.terminal
            || self.host_failure
            || session_id.is_empty()
            || session_id.len() > 256
            || session_id.chars().any(char::is_control)
            || session_file.parent() != Some(self.session_dir.as_path())
            || session_file
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
            || self
                .active_session_id
                .as_deref()
                .is_some_and(|id| id != session_id)
            || self
                .active_session_file
                .as_deref()
                .is_some_and(|path| path != session_file)
        {
            return Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::SessionBinding,
            ));
        }
        let metadata = std::fs::symlink_metadata(session_file);
        if persisted {
            let metadata = metadata.map_err(|_| {
                PiTransportError::InvalidMessageAt(PiInvalidMessageStage::SessionBinding)
            })?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || session_file.canonicalize().ok().as_deref() != Some(session_file)
            {
                return Err(PiTransportError::InvalidMessageAt(
                    PiInvalidMessageStage::SessionBinding,
                ));
            }
        } else if self.prompt_requested
            || self.active_session_persisted
            || !metadata.is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            || !session_file
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.len() <= 512 && name.ends_with(&format!("_{session_id}.jsonl"))
                })
        {
            return Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::SessionBinding,
            ));
        }
        self.active_session_id = Some(session_id.to_owned());
        self.active_session_file = Some(session_file.to_path_buf());
        self.active_session_persisted = persisted;
        Ok(())
    }

    pub fn wait_spawned(&mut self, timeout: Duration) -> Result<(), PiTransportError> {
        if self.terminal || self.host_reported_failure {
            return Err(self.terminal_error());
        }
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
                        return Err(self.terminal_error());
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
        if self.host_reported_failure {
            return Err(PiTransportError::HostFailure);
        }
        if self.pending.is_some() {
            return Err(PiTransportError::Busy);
        }
        if matches!(&command, PiCommand::Prompt(_))
            && (self.prompt_requested || self.turn_receipt_taken)
        {
            return Err(PiTransportError::Busy);
        }
        if matches!(&command, PiCommand::Abort)
            && (!self.prompt_accepted || self.abort_requested || self.prompt_agent_ended)
        {
            return Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::ControlState,
            ));
        }
        if !self.spawned || self.terminal || self.host_failure {
            return Err(PiTransportError::Closed);
        }
        let id = format!("rudder-pi-{}", self.next_request_id);
        self.next_request_id =
            self.next_request_id
                .checked_add(1)
                .ok_or(PiTransportError::InvalidMessageAt(
                    PiInvalidMessageStage::OutboundFrame,
                ))?;
        let name = command.name();
        if name == "prompt" {
            self.prompt_requested = true;
            self.prompt_accepted = false;
            self.prompt_agent_started = false;
            self.prompt_agent_ended = false;
            self.abort_requested = false;
        } else if name == "abort" {
            // The write may be ambiguous. Never expose a retry on the same
            // connection, even when the host rejects or cannot confirm it.
            self.abort_requested = true;
        }
        let mut value = command.fields();
        let object = value
            .as_object_mut()
            .ok_or(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::OutboundFrame,
            ))?;
        object.insert("type".into(), Value::String(name.into()));
        object.insert("id".into(), Value::String(id.clone()));
        let bytes = serde_json::to_vec(&value).map_err(|_| {
            PiTransportError::InvalidMessageAt(PiInvalidMessageStage::OutboundFrame)
        })?;
        if bytes.len() > MAX_PI_EVENT_JSON_BYTES {
            return Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::OutboundFrame,
            ));
        }
        let mut frame = String::from_utf8(bytes).map_err(|_| {
            PiTransportError::InvalidMessageAt(PiInvalidMessageStage::OutboundFrame)
        })?;
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
                        return Err(self.terminal_error());
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

    fn terminal_error(&self) -> PiTransportError {
        if self.host_reported_failure {
            PiTransportError::HostFailure
        } else {
            PiTransportError::ProcessExited
        }
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
            || !self.active_session_persisted
            || !self.prompt_requested
            || !self.prompt_accepted
            || !self.prompt_agent_started
            || !self.prompt_agent_ended
        {
            return Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::TurnObservation,
            ));
        }
        let view = tree.view();
        if self.active_session_id.as_deref() != Some(view.session_id.as_str())
            || self.active_session_file.as_deref() != Some(view.session_file.as_path())
            || !view.session_file.starts_with(&self.session_dir)
        {
            return Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::SessionBinding,
            ));
        }
        let (input, assistant, status, final_text) =
            project_exact_turn(tree, prior_leaf_id, input_text)?;
        let leaf_id = view
            .leaf_id
            .clone()
            .ok_or(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::TurnObservation,
            ))?;
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
        self.stop_with_grace(Duration::from_millis(500), timeout)
    }

    /// Apply the configured process grace independently of the bounded wait
    /// for the host's terminal cleanup receipt.
    pub fn stop_with_grace(
        &mut self,
        grace: Duration,
        timeout: Duration,
    ) -> Result<(), PiTransportError> {
        self.stop_with_grace_and_hook(grace, timeout, &mut || {})
    }

    /// Apply bounded process grace while allowing the caller to maintain its
    /// independent execution authority. Hook failures are retained by the
    /// caller and must not interrupt receipt collection or host cleanup.
    pub fn stop_with_grace_and_hook(
        &mut self,
        grace: Duration,
        timeout: Duration,
        hook: &mut impl FnMut(),
    ) -> Result<(), PiTransportError> {
        if grace.is_zero() || grace > Duration::from_secs(60) || timeout.is_zero() {
            return Err(PiTransportError::InvalidLaunch);
        }
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
                grace_ms: Some(grace.as_millis() as u64),
            })
            .map_err(map_host_error)?;
        let deadline = Instant::now() + timeout;
        let mut next_hook = Instant::now();
        while !self.terminal {
            let now = Instant::now();
            let remaining = deadline.saturating_duration_since(now);
            if remaining.is_zero() {
                return Err(PiTransportError::Timeout);
            }
            if now >= next_hook {
                if remaining
                    > PI_CLEANUP_HOOK_BUDGET.saturating_add(PI_CLEANUP_TERMINAL_DRAIN_RESERVE)
                {
                    hook();
                    next_hook = Instant::now() + PI_CLEANUP_HOOK_BUDGET;
                } else {
                    // A synchronous authority tick cannot be cancelled once
                    // started. Skip tail ticks and leave the remaining budget
                    // exclusively to dequeue the host's terminal receipt.
                    next_hook = deadline;
                }
                if self.terminal {
                    break;
                }
            }
            let receive_timeout = deadline
                .saturating_duration_since(Instant::now())
                .min(next_hook.saturating_duration_since(Instant::now()));
            match self.host.receive(receive_timeout) {
                Ok(HostEvent::Lifecycle(value)) => self.observe_lifecycle(&value)?,
                Ok(HostEvent::Stdout(bytes)) => self.decode_stdout(&bytes)?,
                Ok(HostEvent::Failure) => return Err(PiTransportError::Closed),
                Err(HostError::Timeout) if Instant::now() < deadline => continue,
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
        self.next_write_id =
            self.next_write_id
                .checked_add(1)
                .ok_or(PiTransportError::InvalidMessageAt(
                    PiInvalidMessageStage::OutboundFrame,
                ))?;
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
                        return Err(PiTransportError::InvalidMessageAt(
                            PiInvalidMessageStage::HostIdentity,
                        ));
                    }
                    // A correlated host error permanently closes normal RPC.
                    // Validate lifecycle order before any write-ACK fast path.
                    self.observe_lifecycle(&value)?;
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
                    if self.terminal {
                        return Err(self.terminal_error());
                    }
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
        let mut state = PiLifecycleState {
            spawned: self.spawned,
            terminal: self.terminal,
            reported_failure: self.host_reported_failure,
        };
        observe_lifecycle_value(value, &self.request_id, &self.owner_token, &mut state)?;
        self.spawned = state.spawned;
        self.terminal = state.terminal;
        self.host_reported_failure = state.reported_failure;
        Ok(())
    }

    fn decode_stdout(&mut self, bytes: &[u8]) -> Result<(), PiTransportError> {
        let parsed = self.decoder.push(bytes, parse_stdout_frame)?;
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

fn parse_stdout_frame(frame: &[u8]) -> Result<PiRpcMessage, PiTransportError> {
    let StrictValue(value) = serde_json::from_slice(frame)
        .map_err(|_| PiTransportError::InvalidMessageAt(PiInvalidMessageStage::StdoutJson))?;
    parse_message(value)
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct PiLifecycleState {
    spawned: bool,
    terminal: bool,
    reported_failure: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PiLifecycleAction {
    Handshake,
    Accepted,
    Spawned,
    ReportedFailure,
    StopAccepted,
    Stopped,
    AppExit,
    Terminal,
    StdinWrite,
}

fn observe_lifecycle_value(
    value: &Value,
    request_id: &str,
    owner_token: &str,
    state: &mut PiLifecycleState,
) -> Result<PiLifecycleAction, PiTransportError> {
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    // The shared owned-host layer validates the one startup handshake
    // (including its protocol version and capabilities) before exposing it.
    if kind == "handshake" {
        return Ok(PiLifecycleAction::Handshake);
    }
    if value.get("requestId").and_then(Value::as_str) != Some(request_id)
        || value.get("ownerToken").and_then(Value::as_str) != Some(owner_token)
    {
        return Err(PiTransportError::InvalidMessageAt(
            PiInvalidMessageStage::HostIdentity,
        ));
    }
    let action = match kind {
        // The host announces acceptance before it spawns the child. Keep this
        // informational and wait for `spawned` before permitting RPC writes.
        "accepted" if !state.spawned && !state.terminal && !state.reported_failure => {
            PiLifecycleAction::Accepted
        }
        "spawned" if !state.spawned && !state.terminal && !state.reported_failure => {
            PiLifecycleAction::Spawned
        }
        "stop-accepted" if state.spawned && !state.terminal => PiLifecycleAction::StopAccepted,
        "stopped" if state.spawned && !state.terminal => PiLifecycleAction::Stopped,
        "app-exit" if state.spawned && !state.terminal => PiLifecycleAction::AppExit,
        // Process-host launch/preflight errors are followed by a terminal
        // receipt. Retain only the fact that an error was reported so the
        // caller can drain that receipt without exposing its details.
        "error" if !state.terminal => {
            let valid_code = value
                .get("errorCode")
                .and_then(Value::as_str)
                .is_some_and(|code| !code.is_empty() && code.len() <= 64);
            let valid_message = value
                .get("message")
                .and_then(Value::as_str)
                .is_some_and(|message| !message.is_empty() && message.len() <= 256);
            if !valid_code || !valid_message {
                return Err(PiTransportError::InvalidMessageAt(
                    PiInvalidMessageStage::HostFields,
                ));
            }
            PiLifecycleAction::ReportedFailure
        }
        // A failed launch can terminate before any child was spawned, but
        // only after the host explicitly reported its failure.
        "terminal" if !state.terminal && (state.spawned || state.reported_failure) => {
            PiLifecycleAction::Terminal
        }
        "stdin-write-complete" | "stdin-write-rejected" | "stdin-write-failed"
            if state.spawned && !state.terminal && !state.reported_failure =>
        {
            PiLifecycleAction::StdinWrite
        }
        "accepted"
        | "spawned"
        | "stop-accepted"
        | "stopped"
        | "app-exit"
        | "error"
        | "terminal"
        | "stdin-write-complete"
        | "stdin-write-rejected"
        | "stdin-write-failed" => {
            return Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::HostState,
            ));
        }
        _ => {
            return Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::HostKind,
            ));
        }
    };
    match action {
        PiLifecycleAction::Spawned => state.spawned = true,
        PiLifecycleAction::ReportedFailure => state.reported_failure = true,
        PiLifecycleAction::Terminal => state.terminal = true,
        _ => (),
    }
    Ok(action)
}

fn project_terminal_output(
    assistant: &PiSessionEntry,
) -> Result<(PiTurnStatus, Option<String>), PiTransportError> {
    let status = match assistant.stop_reason() {
        Some("stop" | "length") => PiTurnStatus::Completed,
        Some("aborted") => PiTurnStatus::Interrupted,
        Some("error") => PiTurnStatus::Failed,
        Some("toolUse") => return Err(PiTransportError::UnsupportedOutput),
        _ => {
            return Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::TerminalShape,
            ));
        }
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
    let (input, assistant) = tree.exact_completed_turn(prior_leaf_id, input_text).ok_or(
        PiTransportError::InvalidMessageAt(PiInvalidMessageStage::TurnObservation),
    )?;
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
    if matches!(
        &launch.profile_mode,
        PiProfileMode::ManagedWithInstructions { .. }
    ) && launch.system_prompt_file.is_none()
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
    match &mut launch.profile_mode {
        PiProfileMode::Managed | PiProfileMode::ManagedWithInstructions { .. }
            if !launch.session_dir.starts_with(&launch.isolated_home) =>
        {
            return Err(PiTransportError::InvalidLaunch);
        }
        PiProfileMode::OperatorNative { session_root, .. } => {
            for directory in [
                launch.isolated_home.join(".pi"),
                launch.isolated_home.join(".pi/agent"),
            ] {
                let metadata = std::fs::symlink_metadata(&directory)
                    .map_err(|_| PiTransportError::InvalidLaunch)?;
                if !metadata.is_dir()
                    || metadata.file_type().is_symlink()
                    || !directory
                        .canonicalize()
                        .map_err(|_| PiTransportError::InvalidLaunch)?
                        .starts_with(&launch.isolated_home)
                {
                    return Err(PiTransportError::InvalidLaunch);
                }
            }
            let metadata = std::fs::symlink_metadata(&session_root)
                .map_err(|_| PiTransportError::InvalidLaunch)?;
            if !session_root.is_absolute()
                || !metadata.is_dir()
                || metadata.file_type().is_symlink()
            {
                return Err(PiTransportError::InvalidLaunch);
            }
            *session_root = session_root
                .canonicalize()
                .map_err(|_| PiTransportError::InvalidLaunch)?;
            if launch.session_dir != *session_root {
                return Err(PiTransportError::InvalidLaunch);
            }
        }
        PiProfileMode::Managed | PiProfileMode::ManagedWithInstructions { .. } => {}
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
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|_| PiTransportError::InvalidLaunch)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(PiTransportError::InvalidLaunch);
        }
        *path = path
            .canonicalize()
            .map_err(|_| PiTransportError::InvalidLaunch)?;
        let allowed = match &launch.profile_mode {
            PiProfileMode::Managed => path.starts_with(&launch.isolated_home),
            PiProfileMode::ManagedWithInstructions { instruction_file }
            | PiProfileMode::OperatorNative {
                instruction_file: Some(instruction_file),
                ..
            } => exact_instruction_file(instruction_file, path),
            PiProfileMode::OperatorNative {
                instruction_file: None,
                ..
            } => false,
        };
        if !path.is_file() || !allowed {
            return Err(PiTransportError::InvalidLaunch);
        }
    }
    Ok(launch)
}

fn exact_instruction_file(expected: &Path, actual: &Path) -> bool {
    expected.is_absolute()
        && std::fs::symlink_metadata(expected)
            .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        && expected.canonicalize().ok().as_deref() == Some(actual)
}

fn parse_message(value: Value) -> Result<PiRpcMessage, PiTransportError> {
    let object = value.as_object().ok_or(PiTransportError::InvalidMessageAt(
        PiInvalidMessageStage::RpcShape,
    ))?;
    match object.get("type").and_then(Value::as_str) {
        Some("response") => {
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 128)
                .ok_or(PiTransportError::InvalidMessageAt(
                    PiInvalidMessageStage::RpcResponseFields,
                ))?;
            let command = object
                .get("command")
                .and_then(Value::as_str)
                .filter(|value| value.len() <= 64)
                .ok_or(PiTransportError::InvalidMessageAt(
                    PiInvalidMessageStage::RpcResponseFields,
                ))?;
            let success = object.get("success").and_then(Value::as_bool).ok_or(
                PiTransportError::InvalidMessageAt(PiInvalidMessageStage::RpcResponseFields),
            )?;
            Ok(PiRpcMessage::Response(PiResponse {
                id: id.to_owned(),
                command: command.to_owned(),
                success,
                data: object.get("data").cloned(),
            }))
        }
        Some(kind) if is_known_event(kind) => {
            if kind != "extension_ui_request" && object.contains_key("id") {
                return Err(PiTransportError::InvalidMessageAt(
                    PiInvalidMessageStage::RpcEventFields,
                ));
            }
            if object.len() > 64 {
                return Err(PiTransportError::InvalidMessageAt(
                    PiInvalidMessageStage::RpcEventFields,
                ));
            }
            Ok(PiRpcMessage::Event(PiEvent {
                kind: kind.to_owned(),
                value,
            }))
        }
        Some(_) => Err(PiTransportError::InvalidMessageAt(
            PiInvalidMessageStage::RpcUnknownEvent,
        )),
        None => Err(PiTransportError::InvalidMessageAt(
            PiInvalidMessageStage::RpcShape,
        )),
    }
}

fn is_known_event(kind: &str) -> bool {
    matches!(
        kind,
        "agent_start"
            | "agent_settled"
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
            | "session_info_changed"
            | "thinking_level_changed"
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
        PiCommand, PiInvalidMessageStage, PiLifecycleAction, PiLifecycleState, PiRpcMessage,
        PiTransportError, observe_lifecycle_value, parse_message, parse_stdout_frame,
        project_exact_turn, project_terminal_output,
    };
    use crate::{PiSessionTree, PiSessionTreeError, PiTurnStatus};
    use serde_json::json;

    fn profile_launch(root: &std::path::Path) -> super::ProcessLaunch {
        for directory in [
            "home/.pi/agent",
            "home/.pi/sessions",
            "runtime",
            "workspace",
            "owned-sessions",
        ] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        let executable = std::env::current_exe().unwrap();
        super::ProcessLaunch {
            node_executable: executable.clone(),
            pi_cli_entry: executable.clone(),
            process_host: executable,
            runtime_root: root.join("runtime"),
            isolated_home: root.join("home"),
            session_dir: root.join("home/.pi/sessions"),
            profile_mode: super::PiProfileMode::Managed,
            resume_session_file: None,
            system_prompt_file: None,
            cwd: root.join("workspace"),
            provider: "test".into(),
            model: "test".into(),
            thinking: None,
            run_id: "run".into(),
            attempt_id: "attempt".into(),
            owner_token: "owner".into(),
            env: Default::default(),
        }
    }

    #[test]
    fn operator_launch_requires_exact_owned_session_and_host_resolved_instruction_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let mut managed = profile_launch(&root);
        managed.session_dir = root.join("owned-sessions");
        assert!(matches!(
            super::validate_launch(managed),
            Err(PiTransportError::InvalidLaunch)
        ));

        let instruction = root.join("workspace/AGENTS.md");
        let other = root.join("workspace/OTHER.md");
        std::fs::write(&instruction, "Trusted entry").unwrap();
        std::fs::write(&other, "Not selected").unwrap();
        for (session_name, prompt, valid) in [
            ("owned-sessions", instruction.clone(), true),
            ("home/.pi/sessions", instruction.clone(), false),
            ("owned-sessions", other, false),
        ] {
            let mut launch = profile_launch(&root);
            launch.session_dir = root.join(session_name);
            launch.system_prompt_file = Some(prompt);
            launch.profile_mode = super::PiProfileMode::OperatorNative {
                session_root: root.join("owned-sessions"),
                instruction_file: Some(instruction.clone()),
            };
            assert_eq!(super::validate_launch(launch).is_ok(), valid);
        }
    }

    #[test]
    fn managed_instructions_require_the_exact_host_resolved_file() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let mut launch = profile_launch(&root);
        let instruction = root.join("workspace/AGENTS.md");
        let other = root.join("workspace/OTHER.md");
        std::fs::write(&instruction, "Authorized managed instructions").unwrap();
        std::fs::write(&other, "Different file").unwrap();
        launch.system_prompt_file = Some(instruction.clone());
        launch.profile_mode = super::PiProfileMode::ManagedWithInstructions {
            instruction_file: instruction.clone(),
        };
        assert!(super::validate_launch(launch).is_ok());

        let mut mismatched = profile_launch(&root);
        mismatched.system_prompt_file = Some(other);
        mismatched.profile_mode = super::PiProfileMode::ManagedWithInstructions {
            instruction_file: instruction.clone(),
        };
        assert!(matches!(
            super::validate_launch(mismatched),
            Err(PiTransportError::InvalidLaunch)
        ));

        let mut strict_managed = profile_launch(&root);
        strict_managed.system_prompt_file = Some(instruction);
        assert!(matches!(
            super::validate_launch(strict_managed),
            Err(PiTransportError::InvalidLaunch)
        ));

        let mut external_session = profile_launch(&root);
        external_session.session_dir = root.join("owned-sessions");
        external_session.system_prompt_file = Some(root.join("workspace/AGENTS.md"));
        external_session.profile_mode = super::PiProfileMode::ManagedWithInstructions {
            instruction_file: root.join("workspace/AGENTS.md"),
        };
        assert!(matches!(
            super::validate_launch(external_session),
            Err(PiTransportError::InvalidLaunch)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn operator_launch_rejects_symlinked_provider_session_and_instruction_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        for target in ["home/.pi/agent", "owned-sessions", "workspace/AGENTS.md"] {
            let mut launch = profile_launch(&root);
            let instruction = root.join("workspace/AGENTS.md");
            std::fs::write(&instruction, "Trusted entry").unwrap();
            launch.session_dir = root.join("owned-sessions");
            launch.system_prompt_file = Some(instruction.clone());
            launch.profile_mode = super::PiProfileMode::OperatorNative {
                session_root: launch.session_dir.clone(),
                instruction_file: Some(instruction),
            };
            let target = root.join(target);
            let moved = target.with_extension("original");
            std::fs::rename(&target, &moved).unwrap();
            std::os::unix::fs::symlink(&moved, &target).unwrap();
            assert!(matches!(
                super::validate_launch(launch),
                Err(PiTransportError::InvalidLaunch)
            ));
            std::fs::remove_file(&target).unwrap();
            std::fs::rename(&moved, &target).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn managed_instruction_capability_rejects_symlinked_authority_paths() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let mut launch = profile_launch(&root);
        let instruction = root.join("workspace/AGENTS.md");
        let target = root.join("workspace/REAL.md");
        std::fs::write(&target, "Authorized contents").unwrap();
        std::os::unix::fs::symlink(&target, &instruction).unwrap();
        launch.system_prompt_file = Some(target.clone());
        launch.profile_mode = super::PiProfileMode::ManagedWithInstructions {
            instruction_file: instruction,
        };
        assert!(matches!(
            super::validate_launch(launch),
            Err(PiTransportError::InvalidLaunch)
        ));
    }

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
        fixture.push_str(
            "{\"type\":\"message\",\"id\":\"aaaaaaaa\",\"parentId\":null,\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"visible\"},{\"type\":\"future_audio\",\"data\":\"hidden\"}],\"stopReason\":\"stop\"}}\n",
        );
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
        // This tolerated id-free event is not a response and cannot satisfy a
        // pending command request.
        match parse_message(json!({"type":"session","sessionId":"pi-session","cwd":"/managed"}))
            .unwrap()
        {
            PiRpcMessage::Event(event) => assert_eq!(event.kind(), "session"),
            PiRpcMessage::Response(_) => panic!("session classified as response"),
        }
        match parse_message(json!({"type":"agent_settled"})).unwrap() {
            PiRpcMessage::Event(event) => assert_eq!(event.kind(), "agent_settled"),
            PiRpcMessage::Response(_) => panic!("agent_settled classified as response"),
        }
        for value in [
            json!({"type":"session_info_changed","name":"fixture"}),
            json!({"type":"thinking_level_changed","level":"high"}),
        ] {
            match parse_message(value).unwrap() {
                PiRpcMessage::Event(event) => assert!(matches!(
                    event.kind(),
                    "session_info_changed" | "thinking_level_changed"
                )),
                PiRpcMessage::Response(_) => panic!("session event classified as response"),
            }
        }
        for value in [
            json!({"type":"mystery_event"}),
            json!({"type":"response","id":"x","command":"get_state","success":"yes"}),
            json!({"type":"message_update","id":"not-an-event-id"}),
        ] {
            assert!(parse_message(value).is_err());
        }
    }

    #[test]
    fn rpc_failures_have_static_payload_free_diagnostic_stages() {
        let cases = [
            (json!(null), PiInvalidMessageStage::RpcShape),
            (
                json!({"type": "response", "id": "x"}),
                PiInvalidMessageStage::RpcResponseFields,
            ),
            (
                json!({"type": "future_event"}),
                PiInvalidMessageStage::RpcUnknownEvent,
            ),
            (
                json!({"type": "message_update", "id": "event-id"}),
                PiInvalidMessageStage::RpcEventFields,
            ),
            (
                json!({"type": "session", "id": "session-id"}),
                PiInvalidMessageStage::RpcEventFields,
            ),
        ];
        for (value, expected_stage) in cases {
            assert!(matches!(
                parse_message(value),
                Err(PiTransportError::InvalidMessageAt(stage)) if stage == expected_stage
            ));
            let code = expected_stage.diagnostic_code();
            assert!(code.len() <= 64);
            assert!(
                code.bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
            );
        }
        assert!(matches!(
            parse_stdout_frame(b"{ malformed"),
            Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::StdoutJson
            ))
        ));
    }

    #[test]
    fn rpc_prompt_preflight_error_is_a_correlated_response_not_a_malformed_frame() {
        let message = parse_message(json!({
            "type": "response",
            "id": "rudder-pi-4",
            "command": "prompt",
            "success": false,
            "error": "preflight rejected"
        }))
        .unwrap();
        match message {
            PiRpcMessage::Response(response) => {
                assert_eq!(response.id(), "rudder-pi-4");
                assert_eq!(response.command(), "prompt");
                assert!(!response.success());
                assert!(response.data().is_none());
            }
            PiRpcMessage::Event(_) => panic!("preflight response classified as event"),
        }
    }

    #[test]
    fn extension_ui_request_is_stdout_event_but_response_is_not() {
        assert!(matches!(
            parse_message(json!({
                "type": "extension_ui_request",
                "id": "ui-request",
                "method": "confirm",
                "title": "Confirm",
                "message": "Continue?"
            }))
            .unwrap(),
            PiRpcMessage::Event(_)
        ));
        assert!(matches!(
            parse_message(json!({
                "type": "extension_ui_response",
                "id": "ui-request",
                "confirmed": true
            })),
            Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::RpcUnknownEvent
            ))
        ));
    }

    #[test]
    fn process_host_error_then_terminal_is_typed_and_keeps_cleanup_path_open() {
        let mut state = PiLifecycleState::default();
        let error = json!({
            "type": "error",
            "requestId": "attempt",
            "ownerToken": "owner",
            "errorCode": "spawn_preflight_failed",
            "message": "spawn_preflight_failed"
        });
        assert_eq!(
            observe_lifecycle_value(&error, "attempt", "owner", &mut state),
            Ok(PiLifecycleAction::ReportedFailure)
        );
        assert!(!state.spawned);
        assert!(!state.terminal);
        assert!(state.reported_failure);

        let terminal = json!({
            "type": "terminal",
            "requestId": "attempt",
            "ownerToken": "owner",
            "status": "failed",
            "cleanupProven": true
        });
        assert_eq!(
            observe_lifecycle_value(&terminal, "attempt", "owner", &mut state),
            Ok(PiLifecycleAction::Terminal)
        );
        assert!(state.terminal);
        assert_eq!(
            PiTransportError::HostFailure.diagnostic_code(),
            "pi_process_host_failure"
        );
        assert!(
            !PiTransportError::HostFailure
                .diagnostic_code()
                .contains("not_submitted")
        );
    }

    #[test]
    fn process_host_failure_never_reopens_launch_or_rpc() {
        let error = json!({"type":"error","requestId":"attempt","ownerToken":"owner",
            "errorCode":"spawn_failed","message":"spawn_failed"});
        for accepted_first in [false, true] {
            let mut state = PiLifecycleState::default();
            if accepted_first {
                observe_lifecycle_value(
                    &json!({"type":"accepted","requestId":"attempt",
                    "ownerToken":"owner"}),
                    "attempt",
                    "owner",
                    &mut state,
                )
                .unwrap();
            }
            observe_lifecycle_value(&error, "attempt", "owner", &mut state).unwrap();
            for kind in ["accepted", "spawned"] {
                assert_eq!(
                    observe_lifecycle_value(
                        &json!({"type":kind,"requestId":"attempt",
                    "ownerToken":"owner"}),
                        "attempt",
                        "owner",
                        &mut state
                    ),
                    Err(PiTransportError::InvalidMessageAt(
                        PiInvalidMessageStage::HostState
                    ))
                );
                assert!(!state.spawned);
                assert!(state.reported_failure);
            }
        }
        let mut state = PiLifecycleState {
            spawned: true,
            ..PiLifecycleState::default()
        };
        observe_lifecycle_value(&error, "attempt", "owner", &mut state).unwrap();
        for kind in [
            "stdin-write-complete",
            "stdin-write-rejected",
            "stdin-write-failed",
        ] {
            assert_eq!(
                observe_lifecycle_value(
                    &json!({"type":kind,"requestId":"attempt",
                "ownerToken":"owner"}),
                    "attempt",
                    "owner",
                    &mut state
                ),
                Err(PiTransportError::InvalidMessageAt(
                    PiInvalidMessageStage::HostState
                ))
            );
        }
        for kind in ["stop-accepted", "stopped", "app-exit", "terminal"] {
            assert!(
                observe_lifecycle_value(
                    &json!({"type":kind,"requestId":"attempt",
                "ownerToken":"owner"}),
                    "attempt",
                    "owner",
                    &mut state
                )
                .is_ok()
            );
        }
        assert!(state.terminal);
        assert!(state.reported_failure);
    }

    #[test]
    fn process_host_lifecycle_validation_distinguishes_identity_kind_and_state() {
        let mut state = PiLifecycleState::default();
        assert_eq!(
            observe_lifecycle_value(
                &json!({"type": "spawned", "requestId": "wrong", "ownerToken": "owner"}),
                "attempt",
                "owner",
                &mut state,
            ),
            Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::HostIdentity
            ))
        );
        assert_eq!(
            observe_lifecycle_value(
                &json!({"type": "future", "requestId": "attempt", "ownerToken": "owner"}),
                "attempt",
                "owner",
                &mut state,
            ),
            Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::HostKind
            ))
        );
        assert_eq!(
            observe_lifecycle_value(
                &json!({"type": "terminal", "requestId": "attempt", "ownerToken": "owner"}),
                "attempt",
                "owner",
                &mut state,
            ),
            Err(PiTransportError::InvalidMessageAt(
                PiInvalidMessageStage::HostState
            ))
        );
    }
}
