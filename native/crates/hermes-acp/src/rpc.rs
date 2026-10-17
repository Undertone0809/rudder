use crate::strict_json::StrictValue;
use rudder_native_process_transport::{
    ConnectionIdentity, ConnectionLaunchPermit, ConnectionReceipt, HostCleanupProof,
    HostConnection, HostError, HostEvent, OwnedHost,
};
use rudder_native_protocol::{Command, ProtocolVersion, lines::LineDecoder};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fmt, fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_MESSAGES: usize = 256;
const MAX_RPC_FRAME: usize = 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 256 * 1024;
const MAX_FINAL_BYTES: usize = 256 * 1024;
pub const MAX_EPHEMERAL_INSTRUCTION_BYTES: usize = 64 * 1024;
const PROTOCOL_VERSION_ACP: u64 = 1;
const INSTRUCTION_BOOTSTRAP_EXIT_CODE: i64 = 78;
const HERMES_INSTRUCTION_PROMPT_ENV: &str = "RUDDER_HERMES_EPHEMERAL_SYSTEM_PROMPT";
const HERMES_INSTRUCTION_ROOT_ENV: &str = "RUDDER_HERMES_PYTHON_ROOT";

#[derive(Clone, Copy, Eq, PartialEq, thiserror::Error)]
pub enum HermesTransportError {
    #[error("Hermes ACP launch is invalid")]
    InvalidLaunch,
    #[error("Hermes ACP child is closed")]
    Closed,
    #[error("Hermes ACP operation deadline expired")]
    Timeout,
    #[error("Hermes ACP process exited before a response")]
    ProcessExited,
    #[error("Hermes ACP JSON-RPC framing or message is invalid")]
    InvalidMessage,
    #[error("Hermes ACP returned an error response")]
    Rejected,
    #[error("Hermes ACP session does not exist")]
    SessionNotFound,
    #[error("Hermes ACP output exceeded the configured bound")]
    OutputOverflow,
    #[error("Hermes ACP prompt write outcome is indeterminate")]
    WriteIndeterminate,
    #[error("Hermes ACP prompt was interrupted")]
    Cancelled,
    #[error("Hermes ACP requested a governed permission decision")]
    ApprovalRequired,
    #[error("Hermes ACP returned unsupported content")]
    UnsupportedOutput,
    #[error("installed Hermes ACP instruction adapter is unsupported")]
    UnsupportedInstructionAdapter,
}
impl fmt::Debug for HermesTransportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}
impl From<rudder_native_protocol::lines::LineError> for HermesTransportError {
    fn from(_: rudder_native_protocol::lines::LineError) -> Self {
        Self::InvalidMessage
    }
}

/// Host-derived process information. Never built from HTTP request fields.
pub struct HermesLaunch {
    pub hermes_executable: PathBuf,
    /// Required only when nonempty Agent instructions need the pinned
    /// ephemeral-system-prompt adapter.
    pub python_executable: Option<PathBuf>,
    /// Validated source root for the selected Hermes installation.
    pub python_source_root: Option<PathBuf>,
    /// Resolved Agent instructions. This is sensitive and never formatted or
    /// serialized by Rust; it is sent only to the owned child environment.
    pub ephemeral_system_prompt: Option<String>,
    pub process_host: PathBuf,
    pub runtime_root: PathBuf,
    pub hermes_home: PathBuf,
    pub cwd: PathBuf,
    pub run_id: String,
    pub attempt_id: String,
    pub owner_token: String,
    /// Captured by the trusted Rust host; never accepted from Agent env.
    pub executable_search_path: String,
    pub env: std::collections::BTreeMap<String, String>,
}

/// Exact local files validated for the narrowly supported Hermes 0.21.0
/// instruction adapter. The paths and fingerprint stay in trusted Rust config;
/// none are returned over the provider protocol.
pub struct HermesInstructionBootstrap {
    python_executable: PathBuf,
    source_root: PathBuf,
    revision: String,
}
impl HermesInstructionBootstrap {
    pub fn python_executable(&self) -> &Path {
        &self.python_executable
    }
    pub fn source_root(&self) -> &Path {
        &self.source_root
    }
    pub fn revision(&self) -> &str {
        &self.revision
    }
}
impl fmt::Debug for HermesInstructionBootstrap {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HermesInstructionBootstrap")
            .field("supported", &true)
            .finish()
    }
}

/// Resolve only the known Hermes console-script wrapper and bundled Python
/// environment used by the ephemeral instruction adapter. Unknown launcher
/// layouts or source API revisions fail closed.
pub fn resolve_instruction_bootstrap(
    hermes_executable: &Path,
) -> Result<HermesInstructionBootstrap, HermesTransportError> {
    const MAX_CODE_FILE_BYTES: u64 = 8 * 1024 * 1024;
    const WRAPPER: &str = "#!/bin/sh\n'''exec' \"$(dirname -- \"$(realpath -- \"$0\")\")\"/'python3' \"$0\" \"$@\"\n' '''\n# -*- coding: utf-8 -*-\nimport sys\nfrom hermes_cli.main import main\nif __name__ == \"__main__\":\n";
    let executable = hermes_executable
        .canonicalize()
        .map_err(|_| HermesTransportError::InvalidLaunch)?;
    let wrapper_metadata =
        fs::metadata(&executable).map_err(|_| HermesTransportError::InvalidLaunch)?;
    if !wrapper_metadata.is_file() || wrapper_metadata.len() > 64 * 1024 {
        return Err(HermesTransportError::InvalidLaunch);
    }
    let wrapper = fs::read(&executable).map_err(|_| HermesTransportError::InvalidLaunch)?;
    if !wrapper.starts_with(WRAPPER.as_bytes()) {
        return Err(HermesTransportError::UnsupportedInstructionAdapter);
    }
    let bin = executable
        .parent()
        .ok_or(HermesTransportError::InvalidLaunch)?
        .canonicalize()
        .map_err(|_| HermesTransportError::InvalidLaunch)?;
    let venv = bin
        .parent()
        .ok_or(HermesTransportError::InvalidLaunch)?
        .canonicalize()
        .map_err(|_| HermesTransportError::InvalidLaunch)?;
    let source_root = venv
        .parent()
        .ok_or(HermesTransportError::InvalidLaunch)?
        .canonicalize()
        .map_err(|_| HermesTransportError::InvalidLaunch)?;
    if !executable.starts_with(&bin) || !bin.starts_with(&venv) || !venv.starts_with(&source_root) {
        return Err(HermesTransportError::InvalidLaunch);
    }
    let python_executable = bin
        .join("python3")
        .canonicalize()
        .map_err(|_| HermesTransportError::UnsupportedInstructionAdapter)?;
    if !is_executable(&python_executable) || !python_executable.starts_with(&venv) {
        return Err(HermesTransportError::UnsupportedInstructionAdapter);
    }

    let relative_files = [
        "hermes_bootstrap.py",
        "hermes_cli/__init__.py",
        "acp_adapter/entry.py",
        "acp_adapter/session.py",
        "agent/agent_init.py",
        "agent/chat_completion_helpers.py",
    ];
    let mut digest = Sha256::new();
    digest.update(b"rudder-hermes-ephemeral-instructions-v1\0");
    digest.update(executable.to_string_lossy().as_bytes());
    digest.update(&wrapper);
    digest.update(python_executable.to_string_lossy().as_bytes());
    let mut version_matches = 0usize;
    for relative in relative_files {
        let path = source_root.join(relative);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| HermesTransportError::UnsupportedInstructionAdapter)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_CODE_FILE_BYTES
        {
            return Err(HermesTransportError::UnsupportedInstructionAdapter);
        }
        let canonical = path
            .canonicalize()
            .map_err(|_| HermesTransportError::UnsupportedInstructionAdapter)?;
        if !canonical.starts_with(&source_root) {
            return Err(HermesTransportError::UnsupportedInstructionAdapter);
        }
        let bytes = fs::read(&canonical)
            .map_err(|_| HermesTransportError::UnsupportedInstructionAdapter)?;
        if bytes.len() as u64 != metadata.len() || bytes.len() as u64 > MAX_CODE_FILE_BYTES {
            return Err(HermesTransportError::UnsupportedInstructionAdapter);
        }
        if relative == "hermes_cli/__init__.py"
            && String::from_utf8_lossy(&bytes)
                .lines()
                .any(|line| line.trim() == "__version__ = \"0.21.0\"")
        {
            version_matches += 1;
        }
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update(&bytes);
        digest.update([0]);
    }
    if version_matches != 1 {
        return Err(HermesTransportError::UnsupportedInstructionAdapter);
    }
    if executable.to_str().is_none()
        || python_executable.to_str().is_none()
        || source_root.to_str().is_none()
    {
        return Err(HermesTransportError::UnsupportedInstructionAdapter);
    }
    Ok(HermesInstructionBootstrap {
        python_executable,
        source_root,
        revision: format!("hermes-instruction-v1:{}", hex_lower(&digest.finalize())),
    })
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(_: &Path) -> bool {
    false
}

