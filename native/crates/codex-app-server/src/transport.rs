//! One owned App Server connection. Durable permission to dispatch belongs to
//! the Rust supervisor; a write receipt is not provider acceptance.

use crate::receipts::{ConnectionLaunchPermit, TurnReceiptTracker};
use crate::{
    FrameDecoder, MAX_CHUNK_BYTES, Message, ProtocolError, RequestId, RpcSession, SessionError,
    SessionObservation, encode_notification,
};
use rudder_native_process_transport::{HostConnection, HostError, HostEvent, OwnedHost};
use rudder_native_protocol::{Command, ProtocolVersion};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::time::{Duration, Instant};

/// Trusted Rust configuration, not a wire DTO. Deliberately not Debug or
/// serializable: environment values can contain provider credentials.
pub struct ProcessLaunch {
    pub executable: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub request_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub owner_token: String,
    pub runtime_root: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum TransportError {
    #[error("Codex process specification is invalid")]
    InvalidLaunch,
    #[error("Codex transport is closed; reconcile durable submission state")]
    Closed,
    #[error("Codex transport already has a frame in flight")]
    Busy,
    #[error("Codex transport event deadline expired")]
    Timeout,
    #[error("Codex transport exceeded its bounded output queue")]
    OutputOverflow,
    #[error("Codex stdin outcome is indeterminate; input must not be retried")]
    WriteIndeterminate,
    #[error("Codex process identity or receipt does not match this connection")]
    IdentityMismatch,
    #[error("Codex turn output or usage receipt is invalid or uncorrelated")]
    InvalidTurnReceipt,
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error(transparent)]
    Session(#[from] SessionError),
}

/// Observations only. The supervisor must persist provider IDs and independently
/// verify execution outcome and process quiescence before completing a Run.
pub enum TransportEvent {
    Lifecycle(Value),
    Rpc(SessionObservation),
    FrameWritten { request_id: Option<RequestId> },
}

struct InFlight {
    bytes: String,
    offset: usize,
    chunk_end: usize,
    write_id: String,
    request_id: Option<RequestId>,
}

/// Blocking event-driven transport. Use a dedicated supervisor task/thread;
/// never run its receive loop on an HTTP executor. Each instance is one process
/// and connection epoch. All buffers and host commands are bounded.
pub struct OwnedTransport {
    host: OwnedHost,
    decoder: FrameDecoder,
    session: RpcSession,
    messages: VecDeque<Message>,
    in_flight: Option<InFlight>,
    next_write: u64,
    request_id: String,
    owner_token: String,
    receipts: TurnReceiptTracker,
    effect_response: Option<crate::effect_response::PendingEffectResponse>,
    cleanup_receipt: Option<crate::CleanupReceipt>,
    spawned: bool,
    stopped: bool,
    terminal_received: bool,
}

impl OwnedTransport {
    pub fn launch(launch: ProcessLaunch) -> Result<Self, TransportError> {
        Self::launch_with_host(launch, None, None)
    }

    /// Launch the installed Rust host as a separate ownership process. Losing
    /// this caller closes the command pipe, allowing that host to reap its
    /// provider even when this process cannot run Drop (for example SIGKILL).
    /// Host loss remains indeterminate; it never proves provider quiescence.
    pub fn launch_external(
        launch: ProcessLaunch,
        host_executable: &std::path::Path,
    ) -> Result<Self, TransportError> {
        if !host_executable.is_absolute() {
            return Err(TransportError::InvalidLaunch);
        }
        let host = host_executable
            .canonicalize()
            .map_err(|_| TransportError::InvalidLaunch)?;
        if !host.is_file() {
            return Err(TransportError::InvalidLaunch);
        }
        Self::launch_with_host(launch, Some(host), None)
    }

    /// Launch the only transport authorized by a successful Native Chat D1
    /// claim. The move-only permit binds this process connection to that exact
    /// claim; an epoch-only launch is insufficient because two same-owner
    /// transports could otherwise present interchangeable cleanup evidence.
    pub fn launch_external_for_execution(
        launch: ProcessLaunch,
        host_executable: &std::path::Path,
        permit: ConnectionLaunchPermit,
    ) -> Result<Self, TransportError> {
        if !host_executable.is_absolute() {
            return Err(TransportError::InvalidLaunch);
        }
        let host = host_executable
            .canonicalize()
            .map_err(|_| TransportError::InvalidLaunch)?;
        if !host.is_file() {
            return Err(TransportError::InvalidLaunch);
        }
        Self::launch_with_host(launch, Some(host), Some(permit))
    }

