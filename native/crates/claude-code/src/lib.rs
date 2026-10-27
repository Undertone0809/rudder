//! Rust-owned Claude Code stream-json boundary.
//!
//! This crate is deliberately provider-specific.  It owns the framing and
//! identity rules for the installed Claude Code CLI, while leaving Run claims,
//! D1 state transitions, billing, and transcript projection to the shared
//! Native Chat worker.  It is therefore safe to use as a transport boundary
//! before a shared-worker projector is wired: a parsed `result` is an
//! observation, never a durable completion decision.
//!
//! The protocol was calibrated against Claude Code 2.1.216 on 2026-10-18:
//! `--print - --input-format stream-json --output-format stream-json --verbose`
//! accepts one JSON-LF user envelope and emits a `system/init`, assistant, and
//! `result` sequence.  Session identity is always selected explicitly with
//! `--resume <uuid>` or `--session-id <uuid>`; directory-level `--continue` is
//! intentionally not exposed here.

use rudder_native_process_transport::{
    ConnectionLaunchPermit, ConnectionReceipt, HostCleanupProof, HostConnection, HostError,
    HostEvent, OwnedHost,
};
use rudder_native_protocol::{Command, ProtocolVersion, lines::LineDecoder};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

pub const MAX_USER_INPUT_BYTES: usize = 48 * 1024;
pub const MAX_CONTROL_RESPONSE_BYTES: usize = 64 * 1024;
pub const MAX_HISTORY_BYTES: u64 = 64 * 1024 * 1024;
const MAX_EVENT_QUEUE: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum ClaudeError {
    #[error("Claude Code launch specification is invalid")]
    InvalidLaunch,
    #[error("Claude Code session identity is invalid")]
    InvalidSession,
    #[error("Claude Code transport is closed")]
    Closed,
    #[error("Claude Code transport is busy with another stdin write")]
    Busy,
    #[error("Claude Code transport event deadline expired")]
    Timeout,
    #[error("Claude Code transport output queue overflowed")]
    OutputOverflow,
    #[error("Claude Code stdin write outcome is indeterminate; do not retry")]
    WriteIndeterminate,
    #[error("Claude Code stream-json event is invalid")]
    InvalidEvent,
    #[error("Claude Code native control response is invalid")]
    InvalidControlResponse,
    #[error("Claude Code history file is invalid or outside the managed root")]
    InvalidHistoryPath,
    #[error("Claude Code history file exceeds the bounded reader limit")]
    HistoryTooLarge,
    #[error("Claude Code stream framing failed")]
    Framing,
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl From<rudder_native_protocol::lines::LineError> for ClaudeError {
    fn from(_: rudder_native_protocol::lines::LineError) -> Self {
        Self::Framing
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaudeSessionSelector(String);

impl ClaudeSessionSelector {
    pub fn parse(value: &str) -> Result<Self, ClaudeError> {
        let id = Uuid::parse_str(value).map_err(|_| ClaudeError::InvalidSession)?;
        let canonical = id.hyphenated().to_string();
        if canonical != value {
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

/// An executable path resolved by the trusted Rust host.  The adapter never
/// searches the caller's PATH and never accepts a path supplied by HTTP or an
/// Agent configuration.  Canonicalizing once also prevents a later launch
/// from silently switching through a symlink.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaudeExecutable(PathBuf);

impl ClaudeExecutable {
    pub fn resolve(path: &Path) -> Result<Self, ClaudeError> {
        if !path.is_absolute() {
            return Err(ClaudeError::InvalidLaunch);
        }
        let canonical = path
            .canonicalize()
            .map_err(|_| ClaudeError::InvalidLaunch)?;
        let metadata = fs::symlink_metadata(&canonical).map_err(|_| ClaudeError::InvalidLaunch)?;
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
        Ok(Self(canonical))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

/// Rust-owned Claude configuration boundary.  Authentication remains in the
/// operator home selected by the trusted host; mutable Claude state is kept
/// in a per-runtime managed home.  This type only returns environment values;
/// it never creates, copies, or reads credential files.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaudeRuntimeProfile {
    operator_home: PathBuf,
    managed_home: Option<PathBuf>,
    config_dir: PathBuf,
}

impl ClaudeRuntimeProfile {
    pub fn new(operator_home: PathBuf, managed_home: PathBuf) -> Result<Self, ClaudeError> {
        let operator_home = canonical_directory(&operator_home)?;
        let managed_home = canonical_directory(&managed_home)?;
        if operator_home == managed_home {
            return Err(ClaudeError::InvalidLaunch);
        }
        let config_dir = managed_home.join(".claude");
        let canonical_config = canonical_directory(&config_dir)?;
        if canonical_config != config_dir {
            return Err(ClaudeError::InvalidLaunch);
        }
        Ok(Self {
            operator_home,
            managed_home: Some(managed_home),
            config_dir,
        })
    }

    /// Select the operator's existing Claude profile in place. The operator
    /// home supplies the normal CLI auth boundary and `.claude` remains the
    /// selected config/state directory; no profile files are copied or
    /// rewritten by this constructor.
    pub fn operator_default(operator_home: PathBuf) -> Result<Self, ClaudeError> {
        let operator_home = canonical_directory(&operator_home)?;
        let config_dir = operator_home.join(".claude");
        let canonical_config = canonical_directory(&config_dir)?;
        if canonical_config != config_dir {
            return Err(ClaudeError::InvalidLaunch);
        }
        Ok(Self {
            operator_home,
            managed_home: None,
            config_dir,
        })
    }

    pub fn operator_home(&self) -> &Path {
        &self.operator_home
    }

    pub fn managed_home(&self) -> Option<&Path> {
        self.managed_home.as_deref()
    }

    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    /// Return only the approved environment boundary.  Callers may merge
    /// separately validated provider variables, but must not inherit the
    /// ambient process environment wholesale.
    pub fn environment(&self) -> Result<BTreeMap<String, String>, ClaudeError> {
        let mut env = BTreeMap::new();
        let mut approved = vec![
            ("HOME", &self.operator_home),
            ("USERPROFILE", &self.operator_home),
            ("CLAUDE_CONFIG_DIR", &self.config_dir),
            ("RUDDER_OPERATOR_HOME", &self.operator_home),
        ];
        if let Some(managed_home) = self.managed_home.as_ref() {
            approved.push(("RUDDER_CLAUDE_HOME", managed_home));
        }
        for (key, value) in approved {
            // Reject non-UTF-8 paths rather than silently losing an
            // environment boundary at process-host serialization time.
            let value = value.to_str().ok_or(ClaudeError::InvalidLaunch)?;
            env.insert(key.into(), value.into());
        }
        Ok(env)
    }
}

fn canonical_directory(path: &Path) -> Result<PathBuf, ClaudeError> {
    if !path.is_absolute() {
        return Err(ClaudeError::InvalidLaunch);
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| ClaudeError::InvalidLaunch)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(ClaudeError::InvalidLaunch);
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| ClaudeError::InvalidLaunch)?;
    Ok(canonical)
}

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
    pub max_turns: Option<u32>,
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
            max_turns: None,
            settings_path: None,
            mcp_config_path: None,
            append_system_prompt_file: None,
            add_dirs: Vec::new(),
        }
    }

    /// Build the argument vector for Claude Code 2.1.216.  No prompt is put
    /// on argv: all user input goes through the framed stdin protocol.
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
        if let Some(model) = &self.model {
            push_value(&mut args, "--model", model)?;
        }
        if let Some(effort) = &self.effort {
            if !matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max") {
                return Err(ClaudeError::InvalidLaunch);
            }
            push_value(&mut args, "--effort", effort)?;
        }
        if let Some(permission_mode) = &self.permission_mode {
            if !matches!(
                permission_mode.as_str(),
                "acceptEdits" | "auto" | "default" | "dontAsk" | "manual" | "plan"
            ) {
                return Err(ClaudeError::InvalidLaunch);
            }
            push_value(&mut args, "--permission-mode", permission_mode)?;
        }
        if let Some(max_turns) = self.max_turns {
            if !(1..=1000).contains(&max_turns) {
                return Err(ClaudeError::InvalidLaunch);
            }
            args.extend(["--max-turns".into(), max_turns.to_string()]);
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

#[derive(Clone)]
pub struct ClaudeLaunch {
    pub executable: PathBuf,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub process_host: PathBuf,
    pub runtime_root: PathBuf,
    pub run_id: String,
    pub attempt_id: String,
    pub owner_token: String,
    pub invocation: ClaudeInvocation,
}

impl ClaudeLaunch {
    fn validate(&self) -> Result<(), ClaudeError> {
        for path in [
            &self.executable,
            &self.cwd,
            &self.process_host,
            &self.runtime_root,
        ] {
            if !path.is_absolute() {
                return Err(ClaudeError::InvalidLaunch);
            }
        }
        if !self.executable.is_file()
            || !self.cwd.is_dir()
            || !self.process_host.is_file()
            || !self.runtime_root.is_dir()
            || self.run_id.is_empty()
            || self.attempt_id.is_empty()
            || self.owner_token.is_empty()
            || self.owner_token.len() > 256
            || self.owner_token.contains('/')
            || self.owner_token.contains('\\')
            || self.owner_token.contains('\0')
        {
            return Err(ClaudeError::InvalidLaunch);
        }
        if self.run_id.len() > 4096 || self.attempt_id.len() > 4096 {
            return Err(ClaudeError::InvalidLaunch);
        }
        if self.env.len() > 64
            || self.env.iter().any(|(name, value)| {
                name.is_empty()
                    || name.len() > 256
                    || value.len() > 16_384
                    || name.contains('=')
                    || name.contains('\0')
                    || value.contains('\0')
            })
        {
            return Err(ClaudeError::InvalidLaunch);
        }
        self.invocation.argv().map(|_| ())
    }
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
    ControlResponse(ClaudeControlResponse),
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

/// Opaque id for the one interrupt request sent over a Claude stream-json
/// connection. A request receipt is not evidence that Claude stopped; callers
/// still need the matching terminal `result` and process-host cleanup proof.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaudeInterruptRequest {
    request_id: String,
}

impl ClaudeInterruptRequest {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaudeControlResponseStatus {
    Success,
    Rejected,
}

/// The correlated acknowledgement for a client-originated control request.
/// The provider response body and error text are intentionally discarded.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaudeControlResponse {
    request_id: String,
    status: ClaudeControlResponseStatus,
}

impl ClaudeControlResponse {
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn status(&self) -> ClaudeControlResponseStatus {
        self.status
    }
}

/// Encode the installed Claude stream-json user envelope. The returned value
/// includes exactly one LF terminator for the process-host interactive stdin
/// channel.
pub fn encode_user_message(input: &str) -> Result<String, ClaudeError> {
    if input.is_empty() || input.len() > MAX_USER_INPUT_BYTES || input.contains('\0') {
        return Err(ClaudeError::InvalidEvent);
    }
    encode_json_line(
        &json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": input}],
            },
        }),
        MAX_USER_INPUT_BYTES,
    )
}

/// Encode a response to one provider-originated control request. The request
/// id is taken from the parsed event and may not be supplied independently.
pub fn encode_control_response(
    request: &ClaudeControlRequest,
    response: Value,
) -> Result<String, ClaudeError> {
    if !response.is_object() {
        return Err(ClaudeError::InvalidControlResponse);
    }
    encode_json_line(
        &json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request.request_id,
                "response": response,
            },
        }),
        MAX_CONTROL_RESPONSE_BYTES,
    )
}

