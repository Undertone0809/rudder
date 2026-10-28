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
const HOST_RECEIVE_QUANTUM: Duration = Duration::from_millis(200);
const MAX_FINAL_HOST_DRAIN_EVENTS: usize = 128;

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
    /// Raw tail of one bounded host stdout chunk, retained if the shared
    /// deferred+queued+in-flight event budget is exhausted mid-batch.
    pending_stdout: VecDeque<u8>,
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
            pending_stdout: VecDeque::new(),
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
        let mut observe_nothing = |_: &CursorAcpMessage| Ok(false);
        self.request_reserved_with_observer(command, &mut observe_nothing)
    }

    /// Consume the reserved request while reducing notifications that may be
    /// emitted before the process host acknowledges the prompt write.
    pub fn request_reserved_with_observer(
        &mut self,
        command: CursorAcpCommand,
        observe: &mut impl FnMut(&CursorAcpMessage) -> Result<bool, CursorAcpTransportError>,
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
        if let Err(error) = self.write_frame_with_observer(&bytes, observe) {
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
        let mut observe_nothing = |_: &CursorAcpMessage| Ok(false);
        self.cancel_prompt_with_observer(session_id, prompt_request_id, &mut observe_nothing)
    }

    /// Send ACP's session-cancel notification while reducing prompt messages
    /// that arrive both before and during the stdin-write acknowledgement.
    /// The caller owns the bounded per-prompt reducer; responses remain queued
    /// for the original request-id waiter.
    pub fn cancel_prompt_with_observer(
        &mut self,
        session_id: SessionId,
        prompt_request_id: &RequestId,
        observe: &mut impl FnMut(&CursorAcpMessage) -> Result<bool, CursorAcpTransportError>,
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
        self.write_frame_with_observer(&bytes, observe)?;
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
        let mut observe_nothing = |_: &CursorAcpMessage| Ok(false);
        self.receive_with_observer(timeout, &mut observe_nothing, 0)
    }

    /// Wait for a specific response while preserving notifications and
    /// extension requests for the caller. The matching response is returned;
    /// unrelated responses fail closed.
    pub fn wait_response(
        &mut self,
        request_id: &RequestId,
        timeout: Duration,
    ) -> Result<JsonRpcResponse, CursorAcpTransportError> {
        let mut observe_nothing = |_: &CursorAcpMessage| Ok(false);
        self.wait_response_with(request_id, timeout, &mut observe_nothing)
    }

    /// Wait for the exact response while letting the active prompt reducer
    /// consume interleaved notifications immediately. Unhandled messages are
    /// still preserved under the ordinary bounded queue and response
    /// correlation rules.
    pub fn wait_response_with(
        &mut self,
        request_id: &RequestId,
        timeout: Duration,
        observe: &mut impl FnMut(&CursorAcpMessage) -> Result<bool, CursorAcpTransportError>,
    ) -> Result<JsonRpcResponse, CursorAcpTransportError> {
        let mut deferred = VecDeque::new();
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.requeue_front(deferred);
                return Err(CursorAcpTransportError::Timeout);
            }
            let message = match self.receive_with_observer(remaining, observe, deferred.len()) {
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
        self.stop_with_grace_hook(grace, timeout, |_| {})
    }

    /// Request shutdown and invoke the bounded authority hook while waiting
    /// for the exact host terminal event. Hook failures are handled by the
    /// caller and do not suppress host cleanup proof collection.
    pub fn stop_with_grace_hook(
        &mut self,
        grace: Duration,
        timeout: Duration,
        mut cleanup_tick: impl FnMut(Duration),
    ) -> Result<(), CursorAcpTransportError> {
        self.stop_with_grace_hook_using(
            grace,
            timeout,
            &mut cleanup_tick,
            |transport, command| transport.host.send(command),
            |transport, wait| transport.receive_cleanup_host(wait),
        )
    }

    fn stop_with_grace_hook_using(
        &mut self,
        grace: Duration,
        timeout: Duration,
        cleanup_tick: &mut impl FnMut(Duration),
        mut send_command: impl FnMut(&mut Self, Command) -> Result<(), HostError>,
        mut receive_cleanup: impl FnMut(&mut Self, Duration) -> Result<(), CursorAcpTransportError>,
    ) -> Result<(), CursorAcpTransportError> {
        if grace.is_zero() || grace > Duration::from_secs(60) || timeout.is_zero() {
            return Err(CursorAcpTransportError::InvalidLaunch);
        }
        if self.terminal {
            if self.cleanup_proof.is_none() {
                self.cleanup_proof = self.host.take_cleanup_proof();
            }
            return self
                .cleanup_proof
                .as_ref()
                .map(|_| ())
                .ok_or(CursorAcpTransportError::Closed);
        }
        let stop = Command::Stop {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(self.request_id.clone()),
            grace_ms: Some(grace.as_millis() as u64),
        };
        match send_command(self, stop) {
            Ok(()) => {}
            Err(HostError::Closed) => {
                return self.drain_after_closed_stop_send(&mut receive_cleanup);
            }
            Err(error) => return Err(map_host_error(error)),
        }
        let deadline = Instant::now() + timeout;
        cleanup_tick(deadline.saturating_duration_since(Instant::now()));
        while !self.terminal {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match receive_cleanup(self, remaining.min(HOST_RECEIVE_QUANTUM)) {
                Ok(()) => {}
                Err(CursorAcpTransportError::Timeout) => {}
                Err(error) => return Err(error),
            }
            if !self.terminal {
                cleanup_tick(deadline.saturating_duration_since(Instant::now()));
            }
        }
        // A bounded authority hook can still overrun its intended deadline.
        // Drain already-queued host events once without blocking so a terminal
        // emitted during that hook can mint and retain its exact cleanup proof.
        for _ in 0..MAX_FINAL_HOST_DRAIN_EVENTS {
            if self.terminal {
                break;
            }
            match receive_cleanup(self, Duration::ZERO) {
                Ok(()) => {}
                Err(CursorAcpTransportError::Timeout) => break,
                Err(error) => return Err(error),
            }
        }
        if !self.terminal {
            return Err(CursorAcpTransportError::Timeout);
        }
        if self.cleanup_proof.is_none() {
            self.cleanup_proof = self.host.take_cleanup_proof();
        }
        self.cleanup_proof
            .as_ref()
            .map(|_| ())
            .ok_or(CursorAcpTransportError::Closed)
    }

    /// A disconnected/full command channel can race with a terminal lifecycle
    /// event already queued by the owned host. Inspect only that already-ready
    /// bounded queue; never infer cleanup from EOF or wait for a new event.
    fn drain_after_closed_stop_send(
        &mut self,
        receive_cleanup: &mut impl FnMut(&mut Self, Duration) -> Result<(), CursorAcpTransportError>,
    ) -> Result<(), CursorAcpTransportError> {
        for _ in 0..MAX_FINAL_HOST_DRAIN_EVENTS {
            if self.terminal {
                break;
            }
            match receive_cleanup(self, Duration::ZERO) {
                Ok(()) => {}
                Err(CursorAcpTransportError::Timeout | CursorAcpTransportError::Closed) => break,
                Err(error) => return Err(error),
            }
        }
        if !self.terminal {
            return Err(CursorAcpTransportError::Closed);
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
        let mut observe_nothing = |_: &CursorAcpMessage| Ok(false);
        self.drain_pending_stdout_with_observer(&mut observe_nothing, 0)?;
        match self.host.receive(timeout) {
            Ok(HostEvent::Lifecycle(value)) => self.observe_lifecycle(&value),
            Ok(HostEvent::Stdout(bytes)) => self.decode_stdout(&bytes),
            Ok(HostEvent::Stderr(_)) => Ok(()),
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

    /// Cleanup waits on the owned process host's lifecycle channel only.
    /// Provider stdout is intentionally discarded here: queue saturation or
    /// a retained ACP tail must not prevent observing the host terminal proof,
    /// and cleanup must not project or answer more provider messages.
    fn receive_cleanup_host(&mut self, timeout: Duration) -> Result<(), CursorAcpTransportError> {
        match self.host.receive(timeout) {
            Ok(HostEvent::Lifecycle(value)) => self.observe_lifecycle(&value),
            Ok(HostEvent::Stdout(_)) | Ok(HostEvent::Stderr(_)) => Ok(()),
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

    fn receive_with_observer(
        &mut self,
        timeout: Duration,
        observe: &mut impl FnMut(&CursorAcpMessage) -> Result<bool, CursorAcpTransportError>,
        retained_outside: usize,
    ) -> Result<CursorAcpMessage, CursorAcpTransportError> {
        let deadline = Instant::now() + timeout;
        loop {
            if retained_outside.saturating_add(self.messages.len()) > MAX_EVENT_QUEUE {
                return Err(CursorAcpTransportError::OutputOverflow);
            }
            while let Some(message) = self.messages.pop_front() {
                if self.observe_nonresponse(&message, observe)? {
                    continue;
                }
                return Ok(message);
            }
            if !self.pending_stdout.is_empty() {
                self.drain_pending_stdout_with_observer(observe, retained_outside)?;
                continue;
            }
            if self.host_failure || self.terminal {
                return Err(CursorAcpTransportError::Closed);
            }
            if retained_outside >= MAX_EVENT_QUEUE {
                return Err(CursorAcpTransportError::OutputOverflow);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(CursorAcpTransportError::Timeout);
            }
            self.receive_host_with_observer(remaining, observe, retained_outside)?;
        }
    }

    fn receive_host_with_observer(
        &mut self,
        timeout: Duration,
        observe: &mut impl FnMut(&CursorAcpMessage) -> Result<bool, CursorAcpTransportError>,
        retained_outside: usize,
    ) -> Result<(), CursorAcpTransportError> {
        match self.host.receive(timeout) {
            Ok(HostEvent::Lifecycle(value)) => self.observe_lifecycle(&value),
            Ok(HostEvent::Stdout(bytes)) => {
                self.decode_stdout_with_observer(&bytes, observe, retained_outside)
            }
            Ok(HostEvent::Stderr(_)) => Ok(()),
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

    fn observe_nonresponse(
        &mut self,
        message: &CursorAcpMessage,
        observe: &mut impl FnMut(&CursorAcpMessage) -> Result<bool, CursorAcpTransportError>,
    ) -> Result<bool, CursorAcpTransportError> {
        if matches!(message, CursorAcpMessage::Response(_)) {
            return Ok(false);
        }
        observe(message)
    }

    fn decode_stdout(&mut self, bytes: &[u8]) -> Result<(), CursorAcpTransportError> {
        let mut observe_nothing = |_: &CursorAcpMessage| Ok(false);
        self.decode_stdout_with_observer(bytes, &mut observe_nothing, 0)
    }

    fn decode_stdout_with_observer(
        &mut self,
        bytes: &[u8],
        observe: &mut impl FnMut(&CursorAcpMessage) -> Result<bool, CursorAcpTransportError>,
        retained_outside: usize,
    ) -> Result<(), CursorAcpTransportError> {
        if !self.pending_stdout.is_empty() {
            return Err(CursorAcpTransportError::OutputOverflow);
        }
        if bytes.len() > rudder_native_protocol::lines::MAX_NATIVE_CHUNK_BYTES {
            return Err(CursorAcpTransportError::InvalidMessage);
        }
        self.pending_stdout.extend(bytes);
        self.drain_pending_stdout_with_observer(observe, retained_outside)
    }

    fn drain_pending_stdout_with_observer(
        &mut self,
        observe: &mut impl FnMut(&CursorAcpMessage) -> Result<bool, CursorAcpTransportError>,
        retained_outside: usize,
    ) -> Result<(), CursorAcpTransportError> {
        loop {
            let Some(line_end) = self.pending_stdout.iter().position(|byte| *byte == b'\n') else {
                let partial = self.pending_stdout.drain(..).collect::<Vec<_>>();
                self.decoder
                    .push(&partial, |frame| {
                        if frame.len() > MAX_EVENT_JSON_BYTES {
                            return Err(CursorAcpTransportError::InvalidMessage);
                        }
                        parse_message(frame).map_err(|_| CursorAcpTransportError::InvalidMessage)
                    })
                    .map_err(|_| CursorAcpTransportError::InvalidMessage)?;
                return Ok(());
            };

            let is_empty_line = line_end == 0 || (line_end == 1 && self.pending_stdout[0] == b'\r');
            if !is_empty_line
                && retained_outside.saturating_add(self.messages.len()) >= MAX_EVENT_QUEUE
            {
                // Leave this complete, unparsed frame and the remaining bytes
                // in the bounded current host chunk so overflow never drops
                // the event that exhausted the shared budget.
                return Err(CursorAcpTransportError::OutputOverflow);
            }

            let line = self.pending_stdout.drain(..=line_end).collect::<Vec<_>>();
            let parsed = self
                .decoder
                .push(&line, |frame| {
                    if frame.len() > MAX_EVENT_JSON_BYTES {
                        return Err(CursorAcpTransportError::InvalidMessage);
                    }
                    parse_message(frame).map_err(|_| CursorAcpTransportError::InvalidMessage)
                })
                .map_err(|_| CursorAcpTransportError::InvalidMessage)?;
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
                if self.observe_nonresponse(&message, observe)? {
                    continue;
                }
                if retained_outside.saturating_add(self.messages.len()) >= MAX_EVENT_QUEUE {
                    return Err(CursorAcpTransportError::OutputOverflow);
                }
                self.messages.push_back(message);
            }
        }
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
        let mut observe_nothing = |_: &CursorAcpMessage| Ok(false);
        self.write_frame_with_observer(bytes, &mut observe_nothing)
    }

    fn write_frame_with_observer(
        &mut self,
        bytes: &[u8],
        observe: &mut impl FnMut(&CursorAcpMessage) -> Result<bool, CursorAcpTransportError>,
    ) -> Result<(), CursorAcpTransportError> {
        if bytes.len() > MAX_EVENT_JSON_BYTES {
            return Err(CursorAcpTransportError::InvalidMessage);
        }
        self.drain_pending_stdout_with_observer(observe, 0)?;
        self.consume_queued_with_observer(observe)?;
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
                Ok(event) => {
                    if self.observe_write_ack_event(event, &write_id, frame.len(), observe)? {
                        return Ok(());
                    }
                }
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

    /// Process one event while awaiting the host's stdin-write receipt. Kept
    /// separate so tests can deterministically put stdout ahead of the ACK.
    fn observe_write_ack_event(
        &mut self,
        event: HostEvent,
        write_id: &str,
        expected_bytes: usize,
        observe: &mut impl FnMut(&CursorAcpMessage) -> Result<bool, CursorAcpTransportError>,
    ) -> Result<bool, CursorAcpTransportError> {
        match event {
            HostEvent::Lifecycle(value) => {
                let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
                if value.get("requestId").and_then(Value::as_str) != Some(&self.request_id)
                    || value.get("ownerToken").and_then(Value::as_str) != Some(&self.owner_token)
                {
                    return Err(CursorAcpTransportError::InvalidMessage);
                }
                if kind == "stdin-write-complete"
                    && value.get("writeId").and_then(Value::as_str) == Some(write_id)
                    && value.get("bytesWritten").and_then(Value::as_u64)
                        == Some(expected_bytes as u64)
                {
                    return Ok(true);
                }
                if kind == "stdin-write-rejected"
                    && value.get("writeId").and_then(Value::as_str) == Some(write_id)
                {
                    return Err(CursorAcpTransportError::Rejected);
                }
                if kind == "stdin-write-failed"
                    && value.get("writeId").and_then(Value::as_str) == Some(write_id)
                {
                    return Err(CursorAcpTransportError::WriteIndeterminate);
                }
                self.observe_lifecycle(&value)?;
                Ok(false)
            }
            HostEvent::Stdout(bytes) => {
                self.consume_queued_with_observer(observe)?;
                self.decode_stdout_with_observer(&bytes, observe, 0)?;
                Ok(false)
            }
            HostEvent::Stderr(_) => Ok(false),
            HostEvent::Failure => Err(CursorAcpTransportError::Closed),
        }
    }

    fn consume_queued_with_observer(
        &mut self,
        observe: &mut impl FnMut(&CursorAcpMessage) -> Result<bool, CursorAcpTransportError>,
    ) -> Result<(), CursorAcpTransportError> {
        let mut retained = VecDeque::new();
        while let Some(message) = self.messages.pop_front() {
            if !self.observe_nonresponse(&message, observe)? {
                retained.push_back(message);
            }
        }
        self.messages = retained;
        Ok(())
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

    fn transport_for_queued_message_test() -> CursorAcpTransport {
        let connection = HostConnection {
            request_id: "attempt".into(),
            run_id: "run".into(),
            attempt_id: "attempt".into(),
            owner_token: "owner".into(),
        };
        let host = OwnedHost::launch_embedded(
            connection,
            Some(ConnectionLaunchPermit::from_claim(
                "run".into(),
                "attempt".into(),
                "owner".into(),
                1,
                "claim".into(),
            )),
            8 * 1024,
        )
        .expect("start an in-process host for the deterministic queue test");
        CursorAcpTransport {
            host,
            decoder: LineDecoder::default(),
            messages: VecDeque::new(),
            pending_stdout: VecDeque::new(),
            pending: None,
            reserved: None,
            next_write_id: 0,
            request_id: "attempt".into(),
            owner_token: "owner".into(),
            spawned: false,
            terminal: false,
            host_failure: false,
            cleanup_proof: None,
            session: CursorAcpSession::new(),
        }
    }

    #[cfg(unix)]
    fn completed_embedded_transport() -> (CursorAcpTransport, Value) {
        let mut transport = transport_for_queued_message_test();
        let cwd = std::env::current_dir().expect("test working directory");
        let runtime_root = tempdir().expect("isolated runtime root");
        let start = Command::StartProcess {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(transport.request_id.clone()),
            executable: "/bin/sh".into(),
            // Cross one receive quantum so this fixture also exercises polling
            // without mistaking an expected timeout for host termination.
            argv: vec!["-c".into(), "sleep 0.25; exit 0".into()],
            cwd: cwd.to_string_lossy().into_owned(),
            env: BTreeMap::new(),
            owner_token: Some(transport.owner_token.clone()),
            runtime_root: Some(runtime_root.path().to_string_lossy().into_owned()),
            stdin: None,
            interactive_stdin: true,
            grace_ms: Some(500),
        };
        start.validate().expect("valid synthetic child launch");
        transport.host.send(start).expect("start synthetic child");

        let deadline = Instant::now() + Duration::from_secs(5);
        let terminal = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "synthetic child reaches terminal");
            match transport.host.receive(remaining.min(HOST_RECEIVE_QUANTUM)) {
                Ok(HostEvent::Lifecycle(value)) if value["type"] == "terminal" => break value,
                Ok(HostEvent::Lifecycle(value)) => {
                    transport.observe_lifecycle(&value).unwrap_or_else(|error| {
                        panic!(
                            "unexpected startup lifecycle {} ({:?}): {error:?}",
                            value["type"], value["errorCode"]
                        )
                    })
                }
                Ok(HostEvent::Stdout(_)) | Ok(HostEvent::Stderr(_)) => {}
                Ok(HostEvent::Failure) => panic!("synthetic child host failed"),
                Err(HostError::Timeout) => continue,
                Err(error) => panic!("owned host remains readable through terminal: {error:?}"),
            }
        };
        (transport, terminal)
    }

    #[cfg(unix)]
    #[test]
    fn closed_stop_sender_drains_only_matching_terminal_cleanup_proof() {
        fn stop_with_injected_queue(
            transport: &mut CursorAcpTransport,
            send_result: Result<(), HostError>,
            events: &mut VecDeque<Value>,
        ) -> Result<(), CursorAcpTransportError> {
            transport.stop_with_grace_hook_using(
                Duration::from_millis(500),
                Duration::from_secs(1),
                &mut |_| {},
                |_, _| send_result,
                |transport, _| {
                    let Some(event) = events.pop_front() else {
                        return Err(CursorAcpTransportError::Timeout);
                    };
                    transport.observe_lifecycle(&event)
                },
            )
        }

        // Seed a real, unforgeable proof by letting the embedded owner launch,
        // reap, and report a short-lived child. The terminal is then queued at
        // the adapter boundary while its Stop command sender is closed.
        let (mut completed, terminal) = completed_embedded_transport();
        assert!(completed.spawned, "real host startup was observed");
        assert!(
            !completed.terminal,
            "test keeps the terminal queued at adapter"
        );
        assert!(completed.cleanup_proof.is_none());
        assert_eq!(terminal["type"], "terminal");
        let mut queued_terminal = VecDeque::from([terminal.clone()]);
        assert_eq!(
            stop_with_injected_queue(&mut completed, Err(HostError::Closed), &mut queued_terminal,),
            Ok(())
        );
        assert!(queued_terminal.is_empty());
        assert!(completed.take_cleanup_proof().is_some());

        // EOF/empty queue and a terminal-shaped JSON value without a host
        // minted proof are not cleanup evidence.
        let mut absent = transport_for_queued_message_test();
        absent.spawned = true;
        assert_eq!(
            stop_with_injected_queue(&mut absent, Err(HostError::Closed), &mut VecDeque::new(),),
            Err(CursorAcpTransportError::Closed)
        );

        let mut unproven = transport_for_queued_message_test();
        unproven.spawned = true;
        let mut unproven_terminal = terminal.clone();
        unproven_terminal["cleanupProven"] = serde_json::Value::Bool(false);
        let mut unproven_queue = VecDeque::from([unproven_terminal]);
        assert_eq!(
            stop_with_injected_queue(&mut unproven, Err(HostError::Closed), &mut unproven_queue,),
            Err(CursorAcpTransportError::Closed)
        );

        let mut wrong_owner = transport_for_queued_message_test();
        wrong_owner.spawned = true;
        let mut wrong_identity_terminal = terminal.clone();
        wrong_identity_terminal["ownerToken"] = serde_json::Value::String("other-owner".into());
        let mut wrong_identity_queue = VecDeque::from([wrong_identity_terminal]);
        assert_eq!(
            stop_with_injected_queue(
                &mut wrong_owner,
                Err(HostError::Closed),
                &mut wrong_identity_queue,
            ),
            Err(CursorAcpTransportError::InvalidMessage)
        );

        // Only a closed sender permits the ready-queue drain. Other send
        // failures retain their original classification and consume nothing.
        let mut failed_send = transport_for_queued_message_test();
        failed_send.spawned = true;
        let mut untouched_queue = VecDeque::from([terminal]);
        assert_eq!(
            stop_with_injected_queue(
                &mut failed_send,
                Err(HostError::Timeout),
                &mut untouched_queue,
            ),
            Err(CursorAcpTransportError::Timeout)
        );
        assert_eq!(untouched_queue.len(), 1);
    }

    fn private_extension_request_frame(id: &str) -> Vec<u8> {
        let mut frame = serde_json::json!({
            "jsonrpc":"2.0",
            "id":id,
            "method":"cursor/private_extension",
            "params":{"x":1}
        })
        .to_string()
        .into_bytes();
        frame.push(b'\n');
        frame
    }

    #[test]
    fn shared_event_budget_preserves_triggering_frame_across_queued_and_deferred_requests() {
        let mut transport = transport_for_queued_message_test();
        let already_queued = private_extension_request_frame("already-queued");
        transport.messages.push_back(
            parse_message(&already_queued[..already_queued.len() - 1])
                .expect("valid unhandled request already in the transport queue"),
        );

        let first = private_extension_request_frame("first-in-batch");
        let triggering = private_extension_request_frame("triggering-in-batch");
        let mut stdout = first;
        stdout.extend_from_slice(&triggering);
        let mut observe_nothing = |_: &CursorAcpMessage| Ok(false);

        assert_eq!(
            transport.decode_stdout_with_observer(
                &stdout,
                &mut observe_nothing,
                MAX_EVENT_QUEUE - 2,
            ),
            Err(CursorAcpTransportError::OutputOverflow)
        );
        assert_eq!(
            MAX_EVENT_QUEUE - 2 + transport.messages.len(),
            MAX_EVENT_QUEUE,
            "deferred and queued events share the same retained-message budget"
        );
        assert_eq!(transport.messages.len(), 2);
        assert_eq!(
            transport.pending_stdout.iter().copied().collect::<Vec<_>>(),
            triggering,
            "the triggering frame remains available after the overflow result"
        );
    }

    #[test]
    fn full_deferred_request_budget_fails_before_read_without_dropping_events() {
        let mut transport = transport_for_queued_message_test();
        for index in 0..MAX_EVENT_QUEUE {
            let frame = private_extension_request_frame(&format!("queued-{index}"));
            transport.messages.push_back(
                parse_message(&frame[..frame.len() - 1])
                    .expect("valid queued private-extension request"),
            );
        }
        let request_id = RequestId::new_string("pending-response").unwrap();
        let mut observe_nothing = |_: &CursorAcpMessage| Ok(false);

        assert_eq!(
            transport.wait_response_with(
                &request_id,
                Duration::from_millis(50),
                &mut observe_nothing,
            ),
            Err(CursorAcpTransportError::OutputOverflow)
        );
        assert_eq!(
            transport.messages.len(),
            MAX_EVENT_QUEUE,
            "all deferred requests are restored after the pre-read limit"
        );
        assert!(transport.pending_stdout.is_empty());
    }

    #[test]
    fn pending_prompt_updates_over_256_survive_stdout_before_cancel_write_ack() {
        let mut transport = transport_for_queued_message_test();
        let request_id = RequestId::new_string("prompt-1").unwrap();
        transport.pending = Some(request_id.clone());
        let mut stdout = Vec::new();
        for index in 0..(MAX_EVENT_QUEUE + 1) {
            let mut frame = serde_json::json!({
                "jsonrpc":"2.0",
                "method":"session/update",
                "params":{
                    "sessionId":"session-1",
                    "update":{
                        "sessionUpdate":"agent_message_chunk",
                        "content":{"type":"text","text":index.to_string()}
                    }
                }
            })
            .to_string()
            .into_bytes();
            frame.push(b'\n');
            stdout.extend_from_slice(&frame);
        }
        let mut response = serde_json::json!({
            "jsonrpc":"2.0",
            "id":"prompt-1",
            "result":{"stopReason":"cancelled"}
        })
        .to_string()
        .into_bytes();
        response.push(b'\n');
        stdout.extend_from_slice(&response);
        let observed_updates = std::cell::Cell::new(0usize);
        let mut observe_prompt_message = |message: &CursorAcpMessage| {
            if matches!(
                message,
                CursorAcpMessage::Notification(crate::CursorAcpNotification::SessionUpdate(_))
            ) {
                observed_updates.set(observed_updates.get() + 1);
                Ok(true)
            } else {
                Ok(false)
            }
        };
        transport
            .decode_stdout_with_observer(&stdout, &mut observe_prompt_message, 0)
            .expect("prompt notifications are reduced before queueing the matching response");
        assert_eq!(transport.messages.len(), 1);
        assert_eq!(observed_updates.get(), MAX_EVENT_QUEUE + 1);
        let response = transport
            .wait_response_with(
                &request_id,
                Duration::from_millis(50),
                &mut observe_prompt_message,
            )
            .unwrap();
        assert_eq!(response.id, request_id);
        assert_eq!(response.result.unwrap()["stopReason"], "cancelled");
        assert_eq!(observed_updates.get(), MAX_EVENT_QUEUE + 1);

        let mut stdout = serde_json::json!({
            "jsonrpc":"2.0",
            "method":"session/update",
            "params":{
                "sessionId":"session-1",
                "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"tail"}}
            }
        })
        .to_string()
        .into_bytes();
        stdout.push(b'\n');
        assert!(
            !transport
                .observe_write_ack_event(
                    HostEvent::Stdout(stdout),
                    "cancel-write-1",
                    10,
                    &mut observe_prompt_message,
                )
                .expect("stdout before cancel write ACK is reduced incrementally")
        );
        assert_eq!(observed_updates.get(), MAX_EVENT_QUEUE + 2);
        assert!(
            transport.messages.is_empty(),
            "prompt updates are reduced rather than requeued behind the write ACK"
        );
        assert!(
            transport
                .observe_write_ack_event(
                    HostEvent::Lifecycle(serde_json::json!({
                        "type":"stdin-write-complete",
                        "requestId":"attempt",
                        "ownerToken":"owner",
                        "writeId":"cancel-write-1",
                        "bytesWritten":10
                    })),
                    "cancel-write-1",
                    10,
                    &mut observe_prompt_message,
                )
                .expect("matching cancel write ACK remains correlated")
        );
    }

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
    #[ignore = "requires RUDDER_TEST_PROCESS_HOST and a synthetic local child only"]
    fn cleanup_drain_collects_owned_terminal_with_full_queue_and_pending_tail() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::Instant;

        let process_host = std::env::var_os("RUDDER_TEST_PROCESS_HOST")
            .expect("set RUDDER_TEST_PROCESS_HOST to the Rust process-host binary");
        let process_host = PathBuf::from(process_host)
            .canonicalize()
            .expect("canonical process host");
        let root = tempdir().unwrap();
        let profile_home = root.path().join("profile-home");
        let runtime_root = root.path().join("runtime");
        let cwd = root.path().join("cwd");
        std::fs::create_dir_all(profile_home.join(".cursor")).unwrap();
        std::fs::create_dir_all(&runtime_root).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();

        let executable = root.path().join("synthetic-cursor");
        std::fs::write(
            &executable,
            b"#!/bin/sh\ntrap '' TERM\nwhile :; do /bin/sleep 1; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();

        let run_id = "slow-cleanup-run".to_owned();
        let attempt_id = "slow-cleanup-attempt".to_owned();
        let owner_token = "slow-cleanup-owner".to_owned();
        let mut transport = CursorAcpTransport::launch(
            CursorAcpProcessLaunch {
                executable,
                process_host,
                runtime_root,
                model: None,
                home: CursorAcpHome::OperatorProfile(profile_home.canonicalize().unwrap()),
                cwd: cwd.canonicalize().unwrap(),
                instruction_rule: None,
                run_id: run_id.clone(),
                attempt_id: attempt_id.clone(),
                owner_token: owner_token.clone(),
                env: BTreeMap::new(),
            },
            ConnectionLaunchPermit::from_claim(
                run_id.clone(),
                attempt_id.clone(),
                owner_token.clone(),
                1,
                "slow-cleanup-claim".into(),
            ),
        )
        .expect("launch synthetic child through owned process host");
        transport
            .wait_spawned(Duration::from_secs(5))
            .expect("owned process reaches spawned lifecycle");

        for index in 0..MAX_EVENT_QUEUE {
            let frame = private_extension_request_frame(&format!("queued-{index}"));
            transport.messages.push_back(
                parse_message(&frame[..frame.len() - 1])
                    .expect("valid unhandled extension request in the full queue"),
            );
        }
        let mut pending_tail = serde_json::json!({
            "jsonrpc":"2.0",
            "method":"session/update",
            "params":{
                "sessionId":"session-1",
                "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"late"}}
            }
        })
        .to_string()
        .into_bytes();
        pending_tail.push(b'\n');
        transport.pending_stdout.extend(pending_tail.clone());
        assert_eq!(
            transport.receive_host(Duration::ZERO),
            Err(CursorAcpTransportError::OutputOverflow),
            "normal ACP receive is correctly blocked by the full queue and retained tail"
        );

        let started = Instant::now();
        let mut hook_called = false;
        transport
            .stop_with_grace_hook(
                Duration::from_millis(100),
                Duration::from_millis(300),
                |remaining| {
                    assert!(!remaining.is_zero());
                    if !hook_called {
                        hook_called = true;
                        // The child ignores TERM, so the host emits its
                        // terminal lifecycle while this synchronous hook is
                        // stalled beyond the receive deadline.
                        std::thread::sleep(Duration::from_millis(700));
                    }
                },
            )
            .expect("final nonblocking drain observes the queued terminal");

        assert!(hook_called);
        assert!(started.elapsed() >= Duration::from_millis(700));
        assert_eq!(transport.messages.len(), MAX_EVENT_QUEUE);
        assert_eq!(
            transport.pending_stdout.iter().copied().collect::<Vec<_>>(),
            pending_tail,
            "cleanup does not project or discard ACP output retained before terminal"
        );
        let proof = transport
            .take_cleanup_proof()
            .expect("matching terminal lifecycle mints cleanup proof");
        assert!(proof.matches_execution(&run_id, &attempt_id, &owner_token));
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
