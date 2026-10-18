//! A Rust owned, fail-closed transport boundary for Claude Code.
//!
//! This crate owns only the provider wire boundary.  It does not admit Runs,
//! write D1 state, bill, or project a provider result as a Rudder completion.
//! The installed Claude CLI is invoked with an explicit Session UUID and its
//! documented `--input-format stream-json`/`--output-format stream-json`
//! protocol.  Directory-level `--continue` and “latest session” selection are
//! deliberately unavailable.

use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    io::{BufRead, BufReader, Write},
    path::{Component, Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::Duration,
};
use thiserror::Error;
use uuid::Uuid;

pub const MAX_USER_INPUT_BYTES: usize = 48 * 1024;
pub const MAX_CONTROL_RESPONSE_BYTES: usize = 64 * 1024;
pub const MAX_RAW_EVENT_BYTES: usize = 512 * 1024;
pub const MAX_HISTORY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EVENT_QUEUE: usize = 256;

#[derive(Debug, Error)]
pub enum ClaudeError {
    #[error("Claude Code launch specification is invalid")]
    InvalidLaunch,
    #[error("Claude Code session identity is invalid")]
    InvalidSession,
    #[error("Claude Code transport is closed")]
    Closed,
    #[error("Claude Code transport event deadline expired")]
    Timeout,
    #[error("Claude Code transport output queue overflowed")]
    OutputOverflow,
    #[error("Claude Code stream-json event is invalid")]
    InvalidEvent,
    #[error("Claude Code native control response is invalid")]
    InvalidControlResponse,
    #[error("Claude Code history file is invalid or outside the managed root")]
    InvalidHistoryPath,
    #[error("Claude Code history file exceeds the bounded reader limit")]
    HistoryTooLarge,
    #[error("Claude Code process I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct ClaudeSessionSelector(String);

impl ClaudeSessionSelector {
    pub fn parse(value: &str) -> Result<Self, ClaudeError> {
        let id = Uuid::parse_str(value).map_err(|_| ClaudeError::InvalidSession)?;
        let canonical = id.hyphenated().to_string();
        if value != canonical {
            return Err(ClaudeError::InvalidSession);
        }
        Ok(Self(canonical))
    }