/// Encode one client-originated interrupt request. The caller chooses a
/// unique id and the transport records it before attempting the write, so an
/// indeterminate host write cannot be retried as a second interrupt.
pub fn encode_interrupt_request(request_id: &str) -> Result<String, ClaudeError> {
    if request_id.is_empty() || request_id.len() > 256 || request_id.contains('\0') {
        return Err(ClaudeError::InvalidControlResponse);
    }
    encode_json_line(
        &json!({
            "type": "control_request",
            "request_id": request_id,
            "request": {"subtype": "interrupt"},
        }),
        MAX_CONTROL_RESPONSE_BYTES,
    )
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

/// Single-owner lease for one in-flight native control request.  Claude may
/// ask for permission or an answer while a turn is running; accepting a
/// second request before the first response is acknowledged would make the
/// control stream ambiguous, so the adapter fails closed.
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
        let value: Value = serde_json::from_slice(raw)?;
        parse_event(value)
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
            let session_id = session_from_field(object, "session_id")?;
            Ok(ClaudeEvent::SystemInit {
                session_id,
                cwd: string_field(object, "cwd"),
                model: string_field(object, "model"),
            })
        }
        "assistant" => {
            let session_id = optional_session(object, "session_id")?;
            let message = object.get("message").and_then(Value::as_object);
            let content = message
                .and_then(|message| message.get("content"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let message_id = message.and_then(|message| string_field(message, "id"));
            let stop_reason = message.and_then(|message| string_field(message, "stop_reason"));
            Ok(ClaudeEvent::Assistant {
                session_id,
                message_id,
                content,
                stop_reason,
            })
        }
        "result" => {
            let session_id = session_from_field(object, "session_id")?;
            let subtype = object
                .get("subtype")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 128)
                .ok_or(ClaudeError::InvalidEvent)?
                .to_owned();
            let is_error = object
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let total_cost_usd_micros = object
                .get("total_cost_usd")
                .and_then(Value::as_f64)
                .and_then(cost_micros);
            Ok(ClaudeEvent::Result {
                session_id,
                uuid: string_field(object, "uuid"),
                subtype,
                is_error,
                result: string_field(object, "result"),
                usage: object.get("usage").cloned(),
                total_cost_usd_micros,
                raw: value,
            })
        }
        "control_request" => {
            let request_id = object
                .get("request_id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 256)
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
        "control_response" => {
            let response = object
                .get("response")
                .and_then(Value::as_object)
                .ok_or(ClaudeError::InvalidControlResponse)?;
            let request_id = response
                .get("request_id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 256 && !value.contains('\0'))
                .ok_or(ClaudeError::InvalidControlResponse)?
                .to_owned();
            let status = match response.get("subtype").and_then(Value::as_str) {
                Some("success") => {
                    if response
                        .get("response")
                        .is_some_and(|value| !value.is_object())
                    {
                        return Err(ClaudeError::InvalidControlResponse);
                    }
                    ClaudeControlResponseStatus::Success
                }
                Some("error") => {
                    if response.get("error").and_then(Value::as_str).is_none() {
                        return Err(ClaudeError::InvalidControlResponse);
                    }
                    ClaudeControlResponseStatus::Rejected
                }
                _ => return Err(ClaudeError::InvalidControlResponse),
            };
            Ok(ClaudeEvent::ControlResponse(ClaudeControlResponse {
                request_id,
                status,
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

fn cost_micros(cost: f64) -> Option<u64> {
    if cost.is_finite() && cost >= 0.0 && cost <= (u64::MAX as f64 / 1_000_000.0) {
        Some((cost * 1_000_000.0).round() as u64)
    } else {
        None
    }
}

fn string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 64 * 1024)
        .map(str::to_owned)
}

fn session_from_field(
    object: &Map<String, Value>,
    key: &str,
) -> Result<ClaudeSessionSelector, ClaudeError> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or(ClaudeError::InvalidSession)?;
    ClaudeSessionSelector::parse(value)
}

fn optional_session(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<ClaudeSessionSelector>, ClaudeError> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    let value = value.as_str().ok_or(ClaudeError::InvalidSession)?;
    ClaudeSessionSelector::parse(value).map(Some)
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
    total_cost_usd: Option<u64>,
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
        self.total_cost_usd
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
        total_cost_usd: total_cost_usd_micros,
    })
}

pub enum ClaudeTransportEvent {
    Lifecycle(Value),
    Provider(ClaudeEvent),
}

/// One owned Claude Code process.  It is intentionally lower-level than the
/// shared Native Chat worker: callers must retain the connection cleanup proof
/// and map the provider receipt through the worker's Rust finalizer.
pub struct ClaudeTransport {
    host: OwnedHost,
    decoder: LineDecoder,
    events: VecDeque<ClaudeEvent>,
    pending_write: Option<PendingWrite>,
    next_write: u64,
    request_id: String,
    owner_token: String,
    session_id: Option<ClaudeSessionSelector>,
    process_id: Option<i32>,
    control_lease: ClaudeControlLease,
    user_input_sent: bool,
    interrupt_request: Option<ClaudeInterruptRequest>,
    interrupt_response_seen: bool,
    terminal: Option<ClaudeTurnReceipt>,
    terminal_received: bool,
}

struct PendingWrite {
    bytes: String,
    offset: usize,
}

impl ClaudeTransport {
    pub fn launch(launch: ClaudeLaunch) -> Result<Self, ClaudeError> {
        Self::launch_with_permit(launch, None)
    }

    pub fn launch_for_execution(
        launch: ClaudeLaunch,
        permit: ConnectionLaunchPermit,
    ) -> Result<Self, ClaudeError> {
        Self::launch_with_permit(launch, Some(permit))
    }

    fn launch_with_permit(
        launch: ClaudeLaunch,
        permit: Option<ConnectionLaunchPermit>,
    ) -> Result<Self, ClaudeError> {
        launch.validate()?;
        let executable = ClaudeExecutable::resolve(&launch.executable)?;
        let request_id = launch.attempt_id.clone();
        let owner_token = launch.owner_token.clone();
        let start = Command::StartProcess {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(request_id.clone()),
            executable: executable
                .path()
                .to_str()
                .ok_or(ClaudeError::InvalidLaunch)?
                .to_owned(),
            argv: launch.invocation.argv()?,
            cwd: launch
                .cwd
                .to_str()
                .ok_or(ClaudeError::InvalidLaunch)?
                .to_owned(),
            env: launch.env,
            owner_token: Some(owner_token.clone()),
            runtime_root: Some(
                launch
                    .runtime_root
                    .to_str()
                    .ok_or(ClaudeError::InvalidLaunch)?
                    .to_owned(),
            ),
            stdin: None,
            interactive_stdin: true,
            grace_ms: Some(2_000),
        };
        start.validate().map_err(|_| ClaudeError::InvalidLaunch)?;
        let connection = HostConnection {
            request_id: request_id.clone(),
            run_id: launch.run_id,
            attempt_id: launch.attempt_id,
            owner_token: owner_token.clone(),
        };
        let host = OwnedHost::launch_external(connection, &launch.process_host, permit)
            .map_err(map_host_error)?;
        host.send(start).map_err(map_host_error)?;
        Ok(Self {
            host,
            decoder: LineDecoder::default(),
            events: VecDeque::new(),
            pending_write: None,
            next_write: 0,
            request_id,
            owner_token,
            session_id: None,
            process_id: None,
            control_lease: ClaudeControlLease::default(),
            user_input_sent: false,
            interrupt_request: None,
            interrupt_response_seen: false,
            terminal: None,
            terminal_received: false,
        })
    }

    pub fn wait_spawned(&mut self, timeout: Duration) -> Result<(), ClaudeError> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let event = self.receive_one(remaining(deadline), true)?;
            match event {
                ClaudeTransportEvent::Lifecycle(value)
                    if value.get("type").and_then(Value::as_str) == Some("spawned") =>
                {
                    let process_id = value
                        .get("pid")
                        .and_then(Value::as_i64)
                        .and_then(|pid| i32::try_from(pid).ok())
                        .filter(|pid| *pid > 0)
                        .ok_or(ClaudeError::InvalidEvent)?;
                    self.process_id = Some(process_id);
                    return Ok(());
                }
                ClaudeTransportEvent::Lifecycle(value)
                    if value.get("type").and_then(Value::as_str) == Some("terminal") =>
                {
                    return Err(ClaudeError::Closed);
                }
                ClaudeTransportEvent::Lifecycle(_) | ClaudeTransportEvent::Provider(_) => {}
            }
        }
    }

    pub fn session_id(&self) -> Option<&ClaudeSessionSelector> {
        self.session_id.as_ref()
    }

    /// Process identity reported by the owned process host after spawn. The
    /// caller can persist this before sending provider input.
    pub fn process_id(&self) -> Option<i32> {
        self.process_id
    }

    pub fn connection_receipt(&self) -> ConnectionReceipt {
        self.host.connection_identity().connection_receipt()
    }

    pub fn send_user_message(&mut self, input: &str) -> Result<(), ClaudeError> {
        if self.user_input_sent || self.terminal.is_some() || self.terminal_received {
            return Err(ClaudeError::Busy);
        }
        let frame = encode_user_message(input)?;
        self.user_input_sent = true;
        self.write_frame(frame)
    }

    /// Send at most one Claude-native interrupt for the submitted user input.
    /// A successful return means the process host accepted the framed write;
    /// it is not a provider acknowledgement or a terminal observation.
    pub fn send_interrupt(&mut self) -> Result<ClaudeInterruptRequest, ClaudeError> {
        if !self.user_input_sent
            || self.interrupt_request.is_some()
            || self.terminal.is_some()
            || self.terminal_received
        {
            return Err(ClaudeError::Busy);
        }
        let request = ClaudeInterruptRequest {
            request_id: format!("req_stop_{}", Uuid::new_v4().simple()),
        };
        let frame = encode_interrupt_request(request.request_id())?;
        self.interrupt_request = Some(request.clone());
        self.write_frame(frame)?;
        Ok(request)
    }

    /// Respond to a live Claude control request. The request id is copied from
    /// the provider event, so a caller cannot answer another session's prompt.
    pub fn respond_control(
        &mut self,
        request: &ClaudeControlRequest,
        response: Value,
    ) -> Result<(), ClaudeError> {
        let frame = encode_control_response(request, response)?;
        if self.control_lease.pending_request_id() != Some(request.request_id()) {
            return Err(ClaudeError::InvalidControlResponse);
        }
        self.write_frame(frame)?;
        self.control_lease.authorize(request)
    }

    pub fn pending_control_request_id(&self) -> Option<&str> {
        self.control_lease.pending_request_id()
    }

    /// Stop the owned provider process through the Rust process host. This is
    /// an owned process cutoff; the shared worker must still reconcile whether
    /// Claude emitted a terminal `result` before it promotes cancellation.
    pub fn stop(&mut self, grace_ms: u64) -> Result<(), ClaudeError> {
        if grace_ms > 60_000 {
            return Err(ClaudeError::InvalidLaunch);
        }
        self.host
            .send(Command::Stop {
                protocol_version: Some(ProtocolVersion::default()),
                request_id: Some(self.request_id.clone()),
                grace_ms: Some(grace_ms),
            })
            .map_err(map_host_error)
    }

    pub fn poll(&mut self, timeout: Duration) -> Result<Option<ClaudeTransportEvent>, ClaudeError> {
        match self.receive_one(timeout, true) {
            Ok(value) => Ok(Some(value)),
            Err(ClaudeError::Timeout) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// Receive already-produced output while the owned host is shutting down.
    /// Unlike `poll`, this path never flushes a queued provider write, so
    /// cleanup cannot replay or create a provider effect.
    pub fn poll_cleanup(
        &mut self,
        timeout: Duration,
    ) -> Result<Option<ClaudeTransportEvent>, ClaudeError> {
        match self.receive_one(timeout, false) {
            Ok(value) => Ok(Some(value)),
            Err(ClaudeError::Timeout) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn receive(&mut self, timeout: Duration) -> Result<ClaudeTransportEvent, ClaudeError> {
        self.receive_one(timeout, true)
    }

    pub fn take_event(&mut self) -> Option<ClaudeEvent> {
        self.events.pop_front()
    }

    pub fn take_terminal(&mut self) -> Option<ClaudeTurnReceipt> {
        self.terminal.take()
    }

    pub fn take_cleanup_proof(&mut self) -> Option<HostCleanupProof> {
        if self.terminal_received {
            self.host.take_cleanup_proof()
        } else {
            None
        }
    }

    fn receive_one(
        &mut self,
        timeout: Duration,
        flush_pending: bool,
    ) -> Result<ClaudeTransportEvent, ClaudeError> {
        if self.terminal_received {
            return Err(ClaudeError::Closed);
        }
        if let Some(event) = self.events.pop_front() {
            return Ok(ClaudeTransportEvent::Provider(event));
        }
        if flush_pending {
            self.flush_pending()?;
        }
        match self.host.receive(timeout).map_err(map_host_error)? {
            HostEvent::Stderr(_) if !flush_pending => Err(ClaudeError::Timeout),
            HostEvent::Stderr(_) => self.receive_one(timeout, flush_pending),
            HostEvent::Failure => Err(ClaudeError::Closed),
            HostEvent::Lifecycle(value) => {
                if value.get("type").and_then(Value::as_str) == Some("terminal") {
                    self.terminal_received = true;
                }
                Ok(ClaudeTransportEvent::Lifecycle(value))
            }
            HostEvent::Stdout(bytes) => {
                let mut parsed = self.decoder.push(&bytes, ClaudeEvent::parse)?;
                if parsed.is_empty() {
                    if !flush_pending {
                        // A cleanup receive is always nonblocking or bounded;
                        // let its caller continue the bounded drain instead
                        // of recursively consuming an unbounded stdout stream.
                        return Err(ClaudeError::Timeout);
                    }
                    return self.receive_one(timeout, flush_pending);
                }
                for event in parsed.drain(..) {
                    self.observe(event)?;
                }
                self.events
                    .pop_front()
                    .map(ClaudeTransportEvent::Provider)
                    .ok_or(ClaudeError::InvalidEvent)
            }
        }
    }

    fn observe(&mut self, event: ClaudeEvent) -> Result<(), ClaudeError> {
        match &event {
            ClaudeEvent::SystemInit { session_id, .. } => {
                if let Some(existing) = &self.session_id
                    && existing != session_id
                {
                    return Err(ClaudeError::InvalidSession);
                }
                self.session_id = Some(session_id.clone());
            }
            ClaudeEvent::Assistant { session_id, .. }
            | ClaudeEvent::UserEcho { session_id, .. } => {
                if let Some(session_id) = session_id {
                    if let Some(existing) = &self.session_id {
                        if existing != session_id {
                            return Err(ClaudeError::InvalidSession);
                        }
                    } else {
                        self.session_id = Some(session_id.clone());
                    }
                }
            }
            ClaudeEvent::Result { session_id, .. } => {
                if self
                    .session_id
                    .as_ref()
                    .is_some_and(|existing| existing != session_id)
                {
                    return Err(ClaudeError::InvalidSession);
                }
                self.session_id = Some(session_id.clone());
                if self.terminal.is_some() {
                    return Err(ClaudeError::InvalidEvent);
                }
                self.terminal = Some(receipt_from_result(event.clone())?);
            }
            ClaudeEvent::ControlRequest(request) => self.control_lease.observe(request)?,
            ClaudeEvent::ControlResponse(response) => {
                validate_interrupt_response(
                    self.interrupt_request.as_ref(),
                    self.interrupt_response_seen,
                    response,
                )?;
                self.interrupt_response_seen = true;
            }
            ClaudeEvent::Unknown { .. } => {}
        }
        if self.events.len() >= MAX_EVENT_QUEUE {
            return Err(ClaudeError::OutputOverflow);
        }
        self.events.push_back(event);
        Ok(())
    }

    fn write_frame(&mut self, frame: String) -> Result<(), ClaudeError> {
        if self.pending_write.is_some() {
            return Err(ClaudeError::Busy);
        }
        self.pending_write = Some(PendingWrite {
            bytes: frame,
            offset: 0,
        });
        self.flush_pending()
    }

    fn flush_pending(&mut self) -> Result<(), ClaudeError> {
        let Some(frame) = self.pending_write.as_mut() else {
            return Ok(());
        };
        if frame.offset >= frame.bytes.len() {
            self.pending_write = None;
            return Ok(());
        }
        let end = (frame.offset + 64 * 1024).min(frame.bytes.len());
        self.next_write = self
            .next_write
            .checked_add(1)
            .ok_or(ClaudeError::WriteIndeterminate)?;
        let command = Command::WriteStdin {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(self.request_id.clone()),
            owner_token: Some(self.owner_token.clone()),
            write_id: Some(format!("claude-write-{}", self.next_write)),
            data: frame.bytes[frame.offset..end].to_owned(),
        };
        self.host.send(command).map_err(map_host_error)?;
        frame.offset = end;
        if frame.offset == frame.bytes.len() {
            self.pending_write = None;
        }
        Ok(())
    }
}

fn validate_interrupt_response(
    request: Option<&ClaudeInterruptRequest>,
    response_seen: bool,
    response: &ClaudeControlResponse,
) -> Result<(), ClaudeError> {
    if request.map(ClaudeInterruptRequest::request_id) != Some(response.request_id())
        || response_seen
    {
        return Err(ClaudeError::InvalidControlResponse);
    }
    Ok(())
}

fn encode_json_line(value: &Value, max_bytes: usize) -> Result<String, ClaudeError> {
    let mut bytes = serde_json::to_vec(value)?;
    if bytes.len() >= max_bytes || bytes.contains(&b'\n') || bytes.contains(&b'\r') {
        return Err(ClaudeError::InvalidEvent);
    }
    bytes.push(b'\n');
    String::from_utf8(bytes).map_err(|_| ClaudeError::InvalidEvent)
}

fn map_host_error(error: HostError) -> ClaudeError {
    match error {
        HostError::InvalidLaunch => ClaudeError::InvalidLaunch,
        HostError::Closed => ClaudeError::Closed,
        HostError::Timeout => ClaudeError::Timeout,
        HostError::OutputOverflow => ClaudeError::OutputOverflow,
    }
}

fn remaining(deadline: std::time::Instant) -> Duration {
    deadline.saturating_duration_since(std::time::Instant::now())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaudeHistoryEntry {
    pub event: ClaudeEvent,
}

/// Complete raw JSONL Reader for one explicit Claude session. The caller must
/// already have authorization for the session and supply the managed root; the
/// Reader never searches for “latest” in a directory and never falls back to a
/// model-restoration-only chain.
pub struct ClaudeHistoryReader {
    root: PathBuf,
    session: ClaudeSessionSelector,
}

impl ClaudeHistoryReader {
    pub fn new(root: PathBuf, session: ClaudeSessionSelector) -> Result<Self, ClaudeError> {
        let root = root
            .canonicalize()
            .map_err(|_| ClaudeError::InvalidHistoryPath)?;
        if !root.is_dir() {
            return Err(ClaudeError::InvalidHistoryPath);
        }
        Ok(Self { root, session })
    }

    pub fn read_path(&self, path: &Path) -> Result<Vec<ClaudeHistoryEntry>, ClaudeError> {
        let metadata = fs::symlink_metadata(path).map_err(|_| ClaudeError::InvalidHistoryPath)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() > MAX_HISTORY_BYTES
        {
            return Err(if metadata.len() > MAX_HISTORY_BYTES {
                ClaudeError::HistoryTooLarge
            } else {
                ClaudeError::InvalidHistoryPath
            });
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
        let mut file = fs::File::open(canonical).map_err(|_| ClaudeError::InvalidHistoryPath)?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.read_to_end(&mut bytes)
            .map_err(|_| ClaudeError::InvalidHistoryPath)?;
        let mut decoder = LineDecoder::default();
        let events = decoder.push(&bytes, ClaudeEvent::parse)?;
        decoder.finish()?;
        Ok(events
            .into_iter()
            .map(|event| ClaudeHistoryEntry { event })
            .collect())
    }

    /// Resolve the provider's deterministic project directory for one
    /// canonical working directory.  The reader never scans a directory and
    /// never chooses a latest session; the caller must provide the explicit
    /// Session ID held by the Rust admission record.
    pub fn path_for_cwd(&self, projects_root: &Path, cwd: &Path) -> Result<PathBuf, ClaudeError> {
        let projects_root = canonical_directory(projects_root)?;
        if !projects_root.starts_with(&self.root) {
            return Err(ClaudeError::InvalidHistoryPath);
        }
        let cwd = canonical_directory(cwd)?;
        let project_name = encoded_project_name(&cwd)?;
        let project_dir = projects_root.join(project_name);
        let project_dir_meta =
            fs::symlink_metadata(&project_dir).map_err(|_| ClaudeError::InvalidHistoryPath)?;
        if !project_dir_meta.is_dir() || project_dir_meta.file_type().is_symlink() {
            return Err(ClaudeError::InvalidHistoryPath);
        }
        let project_dir = project_dir
            .canonicalize()
            .map_err(|_| ClaudeError::InvalidHistoryPath)?;
        if !project_dir.starts_with(&projects_root) {
            return Err(ClaudeError::InvalidHistoryPath);
        }
        Ok(project_dir.join(format!("{}.jsonl", self.session.as_str())))
    }

    pub fn read_for_cwd(
        &self,
        projects_root: &Path,
        cwd: &Path,
    ) -> Result<Vec<ClaudeHistoryEntry>, ClaudeError> {
        let path = self.path_for_cwd(projects_root, cwd)?;
        self.read_path(&path)
    }

    pub fn session(&self) -> &ClaudeSessionSelector {
        &self.session
    }
}

fn encoded_project_name(cwd: &Path) -> Result<String, ClaudeError> {
    let value = cwd.to_str().ok_or(ClaudeError::InvalidHistoryPath)?;
    if value.is_empty() || value.contains('\0') {
        return Err(ClaudeError::InvalidHistoryPath);
    }
    let encoded: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect();
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

    #[cfg(not(windows))]
    #[test]
    fn encoded_project_name_matches_claude_unix_slug() {
        assert_eq!(
            encoded_project_name(Path::new("/Users/dev/repo")).unwrap(),
            "-Users-dev-repo"
        );
    }

    #[cfg(windows)]
    #[test]
    fn encoded_project_name_matches_claude_windows_slug() {
        assert_eq!(
            encoded_project_name(Path::new(r"C:\Users\dev\repo")).unwrap(),
            "C--Users-dev-repo"
        );
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
            max_turns: Some(300),
            settings_path: None,
            mcp_config_path: None,
            append_system_prompt_file: None,
            add_dirs: Vec::new(),
        };
        let args = invocation.argv().unwrap();
        assert_eq!(
            args[0..8],
            [
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
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--permission-mode", "auto"])
        );
        assert!(args.windows(2).any(|pair| pair == ["--max-turns", "300"]));
        assert!(args.contains(&"--fork-session".to_owned()));
        assert!(!args.contains(&"--continue".to_owned()));
    }

    #[test]
    fn parses_real_2_1_216_init_and_result_events() {
        let init = br#"{"type":"system","subtype":"init","cwd":"/workspace","session_id":"05a82e73-f42d-4a40-9323-e58356868e6b","model":"gpt-5.6-luna"}"#;
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
    fn interrupt_wire_shape_and_ack_are_correlated_and_nonterminal() {
        let frame = encode_interrupt_request("req_stop_42").unwrap();
        assert_eq!(frame.bytes().filter(|byte| *byte == b'\n').count(), 1);
        let wire: Value = serde_json::from_str(frame.trim_end()).unwrap();
        assert_eq!(wire["type"], "control_request");
        assert_eq!(wire["request_id"], "req_stop_42");
        assert_eq!(wire["request"], json!({"subtype":"interrupt"}));

        let parsed = ClaudeEvent::parse(
            br#"{"type":"control_response","response":{"subtype":"success","request_id":"req_stop_42","response":{"still_queued":[]}}}"#,
        )
        .unwrap();
        let ClaudeEvent::ControlResponse(response) = parsed else {
            panic!("an interrupt ACK must remain a control-response event");
        };
        assert_eq!(response.request_id(), "req_stop_42");
        assert_eq!(response.status(), ClaudeControlResponseStatus::Success);
        assert!(receipt_from_result(ClaudeEvent::ControlResponse(response.clone())).is_err());
        assert!(
            validate_interrupt_response(
                Some(&ClaudeInterruptRequest {
                    request_id: "req_stop_42".into(),
                }),
                false,
                &response,
            )
            .is_ok()
        );
        assert!(
            validate_interrupt_response(
                Some(&ClaudeInterruptRequest {
                    request_id: "req_other".into(),
                }),
                false,
                &response,
            )
            .is_err()
        );
        assert!(
            validate_interrupt_response(
                Some(&ClaudeInterruptRequest {
                    request_id: "req_stop_42".into(),
                }),
                true,
                &response,
            )
            .is_err()
        );
    }

    #[test]
    fn rejected_interrupt_ack_is_typed_without_retaining_provider_text() {
        let event = ClaudeEvent::parse(
            br#"{"type":"control_response","response":{"subtype":"error","request_id":"req_stop_42","error":"private provider detail"}}"#,
        )
        .unwrap();
        let ClaudeEvent::ControlResponse(response) = event else {
            panic!("expected correlated control response");
        };
        assert_eq!(response.status(), ClaudeControlResponseStatus::Rejected);
        assert_eq!(response.request_id(), "req_stop_42");
        assert!(!format!("{response:?}").contains("private provider detail"));

        for invalid in [
            br#"{"type":"control_response","response":{"subtype":"success"}}"#.as_slice(),
            br#"{"type":"control_response","response":{"subtype":"other","request_id":"req_stop_42"}}"#.as_slice(),
            br#"{"type":"control_response","response":{"subtype":"success","request_id":"req_stop_42","response":[]}}"#.as_slice(),
            br#"{"type":"control_response","response":{"subtype":"error","request_id":"req_stop_42"}}"#.as_slice(),
        ] {
            assert!(ClaudeEvent::parse(invalid).is_err());
        }
        assert!(encode_interrupt_request("").is_err());
        assert!(encode_interrupt_request(&"x".repeat(257)).is_err());
    }

    #[test]
    fn interrupted_execution_records_actual_terminal_result_not_ack_as_success() {
        let terminal = ClaudeEvent::parse(
            br#"{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"05a82e73-f42d-4a40-9323-e58356868e6b"}"#,
        )
        .unwrap();
        let receipt = receipt_from_result(terminal).unwrap();
        assert_eq!(receipt.status(), ClaudeTurnStatus::Failed);
        assert_eq!(receipt.summary(), None);
        assert_eq!(receipt.session_id().as_str(), session().as_str());
    }

    #[test]
    fn control_response_copies_provider_request_id() {
        let request = ClaudeControlRequest {
            request_id: "req-42".into(),
            subtype: "permission_request".into(),
            request: json!({"tool_name":"Bash"}),
        };
        let value = json!({"behavior":"deny","message":"operator denied"});
        let encoded = encode_control_response(&request, value).unwrap();
        let encoded: Value = serde_json::from_str(encoded.trim_end()).unwrap();
        assert_eq!(encoded["response"]["request_id"], request.request_id());
        assert!(encoded["response"]["response"].is_object());
        let parsed = ClaudeEvent::parse(
            br#"{"type":"control_request","request_id":"req-42","request":{"subtype":"permission_request","tool_name":"Bash"}}"#,
        )
        .unwrap();
        let ClaudeEvent::ControlRequest(parsed) = parsed else {
            panic!("expected control request");
        };
        assert_eq!(parsed.request_id(), request.request_id());
        assert_eq!(parsed.subtype(), request.subtype());
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
    }

    #[test]
    fn user_payload_is_bounded_and_json_lf_safe() {
        let frame = encode_user_message("line1\nline2").unwrap();
        assert_eq!(frame.bytes().filter(|byte| *byte == b'\n').count(), 1);
        assert!(encode_user_message(&"x".repeat(MAX_USER_INPUT_BYTES)).is_err());
    }

    #[test]
    fn trusted_executable_and_profile_are_canonical_and_isolated() {
        let executable = ClaudeExecutable::resolve(&std::env::current_exe().unwrap()).unwrap();
        assert!(executable.path().is_absolute());

        let temp = tempfile::tempdir().unwrap();
        let operator = temp.path().join("operator");
        let managed = temp.path().join("managed");
        fs::create_dir(&operator).unwrap();
        fs::create_dir(&managed).unwrap();
        fs::create_dir(managed.join(".claude")).unwrap();
        let profile = ClaudeRuntimeProfile::new(operator.clone(), managed.clone()).unwrap();
        let env = profile.environment().unwrap();
        let operator = operator.canonicalize().unwrap();
        let managed = managed.canonicalize().unwrap();
        assert_eq!(env["HOME"], operator.to_str().unwrap());
        assert_eq!(env["USERPROFILE"], operator.to_str().unwrap());
        assert_eq!(
            env["CLAUDE_CONFIG_DIR"],
            managed.join(".claude").to_str().unwrap()
        );
        assert_eq!(env["RUDDER_CLAUDE_HOME"], managed.to_str().unwrap());
        assert_eq!(profile.managed_home(), Some(managed.as_path()));
        assert!(ClaudeRuntimeProfile::new(operator.clone(), operator).is_err());
    }

    #[test]
    fn operator_profile_uses_existing_claude_dir_without_managed_home() {
        let temp = tempfile::tempdir().unwrap();
        let operator = temp.path().join("operator");
        let config_dir = operator.join(".claude");
        fs::create_dir_all(&config_dir).unwrap();
        let marker = b"synthetic operator auth marker; not a credential";
        fs::write(config_dir.join("operator-marker"), marker).unwrap();

        let profile = ClaudeRuntimeProfile::operator_default(operator.clone()).unwrap();
        let canonical_operator = operator.canonicalize().unwrap();
        let env = profile.environment().unwrap();
        assert_eq!(env["HOME"], canonical_operator.to_str().unwrap());
        assert_eq!(env["USERPROFILE"], canonical_operator.to_str().unwrap());
        assert_eq!(
            env["CLAUDE_CONFIG_DIR"],
            canonical_operator.join(".claude").to_str().unwrap()
        );
        assert_eq!(
            env["RUDDER_OPERATOR_HOME"],
            canonical_operator.to_str().unwrap()
        );
        assert!(!env.contains_key("RUDDER_CLAUDE_HOME"));
        assert_eq!(profile.managed_home(), None);
        assert_eq!(
            fs::read(config_dir.join("operator-marker")).unwrap(),
            marker,
            "profile selection must not modify operator-owned files"
        );
    }

    #[cfg(unix)]
    #[test]
    fn operator_profile_rejects_symlinked_claude_dir() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let operator = temp.path().join("operator");
        let redirected = temp.path().join("redirected-claude");
        fs::create_dir_all(&operator).unwrap();
        fs::create_dir_all(&redirected).unwrap();
        symlink(redirected, operator.join(".claude")).unwrap();
        assert!(ClaudeRuntimeProfile::operator_default(operator).is_err());
    }

    #[test]
    fn control_lease_rejects_concurrent_or_stale_owners() {
        let first = ClaudeControlRequest {
            request_id: "req-1".into(),
            subtype: "permission_request".into(),
            request: json!({"tool_name":"Bash"}),
        };
        let second = ClaudeControlRequest {
            request_id: "req-2".into(),
            subtype: "question".into(),
            request: json!({"question":"continue?"}),
        };
        let mut lease = ClaudeControlLease::default();
        lease.observe(&first).unwrap();
        assert_eq!(lease.pending_request_id(), Some("req-1"));
        assert!(lease.observe(&second).is_err());
        assert!(lease.authorize(&second).is_err());
        lease.authorize(&first).unwrap();
        assert_eq!(lease.pending_request_id(), None);
    }

    #[test]
    fn history_reader_resolves_only_the_explicit_cwd_and_session() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join("projects");
        let cwd = root.path().join("workspace");
        fs::create_dir(&projects).unwrap();
        fs::create_dir(&cwd).unwrap();
        let projects = projects.canonicalize().unwrap();
        let cwd = cwd.canonicalize().unwrap();
        let project_dir = projects.join(encoded_project_name(&cwd).unwrap());
        fs::create_dir(&project_dir).unwrap();
        let path = project_dir.join(format!("{}.jsonl", session().as_str()));
        fs::write(
            &path,
            format!(
                "{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{}\"}}\n",
                session().as_str()
            ),
        )
        .unwrap();

        let reader = ClaudeHistoryReader::new(projects.clone(), session()).unwrap();
        assert_eq!(reader.path_for_cwd(&projects, &cwd).unwrap(), path);
        assert_eq!(reader.read_for_cwd(&projects, &cwd).unwrap().len(), 1);
        let other = root.path().join("other");
        fs::create_dir(&other).unwrap();
        assert!(reader.path_for_cwd(&projects, &other).is_err());
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "requires RUDDER_TEST_PROCESS_HOST and a synthetic local child only"]
    fn cleanup_poll_recovers_terminal_queued_during_slow_authority_tick() {
        use std::{
            os::unix::fs::PermissionsExt,
            path::PathBuf,
            time::{Duration, Instant},
        };

        let process_host = std::env::var_os("RUDDER_TEST_PROCESS_HOST")
            .expect("set RUDDER_TEST_PROCESS_HOST to the Rust process-host binary");
        let process_host = PathBuf::from(process_host)
            .canonicalize()
            .expect("canonical process host");
        let root = tempfile::tempdir().unwrap();
        let runtime_root = root.path().join("runtime");
        let cwd = root.path().join("cwd");
        fs::create_dir_all(&runtime_root).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let executable = root.path().join("synthetic-claude");
        fs::write(
            &executable,
            b"#!/bin/sh\ntrap '' TERM\nwhile :; do /bin/sleep 1; done\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();

        let run_id = "slow-claude-cleanup-run".to_owned();
        let attempt_id = "slow-claude-cleanup-attempt".to_owned();
        let owner_token = "slow-claude-cleanup-owner".to_owned();
        let launch = ClaudeLaunch {
            executable,
            cwd: cwd.canonicalize().unwrap(),
            env: BTreeMap::new(),
            process_host,
            runtime_root,
            run_id: run_id.clone(),
            attempt_id: attempt_id.clone(),
            owner_token: owner_token.clone(),
            invocation: ClaudeInvocation::new(ClaudeSessionMode::New {
                session_id: Some(ClaudeSessionSelector::new()),
            }),
        };
        let mut transport = ClaudeTransport::launch_for_execution(
            launch,
            ConnectionLaunchPermit::from_claim(
                run_id.clone(),
                attempt_id.clone(),
                owner_token.clone(),
                1,
                "slow-claude-cleanup-claim".into(),
            ),
        )
        .expect("launch synthetic CLI through owned process host");
        transport
            .wait_spawned(Duration::from_secs(5))
            .expect("owned process reaches spawned lifecycle");
        assert!(
            transport
                .process_id()
                .is_some_and(|process_id| process_id > 0),
            "the owned process identity is available before provider input"
        );
        transport.stop(100).expect("send bounded host stop");

        let started = Instant::now();
        // Model a synchronous D1 cleanup tick that outlives the remaining
        // host receive window. The terminal must still be collectable after
        // the hook returns, without flushing a provider write.
        std::thread::sleep(Duration::from_millis(700));
        assert!(started.elapsed() >= Duration::from_millis(700));
        let mut terminal_seen = false;
        for _ in 0..128 {
            match transport.poll_cleanup(Duration::ZERO) {
                Ok(Some(ClaudeTransportEvent::Lifecycle(value)))
                    if value.get("type").and_then(Value::as_str) == Some("terminal") =>
                {
                    terminal_seen = true;
                    break;
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(ClaudeError::Closed | ClaudeError::Timeout) => break,
                Err(error) => panic!("cleanup receive failed: {error}"),
            }
        }
        assert!(
            terminal_seen,
            "terminal emitted during tick must be observed"
        );
        let proof = transport
            .take_cleanup_proof()
            .expect("matching terminal yields the exact host cleanup proof");
        assert!(proof.matches_execution(&run_id, &attempt_id, &owner_token));
    }
}