/// Exact Hermes ACP session UUID. This is never a Codex Thread ID.
#[derive(Clone, Eq, PartialEq)]
pub struct HermesSessionSelector(String);
impl HermesSessionSelector {
    pub fn from_persisted(value: &str) -> Result<Self, HermesTransportError> {
        let id = Uuid::parse_str(value).map_err(|_| HermesTransportError::InvalidMessage)?;
        if id.hyphenated().to_string() != value {
            return Err(HermesTransportError::InvalidMessage);
        }
        Ok(Self(value.to_owned()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for HermesSessionSelector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HermesSessionSelector")
            .field("has_session_id", &true)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HermesStopReason {
    EndTurn,
    Cancelled,
    Refusal,
    ApprovalRequired,
}

/// Optional ACP token accounting. This is provider usage only, never monetary cost.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct HermesUsage {
    /// ACP declares these as aggregate session usage, not a per-prompt delta.
    pub scope: HermesUsageScope,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub thought_tokens: Option<u64>,
    pub cached_read_tokens: Option<u64>,
    pub cached_write_tokens: Option<u64>,
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum HermesUsageScope {
    #[default]
    SessionCumulative,
}

/// Opaque evidence for one terminal Hermes ACP prompt on an owned connection.
pub struct HermesTurnReceipt {
    identity: ConnectionIdentity,
    session: HermesSessionSelector,
    request_id: u64,
    user_message_id: String,
    input_fingerprint: String,
    final_text: String,
    updates: Vec<Value>,
    stop_reason: HermesStopReason,
    usage: Option<HermesUsage>,
}

/// Opaque proof that this owned ACP connection created a new exact session.
/// D1 can use it to persist a late session/new result after Stop without
/// accepting an arbitrary UUID from a caller.
pub struct HermesSessionStartReceipt {
    identity: ConnectionIdentity,
    session: HermesSessionSelector,
}
impl HermesSessionStartReceipt {
    pub fn session(&self) -> &HermesSessionSelector {
        &self.session
    }
    pub fn connection_receipt_id(&self) -> &str {
        self.identity.connection_receipt_id()
    }
    pub fn correlation(&self) -> String {
        format!("session/new:{}", self.session.as_str())
    }
    pub fn matches_connection_claim(
        &self,
        run_id: &str,
        attempt_id: &str,
        owner_token: &str,
        epoch: i32,
        claim_id: &str,
    ) -> bool {
        self.identity
            .matches_connection_claim(run_id, attempt_id, owner_token, epoch, claim_id)
    }
}
impl fmt::Debug for HermesSessionStartReceipt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HermesSessionStartReceipt")
            .field("has_owned_connection", &true)
            .field("has_session", &true)
            .finish()
    }
}
impl HermesTurnReceipt {
    pub fn session(&self) -> &HermesSessionSelector {
        &self.session
    }
    pub fn request_id(&self) -> u64 {
        self.request_id
    }
    pub fn connection_receipt_id(&self) -> &str {
        self.identity.connection_receipt_id()
    }
    pub fn correlation(&self) -> String {
        format!(
            "session/prompt:{}:{}",
            self.session.as_str(),
            self.request_id
        )
    }
    pub fn user_message_id(&self) -> &str {
        &self.user_message_id
    }
    pub fn input_fingerprint(&self) -> &str {
        &self.input_fingerprint
    }
    pub fn final_text(&self) -> &str {
        &self.final_text
    }
    /// Exact bounded ACP updates from this prompt. These are provider data;
    /// callers must apply a separate public projection before exposing them.
    pub fn updates(&self) -> &[Value] {
        &self.updates
    }
    pub fn stop_reason(&self) -> HermesStopReason {
        self.stop_reason
    }
    pub fn usage(&self) -> Option<HermesUsage> {
        self.usage
    }
    pub fn matches_execution(&self, run_id: &str, attempt_id: &str, owner_token: &str) -> bool {
        self.identity
            .matches_execution(run_id, attempt_id, owner_token)
    }
    pub fn matches_connection_claim(
        &self,
        run_id: &str,
        attempt_id: &str,
        owner_token: &str,
        epoch: i32,
        claim_id: &str,
    ) -> bool {
        self.identity
            .matches_connection_claim(run_id, attempt_id, owner_token, epoch, claim_id)
    }
}
impl fmt::Debug for HermesTurnReceipt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HermesTurnReceipt")
            .field("has_owned_connection", &true)
            .field("has_session", &true)
            .field("request_id", &self.request_id)
            .field("has_user_message_id", &true)
            .field("has_input_fingerprint", &true)
            .field("final_text_bytes", &self.final_text.len())
            .field("update_count", &self.updates.len())
            .field("stop_reason", &self.stop_reason)
            .field("has_usage", &self.usage.is_some())
            .finish()
    }
}

/// Cleanup evidence can only wrap the matching owned-host proof.
pub struct HermesCleanupReceipt {
    proof: HostCleanupProof,
}
impl HermesCleanupReceipt {
    fn new(proof: HostCleanupProof) -> Self {
        Self { proof }
    }
    pub fn matches_execution(&self, run_id: &str, attempt_id: &str, owner_token: &str) -> bool {
        self.proof
            .matches_execution(run_id, attempt_id, owner_token)
    }
    pub fn matches_connection_claim(
        &self,
        run_id: &str,
        attempt_id: &str,
        owner_token: &str,
        epoch: i32,
        claim_id: &str,
    ) -> bool {
        self.proof
            .matches_connection_claim(run_id, attempt_id, owner_token, epoch, claim_id)
    }
    pub fn proves_quiescence_for(&self, turn: &HermesTurnReceipt) -> bool {
        self.proof.matches_identity(&turn.identity)
    }
    pub fn connection_receipt_id(&self) -> &str {
        self.proof.connection_receipt_id()
    }
    /// Opaque identity for D1's Stop binding path. This is derived from the
    /// owned-host cleanup proof; callers cannot construct a connection receipt
    /// for a different process or execution fence.
    pub fn connection_receipt(&self) -> ConnectionReceipt {
        self.proof.connection_receipt()
    }
    pub fn evidence_fingerprint(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(b"rudder-hermes-cleanup-v1\0");
        digest.update(self.proof.connection_receipt_id().as_bytes());
        format!("hermes-cleanup-v1:{}", hex_lower(&digest.finalize()))
    }
}
impl fmt::Debug for HermesCleanupReceipt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HermesCleanupReceipt")
            .field("has_owned_host_proof", &true)
            .finish()
    }
}

