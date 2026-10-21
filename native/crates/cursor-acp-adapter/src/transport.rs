//! Rust-owned Cursor ACP process transport.
//!
//! The protocol reducer in `lib.rs` is useful without a process, but a native
//! Chat claim needs a real owner for the Cursor child.  This transport keeps
//! that owner behind the same Rust process-host boundary used by the other
//! local runtimes.  It intentionally stops at ACP observations: D1 admission,
//! provider identity checkpoints, transcript projection and billing remain
//! the caller's responsibility.

use super::rules::{CursorManagedInstructionRule, materialize};
use super::{
    CursorAcpCommand, CursorAcpMessage, CursorAcpSession, JsonRpcResponse, RequestId, SessionId,
    parse_message,
};
use rudder_native_process_transport::{
    ConnectionLaunchPermit, ConnectionReceipt, HostCleanupProof, HostConnection, HostError,
    HostEvent, OwnedHost,
};
use rudder_native_protocol::{
    Command, ProtocolVersion,
    lines::{LineDecoder, LineError},
};
use serde_json::Value;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MAX_EVENT_QUEUE: usize = 256;
const MAX_EVENT_JSON_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CursorAcpTransportError {
    #[error("Cursor ACP process launch is invalid")]
    InvalidLaunch,
    #[error("Cursor ACP transport is closed")]
    Closed,
    #[error("Cursor ACP request is already in flight")]
    Busy,
    #[error("Cursor ACP response does not match the active request")]
    MismatchedResponse,
    #[error("Cursor ACP response was rejected")]
    Rejected,
    #[error("Cursor ACP stream is malformed")]
    InvalidMessage,
    #[error("Cursor ACP event buffer exceeded its limit")]
    OutputOverflow,
    #[error("Cursor ACP stdin write outcome is indeterminate")]
    WriteIndeterminate,
    #[error("Cursor ACP child exited before completing the request")]
    ProcessExited,
    #[error("Cursor ACP operation deadline expired")]
    Timeout,
    #[error("Cursor managed instruction rule could not be safely materialized")]
    InstructionRuleUnavailable,
}

impl From<LineError> for CursorAcpTransportError {
    fn from(_: LineError) -> Self {
        Self::InvalidMessage
    }
}

/// Trusted process data assembled by the Rust host.  No field is accepted
/// directly from an HTTP request or serialized across the public API.
pub struct CursorAcpProcessLaunch {
    pub executable: PathBuf,
    pub process_host: PathBuf,
    pub runtime_root: PathBuf,
    /// The provider/model selector is passed as the installed CLI's global
    /// `--model` option before the `acp` subcommand. This value is resolved by
    /// D1 and never comes from an arbitrary argv setting.
    pub model: Option<String>,
    /// Native Chat selects between the existing isolated runtime home and an
    /// explicitly selected provider profile. This path is never supplied by
    /// a request.
    pub home: CursorAcpHome,
    pub cwd: PathBuf,
    /// Claim-resolved data for the per-Agent managed fallback workspace.
    /// The adapter writes it before starting the process host.
    pub instruction_rule: Option<CursorManagedInstructionRule>,
    pub run_id: String,
    pub attempt_id: String,
    pub owner_token: String,
    pub env: std::collections::BTreeMap<String, String>,
}

/// A Cursor process runs in the per-run isolated HOME by default. The explicit
/// operator-default mode opts into the selected operator profile in place.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CursorAcpHome {
    IsolatedRuntime(PathBuf),
    OperatorProfile(PathBuf),
}

impl CursorAcpHome {
    fn path(&self) -> &Path {
        match self {
            Self::IsolatedRuntime(path) | Self::OperatorProfile(path) => path,
        }
    }

    fn uses_provider_profile(&self) -> bool {
        matches!(self, Self::OperatorProfile(_))
    }
}

