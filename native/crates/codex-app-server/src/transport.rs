//! One owned App Server connection. Durable permission to dispatch belongs to
//! the Rust supervisor; a write receipt is not provider acceptance.

use crate::{
    FrameDecoder, MAX_CHUNK_BYTES, Message, ProtocolError, RequestId, RpcSession, SessionError,
    SessionObservation, encode_notification,
};
use rudder_native_protocol::{Command, ProtocolVersion};
use rudder_process_host::{HostInput, LifecycleEvent, LifecycleSink, run_host};
use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::io::{self, Write};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const EVENT_CAPACITY: usize = 128;
const COMMAND_CAPACITY: usize = 16;

/// Trusted Rust configuration, not a wire DTO. Deliberately not Debug or
/// serializable: environment values can contain provider credentials.
pub struct ProcessLaunch {
    pub executable: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub request_id: String,
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

enum InputEvent {
    Lifecycle(Value),
    Stdout(Vec<u8>),
}

struct EventQueue {
    sender: mpsc::SyncSender<InputEvent>,
    open: AtomicBool,
    overflow: AtomicBool,
}

impl EventQueue {
    fn emit(&self, event: InputEvent) -> io::Result<()> {
        if !self.open.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "Codex consumer closed",
            ));
        }
        self.sender.try_send(event).map_err(|error| {
            if matches!(error, mpsc::TrySendError::Full(_)) {
                self.overflow.store(true, Ordering::Release);
            }
            self.open.store(false, Ordering::Release);
            io::Error::new(io::ErrorKind::BrokenPipe, "Codex output queue unavailable")
        })
    }
}

struct HostEvents(Arc<EventQueue>);
impl LifecycleSink for HostEvents {
    fn emit(&self, event: LifecycleEvent) -> io::Result<()> {
        self.0.emit(InputEvent::Lifecycle(event.into_value()))
    }
    fn is_closed(&self) -> bool {
        !self.0.open.load(Ordering::Acquire)
    }
}

struct Stdout(Arc<EventQueue>);
impl Write for Stdout {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        for chunk in bytes.chunks(MAX_CHUNK_BYTES) {
            self.0.emit(InputEvent::Stdout(chunk.to_vec()))?;
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
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
    commands: Option<mpsc::SyncSender<HostInput>>,
    events: mpsc::Receiver<InputEvent>,
    queue: Arc<EventQueue>,
    host: Option<JoinHandle<i32>>,
    decoder: FrameDecoder,
    session: RpcSession,
    messages: VecDeque<Message>,
    in_flight: Option<InFlight>,
    next_write: u64,
    request_id: String,
    owner_token: String,
    spawned: bool,
    stopped: bool,
    terminal_received: bool,
}

impl OwnedTransport {
    pub fn launch(launch: ProcessLaunch) -> Result<Self, TransportError> {
        let request_id = launch.request_id.clone();
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
        let (sender, events) = mpsc::sync_channel(EVENT_CAPACITY);
        let queue = Arc::new(EventQueue {
            sender,
            open: AtomicBool::new(true),
            overflow: AtomicBool::new(false),
        });
        let (commands, input) = mpsc::sync_channel(COMMAND_CAPACITY);
        let sink = Arc::new(HostEvents(Arc::clone(&queue)));
        let output = Box::new(Stdout(Arc::clone(&queue)));
        let host = thread::spawn(move || run_host(input, sink, output, Box::new(io::sink())));
        let transport = Self {
            commands: Some(commands),
            events,
            queue,
            host: Some(host),
            decoder: FrameDecoder::default(),
            session: RpcSession::default(),
            messages: VecDeque::new(),
            in_flight: None,
            next_write: 0,
            request_id,
            owner_token,
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
            if self.queue.overflow.load(Ordering::Acquire) {
                return Err(TransportError::OutputOverflow);
            }
            if let Some(message) = self.messages.pop_front() {
                return Ok(TransportEvent::Rpc(self.session.observe(message)?));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let event = self
                .events
                .recv_timeout(remaining)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => TransportError::Timeout,
                    mpsc::RecvTimeoutError::Disconnected => TransportError::Closed,
                })?;
            match event {
                InputEvent::Stdout(bytes) => self.messages.extend(self.decoder.push(&bytes)?),
                InputEvent::Lifecycle(value) => {
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
                            self.stopped = true;
                            self.terminal_received = true;
                            self.session.close();
                            self.decoder.finish()?;
                            self.commands.take();
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

    fn command(&self, command: Command) -> Result<(), TransportError> {
        self.commands
            .as_ref()
            .ok_or(TransportError::Closed)?
            .try_send(HostInput::Command(command))
            .map_err(|_| TransportError::Closed)
    }

    fn fail_closed(&mut self) {
        self.stopped = true;
        self.session.close();
        self.commands.take();
        self.queue.open.store(false, Ordering::Release);
    }
}

impl Drop for OwnedTransport {
    fn drop(&mut self) {
        self.fail_closed();
        // The host's ownership monitor performs bounded stop/reap on channel
        // loss. Joining here prevents an abandoned owned child after Drop.
        if let Some(host) = self.host.take() {
            let _ = host.join();
        }
    }
}