/// Cloneable cancellation signal. The owned transport sends `session/cancel`
/// from its prompt receive loop, then waits for the correlated prompt response.
#[derive(Clone, Default)]
pub struct HermesCancellation(Arc<AtomicBool>);
impl HermesCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// A single Hermes ACP child and its exclusive protocol stream.
pub struct HermesAcpTransport {
    host: OwnedHost,
    decoder: LineDecoder,
    messages: VecDeque<Message>,
    next_request_id: u64,
    next_write_id: u64,
    request_id: String,
    owner_token: String,
    spawned: bool,
    terminal: bool,
    initialized: bool,
    active_session: Option<HermesSessionSelector>,
    prompt_started: bool,
    turn_receipt_taken: bool,
    instruction_bootstrap_active: bool,
}

impl HermesAcpTransport {
    pub fn launch(
        launch: HermesLaunch,
        permit: ConnectionLaunchPermit,
    ) -> Result<Self, HermesTransportError> {
        let launch = validate_launch(launch)?;
        let instruction_bootstrap_active = launch.ephemeral_system_prompt.is_some();
        let request_id = launch.attempt_id.clone();
        let owner_token = launch.owner_token.clone();
        let mut env = launch.env;
        if env.keys().any(|key| protected_environment_key(key)) {
            return Err(HermesTransportError::InvalidLaunch);
        }
        let home = launch.hermes_home.to_string_lossy().into_owned();
        env.insert("HOME".into(), home.clone());
        env.insert("USERPROFILE".into(), home.clone());
        env.insert("HERMES_HOME".into(), home);
        env.insert("PATH".into(), launch.executable_search_path.clone());
        let (executable, argv) = if let Some(prompt) = launch.ephemeral_system_prompt {
            let python = launch
                .python_executable
                .as_ref()
                .ok_or(HermesTransportError::InvalidLaunch)?;
            let source_root = launch
                .python_source_root
                .as_ref()
                .ok_or(HermesTransportError::InvalidLaunch)?;
            env.insert(HERMES_INSTRUCTION_PROMPT_ENV.into(), prompt);
            env.insert(
                HERMES_INSTRUCTION_ROOT_ENV.into(),
                source_root.to_string_lossy().into_owned(),
            );
            (
                python.to_string_lossy().into_owned(),
                vec![
                    "-I".into(),
                    "-c".into(),
                    include_str!("acp_instruction_bootstrap.py").into(),
                ],
            )
        } else {
            (
                launch.hermes_executable.to_string_lossy().into_owned(),
                vec!["acp".into()],
            )
        };
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
        let command = Command::StartProcess {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(request_id.clone()),
            executable,
            argv,
            cwd: launch.cwd.to_string_lossy().into_owned(),
            env,
            owner_token: Some(owner_token.clone()),
            runtime_root: Some(launch.runtime_root.to_string_lossy().into_owned()),
            stdin: None,
            interactive_stdin: true,
            grace_ms: Some(1000),
        };
        command
            .validate()
            .map_err(|_| HermesTransportError::InvalidLaunch)?;
        host.send(command).map_err(map_host_error)?;
        Ok(Self {
            host,
            decoder: LineDecoder::default(),
            messages: VecDeque::new(),
            next_request_id: 0,
            next_write_id: 0,
            request_id,
            owner_token,
            spawned: false,
            terminal: false,
            initialized: false,
            active_session: None,
            prompt_started: false,
            turn_receipt_taken: false,
            instruction_bootstrap_active,
        })
    }

    pub fn connection_identity(&self) -> ConnectionIdentity {
        self.host.connection_identity()
    }

    pub fn connection_receipt(&self) -> ConnectionReceipt {
        self.host.connection_identity().connection_receipt()
    }

    /// The next locally allocated JSON-RPC request identifier. Callers may
    /// commit this value to the durable checkpoint before an input effect.
    pub fn next_request_id(&self) -> u64 {
        self.next_request_id
    }

    pub fn wait_spawned(&mut self, timeout: Duration) -> Result<(), HermesTransportError> {
        let deadline = Instant::now() + timeout;
        while !self.spawned {
            self.receive_until(deadline)?;
        }
        Ok(())
    }