    fn launch_with_host(
        launch: ProcessLaunch,
        external_host: Option<std::path::PathBuf>,
        permit: Option<ConnectionLaunchPermit>,
    ) -> Result<Self, TransportError> {
        let request_id = launch.request_id.clone();
        if launch.run_id.is_empty()
            || launch.attempt_id.is_empty()
            || launch.attempt_id != launch.request_id
            || launch.owner_token.is_empty()
        {
            return Err(TransportError::InvalidLaunch);
        }
        let run_id = launch.run_id.clone();
        let attempt_id = launch.attempt_id.clone();
        let owner_token = launch.owner_token.clone();
        let start = Command::StartProcess {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(launch.request_id),
            executable: launch.executable,
            argv: launch.argv,
            cwd: launch.cwd,
            env: launch.env,
            owner_token: Some(launch.owner_token),
            runtime_root: Some(launch.runtime_root),
            stdin: None,
            interactive_stdin: true,
            grace_ms: Some(500),
        };
        start
            .validate()
            .map_err(|_| TransportError::InvalidLaunch)?;
        let connection = HostConnection {
            request_id: request_id.clone(),
            run_id,
            attempt_id,
            owner_token: owner_token.clone(),
        };
        let host = match external_host {
            Some(executable) => OwnedHost::launch_external(connection, &executable, permit),
            None => OwnedHost::launch_embedded(connection, permit, MAX_CHUNK_BYTES),
        }
        .map_err(|error| match error {
            HostError::InvalidLaunch => TransportError::InvalidLaunch,
            HostError::Closed => TransportError::Closed,
            HostError::Timeout => TransportError::Timeout,
            HostError::OutputOverflow => TransportError::OutputOverflow,
        })?;
        let receipts = TurnReceiptTracker::new(host.connection_identity());
        let transport = Self {
            host,
            decoder: FrameDecoder::default(),
            session: RpcSession::default(),
            messages: VecDeque::new(),
            in_flight: None,
            next_write: 0,
            request_id,
            owner_token,
            receipts,
            effect_response: None,
            cleanup_receipt: None,
            spawned: false,
            stopped: false,
            terminal_received: false,
        };
        transport.command(start)?;
        Ok(transport)
    }

    /// Register before any bytes are queued. Caller must already have committed
    /// the appropriate indeterminate checkpoint for effectful methods. Never
    /// retry this operation after an error using a new connection. Consume the
    /// spawned lifecycle event before calling request/notify; a not-yet-spawned
    /// connection is not writable.
    pub fn request(&mut self, method: &str, params: Value) -> Result<RequestId, TransportError> {
        self.ensure_writable()?;
        let prepared = self.session.prepare(method, params)?;
        let id = prepared.id().clone();
        self.start_frame(prepared.into_bytes(), Some(id.clone()))?;
        Ok(id)
    }