    pub fn new() -> Self {
        Self(Uuid::new_v4().hyphenated().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for ClaudeSessionSelector {
    fn default() -> Self {
        Self::new()
    }
}

/// Session selection is explicit.  No variant represents directory-level
/// continuation, because it cannot prove which native session is being used.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClaudeSessionMode {
    New {
        session_id: Option<ClaudeSessionSelector>,
    },
    Resume {
        session_id: ClaudeSessionSelector,
    },
    Fork {
        source_session_id: ClaudeSessionSelector,
        session_id: Option<ClaudeSessionSelector>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaudeInvocation {
    pub session: ClaudeSessionMode,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub settings_path: Option<PathBuf>,
    pub mcp_config_path: Option<PathBuf>,
    pub append_system_prompt_file: Option<PathBuf>,
    pub add_dirs: Vec<PathBuf>,
}

impl ClaudeInvocation {
    pub fn new(session: ClaudeSessionMode) -> Self {
        Self {
            session,
            model: None,
            effort: None,
            permission_mode: None,
            settings_path: None,
            mcp_config_path: None,
            append_system_prompt_file: None,
            add_dirs: Vec::new(),
        }
    }

    /// Arguments calibrated against the installed Claude Code CLI 2.1.x.
    /// User input is never put on argv; it is sent as a JSON-LF stdin frame.
    pub fn argv(&self) -> Result<Vec<String>, ClaudeError> {
        let mut args = vec![
            "--print".into(),
            "-".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--replay-user-messages".into(),
        ];
        match &self.session {
            ClaudeSessionMode::New { session_id } => {
                if let Some(id) = session_id {
                    args.extend(["--session-id".into(), id.as_str().into()]);
                }
            }
            ClaudeSessionMode::Resume { session_id } => {
                args.extend(["--resume".into(), session_id.as_str().into()]);
            }
            ClaudeSessionMode::Fork {
                source_session_id,
                session_id,
            } => {
                args.extend([
                    "--resume".into(),
                    source_session_id.as_str().into(),
                    "--fork-session".into(),
                ]);
                if let Some(id) = session_id {
                    args.extend(["--session-id".into(), id.as_str().into()]);
                }
            }
        }
        if let Some(model) = self.model.as_deref() {
            push_value(&mut args, "--model", model)?;
        }
        if let Some(effort) = self.effort.as_deref() {
            if !matches!(effort, "low" | "medium" | "high" | "xhigh" | "max") {
                return Err(ClaudeError::InvalidLaunch);
            }
            push_value(&mut args, "--effort", effort)?;
        }
        if let Some(mode) = self.permission_mode.as_deref() {
            if !matches!(
                mode,
                "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "manual" | "plan"
            ) {
                return Err(ClaudeError::InvalidLaunch);
            }
            push_value(&mut args, "--permission-mode", mode)?;
        }
        for (flag, path) in [
            ("--settings", self.settings_path.as_ref()),
            ("--mcp-config", self.mcp_config_path.as_ref()),
            (
                "--append-system-prompt-file",
                self.append_system_prompt_file.as_ref(),
            ),
        ] {
            if let Some(path) = path {
                push_path(&mut args, flag, path)?;
            }
        }
        if self.mcp_config_path.is_some() {
            args.push("--strict-mcp-config".into());
        }
        for path in &self.add_dirs {
            push_path(&mut args, "--add-dir", path)?;
        }
        Ok(args)
    }
}

fn push_value(args: &mut Vec<String>, flag: &str, value: &str) -> Result<(), ClaudeError> {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') || value.starts_with('-') {
        return Err(ClaudeError::InvalidLaunch);
    }
    args.extend([flag.into(), value.into()]);
    Ok(())
}

fn push_path(args: &mut Vec<String>, flag: &str, path: &Path) -> Result<(), ClaudeError> {
    if !path.is_absolute() {
        return Err(ClaudeError::InvalidLaunch);
    }
    let path = path.to_str().ok_or(ClaudeError::InvalidLaunch)?;
    push_value(args, flag, path)
}

/// A trusted launch specification.  The executable must be resolved by the
/// caller from an approved installation path; this type never searches PATH.
#[derive(Clone, Debug)]
pub struct ClaudeLaunch {
    pub executable: PathBuf,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub invocation: ClaudeInvocation,
}

impl ClaudeLaunch {
    fn validate(&self) -> Result<PathBuf, ClaudeError> {
        if !self.executable.is_absolute() || !self.cwd.is_absolute() || !self.cwd.is_dir() {
            return Err(ClaudeError::InvalidLaunch);
        }
        let executable = self
            .executable
            .canonicalize()
            .map_err(|_| ClaudeError::InvalidLaunch)?;
        let metadata = fs::symlink_metadata(&executable).map_err(|_| ClaudeError::InvalidLaunch)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ClaudeError::InvalidLaunch);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err(ClaudeError::InvalidLaunch);
            }
        }
        if self.env.len() > 64
            || self.env.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > 256
                    || value.len() > 16_384
                    || key.contains('=')
                    || key.contains('\0')
                    || value.contains('\0')
            })
        {
            return Err(ClaudeError::InvalidLaunch);
        }
        self.invocation.argv()?;
        Ok(executable)
    }
}

/// Isolated environment values for a managed Claude profile.  Credentials are
/// intentionally not copied or read here; the host decides how auth is made
/// available in the operator home.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaudeRuntimeProfile {
    operator_home: PathBuf,
    managed_home: PathBuf,
}

impl ClaudeRuntimeProfile {
    pub fn new(operator_home: PathBuf, managed_home: PathBuf) -> Result<Self, ClaudeError> {
        let operator_home = canonical_directory(&operator_home)?;
        let managed_home = canonical_directory(&managed_home)?;
        if operator_home == managed_home {
            return Err(ClaudeError::InvalidLaunch);
        }
        let config_dir = managed_home.join(".claude");
        if !config_dir.is_dir()
            || fs::symlink_metadata(&config_dir)
                .map_err(|_| ClaudeError::InvalidLaunch)?
                .file_type()
                .is_symlink()
        {
            return Err(ClaudeError::InvalidLaunch);
        }
        Ok(Self {
            operator_home,
            managed_home,
        })
    }