/// One owned Cursor ACP process and its bounded JSON-RPC line stream.
pub struct CursorAcpTransport {
    host: OwnedHost,
    decoder: LineDecoder,
    messages: VecDeque<CursorAcpMessage>,
    pending: Option<RequestId>,
    reserved: Option<RequestId>,
    next_write_id: u64,
    request_id: String,
    owner_token: String,
    spawned: bool,
    terminal: bool,
    host_failure: bool,
    cleanup_proof: Option<HostCleanupProof>,
    session: CursorAcpSession,
}

impl CursorAcpTransport {
    /// Launch Cursor's documented ACP subcommand through the external Rust
    /// process host. The one-use D1 permit is consumed by this owner.
    pub fn launch(
        launch: CursorAcpProcessLaunch,
        permit: ConnectionLaunchPermit,
    ) -> Result<Self, CursorAcpTransportError> {
        let launch = validate_launch(launch)?;
        if let Some(rule) = &launch.instruction_rule {
            materialize(&launch.cwd, rule)
                .map_err(|_| CursorAcpTransportError::InstructionRuleUnavailable)?;
        }
        let env = cursor_process_environment(launch.env, launch.home.path())?;
        let argv = cursor_acp_argv(launch.model.as_deref())?;
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

        let start = Command::StartProcess {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(request_id.clone()),
            executable: launch.executable.to_string_lossy().into_owned(),
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
            .map_err(|_| CursorAcpTransportError::InvalidLaunch)?;
        host.send(start).map_err(map_host_error)?;

        Ok(Self {
            host,
            decoder: LineDecoder::default(),
            messages: VecDeque::new(),
            pending: None,
            reserved: None,
            next_write_id: 0,
            request_id,
            owner_token,
            spawned: false,
            terminal: false,
            host_failure: false,
            cleanup_proof: None,
            session: CursorAcpSession::new(),
        })
    }

    pub fn session(&self) -> &CursorAcpSession {
        &self.session
    }

    pub fn connection_receipt(&self) -> ConnectionReceipt {
        self.host.connection_identity().connection_receipt()
    }

    pub fn wait_spawned(&mut self, timeout: Duration) -> Result<(), CursorAcpTransportError> {
        if self.spawned {
            return Ok(());
        }
        let deadline = Instant::now() + timeout;
        while !self.spawned {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(CursorAcpTransportError::Timeout);
            }
            self.receive_host(remaining)?;
            if self.terminal {
                return Err(CursorAcpTransportError::ProcessExited);
            }
        }
        Ok(())
    }

    /// Queue one typed ACP request.  Only one request may have an outstanding
    /// response; provider notifications and inbound extension requests can be
    /// interleaved and are retained in the bounded observation queue.
    pub fn request(
        &mut self,
        command: CursorAcpCommand,
    ) -> Result<RequestId, CursorAcpTransportError> {
        self.reserve_request()?;
        self.request_reserved(command)
    }

    /// Allocate a native JSON-RPC correlation ID without writing to the child.
    /// D1 can durably fence that exact prompt before consuming this reservation.
    pub fn reserve_request(&mut self) -> Result<RequestId, CursorAcpTransportError> {
        self.ensure_writable()?;
        if self.pending.is_some() || self.reserved.is_some() {
            return Err(CursorAcpTransportError::Busy);
        }
        let id = self.session.new_request();
        self.reserved = Some(id.clone());
        Ok(id)
    }

    /// Consume the sole local reservation once. A failed/ambiguous write must
    /// never recreate it or resend the prompt.
    pub fn request_reserved(
        &mut self,
        command: CursorAcpCommand,
    ) -> Result<RequestId, CursorAcpTransportError> {
        self.ensure_writable()?;
        if self.pending.is_some() {
            return Err(CursorAcpTransportError::Busy);
        }
        let id = self
            .reserved
            .take()
            .ok_or(CursorAcpTransportError::InvalidMessage)?;
        let request = command
            .request(id.clone())
            .map_err(|_| CursorAcpTransportError::InvalidMessage)?;
        let bytes =
            serde_json::to_vec(&request).map_err(|_| CursorAcpTransportError::InvalidMessage)?;
        self.pending = Some(id.clone());
        if let Err(error) = self.write_frame(&bytes) {
            self.pending = None;
            return Err(error);
        }
        Ok(id)
    }