    pub fn initialize(&mut self, timeout: Duration) -> Result<(), HermesTransportError> {
        if !self.spawned || self.initialized {
            return Err(HermesTransportError::InvalidMessage);
        }
        let result = self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION_ACP,
                "clientInfo": {"name":"rudder-native-chat","version":"0.1"},
                "clientCapabilities": {}
            }),
            None,
            Instant::now() + timeout,
        )?;
        if result.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION_ACP)
            || result
                .pointer("/agentCapabilities/loadSession")
                .and_then(Value::as_bool)
                != Some(true)
        {
            return Err(HermesTransportError::InvalidMessage);
        }
        self.send_notification("initialized", json!({}), Instant::now() + timeout)?;
        self.initialized = true;
        Ok(())
    }

    pub fn new_session(
        &mut self,
        cwd: &Path,
        timeout: Duration,
    ) -> Result<HermesSessionSelector, HermesTransportError> {
        self.new_session_with_receipt(cwd, timeout)
            .map(|receipt| receipt.session)
    }

    pub fn new_session_with_receipt(
        &mut self,
        cwd: &Path,
        timeout: Duration,
    ) -> Result<HermesSessionStartReceipt, HermesTransportError> {
        if !self.initialized || self.active_session.is_some() || !cwd.is_absolute() || !cwd.is_dir()
        {
            return Err(HermesTransportError::InvalidLaunch);
        }
        let result = self.request(
            "session/new",
            json!({"cwd":cwd.to_string_lossy(),"mcpServers":[]}),
            None,
            Instant::now() + timeout,
        )?;
        let raw = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or(HermesTransportError::InvalidMessage)?;
        let session = HermesSessionSelector::from_persisted(raw)?;
        self.active_session = Some(HermesSessionSelector(raw.to_owned()));
        Ok(HermesSessionStartReceipt {
            identity: self.host.connection_identity(),
            session,
        })
    }

    /// Load only the exact durable session selector. A null response is a
    /// hard miss; unlike ACP `session/resume`, this never creates a session.
    pub fn load_session(
        &mut self,
        session: &HermesSessionSelector,
        cwd: &Path,
        timeout: Duration,
    ) -> Result<(), HermesTransportError> {
        if !self.initialized || self.active_session.is_some() || !cwd.is_absolute() || !cwd.is_dir()
        {
            return Err(HermesTransportError::InvalidLaunch);
        }
        let result = self.request(
            "session/load",
            json!({"cwd":cwd.to_string_lossy(),"sessionId":session.as_str(),"mcpServers":[]}),
            Some(session.as_str()),
            Instant::now() + timeout,
        )?;
        if result.is_null() {
            return Err(HermesTransportError::SessionNotFound);
        }
        self.active_session = Some(HermesSessionSelector(session.0.clone()));
        Ok(())
    }

    /// Apply the exact configured model to the loaded/new session. The ACP
    /// receipt must echo that model so a silent provider fallback is rejected.
    pub fn set_model(
        &mut self,
        model: &str,
        timeout: Duration,
    ) -> Result<(), HermesTransportError> {
        let session = self
            .active_session
            .clone()
            .ok_or(HermesTransportError::InvalidMessage)?;
        if model.trim().is_empty() || model.len() > 512 || model.chars().any(char::is_control) {
            return Err(HermesTransportError::InvalidLaunch);
        }
        let result = self.request(
            "session/set_model",
            json!({"sessionId":session.as_str(),"modelId":model}),
            Some(session.as_str()),
            Instant::now() + timeout,
        )?;
        // Hermes 0.21.0 applies the model successfully but returns an empty
        // result object. Newer ACP builds may echo `modelId`; accept either
        // shape while rejecting an explicit conflicting echo.
        if let Some(echo) = result.get("modelId").and_then(Value::as_str)
            && echo != model
        {
            return Err(HermesTransportError::UnsupportedOutput);
        }
        Ok(())
    }

    pub fn prompt(
        &mut self,
        input: &str,
        message_id: &str,
        cancellation: &HermesCancellation,
        timeout: Duration,
    ) -> Result<HermesTurnReceipt, HermesTransportError> {
        self.prompt_with_poll(input, message_id, cancellation, timeout, |_| true)
    }

    /// Prompt while giving the owning execution a bounded receive-loop hook
    /// for lease renewal and Stop observation. Returning false sends ACP
    /// `session/cancel`; it never claims the prompt itself was terminal.
    pub fn prompt_with_poll<F>(
        &mut self,
        input: &str,
        message_id: &str,
        cancellation: &HermesCancellation,
        timeout: Duration,
        mut poll_owner: F,
    ) -> Result<HermesTurnReceipt, HermesTransportError>
    where
        F: FnMut(&HermesCancellation) -> bool,
    {
        let session = self
            .active_session
            .as_ref()
            .ok_or(HermesTransportError::InvalidMessage)?
            .clone();
        if !self.initialized
            || self.prompt_started
            || self.turn_receipt_taken
            || input.trim().is_empty()
            || input.len() > MAX_PROMPT_BYTES
        {
            return Err(HermesTransportError::InvalidLaunch);
        }
        let parsed_message_id =
            Uuid::parse_str(message_id).map_err(|_| HermesTransportError::InvalidLaunch)?;
        if parsed_message_id.hyphenated().to_string() != message_id {
            return Err(HermesTransportError::InvalidLaunch);
        }
        if cancellation.0.load(Ordering::Acquire) {
            return Err(HermesTransportError::Cancelled);
        }
        self.prompt_started = true;
        let request_id = self.next_request_id;
        let deadline = Instant::now() + timeout;
        let prompt_json = json!({
            "sessionId":session.as_str(),
            "messageId":message_id,
            "prompt":[{"type":"text","text":input}]
        });
        let id = self.send_request("session/prompt", prompt_json, deadline)?;
        let mut final_text = String::new();
        let mut message_id_seen: Option<String> = None;
        let mut updates = Vec::new();
        let mut update_bytes = 0usize;
        let mut approval_required = false;
        let mut cancel_sent = false;
        loop {
            if !poll_owner(cancellation) {
                cancellation.cancel();
            }
            if cancellation.0.load(Ordering::Acquire) && !cancel_sent {
                self.send_notification(
                    "session/cancel",
                    json!({"sessionId":session.as_str()}),
                    deadline,
                )?;
                cancel_sent = true;
            }
            let Some(message) = self.receive_message(deadline, true)? else {
                // A cancelable receive is a bounded poll. Return control to
                // this loop so it can observe cancellation and send
                // `session/cancel`; receive_message must not sleep until the
                // whole request deadline after a cancellation arrives.
                continue;
            };
            match message {
                Message::Response {
                    id: response_id,
                    result: Some(result),
                    error: None,
                } if response_id == id => {
                    let (reason, usage, echoed_message) = parse_prompt_response(&result)?;
                    if echoed_message.is_some_and(|echo| echo != message_id) {
                        return Err(HermesTransportError::InvalidMessage);
                    }
                    let stop_reason = if approval_required {
                        HermesStopReason::ApprovalRequired
                    } else {
                        reason
                    };
                    if stop_reason == HermesStopReason::EndTurn && final_text.trim().is_empty() {
                        return Err(HermesTransportError::UnsupportedOutput);
                    }
                    let identity = self.host.connection_identity();
                    let digest = Sha256::digest(input.as_bytes());
                    let fingerprint = format!("native-chat-v1:{}", hex_lower(&digest));
                    self.turn_receipt_taken = true;
                    return Ok(HermesTurnReceipt {
                        identity,
                        session: HermesSessionSelector(session.0.clone()),
                        request_id,
                        user_message_id: message_id.to_owned(),
                        input_fingerprint: fingerprint,
                        final_text,
                        updates,
                        stop_reason,
                        usage,
                    });
                }
                Message::Response {
                    id: response_id,
                    error: Some(_),
                    ..
                } if response_id == id => return Err(HermesTransportError::Rejected),
                Message::Notification { method, params } if method == "session/update" => {
                    let update_session = params
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .ok_or(HermesTransportError::InvalidMessage)?;
                    if update_session != session.as_str() {
                        return Err(HermesTransportError::InvalidMessage);
                    }
                    let update = params
                        .get("update")
                        .ok_or(HermesTransportError::InvalidMessage)?;
                    let update_size = serde_json::to_vec(update)
                        .map_err(|_| HermesTransportError::InvalidMessage)?
                        .len();
                    update_bytes = update_bytes.saturating_add(update_size);
                    if updates.len() >= MAX_MESSAGES || update_bytes > MAX_RPC_FRAME {
                        return Err(HermesTransportError::OutputOverflow);
                    }
                    updates.push(update.clone());
                    if update.get("sessionUpdate").and_then(Value::as_str)
                        == Some("agent_message_chunk")
                    {
                        let chunk = update
                            .pointer("/content/text")
                            .and_then(Value::as_str)
                            .ok_or(HermesTransportError::UnsupportedOutput)?;
                        if let Some(id) = update.get("messageId").and_then(Value::as_str) {
                            let parsed = Uuid::parse_str(id)
                                .map_err(|_| HermesTransportError::InvalidMessage)?;
                            if parsed.hyphenated().to_string() != id {
                                return Err(HermesTransportError::InvalidMessage);
                            }
                            if message_id_seen
                                .as_deref()
                                .is_some_and(|previous| previous != id)
                            {
                                return Err(HermesTransportError::UnsupportedOutput);
                            }
                            message_id_seen.get_or_insert_with(|| id.to_owned());
                        }
                        if final_text.len().saturating_add(chunk.len()) > MAX_FINAL_BYTES {
                            return Err(HermesTransportError::OutputOverflow);
                        }
                        final_text.push_str(chunk);
                    }
                }
                Message::Request {
                    id: request_id,
                    method,
                    params,
                } if method == "session/request_permission" => {
                    let request_session = params
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .ok_or(HermesTransportError::InvalidMessage)?;
                    if request_session != session.as_str() {
                        return Err(HermesTransportError::InvalidMessage);
                    }
                    approval_required = true;
                    self.send_response(
                        request_id,
                        json!({"outcome":{"outcome":"cancelled"}}),
                        deadline,
                    )?;
                }
                Message::Request { id, .. } => {
                    self.send_error_response(id, -32601, "Method not supported", deadline)?;
                }
                Message::Response { .. } => return Err(HermesTransportError::InvalidMessage),
                Message::Notification { .. } => return Err(HermesTransportError::InvalidMessage),
            }
        }
    }

    /// Prompt only when the provider request ID still equals the precommitted
    /// D1 request ID. This makes a lost/ambiguous write non-replayable.
    pub fn prompt_with_expected_request_id(
        &mut self,
        input: &str,
        message_id: &str,
        expected_request_id: u64,
        cancellation: &HermesCancellation,
        timeout: Duration,
    ) -> Result<HermesTurnReceipt, HermesTransportError> {
        self.prompt_with_expected_request_id_and_poll(
            input,
            message_id,
            expected_request_id,
            cancellation,
            timeout,
            |_| true,
        )
    }

    pub fn prompt_with_expected_request_id_and_poll<F>(
        &mut self,
        input: &str,
        message_id: &str,
        expected_request_id: u64,
        cancellation: &HermesCancellation,
        timeout: Duration,
        poll_owner: F,
    ) -> Result<HermesTurnReceipt, HermesTransportError>
    where
        F: FnMut(&HermesCancellation) -> bool,
    {
        if self.next_request_id != expected_request_id {
            return Err(HermesTransportError::WriteIndeterminate);
        }
        self.prompt_with_poll(input, message_id, cancellation, timeout, poll_owner)
    }

    pub fn take_cleanup_receipt(&mut self) -> Option<HermesCleanupReceipt> {
        self.take_cleanup_proof().map(HermesCleanupReceipt::new)
    }

    pub fn stop(
        &mut self,
        timeout: Duration,
    ) -> Result<HermesCleanupReceipt, HermesTransportError> {
        if !self.terminal {
            self.host
                .send(Command::Stop {
                    protocol_version: Some(ProtocolVersion::default()),
                    request_id: Some(self.request_id.clone()),
                    grace_ms: Some(1000),
                })
                .map_err(map_host_error)?;
            let deadline = Instant::now() + timeout;
            while !self.terminal {
                self.receive_until(deadline)?;
            }
        }
        self.take_cleanup_receipt()
            .ok_or(HermesTransportError::Closed)
    }

    pub fn close(&mut self) {
        self.host.close();
    }

    fn request(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&str>,
        deadline: Instant,
    ) -> Result<Value, HermesTransportError> {
        let id = self.send_request(method, params, deadline)?;
        loop {
            match self
                .receive_message(deadline, false)?
                .ok_or(HermesTransportError::Timeout)?
            {
                Message::Response {
                    id: response_id,
                    result: Some(result),
                    error: None,
                } if response_id == id => {
                    return Ok(result);
                }
                Message::Response {
                    id: response_id,
                    error: Some(_),
                    ..
                } if response_id == id => return Err(HermesTransportError::Rejected),
                Message::Notification { method, params } if method == "session/update" => {
                    if let Some(expected) = session
                        && params.get("sessionId").and_then(Value::as_str) != Some(expected)
                    {
                        return Err(HermesTransportError::InvalidMessage);
                    }
                    // Exact load/new response is the authority; ACP history
                    // replay notifications are bounded but are not treated as
                    // a new prompt or persisted output here.
                }
                Message::Request { id, .. } => {
                    self.send_error_response(id, -32601, "Method not supported", deadline)?
                }
                _ => return Err(HermesTransportError::InvalidMessage),
            }
        }
    }

    fn send_request(
        &mut self,
        method: &str,
        params: Value,
        deadline: Instant,
    ) -> Result<u64, HermesTransportError> {
        let id = self.next_request_id;
        self.next_request_id = self
            .next_request_id
            .checked_add(1)
            .ok_or(HermesTransportError::InvalidMessage)?;
        self.write_json(
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            deadline,
        )?;
        Ok(id)
    }

    fn send_notification(
        &mut self,
        method: &str,
        params: Value,
        deadline: Instant,
    ) -> Result<(), HermesTransportError> {
        self.write_json(
            json!({"jsonrpc":"2.0","method":method,"params":params}),
            deadline,
        )
    }
    fn send_response(
        &mut self,
        id: Value,
        result: Value,
        deadline: Instant,
    ) -> Result<(), HermesTransportError> {
        self.write_json(json!({"jsonrpc":"2.0","id":id,"result":result}), deadline)
    }
    fn send_error_response(
        &mut self,
        id: Value,
        code: i64,
        message: &str,
        deadline: Instant,
    ) -> Result<(), HermesTransportError> {
        self.write_json(
            json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}),
            deadline,
        )
    }

    fn write_json(&mut self, value: Value, deadline: Instant) -> Result<(), HermesTransportError> {
        let mut bytes =
            serde_json::to_vec(&value).map_err(|_| HermesTransportError::InvalidMessage)?;
        if bytes.len().saturating_add(1) > MAX_RPC_FRAME {
            return Err(HermesTransportError::OutputOverflow);
        }
        bytes.push(b'\n');
        self.next_write_id = self
            .next_write_id
            .checked_add(1)
            .ok_or(HermesTransportError::InvalidMessage)?;
        let write_id = format!("hermes-write-{}", self.next_write_id);
        let frame = String::from_utf8(bytes).map_err(|_| HermesTransportError::InvalidMessage)?;
        self.host
            .send(Command::WriteStdin {
                protocol_version: Some(ProtocolVersion::default()),
                request_id: Some(self.request_id.clone()),
                owner_token: Some(self.owner_token.clone()),
                write_id: Some(write_id.clone()),
                data: frame.clone(),
            })
            .map_err(map_host_error)?;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(HermesTransportError::WriteIndeterminate);
            }
            match self.host.receive(remaining) {
                Ok(HostEvent::Lifecycle(value)) => {
                    self.observe_lifecycle(&value)?;
                    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
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
                        return Err(HermesTransportError::Rejected);
                    }
                    if kind == "stdin-write-failed"
                        && value.get("writeId").and_then(Value::as_str) == Some(&write_id)
                    {
                        return Err(HermesTransportError::WriteIndeterminate);
                    }
                }
                Ok(HostEvent::Stdout(data)) => self.decode(&data)?,
                Ok(HostEvent::Failure) => return Err(HermesTransportError::Closed),
                Err(HostError::Timeout) => return Err(HermesTransportError::WriteIndeterminate),
                Err(err) => return Err(map_host_error(err)),
            }
        }
    }

    fn receive_message(
        &mut self,
        deadline: Instant,
        cancelable: bool,
    ) -> Result<Option<Message>, HermesTransportError> {
        if let Some(message) = self.messages.pop_front() {
            return Ok(Some(message));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(HermesTransportError::Timeout);
        }
        match self.host.receive(if cancelable {
            remaining.min(Duration::from_millis(100))
        } else {
            remaining
        }) {
            Ok(HostEvent::Lifecycle(value)) => self.observe_lifecycle(&value)?,
            Ok(HostEvent::Stdout(data)) => self.decode(&data)?,
            Ok(HostEvent::Failure) => return Err(HermesTransportError::Closed),
            Err(HostError::Timeout) if cancelable => return Ok(None),
            Err(err) => return Err(map_host_error(err)),
        }
        Ok(self.messages.pop_front())
    }

    fn receive_until(&mut self, deadline: Instant) -> Result<(), HermesTransportError> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(HermesTransportError::Timeout);
        }
        match self.host.receive(remaining) {
            Ok(HostEvent::Lifecycle(value)) => self.observe_lifecycle(&value),
            Ok(HostEvent::Stdout(data)) => self.decode(&data),
            Ok(HostEvent::Failure) => Err(HermesTransportError::Closed),
            Err(err) => Err(map_host_error(err)),
        }
    }

    fn decode(&mut self, bytes: &[u8]) -> Result<(), HermesTransportError> {
        let messages = self.decoder.push(bytes, |frame| {
            if frame.len() > MAX_RPC_FRAME {
                return Err(HermesTransportError::OutputOverflow);
            }
            let StrictValue(value) =
                serde_json::from_slice(frame).map_err(|_| HermesTransportError::InvalidMessage)?;
            parse_message(value)
        })?;
        if self.messages.len().saturating_add(messages.len()) > MAX_MESSAGES {
            return Err(HermesTransportError::OutputOverflow);
        }
        self.messages.extend(messages);
        Ok(())
    }

    fn observe_lifecycle(&mut self, value: &Value) -> Result<(), HermesTransportError> {
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "handshake" {
            return Ok(());
        }
        if value.get("requestId").and_then(Value::as_str) != Some(&self.request_id)
            || value.get("ownerToken").and_then(Value::as_str) != Some(&self.owner_token)
        {
            return Err(HermesTransportError::InvalidMessage);
        }
        match kind {
            "accepted" if !self.spawned && !self.terminal => Ok(()),
            "spawned" if !self.spawned && !self.terminal => {
                self.spawned = true;
                Ok(())
            }
            "stop-accepted" if self.spawned && !self.terminal => Ok(()),
            "stopped" if self.spawned && !self.terminal => Ok(()),
            "app-exit" if self.spawned && !self.terminal => {
                if self.instruction_bootstrap_active
                    && value.get("code").and_then(Value::as_i64)
                        == Some(INSTRUCTION_BOOTSTRAP_EXIT_CODE)
                {
                    return Err(HermesTransportError::UnsupportedInstructionAdapter);
                }
                Ok(())
            }
            "terminal" if self.spawned && !self.terminal => {
                self.terminal = true;
                Ok(())
            }
            "stdin-write-complete" | "stdin-write-rejected" | "stdin-write-failed" => Ok(()),
            _ => Err(HermesTransportError::InvalidMessage),
        }
    }

    fn take_cleanup_proof(&mut self) -> Option<HostCleanupProof> {
        self.host.take_cleanup_proof()
    }
}