    /// Opt in to bounded successful-response proof for a single effect RPC.
    pub fn request_with_effect_receipt(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<RequestId, TransportError> {
        self.ensure_writable()?;
        if self.effect_response.is_some() {
            return Err(TransportError::Busy);
        }
        if !matches!(method, "thread/start" | "turn/start") {
            return Err(TransportError::InvalidTurnReceipt);
        }
        let prepared = self.session.prepare(method, params.clone())?;
        let id = prepared.id().clone();
        self.effect_response = Some(crate::effect_response::PendingEffectResponse::new(
            id.clone(),
            method,
            &params,
        )?);
        self.start_frame(prepared.into_bytes(), Some(id.clone()))?;
        Ok(id)
    }

    pub fn notify(&mut self, method: &str, params: Value) -> Result<(), TransportError> {
        self.ensure_writable()?;
        self.start_frame(encode_notification(method, params)?, None)
    }

    fn ensure_writable(&self) -> Result<(), TransportError> {
        if !self.spawned || self.stopped || self.session.is_closed() {
            return Err(TransportError::Closed);
        }
        if self.in_flight.is_some() {
            return Err(TransportError::Busy);
        }
        Ok(())
    }

    fn start_frame(
        &mut self,
        bytes: Vec<u8>,
        request_id: Option<RequestId>,
    ) -> Result<(), TransportError> {
        let bytes = String::from_utf8(bytes).map_err(|_| ProtocolError::InvalidFrame)?;
        self.in_flight = Some(InFlight {
            bytes,
            offset: 0,
            chunk_end: 0,
            write_id: String::new(),
            request_id,
        });
        if let Err(error) = self.send_chunk() {
            self.fail_closed();
            return Err(error);
        }
        Ok(())
    }

    fn send_chunk(&mut self) -> Result<(), TransportError> {
        let frame = self
            .in_flight
            .as_mut()
            .ok_or(TransportError::WriteIndeterminate)?;
        let mut end = (frame.offset + MAX_CHUNK_BYTES).min(frame.bytes.len());
        while !frame.bytes.is_char_boundary(end) {
            end -= 1;
        }
        self.next_write = self
            .next_write
            .checked_add(1)
            .ok_or(TransportError::Closed)?;
        frame.write_id = format!("rpc-chunk-{}", self.next_write);
        frame.chunk_end = end;
        let command = Command::WriteStdin {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(self.request_id.clone()),
            owner_token: Some(self.owner_token.clone()),
            write_id: Some(frame.write_id.clone()),
            data: frame.bytes[frame.offset..end].to_owned(),
        };
        self.command(command)
    }

    /// Wait for an observation within a fatal operation deadline. Expiry closes
    /// this connection and its owned child; this is not a nonfatal polling API.
    pub fn receive(&mut self, timeout: Duration) -> Result<TransportEvent, TransportError> {
        let result = self.receive_inner(timeout);
        if result.is_err() {
            self.fail_closed();
        }
        result
    }

    /// Wait for at most one observation without treating provider silence as
    /// failure. A supervisor can renew its durable leases between polls; it
    /// must enforce its own operation deadline and stop on lost ownership.
    /// Partial frames and pending writes survive an empty poll. All actual
    /// protocol, identity, queue and disconnection failures still close the
    /// connection, and no polling result authorizes resubmission.
    pub fn poll(&mut self, timeout: Duration) -> Result<Option<TransportEvent>, TransportError> {
        match self.receive_inner(timeout) {
            Ok(event) => Ok(Some(event)),
            Err(TransportError::Timeout) => Ok(None),
            Err(error) => {
                self.fail_closed();
                Err(error)
            }
        }
    }

    fn receive_inner(&mut self, timeout: Duration) -> Result<TransportEvent, TransportError> {
        if self.terminal_received {
            return Err(TransportError::Closed);
        }
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(message) = self.messages.pop_front() {
                let observation = self.session.observe(message)?;
                if let SessionObservation::Incoming(Message::Notification { method, params }) =
                    &observation
                    && matches!(
                        method.as_str(),
                        "item/started"
                            | "item/agentMessage/delta"
                            | "item/completed"
                            | "thread/tokenUsage/updated"
                            | "turn/completed"
                    )
                {
                    self.receipts.observe(
                        method,
                        params.clone().ok_or(TransportError::InvalidTurnReceipt)?,
                    )?;
                }
                if let Some(response) = &mut self.effect_response {
                    response.observe(&observation)?;
                }
                return Ok(TransportEvent::Rpc(observation));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let event = self.host.receive(remaining).map_err(|error| match error {
                HostError::InvalidLaunch | HostError::Closed => TransportError::Closed,
                HostError::Timeout => TransportError::Timeout,
                HostError::OutputOverflow => TransportError::OutputOverflow,
            })?;
            match event {
                HostEvent::Failure => return Err(TransportError::Closed),
                HostEvent::Stdout(bytes) => self.messages.extend(self.decoder.push(&bytes)?),
                HostEvent::Lifecycle(value) => {
                    let kind = value
                        .get("type")
                        .and_then(Value::as_str)
                        .ok_or(TransportError::IdentityMismatch)?;
                    match kind {
                        "spawned" => {
                            if value["ownerToken"] != self.owner_token
                                || self.spawned
                                || self.stopped
                            {
                                return Err(TransportError::IdentityMismatch);
                            }
                            self.spawned = true;
                        }
                        "stdin-write-complete" => {
                            let frame = self
                                .in_flight
                                .as_mut()
                                .ok_or(TransportError::IdentityMismatch)?;
                            if value["requestId"] != self.request_id
                                || value["ownerToken"] != self.owner_token
                                || value["writeId"] != frame.write_id
                                || value["replayed"] != false
                                || value["bytesWritten"].as_u64()
                                    != Some((frame.chunk_end - frame.offset) as u64)
                            {
                                return Err(TransportError::IdentityMismatch);
                            }
                            frame.offset = frame.chunk_end;
                            if frame.offset == frame.bytes.len() {
                                let request_id = self.in_flight.take().unwrap().request_id;
                                if let Some(response) = &mut self.effect_response {
                                    response.written(request_id.as_ref());
                                }
                                return Ok(TransportEvent::FrameWritten { request_id });
                            }
                            if self.stopped {
                                return Err(TransportError::WriteIndeterminate);
                            }
                            self.send_chunk()?;
                            continue;
                        }
                        "stdin-write-failed" | "stdin-write-rejected" => {
                            return Err(TransportError::WriteIndeterminate);
                        }
                        "app-exit" => {
                            self.stopped = true;
                        }
                        "terminal" => {
                            if value["requestId"] != self.request_id
                                || value["ownerToken"] != self.owner_token
                            {
                                return Err(TransportError::IdentityMismatch);
                            }
                            self.stopped = true;
                            self.terminal_received = true;
                            if value["cleanupProven"] == true && value["receiptWritten"] == true {
                                self.cleanup_receipt = self
                                    .host
                                    .take_cleanup_proof()
                                    .map(crate::CleanupReceipt::from_host_proof);
                            }
                            if self.receipts.is_armed() && self.receipts.has_terminal() {
                                self.receipts.finish()?;
                            }
                            self.session.close();
                            self.decoder.finish()?;
                            self.host.close();
                        }
                        _ => {}
                    }
                    return Ok(TransportEvent::Lifecycle(value));
                }
            }
        }
    }

    /// Requests process shutdown only; does not alter a Run or claim cleanup.
    /// Keep receiving until the terminal receipt and verify cleanup separately.
    pub fn stop(&mut self) -> Result<(), TransportError> {
        self.stopped = true;
        self.command(Command::Stop {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(self.request_id.clone()),
            grace_ms: Some(500),
        })
    }

    /// Begin collecting an exact turn after its opaque ID is returned. Bounded
    /// notifications received before the RPC response are correlated now.
    pub fn begin_turn_receipt(
        &mut self,
        thread_id: String,
        turn_id: String,
    ) -> Result<(), TransportError> {
        self.receipts.begin_turn(thread_id, turn_id)?;
        if self.terminal_received && self.receipts.has_terminal() {
            self.receipts.finish()?;
        }
        Ok(())
    }

    /// Start buffering notifications for the next `turn/start` dispatch. Events
    /// observed before this call (for example prior resumed-turn usage replay)
    /// are ignored and cannot be attached to the next turn receipt.
    pub fn arm_turn_receipt(&mut self) -> Result<(), TransportError> {
        self.receipts.arm()
    }

    /// Consume proof only after both the exact successful RPC and complete
    /// frame write were observed on this connection.
    pub fn take_effect_response_receipt(&mut self) -> Option<crate::EffectResponseReceipt> {
        if !self.effect_response.as_ref().is_some_and(|r| r.ready()) {
            return None;
        }
        Some(
            self.effect_response
                .take()?
                .finish(self.receipts.response_identity()),
        )
    }

    pub fn connection_receipt_id(&self) -> String {
        self.receipts
            .response_identity()
            .connection_receipt_id()
            .to_owned()
    }

    /// Opaque identity for registering this concrete transport against a
    /// stopping D1 action. It carries no cleanup or provider-effect authority.
    pub fn connection_receipt(&self) -> crate::ConnectionReceipt {
        self.receipts.response_identity().connection_receipt()
    }

    /// Drain typed output observations for the exact armed Thread/Turn. Deltas
    /// are safe only after item/started proves `agentMessage/final_answer`;
    /// snapshots replace the message body. This receipt is not terminal or Run
    /// authority, and callers should drain after every receive observation.
    pub fn take_visible_output_receipts(&mut self) -> Vec<crate::VisibleOutputReceipt> {
        self.receipts.take_visible_output_receipts()
    }

    /// A turn receipt requires the exact `turn/completed` notification and the
    /// host terminal boundary that drained all provider output.
    pub fn take_turn_receipt(&mut self) -> Option<crate::TurnReceipt> {
        if self.terminal_received {
            self.receipts.take()
        } else {
            None
        }
    }

    /// A cleanup receipt requires exact connection identity and both durable
    /// host cleanup flags. Host loss, EOF and Drop never create one.
    pub fn take_cleanup_receipt(&mut self) -> Option<crate::CleanupReceipt> {
        if self.terminal_received {
            self.cleanup_receipt.take()
        } else {
            None
        }
    }

    fn command(&self, command: Command) -> Result<(), TransportError> {
        self.host.send(command).map_err(|error| match error {
            HostError::InvalidLaunch | HostError::Closed => TransportError::Closed,
            HostError::Timeout => TransportError::Timeout,
            HostError::OutputOverflow => TransportError::OutputOverflow,
        })
    }

    fn fail_closed(&mut self) {
        self.stopped = true;
        self.session.close();
        self.host.close();
    }
}

impl Drop for OwnedTransport {
    fn drop(&mut self) {
        self.fail_closed();
        // OwnedHost closes the command pipe and joins its bounded monitor.
    }
}