    /// Send ACP's session-cancel notification without consuming or replacing
    /// the outstanding `session/prompt` response ID. The return value is false
    /// only when that exact prompt response was already received and queued;
    /// callers must still read and validate the original response.
    pub fn cancel_prompt(
        &mut self,
        session_id: SessionId,
        prompt_request_id: &RequestId,
    ) -> Result<bool, CursorAcpTransportError> {
        self.ensure_spawned()?;
        if self.pending.as_ref() != Some(prompt_request_id) {
            if self.messages.iter().any(|message| {
                matches!(message, CursorAcpMessage::Response(response)
                    if &response.id == prompt_request_id)
            }) {
                return Ok(false);
            }
            return Err(CursorAcpTransportError::MismatchedResponse);
        }
        let notification = CursorAcpCommand::SessionCancel {
            params: super::SessionCancelParams { session_id },
        }
        .notification()
        .map_err(|_| CursorAcpTransportError::InvalidMessage)?;
        let bytes = serde_json::to_vec(&notification)
            .map_err(|_| CursorAcpTransportError::InvalidMessage)?;
        self.write_frame(&bytes)?;
        Ok(true)
    }

    /// Respond to a provider extension request (permission/question/plan).
    /// A caller must choose an explicit typed response; this method never
    /// synthesizes an approval for an unknown request.
    pub fn respond(&mut self, response: JsonRpcResponse) -> Result<(), CursorAcpTransportError> {
        self.ensure_spawned()?;
        let bytes =
            serde_json::to_vec(&response).map_err(|_| CursorAcpTransportError::InvalidMessage)?;
        self.write_frame(&bytes)
    }