fn validate_launch(launch: HermesLaunch) -> Result<HermesLaunch, HermesTransportError> {
    let canonical_file = |path: &Path| -> Result<PathBuf, HermesTransportError> {
        if !path.is_absolute() {
            return Err(HermesTransportError::InvalidLaunch);
        }
        let canonical = path
            .canonicalize()
            .map_err(|_| HermesTransportError::InvalidLaunch)?;
        if !canonical.is_file() {
            return Err(HermesTransportError::InvalidLaunch);
        }
        Ok(canonical)
    };
    let canonical_dir = |path: &Path| -> Result<PathBuf, HermesTransportError> {
        if !path.is_absolute() {
            return Err(HermesTransportError::InvalidLaunch);
        }
        let canonical = path
            .canonicalize()
            .map_err(|_| HermesTransportError::InvalidLaunch)?;
        if !canonical.is_dir() {
            return Err(HermesTransportError::InvalidLaunch);
        }
        Ok(canonical)
    };
    let hermes_executable = canonical_file(&launch.hermes_executable)?;
    let process_host = canonical_file(&launch.process_host)?;
    let runtime_root = canonical_dir(&launch.runtime_root)?;
    let hermes_home = canonical_dir(&launch.hermes_home)?;
    let cwd = canonical_dir(&launch.cwd)?;
    if launch.executable_search_path.is_empty()
        || launch.executable_search_path.len() > 16_384
        || launch.executable_search_path.contains('\0')
    {
        return Err(HermesTransportError::InvalidLaunch);
    }
    let search_entries =
        std::env::split_paths(std::ffi::OsStr::new(&launch.executable_search_path))
            .collect::<Vec<_>>();
    if search_entries.is_empty()
        || search_entries
            .iter()
            .any(|entry| entry.as_os_str().is_empty() || !entry.is_absolute())
    {
        return Err(HermesTransportError::InvalidLaunch);
    }
    if launch.run_id.is_empty()
        || launch.attempt_id.is_empty()
        || launch.owner_token.is_empty()
        || launch.run_id.len() > 128
        || launch.attempt_id.len() > 128
        || launch.owner_token.len() > 1024
    {
        return Err(HermesTransportError::InvalidLaunch);
    }
    let has_prompt = match launch.ephemeral_system_prompt.as_deref() {
        None => false,
        Some(prompt)
            if !prompt.trim().is_empty()
                && prompt.len() <= MAX_EPHEMERAL_INSTRUCTION_BYTES
                && !prompt.chars().any(|character| character == '\0') =>
        {
            true
        }
        Some(_) => return Err(HermesTransportError::InvalidLaunch),
    };
    match (
        has_prompt,
        launch.python_executable.as_ref(),
        launch.python_source_root.as_ref(),
    ) {
        (true, Some(python), Some(source_root)) => {
            let expected = resolve_instruction_bootstrap(&hermes_executable)?;
            let python = python
                .canonicalize()
                .map_err(|_| HermesTransportError::UnsupportedInstructionAdapter)?;
            let source_root = source_root
                .canonicalize()
                .map_err(|_| HermesTransportError::UnsupportedInstructionAdapter)?;
            if python != expected.python_executable || source_root != expected.source_root {
                return Err(HermesTransportError::UnsupportedInstructionAdapter);
            }
        }
        (false, None, None) => {}
        _ => return Err(HermesTransportError::InvalidLaunch),
    }
    Ok(HermesLaunch {
        hermes_executable,
        process_host,
        runtime_root,
        hermes_home,
        cwd,
        executable_search_path: launch.executable_search_path,
        ..launch
    })
}