    pub fn environment(&self) -> Result<BTreeMap<String, String>, ClaudeError> {
        let config = self.managed_home.join(".claude");
        let mut env = BTreeMap::new();
        for (key, value) in [
            ("HOME", &self.operator_home),
            ("USERPROFILE", &self.operator_home),
            ("CLAUDE_CONFIG_DIR", &config),
            ("RUDDER_CLAUDE_HOME", &self.managed_home),
            ("RUDDER_OPERATOR_HOME", &self.operator_home),
        ] {
            env.insert(
                key.into(),
                value.to_str().ok_or(ClaudeError::InvalidLaunch)?.into(),
            );
        }
        Ok(env)
    }
}

fn canonical_directory(path: &Path) -> Result<PathBuf, ClaudeError> {
    if !path.is_absolute() || !path.is_dir() {
        return Err(ClaudeError::InvalidLaunch);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| ClaudeError::InvalidLaunch)?;
    if metadata.file_type().is_symlink() {
        return Err(ClaudeError::InvalidLaunch);
    }
    path.canonicalize().map_err(|_| ClaudeError::InvalidLaunch)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ClaudeEvent {
    SystemInit {
        session_id: ClaudeSessionSelector,
        cwd: Option<String>,
        model: Option<String>,
    },
    Assistant {
        session_id: Option<ClaudeSessionSelector>,
        message_id: Option<String>,
        content: Vec<Value>,
        stop_reason: Option<String>,
    },
    Result {
        session_id: ClaudeSessionSelector,
        uuid: Option<String>,
        subtype: String,
        is_error: bool,
        result: Option<String>,
        usage: Option<Value>,
        total_cost_usd_micros: Option<u64>,
        raw: Value,
    },
    ControlRequest(ClaudeControlRequest),
    UserEcho {
        session_id: Option<ClaudeSessionSelector>,
        message: Value,
    },
    Unknown {
        kind: String,
        raw: Value,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaudeControlRequest {
    request_id: String,
    subtype: String,
    request: Value,
}

impl ClaudeControlRequest {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
    pub fn subtype(&self) -> &str {
        &self.subtype
    }
    pub fn request(&self) -> &Value {
        &self.request
    }
}

pub fn encode_user_message(input: &str) -> Result<String, ClaudeError> {
    if input.is_empty() || input.len() > MAX_USER_INPUT_BYTES || input.contains('\0') {
        return Err(ClaudeError::InvalidEvent);
    }
    encode_json_line(
        &json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":input}]}}),
        MAX_USER_INPUT_BYTES,
    )
}

pub fn encode_control_response(
    request: &ClaudeControlRequest,
    response: Value,
) -> Result<String, ClaudeError> {
    if !response.is_object() {
        return Err(ClaudeError::InvalidControlResponse);
    }
    encode_json_line(
        &json!({"type":"control_response","response":{"subtype":"success","request_id":request.request_id,"response":response}}),
        MAX_CONTROL_RESPONSE_BYTES,
    )
}

fn encode_json_line(value: &Value, max: usize) -> Result<String, ClaudeError> {
    let mut bytes = serde_json::to_vec(value)?;
    if bytes.len() >= max || bytes.contains(&b'\n') || bytes.contains(&b'\r') {
        return Err(ClaudeError::InvalidEvent);
    }
    bytes.push(b'\n');
    String::from_utf8(bytes).map_err(|_| ClaudeError::InvalidEvent)
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ClaudeControlLease {
    request_id: Option<String>,
}

impl ClaudeControlLease {
    pub fn pending_request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }
    pub fn observe(&mut self, request: &ClaudeControlRequest) -> Result<(), ClaudeError> {
        if self.request_id.is_some() {
            return Err(ClaudeError::InvalidControlResponse);
        }
        self.request_id = Some(request.request_id.clone());
        Ok(())
    }
    pub fn authorize(&mut self, request: &ClaudeControlRequest) -> Result<(), ClaudeError> {
        if self.request_id.as_deref() != Some(request.request_id()) {
            return Err(ClaudeError::InvalidControlResponse);
        }
        self.request_id = None;
        Ok(())
    }
}

impl ClaudeEvent {
    pub fn parse(raw: &[u8]) -> Result<Self, ClaudeError> {
        if raw.len() > MAX_RAW_EVENT_BYTES {
            return Err(ClaudeError::InvalidEvent);
        }
        parse_event(serde_json::from_slice(raw)?)
    }
}

fn parse_event(value: Value) -> Result<ClaudeEvent, ClaudeError> {
    let object = value.as_object().ok_or(ClaudeError::InvalidEvent)?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or(ClaudeError::InvalidEvent)?;
    match kind {
        "system" if object.get("subtype").and_then(Value::as_str) == Some("init") => {
            Ok(ClaudeEvent::SystemInit {
                session_id: session_from_field(object, "session_id")?,
                cwd: string_field(object, "cwd"),
                model: string_field(object, "model"),
            })
        }
        "assistant" => {
            let message = object.get("message").and_then(Value::as_object);
            let content = message
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            Ok(ClaudeEvent::Assistant {
                session_id: optional_session(object, "session_id")?,
                message_id: message.and_then(|m| string_field(m, "id")),
                content,
                stop_reason: message.and_then(|m| string_field(m, "stop_reason")),
            })
        }
        "result" => {
            let subtype = object
                .get("subtype")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= 128)
                .ok_or(ClaudeError::InvalidEvent)?
                .to_owned();
            Ok(ClaudeEvent::Result {
                session_id: session_from_field(object, "session_id")?,
                uuid: string_field(object, "uuid"),
                subtype,
                is_error: object
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                result: string_field(object, "result"),
                usage: object.get("usage").cloned(),
                total_cost_usd_micros: object
                    .get("total_cost_usd")
                    .and_then(Value::as_f64)
                    .and_then(cost_micros),
                raw: value,
            })
        }
        "control_request" => {
            let request_id = object
                .get("request_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.len() <= 256)
                .ok_or(ClaudeError::InvalidControlResponse)?
                .to_owned();
            let request = object
                .get("request")
                .cloned()
                .ok_or(ClaudeError::InvalidControlResponse)?;
            let subtype = request
                .get("subtype")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            Ok(ClaudeEvent::ControlRequest(ClaudeControlRequest {
                request_id,
                subtype,
                request,
            }))
        }
        "user" => Ok(ClaudeEvent::UserEcho {
            session_id: optional_session(object, "session_id")?,
            message: object.get("message").cloned().unwrap_or(Value::Null),
        }),
        _ => Ok(ClaudeEvent::Unknown {
            kind: kind.to_owned(),
            raw: value,
        }),
    }
}

fn string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 64 * 1024)
        .map(ToOwned::to_owned)
}
fn session_from_field(
    object: &Map<String, Value>,
    key: &str,
) -> Result<ClaudeSessionSelector, ClaudeError> {
    ClaudeSessionSelector::parse(
        object
            .get(key)
            .and_then(Value::as_str)
            .ok_or(ClaudeError::InvalidSession)?,
    )
}
fn optional_session(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<ClaudeSessionSelector>, ClaudeError> {
    object
        .get(key)
        .map(|v| ClaudeSessionSelector::parse(v.as_str().ok_or(ClaudeError::InvalidSession)?))
        .transpose()
}
fn cost_micros(cost: f64) -> Option<u64> {
    (cost.is_finite() && cost >= 0.0 && cost <= (u64::MAX as f64 / 1_000_000.0))
        .then(|| (cost * 1_000_000.0).round() as u64)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaudeTurnStatus {
    Completed,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaudeTurnReceipt {
    session_id: ClaudeSessionSelector,
    result_uuid: Option<String>,
    subtype: String,
    status: ClaudeTurnStatus,
    is_error: bool,
    summary: Option<String>,
    usage: Option<Value>,
    total_cost_usd_micros: Option<u64>,
}

impl ClaudeTurnReceipt {
    pub fn session_id(&self) -> &ClaudeSessionSelector {
        &self.session_id
    }
    pub fn result_uuid(&self) -> Option<&str> {
        self.result_uuid.as_deref()
    }
    pub fn subtype(&self) -> &str {
        &self.subtype
    }
    pub fn status(&self) -> ClaudeTurnStatus {
        self.status
    }
    pub fn is_error(&self) -> bool {
        self.is_error
    }
    pub fn summary(&self) -> Option<&str> {
        self.summary.as_deref()
    }
    pub fn usage(&self) -> Option<&Value> {
        self.usage.as_ref()
    }
    pub fn total_cost_usd_micros(&self) -> Option<u64> {
        self.total_cost_usd_micros
    }
}

fn receipt_from_result(event: ClaudeEvent) -> Result<ClaudeTurnReceipt, ClaudeError> {
    let ClaudeEvent::Result {
        session_id,
        uuid,
        subtype,
        is_error,
        result,
        usage,
        total_cost_usd_micros,
        ..
    } = event
    else {
        return Err(ClaudeError::InvalidEvent);
    };
    let status = if is_error || subtype.starts_with("error_") {
        ClaudeTurnStatus::Failed
    } else {
        ClaudeTurnStatus::Completed
    };
    Ok(ClaudeTurnReceipt {
        session_id,
        result_uuid: uuid,
        subtype,
        status,
        is_error,
        summary: result,
        usage,
        total_cost_usd_micros,
    })
}

enum OutputLine {
    Line(Vec<u8>),
    Eof,
    Error(std::io::Error),
}

/// One owned provider process.  The shared executor still owns admission,
/// terminal persistence, and billing.  A result observed here is not enough to
/// complete a Run; the caller must retain the receipt and reconcile ownership.
pub struct ClaudeTransport {
    child: Child,
    stdin: ChildStdin,
    output: Receiver<OutputLine>,
    events: VecDeque<ClaudeEvent>,
    control_lease: ClaudeControlLease,
    session_id: Option<ClaudeSessionSelector>,
    terminal: Option<ClaudeTurnReceipt>,
    terminal_received: bool,
}

impl ClaudeTransport {
    pub fn launch(launch: ClaudeLaunch) -> Result<Self, ClaudeError> {
        let executable = launch.validate()?;
        let mut command = Command::new(executable);
        command
            .args(launch.invocation.argv()?)
            .current_dir(&launch.cwd)
            .env_clear()
            .envs(launch.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn()?;
        let stdin = child.stdin.take().ok_or(ClaudeError::InvalidLaunch)?;
        let stdout = child.stdout.take().ok_or(ClaudeError::InvalidLaunch)?;
        let (sender, output) = mpsc::channel();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => {
                        let _ = sender.send(OutputLine::Eof);
                        break;
                    }
                    Ok(_) if line.len() > MAX_RAW_EVENT_BYTES => {
                        let _ = sender.send(OutputLine::Error(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "event too large",
                        )));
                        break;
                    }
                    Ok(_) => {
                        let _ = sender.send(OutputLine::Line(line));
                    }
                    Err(error) => {
                        let _ = sender.send(OutputLine::Error(error));
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            output,
            events: VecDeque::new(),
            control_lease: ClaudeControlLease::default(),
            session_id: None,
            terminal: None,
            terminal_received: false,
        })
    }

    pub fn session_id(&self) -> Option<&ClaudeSessionSelector> {
        self.session_id.as_ref()
    }
    pub fn pending_control_request_id(&self) -> Option<&str> {
        self.control_lease.pending_request_id()
    }
    pub fn send_user_message(&mut self, input: &str) -> Result<(), ClaudeError> {
        self.stdin
            .write_all(encode_user_message(input)?.as_bytes())
            .map_err(ClaudeError::Io)
    }
    pub fn respond_control(
        &mut self,
        request: &ClaudeControlRequest,
        response: Value,
    ) -> Result<(), ClaudeError> {
        if self.control_lease.pending_request_id() != Some(request.request_id()) {
            return Err(ClaudeError::InvalidControlResponse);
        }
        self.stdin
            .write_all(encode_control_response(request, response)?.as_bytes())?;
        self.stdin.flush()?;
        self.control_lease.authorize(request)
    }
    pub fn stop(&mut self) -> Result<(), ClaudeError> {
        self.child.kill().map_err(|_| ClaudeError::Closed)?;
        let _ = self.child.wait();
        self.terminal_received = true;
        Ok(())
    }
    pub fn take_event(&mut self) -> Option<ClaudeEvent> {
        self.events.pop_front()
    }
    pub fn take_terminal(&mut self) -> Option<ClaudeTurnReceipt> {
        self.terminal.take()
    }
    pub fn receive(&mut self, timeout: Duration) -> Result<ClaudeEvent, ClaudeError> {
        if let Some(event) = self.events.pop_front() {
            return Ok(event);
        }
        if self.terminal_received {
            return Err(ClaudeError::Closed);
        }
        let line = match self.output.recv_timeout(timeout) {
            Ok(OutputLine::Line(line)) => line,
            Ok(OutputLine::Eof) => {
                self.terminal_received = true;
                return Err(ClaudeError::Closed);
            }
            Ok(OutputLine::Error(error)) => return Err(ClaudeError::Io(error)),
            Err(RecvTimeoutError::Timeout) => return Err(ClaudeError::Timeout),
            Err(RecvTimeoutError::Disconnected) => {
                self.terminal_received = true;
                return Err(ClaudeError::Closed);
            }
        };
        let line = line
            .strip_suffix(b"\n")
            .or_else(|| line.strip_suffix(b"\r"))
            .unwrap_or(&line);
        let event = ClaudeEvent::parse(line)?;
        self.observe(event.clone())?;
        self.events.pop_front().ok_or(ClaudeError::InvalidEvent)
    }
    fn observe(&mut self, event: ClaudeEvent) -> Result<(), ClaudeError> {
        match &event {
            ClaudeEvent::SystemInit { session_id, .. } => self.bind_session(session_id)?,
            ClaudeEvent::Assistant { session_id, .. }
            | ClaudeEvent::UserEcho { session_id, .. } => {
                if let Some(id) = session_id {
                    self.bind_session(id)?;
                }
            }
            ClaudeEvent::Result { session_id, .. } => {
                self.bind_session(session_id)?;
                if self.terminal.is_some() {
                    return Err(ClaudeError::InvalidEvent);
                }
                self.terminal = Some(receipt_from_result(event.clone())?);
            }
            ClaudeEvent::ControlRequest(request) => self.control_lease.observe(request)?,
            ClaudeEvent::Unknown { .. } => {}
        }
        if self.events.len() >= MAX_EVENT_QUEUE {
            return Err(ClaudeError::OutputOverflow);
        }
        self.events.push_back(event);
        Ok(())
    }
    fn bind_session(&mut self, id: &ClaudeSessionSelector) -> Result<(), ClaudeError> {
        if self
            .session_id
            .as_ref()
            .is_some_and(|existing| existing != id)
        {
            return Err(ClaudeError::InvalidSession);
        }
        self.session_id = Some(id.clone());
        Ok(())
    }
}

impl Drop for ClaudeTransport {
    fn drop(&mut self) {
        if !self.terminal_received {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaudeHistoryEntry {
    pub event: ClaudeEvent,
}

pub struct ClaudeHistoryReader {
    root: PathBuf,
    session: ClaudeSessionSelector,
}

impl ClaudeHistoryReader {
    pub fn new(root: PathBuf, session: ClaudeSessionSelector) -> Result<Self, ClaudeError> {
        let root = canonical_directory(&root)?;
        Ok(Self { root, session })
    }
    pub fn read_path(&self, path: &Path) -> Result<Vec<ClaudeHistoryEntry>, ClaudeError> {
        let metadata = fs::symlink_metadata(path).map_err(|_| ClaudeError::InvalidHistoryPath)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ClaudeError::InvalidHistoryPath);
        }
        if metadata.len() > MAX_HISTORY_BYTES {
            return Err(ClaudeError::HistoryTooLarge);
        }
        let canonical = path
            .canonicalize()
            .map_err(|_| ClaudeError::InvalidHistoryPath)?;
        if !canonical.starts_with(&self.root)
            || canonical.file_name().and_then(|name| name.to_str())
                != Some(&format!("{}.jsonl", self.session.as_str()))
        {
            return Err(ClaudeError::InvalidHistoryPath);
        }
        let bytes = fs::read(canonical)?;
        let mut entries = Vec::new();
        for line in bytes.split(|byte| *byte == b'\n') {
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if line.is_empty() {
                continue;
            }
            entries.push(ClaudeHistoryEntry {
                event: ClaudeEvent::parse(line)?,
            });
        }
        Ok(entries)
    }
    pub fn path_for_cwd(&self, projects_root: &Path, cwd: &Path) -> Result<PathBuf, ClaudeError> {
        let projects_root = canonical_directory(projects_root)?;
        if !projects_root.starts_with(&self.root) {
            return Err(ClaudeError::InvalidHistoryPath);
        }
        let cwd = canonical_directory(cwd)?;
        let project_dir = projects_root.join(encoded_project_name(&cwd)?);
        let metadata =
            fs::symlink_metadata(&project_dir).map_err(|_| ClaudeError::InvalidHistoryPath)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(ClaudeError::InvalidHistoryPath);
        }
        Ok(project_dir
            .canonicalize()
            .map_err(|_| ClaudeError::InvalidHistoryPath)?
            .join(format!("{}.jsonl", self.session.as_str())))
    }
    pub fn read_for_cwd(
        &self,
        projects_root: &Path,
        cwd: &Path,
    ) -> Result<Vec<ClaudeHistoryEntry>, ClaudeError> {
        self.read_path(&self.path_for_cwd(projects_root, cwd)?)
    }
}

fn encoded_project_name(cwd: &Path) -> Result<String, ClaudeError> {
    let mut encoded = String::new();
    for component in cwd.components() {
        match component {
            Component::RootDir => encoded.push('-'),
            Component::Normal(value) => {
                let value = value.to_str().ok_or(ClaudeError::InvalidHistoryPath)?;
                if value.is_empty() || value.contains('\0') {
                    return Err(ClaudeError::InvalidHistoryPath);
                }
                encoded.push('-');
                encoded.push_str(value);
            }
            Component::Prefix(value) => {
                encoded.push('-');
                encoded.push_str(
                    value
                        .as_os_str()
                        .to_str()
                        .ok_or(ClaudeError::InvalidHistoryPath)?,
                );
            }
            Component::CurDir | Component::ParentDir => {
                return Err(ClaudeError::InvalidHistoryPath);
            }
        }
    }
    if encoded.is_empty() || encoded.len() > 4096 {
        return Err(ClaudeError::InvalidHistoryPath);
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn session() -> ClaudeSessionSelector {
        ClaudeSessionSelector::parse("05a82e73-f42d-4a40-9323-e58356868e6b").unwrap()
    }

    #[test]
    fn invocation_uses_explicit_session_and_stream_json_stdin() {
        let invocation = ClaudeInvocation {
            session: ClaudeSessionMode::Fork {
                source_session_id: session(),
                session_id: None,
            },
            model: Some("sonnet".into()),
            effort: Some("high".into()),
            permission_mode: Some("auto".into()),
            settings_path: None,
            mcp_config_path: None,
            append_system_prompt_file: None,
            add_dirs: vec![],
        };
        let args = invocation.argv().unwrap();
        assert_eq!(
            &args[..8],
            &[
                "--print",
                "-",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--replay-user-messages"
            ]
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--resume", session().as_str()])
        );
        assert!(args.contains(&"--fork-session".to_owned()));
        assert!(!args.contains(&"--continue".to_owned()));
    }

    #[test]
    fn parses_installed_init_result_and_keeps_receipt_observation_separate() {
        let init = br#"{"type":"system","subtype":"init","cwd":"/workspace","session_id":"05a82e73-f42d-4a40-9323-e58356868e6b","model":"sonnet"}"#;
        let result = br#"{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"05a82e73-f42d-4a40-9323-e58356868e6b","total_cost_usd":0.001,"uuid":"655b28ae-cd7d-41cf-be0e-5208bfa02066"}"#;
        assert!(matches!(
            ClaudeEvent::parse(init).unwrap(),
            ClaudeEvent::SystemInit { .. }
        ));
        let event = ClaudeEvent::parse(result).unwrap();
        let receipt = receipt_from_result(event).unwrap();
        assert_eq!(receipt.status(), ClaudeTurnStatus::Completed);
        assert_eq!(receipt.summary(), Some("done"));
        assert_eq!(receipt.total_cost_usd_micros(), Some(1_000));
    }

    #[test]
    fn control_response_copies_provider_request_id_and_lease_rejects_stale() {
        let request = ClaudeControlRequest {
            request_id: "req-42".into(),
            subtype: "permission_request".into(),
            request: json!({"tool_name":"Bash"}),
        };
        let encoded: Value = serde_json::from_str(
            encode_control_response(&request, json!({"behavior":"deny"}))
                .unwrap()
                .trim(),
        )
        .unwrap();
        assert_eq!(encoded["response"]["request_id"], request.request_id());
        let mut lease = ClaudeControlLease::default();
        lease.observe(&request).unwrap();
        assert!(lease.observe(&request).is_err());
        lease.authorize(&request).unwrap();
        assert!(lease.authorize(&request).is_err());
    }

    #[test]
    fn history_reader_requires_exact_session_filename_and_preserves_unknown_events() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("{}.jsonl", session().as_str()));
        let mut file = fs::File::create(&path).unwrap();
        writeln!(
            file,
            r#"{{"type":"system","subtype":"init","session_id":"{}"}}"#,
            session().as_str()
        )
        .unwrap();
        writeln!(
            file,
            r#"{{"type":"future_event","session_id":"{}"}}"#,
            session().as_str()
        )
        .unwrap();
        drop(file);
        let reader = ClaudeHistoryReader::new(dir.path().to_owned(), session()).unwrap();
        let entries = reader.read_path(&path).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(matches!(entries[1].event, ClaudeEvent::Unknown { .. }));
        let wrong = dir.path().join("other.jsonl");
        fs::write(&wrong, b"{}\n").unwrap();
        assert!(reader.read_path(&wrong).is_err());
    }

    #[test]
    fn user_frame_is_single_lf_and_bounded() {
        let frame = encode_user_message("line1\nline2").unwrap();
        assert_eq!(frame.bytes().filter(|byte| *byte == b'\n').count(), 1);
        assert!(encode_user_message(&"x".repeat(MAX_USER_INPUT_BYTES)).is_err());
        assert!(ClaudeEvent::parse(&vec![b'x'; MAX_RAW_EVENT_BYTES + 1]).is_err());
    }

    #[test]
    fn trusted_profile_does_not_share_operator_and_managed_home() {
        let temp = tempfile::tempdir().unwrap();
        let operator = temp.path().join("operator");
        let managed = temp.path().join("managed");
        fs::create_dir(&operator).unwrap();
        fs::create_dir(&managed).unwrap();
        fs::create_dir(managed.join(".claude")).unwrap();
        let profile = ClaudeRuntimeProfile::new(operator.clone(), managed.clone()).unwrap();
        let env = profile.environment().unwrap();
        assert_eq!(
            env["HOME"],
            operator.canonicalize().unwrap().to_str().unwrap()
        );
        assert_ne!(env["HOME"], env["RUDDER_CLAUDE_HOME"]);
    }

    #[cfg(unix)]
    #[test]
    fn fake_cli_transport_reads_bounded_ndjson_until_provider_result() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-claude");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{}\"}}'\nprintf '%s\\n' '{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"fake-ok\",\"session_id\":\"{}\"}}'\n",
                session().as_str(),
                session().as_str()
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).unwrap();

        let launch = ClaudeLaunch {
            executable: script,
            cwd: dir.path().to_owned(),
            env: BTreeMap::new(),
            invocation: ClaudeInvocation::new(ClaudeSessionMode::New {
                session_id: Some(session()),
            }),
        };
        let mut transport = ClaudeTransport::launch(launch).unwrap();
        let first = transport.receive(Duration::from_secs(1)).unwrap();
        assert!(matches!(first, ClaudeEvent::SystemInit { .. }));
        let second = transport.receive(Duration::from_secs(1)).unwrap();
        assert!(matches!(second, ClaudeEvent::Result { .. }));
        assert_eq!(transport.session_id(), Some(&session()));
        assert_eq!(
            transport.take_terminal().unwrap().summary(),
            Some("fake-ok")
        );
    }
}