    pub fn receive(
        &mut self,
        timeout: Duration,
    ) -> Result<CursorAcpMessage, CursorAcpTransportError> {
        if let Some(message) = self.messages.pop_front() {
            return Ok(message);
        }
        if self.host_failure || self.terminal {
            return Err(CursorAcpTransportError::Closed);
        }
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(CursorAcpTransportError::Timeout);
            }
            self.receive_host(remaining)?;
            if let Some(message) = self.messages.pop_front() {
                return Ok(message);
            }
        }
    }

    /// Wait for a specific response while preserving notifications and
    /// extension requests for the caller. The matching response is returned;
    /// unrelated responses fail closed.
    pub fn wait_response(
        &mut self,
        request_id: &RequestId,
        timeout: Duration,
    ) -> Result<JsonRpcResponse, CursorAcpTransportError> {
        let mut deferred = VecDeque::new();
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.requeue_front(deferred);
                return Err(CursorAcpTransportError::Timeout);
            }
            let message = match self.receive(remaining) {
                Ok(message) => message,
                Err(error) => {
                    self.requeue_front(deferred);
                    return Err(error);
                }
            };
            match message {
                CursorAcpMessage::Response(response) if &response.id == request_id => {
                    self.requeue_front(deferred);
                    if response.error.is_some() {
                        return Err(CursorAcpTransportError::Rejected);
                    }
                    return Ok(response);
                }
                other => {
                    deferred.push_back(other);
                }
            }
        }
    }

    fn requeue_front(&mut self, mut deferred: VecDeque<CursorAcpMessage>) {
        while let Some(message) = deferred.pop_back() {
            self.messages.push_front(message);
        }
    }

    pub fn take_cleanup_proof(&mut self) -> Option<HostCleanupProof> {
        self.cleanup_proof
            .take()
            .or_else(|| self.host.take_cleanup_proof())
    }

    /// Request shutdown and wait for the exact host terminal lifecycle event.
    /// EOF, Drop or host loss never produce cleanup proof.
    pub fn stop(&mut self, timeout: Duration) -> Result<(), CursorAcpTransportError> {
        self.stop_with_grace(Duration::from_millis(500), timeout)
    }

    /// Request shutdown with a configured process-host grace period, then
    /// wait independently for its matching terminal lifecycle proof.
    pub fn stop_with_grace(
        &mut self,
        grace: Duration,
        timeout: Duration,
    ) -> Result<(), CursorAcpTransportError> {
        self.stop_with_grace_hook(grace, timeout, || {})
    }

    /// Request shutdown and invoke the bounded authority hook while waiting
    /// for the exact host terminal event. Hook failures are handled by the
    /// caller and do not suppress host cleanup proof collection.
    pub fn stop_with_grace_hook(
        &mut self,
        grace: Duration,
        timeout: Duration,
        mut cleanup_tick: impl FnMut(),
    ) -> Result<(), CursorAcpTransportError> {
        if grace.is_zero() || grace > Duration::from_secs(60) || timeout.is_zero() {
            return Err(CursorAcpTransportError::InvalidLaunch);
        }
        if self.terminal {
            cleanup_tick();
            if self.cleanup_proof.is_none() {
                self.cleanup_proof = self.host.take_cleanup_proof();
            }
            return self
                .cleanup_proof
                .as_ref()
                .map(|_| ())
                .ok_or(CursorAcpTransportError::Closed);
        }
        self.host
            .send(Command::Stop {
                protocol_version: Some(ProtocolVersion::default()),
                request_id: Some(self.request_id.clone()),
                grace_ms: Some(grace.as_millis() as u64),
            })
            .map_err(map_host_error)?;
        let deadline = Instant::now() + timeout;
        cleanup_tick();
        while !self.terminal {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(CursorAcpTransportError::Timeout);
            }
            self.receive_host(remaining.min(Duration::from_millis(200)))?;
            cleanup_tick();
        }
        if self.cleanup_proof.is_none() {
            self.cleanup_proof = self.host.take_cleanup_proof();
        }
        self.cleanup_proof
            .as_ref()
            .map(|_| ())
            .ok_or(CursorAcpTransportError::Closed)
    }

    pub fn close(&mut self) {
        self.host.close();
        self.host_failure = true;
    }

    fn ensure_spawned(&self) -> Result<(), CursorAcpTransportError> {
        if !self.spawned || self.terminal || self.host_failure {
            Err(CursorAcpTransportError::Closed)
        } else {
            Ok(())
        }
    }

    fn ensure_writable(&self) -> Result<(), CursorAcpTransportError> {
        self.ensure_spawned()?;
        if self.pending.is_some() {
            Err(CursorAcpTransportError::Busy)
        } else {
            Ok(())
        }
    }

    fn receive_host(&mut self, timeout: Duration) -> Result<(), CursorAcpTransportError> {
        match self.host.receive(timeout) {
            Ok(HostEvent::Lifecycle(value)) => self.observe_lifecycle(&value),
            Ok(HostEvent::Stdout(bytes)) => self.decode_stdout(&bytes),
            Ok(HostEvent::Failure) => {
                self.host_failure = true;
                Err(CursorAcpTransportError::Closed)
            }
            Err(HostError::Timeout) => Err(CursorAcpTransportError::Timeout),
            Err(HostError::OutputOverflow) => Err(CursorAcpTransportError::OutputOverflow),
            Err(HostError::Closed | HostError::InvalidLaunch) => {
                self.host_failure = true;
                Err(CursorAcpTransportError::Closed)
            }
        }
    }

    fn decode_stdout(&mut self, bytes: &[u8]) -> Result<(), CursorAcpTransportError> {
        let parsed = self
            .decoder
            .push(bytes, |frame| {
                if frame.len() > MAX_EVENT_JSON_BYTES {
                    return Err(CursorAcpTransportError::InvalidMessage);
                }
                parse_message(frame).map_err(|_| CursorAcpTransportError::InvalidMessage)
            })
            .map_err(|_| CursorAcpTransportError::InvalidMessage)?;
        if self.messages.len().saturating_add(parsed.len()) > MAX_EVENT_QUEUE {
            return Err(CursorAcpTransportError::OutputOverflow);
        }
        for message in parsed {
            if let CursorAcpMessage::Response(response) = &message {
                let Some(pending) = self.pending.as_ref() else {
                    return Err(CursorAcpTransportError::MismatchedResponse);
                };
                if &response.id != pending {
                    return Err(CursorAcpTransportError::MismatchedResponse);
                }
                self.pending = None;
            }
            self.messages.push_back(message);
        }
        Ok(())
    }

    fn observe_lifecycle(&mut self, value: &Value) -> Result<(), CursorAcpTransportError> {
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "handshake" {
            return Ok(());
        }
        if value.get("requestId").and_then(Value::as_str) != Some(&self.request_id)
            || value.get("ownerToken").and_then(Value::as_str) != Some(&self.owner_token)
        {
            return Err(CursorAcpTransportError::InvalidMessage);
        }
        match kind {
            "accepted" if !self.spawned && !self.terminal => {}
            "spawned" if !self.spawned && !self.terminal => self.spawned = true,
            "stop-accepted" | "stopped" | "app-exit" if self.spawned && !self.terminal => {}
            "terminal" if self.spawned && !self.terminal => {
                self.terminal = true;
                self.cleanup_proof = self.host.take_cleanup_proof();
            }
            "stdin-write-complete" | "stdin-write-rejected" | "stdin-write-failed" => {}
            _ => return Err(CursorAcpTransportError::InvalidMessage),
        }
        Ok(())
    }

    fn write_frame(&mut self, bytes: &[u8]) -> Result<(), CursorAcpTransportError> {
        if bytes.len() > MAX_EVENT_JSON_BYTES {
            return Err(CursorAcpTransportError::InvalidMessage);
        }
        let mut frame = bytes.to_vec();
        frame.push(b'\n');
        self.next_write_id = self
            .next_write_id
            .checked_add(1)
            .ok_or(CursorAcpTransportError::InvalidMessage)?;
        let write_id = format!("cursor-write-{}", self.next_write_id);
        self.host
            .send(Command::WriteStdin {
                protocol_version: Some(ProtocolVersion::default()),
                request_id: Some(self.request_id.clone()),
                owner_token: Some(self.owner_token.clone()),
                write_id: Some(write_id.clone()),
                data: String::from_utf8(frame.clone())
                    .map_err(|_| CursorAcpTransportError::InvalidMessage)?,
            })
            .map_err(map_host_error)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(CursorAcpTransportError::WriteIndeterminate);
            }
            match self.host.receive(remaining) {
                Ok(HostEvent::Lifecycle(value)) => {
                    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
                    if value.get("requestId").and_then(Value::as_str) != Some(&self.request_id)
                        || value.get("ownerToken").and_then(Value::as_str)
                            != Some(&self.owner_token)
                    {
                        return Err(CursorAcpTransportError::InvalidMessage);
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
                        return Err(CursorAcpTransportError::Rejected);
                    }
                    if kind == "stdin-write-failed"
                        && value.get("writeId").and_then(Value::as_str) == Some(&write_id)
                    {
                        return Err(CursorAcpTransportError::WriteIndeterminate);
                    }
                    self.observe_lifecycle(&value)?;
                }
                Ok(HostEvent::Stdout(bytes)) => self.decode_stdout(&bytes)?,
                Ok(HostEvent::Failure) => return Err(CursorAcpTransportError::Closed),
                Err(HostError::Timeout) => return Err(CursorAcpTransportError::WriteIndeterminate),
                Err(HostError::OutputOverflow) => {
                    return Err(CursorAcpTransportError::OutputOverflow);
                }
                Err(HostError::Closed | HostError::InvalidLaunch) => {
                    return Err(CursorAcpTransportError::Closed);
                }
            }
        }
    }
}