fn protected_environment_key(key: &str) -> bool {
    matches!(
        key.to_ascii_uppercase().as_str(),
        "HOME"
            | "USERPROFILE"
            | "HERMES_HOME"
            | "PATH"
            | "PYTHONPATH"
            | "PYTHONHOME"
            | "LD_PRELOAD"
            | "LD_LIBRARY_PATH"
            | "DYLD_INSERT_LIBRARIES"
            | "DYLD_LIBRARY_PATH"
            | "RUDDER_NATIVE_PROCESS_HOST"
            | "RUDDER_NATIVE_RUNTIME_ROOT"
            | "RUDDER_HERMES_PYTHON_ROOT"
            | "RUDDER_HERMES_EPHEMERAL_SYSTEM_PROMPT"
    )
}

fn map_host_error(error: HostError) -> HermesTransportError {
    match error {
        HostError::InvalidLaunch => HermesTransportError::InvalidLaunch,
        HostError::Closed => HermesTransportError::Closed,
        HostError::Timeout => HermesTransportError::Timeout,
        HostError::OutputOverflow => HermesTransportError::OutputOverflow,
    }
}

fn parse_prompt_response(
    value: &Value,
) -> Result<(HermesStopReason, Option<HermesUsage>, Option<&str>), HermesTransportError> {
    if !value.is_object() {
        return Err(HermesTransportError::InvalidMessage);
    }
    let reason = match value.get("stopReason").and_then(Value::as_str) {
        Some("end_turn") => HermesStopReason::EndTurn,
        Some("cancelled") => HermesStopReason::Cancelled,
        Some("refusal") => HermesStopReason::Refusal,
        _ => return Err(HermesTransportError::InvalidMessage),
    };
    let user_message_id = value.get("userMessageId").and_then(Value::as_str);
    let usage = value.get("usage").map(parse_usage).transpose()?;
    Ok((reason, usage, user_message_id))
}
fn parse_usage(value: &Value) -> Result<HermesUsage, HermesTransportError> {
    let obj = value
        .as_object()
        .ok_or(HermesTransportError::InvalidMessage)?;
    let num = |key: &str| -> Result<Option<u64>, HermesTransportError> {
        obj.get(key)
            .map(|value| value.as_u64().ok_or(HermesTransportError::InvalidMessage))
            .transpose()
    };
    Ok(HermesUsage {
        scope: HermesUsageScope::SessionCumulative,
        input_tokens: num("inputTokens")?,
        output_tokens: num("outputTokens")?,
        total_tokens: num("totalTokens")?,
        thought_tokens: num("thoughtTokens")?,
        cached_read_tokens: num("cachedReadTokens")?,
        cached_write_tokens: num("cachedWriteTokens")?,
    })
}
fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