fn validate_launch(
    mut launch: CursorAcpProcessLaunch,
) -> Result<CursorAcpProcessLaunch, CursorAcpTransportError> {
    for path in [
        &mut launch.executable,
        &mut launch.process_host,
        &mut launch.runtime_root,
        &mut launch.cwd,
    ] {
        if !path.is_absolute() {
            return Err(CursorAcpTransportError::InvalidLaunch);
        }
    }
    if !launch.home.path().is_absolute() {
        return Err(CursorAcpTransportError::InvalidLaunch);
    }
    if !launch.executable.is_file()
        || !launch.process_host.is_file()
        || !launch.runtime_root.is_dir()
        || !launch.home.path().is_dir()
        || !launch.cwd.is_dir()
        || launch.run_id.is_empty()
        || launch.attempt_id.is_empty()
        || launch.owner_token.is_empty()
        || launch.env.keys().any(|name| {
            name.is_empty()
                || name.contains('=')
                || name.chars().any(char::is_control)
                || matches!(name.as_str(), "HOME" | "USERPROFILE")
        })
    {
        return Err(CursorAcpTransportError::InvalidLaunch);
    }
    validate_home(&launch.home)?;
    Ok(launch)
}

fn validate_home(home: &CursorAcpHome) -> Result<(), CursorAcpTransportError> {
    let path = home.path();
    let home_metadata =
        std::fs::symlink_metadata(path).map_err(|_| CursorAcpTransportError::InvalidLaunch)?;
    if !home_metadata.is_dir() || home_metadata.file_type().is_symlink() {
        return Err(CursorAcpTransportError::InvalidLaunch);
    }
    let canonical_home = path
        .canonicalize()
        .map_err(|_| CursorAcpTransportError::InvalidLaunch)?;
    if canonical_home != path {
        return Err(CursorAcpTransportError::InvalidLaunch);
    }

    if !home.uses_provider_profile() {
        return Ok(());
    }

    let config_dir = path.join(".cursor");
    let config_metadata = std::fs::symlink_metadata(&config_dir)
        .map_err(|_| CursorAcpTransportError::InvalidLaunch)?;
    if !config_metadata.is_dir() || config_metadata.file_type().is_symlink() {
        return Err(CursorAcpTransportError::InvalidLaunch);
    }
    let canonical_config_dir = config_dir
        .canonicalize()
        .map_err(|_| CursorAcpTransportError::InvalidLaunch)?;
    if canonical_config_dir != config_dir {
        return Err(CursorAcpTransportError::InvalidLaunch);
    }
    Ok(())
}

fn cursor_process_environment(
    mut env: std::collections::BTreeMap<String, String>,
    profile_home: &Path,
) -> Result<std::collections::BTreeMap<String, String>, CursorAcpTransportError> {
    let home = profile_home
        .to_str()
        .ok_or(CursorAcpTransportError::InvalidLaunch)?
        .to_owned();
    env.insert("HOME".into(), home.clone());
    env.insert("USERPROFILE".into(), home);
    Ok(env)
}

fn cursor_acp_argv(model: Option<&str>) -> Result<Vec<String>, CursorAcpTransportError> {
    let Some(model) = model else {
        return Ok(vec!["acp".into()]);
    };
    if model.is_empty()
        || model.trim() != model
        || model.len() > 512
        || model.chars().any(char::is_control)
        || !model
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(CursorAcpTransportError::InvalidLaunch);
    }
    Ok(vec!["--model".into(), model.into(), "acp".into()])
}

fn map_host_error(error: HostError) -> CursorAcpTransportError {
    match error {
        HostError::InvalidLaunch => CursorAcpTransportError::InvalidLaunch,
        HostError::Closed => CursorAcpTransportError::Closed,
        HostError::Timeout => CursorAcpTransportError::Timeout,
        HostError::OutputOverflow => CursorAcpTransportError::OutputOverflow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tempfile::tempdir;

    #[test]
    fn rejects_ambient_protected_environment_overrides() {
        let root = tempdir().unwrap();
        let profile_home = root.path().join("operator-home");
        std::fs::create_dir_all(profile_home.join(".cursor")).unwrap();
        let runtime_root = root.path().join("runtime");
        let cwd = root.path().join("cwd");
        std::fs::create_dir_all(&runtime_root).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let executable = root.path().join("cursor-agent");
        let process_host = root.path().join("process-host");
        std::fs::write(&executable, b"fixture").unwrap();
        std::fs::write(&process_host, b"fixture").unwrap();
        let mut env = BTreeMap::new();
        env.insert("HOME".into(), "/operator".into());
        let launch = CursorAcpProcessLaunch {
            executable,
            process_host,
            runtime_root,
            model: None,
            home: CursorAcpHome::OperatorProfile(profile_home),
            cwd,
            instruction_rule: None,
            run_id: "run".into(),
            attempt_id: "attempt".into(),
            owner_token: "owner".into(),
            env,
        };
        assert!(matches!(
            validate_launch(launch),
            Err(CursorAcpTransportError::InvalidLaunch)
        ));
    }

    #[test]
    fn rejects_non_absolute_or_missing_paths() {
        let launch = CursorAcpProcessLaunch {
            executable: "cursor-agent".into(),
            process_host: "/tmp/process-host".into(),
            runtime_root: "/tmp/runtime".into(),
            model: None,
            home: CursorAcpHome::OperatorProfile("/tmp/home".into()),
            cwd: "/tmp".into(),
            instruction_rule: None,
            run_id: "run".into(),
            attempt_id: "attempt".into(),
            owner_token: "owner".into(),
            env: BTreeMap::new(),
        };
        assert!(matches!(
            validate_launch(launch),
            Err(CursorAcpTransportError::InvalidLaunch)
        ));
    }

    #[test]
    fn selected_profile_is_the_child_home_and_userprofile() {
        let root = tempdir().unwrap();
        let profile_home = root.path().join("selected-profile");
        std::fs::create_dir_all(profile_home.join(".cursor")).unwrap();
        let runtime_root = root.path().join("runtime");
        let cwd = root.path().join("cwd");
        std::fs::create_dir_all(&runtime_root).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let executable = root.path().join("cursor-agent");
        let process_host = root.path().join("process-host");
        std::fs::write(&executable, b"fixture").unwrap();
        std::fs::write(&process_host, b"fixture").unwrap();
        let launch = CursorAcpProcessLaunch {
            executable,
            process_host,
            runtime_root,
            model: None,
            home: CursorAcpHome::OperatorProfile(profile_home.canonicalize().unwrap()),
            cwd,
            instruction_rule: None,
            run_id: "run".into(),
            attempt_id: "attempt".into(),
            owner_token: "owner".into(),
            env: BTreeMap::from([("RUDDER_OPERATOR_HOME".into(), "/operator".into())]),
        };
        let launch = validate_launch(launch).unwrap();
        let env = cursor_process_environment(launch.env, launch.home.path()).unwrap();
        let expected_home = profile_home
            .canonicalize()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert_eq!(env["HOME"], expected_home);
        assert_eq!(env["USERPROFILE"], expected_home);
        assert_eq!(env["RUDDER_OPERATOR_HOME"], "/operator");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_cursor_config_directory_before_launch() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let profile_home = root.path().join("selected-profile");
        let redirected = root.path().join("redirected-cursor");
        std::fs::create_dir(&profile_home).unwrap();
        std::fs::create_dir(&redirected).unwrap();
        symlink(&redirected, profile_home.join(".cursor")).unwrap();
        let runtime_root = root.path().join("runtime");
        let cwd = root.path().join("cwd");
        std::fs::create_dir_all(&runtime_root).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let executable = root.path().join("cursor-agent");
        let process_host = root.path().join("process-host");
        std::fs::write(&executable, b"fixture").unwrap();
        std::fs::write(&process_host, b"fixture").unwrap();
        let launch = CursorAcpProcessLaunch {
            executable,
            process_host,
            runtime_root,
            model: None,
            home: CursorAcpHome::OperatorProfile(profile_home.canonicalize().unwrap()),
            cwd,
            instruction_rule: None,
            run_id: "run".into(),
            attempt_id: "attempt".into(),
            owner_token: "owner".into(),
            env: BTreeMap::new(),
        };
        assert!(matches!(
            validate_launch(launch),
            Err(CursorAcpTransportError::InvalidLaunch)
        ));
    }

    #[test]
    fn managed_runtime_keeps_existing_isolated_home_without_cursor_config() {
        let root = tempdir().unwrap();
        let isolated_home = root.path().join("isolated-home");
        let runtime_root = root.path().join("runtime");
        let cwd = root.path().join("cwd");
        std::fs::create_dir_all(&isolated_home).unwrap();
        std::fs::create_dir_all(&runtime_root).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let executable = root.path().join("cursor-agent");
        let process_host = root.path().join("process-host");
        std::fs::write(&executable, b"fixture").unwrap();
        std::fs::write(&process_host, b"fixture").unwrap();
        let launch = CursorAcpProcessLaunch {
            executable,
            process_host,
            runtime_root,
            model: None,
            home: CursorAcpHome::IsolatedRuntime(isolated_home.canonicalize().unwrap()),
            cwd,
            instruction_rule: None,
            run_id: "run".into(),
            attempt_id: "attempt".into(),
            owner_token: "owner".into(),
            env: BTreeMap::new(),
        };
        let launch = validate_launch(launch).unwrap();
        let env = cursor_process_environment(launch.env, launch.home.path()).unwrap();
        assert_eq!(
            env["HOME"],
            isolated_home.canonicalize().unwrap().to_str().unwrap()
        );
        assert!(!isolated_home.join(".cursor").exists());
    }

    #[cfg(unix)]
    #[test]
    fn materializes_managed_rule_before_starting_the_owned_host() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempdir().unwrap();
        let profile_home = root.path().join("operator-home");
        let runtime_root = root.path().join("runtime");
        let cwd = root.path().join("managed-agent");
        std::fs::create_dir_all(profile_home.join(".cursor")).unwrap();
        std::fs::create_dir_all(&runtime_root).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let executable = root.path().join("cursor-agent");
        let process_host = root.path().join("process-host");
        std::fs::write(&executable, b"fixture").unwrap();
        std::fs::write(&process_host, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&process_host, std::fs::Permissions::from_mode(0o755)).unwrap();
        let agent_id = uuid::Uuid::new_v4().to_string();
        let run_id = "run".to_owned();
        let attempt_id = "attempt".to_owned();
        let owner_token = "owner".to_owned();
        let rule_path = cwd
            .join(".cursor/rules")
            .join(format!("rudder-agent-{agent_id}.mdc"));

        let transport = CursorAcpTransport::launch(
            CursorAcpProcessLaunch {
                executable,
                process_host,
                runtime_root,
                model: Some("auto".into()),
                home: CursorAcpHome::OperatorProfile(profile_home.canonicalize().unwrap()),
                cwd: cwd.canonicalize().unwrap(),
                instruction_rule: Some(CursorManagedInstructionRule {
                    agent_id,
                    revision: format!("sha256:{}", "c".repeat(64)),
                    content: Some("Always include this managed instruction.".into()),
                }),
                run_id: run_id.clone(),
                attempt_id: attempt_id.clone(),
                owner_token: owner_token.clone(),
                env: BTreeMap::new(),
            },
            ConnectionLaunchPermit::from_claim(run_id, attempt_id, owner_token, 1, "claim".into()),
        );

        assert!(
            rule_path.is_file(),
            "rule must be durable before host start"
        );
        assert!(
            std::fs::read_to_string(&rule_path)
                .unwrap()
                .contains("Always include this managed instruction.")
        );
        drop(transport);
    }

    #[test]
    fn response_error_is_not_projected_as_success() {
        let response = JsonRpcResponse::error(RequestId::generated(1), -1, "rejected");
        assert!(response.error.is_some());
    }

    #[test]
    fn model_selection_uses_installed_cli_global_flag_before_acp() {
        assert_eq!(
            cursor_acp_argv(Some("gpt-5.3-codex[effort=high]")).unwrap(),
            ["--model", "gpt-5.3-codex[effort=high]", "acp"]
        );
        assert_eq!(cursor_acp_argv(None).unwrap(), ["acp"]);
        assert!(cursor_acp_argv(Some("model\n--force")).is_err());
        assert!(cursor_acp_argv(Some("--yolo")).is_err());
    }
}