enum Message {
    Response {
        id: Value,
        result: Option<Value>,
        error: Option<Value>,
    },
    Notification {
        method: String,
        params: Value,
    },
    Request {
        id: Value,
        method: String,
        params: Value,
    },
}
fn parse_message(value: Value) -> Result<Message, HermesTransportError> {
    let object = value
        .as_object()
        .ok_or(HermesTransportError::InvalidMessage)?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(HermesTransportError::InvalidMessage);
    }
    let method = object.get("method").and_then(Value::as_str);
    match method {
        Some(method) => {
            if object.contains_key("result") || object.contains_key("error") {
                return Err(HermesTransportError::InvalidMessage);
            }
            if method.is_empty() || method.len() > 256 {
                return Err(HermesTransportError::InvalidMessage);
            }
            let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
            if !params.is_object() && !params.is_array() {
                return Err(HermesTransportError::InvalidMessage);
            }
            if let Some(id) = object.get("id") {
                Ok(Message::Request {
                    id: id.clone(),
                    method: method.to_owned(),
                    params,
                })
            } else {
                Ok(Message::Notification {
                    method: method.to_owned(),
                    params,
                })
            }
        }
        None => {
            let id = object
                .get("id")
                .cloned()
                .ok_or(HermesTransportError::InvalidMessage)?;
            if !(id.is_string() || id.as_i64().is_some() || id.as_u64().is_some()) {
                return Err(HermesTransportError::InvalidMessage);
            }
            if object.contains_key("params") {
                return Err(HermesTransportError::InvalidMessage);
            }
            if object.contains_key("result") == object.contains_key("error") {
                return Err(HermesTransportError::InvalidMessage);
            }
            if let Some(error) = object.get("error")
                && (!error.get("code").is_some_and(Value::is_i64)
                    || !error.get("message").is_some_and(Value::is_string))
            {
                return Err(HermesTransportError::InvalidMessage);
            }
            Ok(Message::Response {
                id,
                result: object.get("result").cloned(),
                error: object.get("error").cloned(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn fixture_search_path() -> String {
        std::env::join_paths([std::env::current_dir().expect("test working directory")])
            .expect("encode test executable search path")
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn parses_acp_method_names_and_correlation_fields() {
        match parse_message(json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}})).unwrap()
        {
            Message::Response {
                id,
                result: Some(value),
                error: None,
            } => {
                assert_eq!(id, 1);
                assert_eq!(value["protocolVersion"], 1);
            }
            _ => panic!("expected correlated response"),
        }
        match parse_message(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{}}})).unwrap() {
            Message::Notification { method, .. } => assert_eq!(method, "session/update"),
            _ => panic!("expected notification"),
        }
    }

    #[test]
    fn rejects_duplicate_fields_bad_jsonrpc_and_ambiguous_response() {
        assert!(serde_json::from_str::<StrictValue>(r#"{"jsonrpc":"2.0","id":1,"id":2}"#).is_err());
        assert!(parse_message(json!({"jsonrpc":"1.0","id":1,"result":null})).is_err());
        assert!(parse_message(json!({"jsonrpc":"2.0","id":1,"result":null,"error":null})).is_err());
    }

    #[test]
    fn session_selector_is_a_canonical_hermes_uuid() {
        let good =
            HermesSessionSelector::from_persisted("550e8400-e29b-41d4-a716-446655440000").unwrap();
        assert_eq!(good.as_str(), "550e8400-e29b-41d4-a716-446655440000");
        assert!(
            HermesSessionSelector::from_persisted("550E8400-E29B-41D4-A716-446655440000").is_err()
        );
        assert!(HermesSessionSelector::from_persisted("thread-123").is_err());
    }

    #[test]
    fn launch_rejects_profile_environment_overrides() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("hermes");
        fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
        let host = temp.path().join("host");
        fs::write(&host, "host").unwrap();
        let launch = HermesLaunch {
            hermes_executable: executable,
            python_executable: None,
            python_source_root: None,
            ephemeral_system_prompt: None,
            process_host: host,
            runtime_root: temp.path().to_path_buf(),
            hermes_home: temp.path().to_path_buf(),
            cwd: temp.path().to_path_buf(),
            run_id: "run".into(),
            attempt_id: "attempt".into(),
            owner_token: "owner".into(),
            executable_search_path: fixture_search_path(),
            env: [("HERMES_HOME".into(), "/attacker".into())]
                .into_iter()
                .collect(),
        };
        assert!(validate_launch(launch).is_ok());
        assert!(protected_environment_key("HERMES_HOME"));
        assert!(protected_environment_key("DYLD_INSERT_LIBRARIES"));
        assert!(!protected_environment_key("HERMES_CUSTOM_SETTING"));
        assert!(protected_environment_key(HERMES_INSTRUCTION_PROMPT_ENV));
        assert!(protected_environment_key(HERMES_INSTRUCTION_ROOT_ENV));
    }

    #[cfg(unix)]
    #[test]
    fn instruction_bootstrap_accepts_only_the_pinned_console_script_layout() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("hermes-agent");
        let bin = root.join("venv/bin");
        fs::create_dir_all(&bin).unwrap();
        let executable = bin.join("hermes");
        let wrapper = "#!/bin/sh\n'''exec' \"$(dirname -- \"$(realpath -- \"$0\")\")\"/'python3' \"$0\" \"$@\"\n' '''\n# -*- coding: utf-8 -*-\nimport sys\nfrom hermes_cli.main import main\nif __name__ == \"__main__\":\n";
        fs::write(&executable, wrapper).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let python = bin.join("python3");
        fs::write(&python, "python").unwrap();
        fs::set_permissions(&python, fs::Permissions::from_mode(0o755)).unwrap();
        for relative in [
            "hermes_bootstrap.py",
            "hermes_cli/__init__.py",
            "acp_adapter/entry.py",
            "acp_adapter/session.py",
            "agent/agent_init.py",
            "agent/chat_completion_helpers.py",
        ] {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let source = if relative == "hermes_cli/__init__.py" {
                "__version__ = \"0.21.0\"\n"
            } else {
                "# pinned fixture\n"
            };
            fs::write(path, source).unwrap();
        }

        let resolved = resolve_instruction_bootstrap(&executable).unwrap();
        assert_eq!(resolved.python_executable(), python.canonicalize().unwrap());
        assert_eq!(resolved.source_root(), root.canonicalize().unwrap());
        assert!(resolved.revision().starts_with("hermes-instruction-v1:"));

        fs::write(&executable, "#!/bin/sh\nexec python3 -m hermes_cli\n").unwrap();
        assert_eq!(
            resolve_instruction_bootstrap(&executable).unwrap_err(),
            HermesTransportError::UnsupportedInstructionAdapter
        );
    }

    /// Exercises real OS process ownership and full ACP request correlation
    /// against a small protocol peer. Set RUDDER_PROCESS_HOST and run this test
    /// explicitly; normal unit tests stay process-free.
    #[test]
    #[ignore = "requires the built rudder-process-host executable"]
    fn owned_fake_acp_process_round_trips_prompt_and_cancel() {
        let process_host = PathBuf::from(std::env::var("RUDDER_PROCESS_HOST").unwrap());
        let temp = tempfile::tempdir().unwrap();
        let hermes = temp.path().join("fake-hermes.py");
        fs::write(&hermes, FAKE_ACP_CHILD).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hermes, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let home = temp.path().join("home");
        fs::create_dir(&home).unwrap();
        let cwd = temp.path();
        let mk_launch = |attempt: &str| HermesLaunch {
            hermes_executable: hermes.clone(),
            python_executable: None,
            python_source_root: None,
            ephemeral_system_prompt: None,
            process_host: process_host.clone(),
            runtime_root: temp.path().to_path_buf(),
            hermes_home: home.clone(),
            cwd: cwd.to_path_buf(),
            run_id: "00000000-0000-4000-8000-000000000001".into(),
            attempt_id: attempt.into(),
            owner_token: format!("owner-{attempt}"),
            executable_search_path: fixture_search_path(),
            env: Default::default(),
        };
        let permit = |attempt: &str| {
            ConnectionLaunchPermit::from_claim(
                "00000000-0000-4000-8000-000000000001".into(),
                attempt.into(),
                format!("owner-{attempt}"),
                1,
                format!("claim-{attempt}"),
            )
        };

        let mut first =
            HermesAcpTransport::launch(mk_launch("attempt-one"), permit("attempt-one")).unwrap();
        first.wait_spawned(Duration::from_secs(5)).unwrap();
        first.initialize(Duration::from_secs(5)).unwrap();
        let session = first.new_session(cwd, Duration::from_secs(5)).unwrap();
        let message_id = "550e8400-e29b-41d4-a716-446655440001";
        let turn = first
            .prompt(
                "say hello",
                message_id,
                &HermesCancellation::default(),
                Duration::from_secs(5),
            )
            .unwrap();
        assert_eq!(turn.session().as_str(), session.as_str());
        assert_eq!(turn.final_text(), "hello from fake Hermes");
        assert_eq!(turn.stop_reason(), HermesStopReason::EndTurn);
        assert_eq!(
            turn.usage().unwrap().scope,
            HermesUsageScope::SessionCumulative
        );
        let cleanup = first.stop(Duration::from_secs(5)).unwrap();
        assert!(cleanup.proves_quiescence_for(&turn));

        let mut second =
            HermesAcpTransport::launch(mk_launch("attempt-two"), permit("attempt-two")).unwrap();
        second.wait_spawned(Duration::from_secs(5)).unwrap();
        second.initialize(Duration::from_secs(5)).unwrap();
        second
            .load_session(&session, cwd, Duration::from_secs(5))
            .unwrap();
        let cancel = HermesCancellation::default();
        let cancel_thread = cancel.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel_thread.cancel();
        });
        let cancelled = second
            .prompt(
                "cancel me",
                "550e8400-e29b-41d4-a716-446655440002",
                &cancel,
                Duration::from_secs(5),
            )
            .unwrap();
        canceller.join().unwrap();
        assert_eq!(cancelled.session().as_str(), session.as_str());
        assert_eq!(cancelled.stop_reason(), HermesStopReason::Cancelled);
        let cleanup = second.stop(Duration::from_secs(5)).unwrap();
        assert!(cleanup.proves_quiescence_for(&cancelled));
    }

    /// Real installed Hermes protocol/session-store probe. It creates an empty
    /// task-owned home, creates a session without prompting, stops the first
    /// child, and loads that exact UUID in a second child. No provider/model is
    /// invoked. Set both paths explicitly and run this ignored test on demand.
    #[test]
    #[ignore = "requires installed Hermes and rudder-process-host; no model call"]
    fn installed_hermes_persists_exact_session_across_owned_process_restart() {
        let process_host = PathBuf::from(std::env::var("RUDDER_PROCESS_HOST").unwrap());
        let hermes_executable = PathBuf::from(std::env::var("HERMES_TEST_EXECUTABLE").unwrap());
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("hermes-home");
        let cwd = temp.path().join("workspace");
        let runtime_root = temp.path().join("runtime");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&cwd).unwrap();
        fs::create_dir(&runtime_root).unwrap();
        let run_id = "00000000-0000-4000-8000-000000000010";
        let mk_launch = |attempt: &str| HermesLaunch {
            hermes_executable: hermes_executable.clone(),
            python_executable: None,
            python_source_root: None,
            ephemeral_system_prompt: None,
            process_host: process_host.clone(),
            runtime_root: runtime_root.clone(),
            hermes_home: home.clone(),
            cwd: cwd.clone(),
            run_id: run_id.into(),
            attempt_id: attempt.into(),
            owner_token: format!("owned-{attempt}"),
            executable_search_path: std::env::var("PATH").unwrap_or_else(|_| fixture_search_path()),
            env: Default::default(),
        };
        let permit = |attempt: &str| {
            ConnectionLaunchPermit::from_claim(
                run_id.into(),
                attempt.into(),
                format!("owned-{attempt}"),
                1,
                format!("claim-{attempt}"),
            )
        };

        let mut first = HermesAcpTransport::launch(
            mk_launch("00000000-0000-4000-8000-000000000011"),
            permit("00000000-0000-4000-8000-000000000011"),
        )
        .unwrap();
        first.wait_spawned(Duration::from_secs(20)).unwrap();
        first.initialize(Duration::from_secs(30)).unwrap();
        let session = first.new_session(&cwd, Duration::from_secs(30)).unwrap();
        let first_cleanup = first.stop(Duration::from_secs(10)).unwrap();
        assert!(first_cleanup.matches_execution(
            run_id,
            "00000000-0000-4000-8000-000000000011",
            "owned-00000000-0000-4000-8000-000000000011"
        ));

        let mut second = HermesAcpTransport::launch(
            mk_launch("00000000-0000-4000-8000-000000000012"),
            permit("00000000-0000-4000-8000-000000000012"),
        )
        .unwrap();
        second.wait_spawned(Duration::from_secs(20)).unwrap();
        second.initialize(Duration::from_secs(30)).unwrap();
        second
            .load_session(&session, &cwd, Duration::from_secs(30))
            .unwrap();
        let second_cleanup = second.stop(Duration::from_secs(10)).unwrap();
        assert!(second_cleanup.matches_execution(
            run_id,
            "00000000-0000-4000-8000-000000000012",
            "owned-00000000-0000-4000-8000-000000000012"
        ));
    }

    const FAKE_ACP_CHILD: &str = r##"#!/usr/bin/python3
import json, sys
session = "550e8400-e29b-41d4-a716-446655440000"
def out(v):
  sys.stdout.write(json.dumps(v, separators=(",", ":")) + "\n")
  sys.stdout.flush()
for line in sys.stdin:
  m = json.loads(line)
  method = m.get("method")
  if method == "initialized":
    continue
  if method == "initialize":
    out({"jsonrpc":"2.0","id":m["id"],"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":True}}})
  elif method == "session/new":
    out({"jsonrpc":"2.0","id":m["id"],"result":{"sessionId":session}})
  elif method == "session/load":
    out({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"history"}}}})
    out({"jsonrpc":"2.0","id":m["id"],"result":{}})
  elif method == "session/prompt":
    user_id = m["params"]["messageId"]
    text = m["params"]["prompt"][0]["text"]
    if text == "cancel me":
      incoming = json.loads(sys.stdin.readline())
      assert incoming.get("method") == "session/cancel"
      out({"jsonrpc":"2.0","id":m["id"],"result":{"stopReason":"cancelled","userMessageId":user_id}})
    else:
      out({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_message_chunk","messageId":"550e8400-e29b-41d4-a716-446655440003","content":{"type":"text","text":"hello from fake Hermes"}}}})
      out({"jsonrpc":"2.0","id":m["id"],"result":{"stopReason":"end_turn","userMessageId":user_id,"usage":{"inputTokens":3,"outputTokens":2,"totalTokens":5}}})
  elif method == "session/request_permission":
    out({"jsonrpc":"2.0","id":m["id"],"result":{"outcome":{"outcome":"cancelled"}}})
"##;
}
