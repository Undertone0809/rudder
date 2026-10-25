//! Bounded ownership transport for the Rust process host.
//!
//! This crate owns the host lifecycle and its opaque cleanup proof. Runtime
//! adapters may interpret JSON-RPC or another child protocol above this layer,
//! but cannot construct a cleanup proof from caller-provided data.

mod connection;
mod external;
mod strict_json;

pub use connection::{
    ConnectionIdentity, ConnectionLaunchPermit, ConnectionReceipt, DurableCleanupReceiptError,
    DurableHostCleanupReceipt, HostCleanupProof, read_durable_cleanup_receipt,
};

use rudder_native_protocol::Command;
use rudder_process_host::{HostInput, LifecycleEvent, LifecycleSink, run_host};
use std::io::{self, Write};
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const EVENT_CAPACITY: usize = 128;
const COMMAND_CAPACITY: usize = 16;
const EVENT_SEND_TIMEOUT: Duration = Duration::from_secs(2);
const EVENT_SEND_RETRY_INTERVAL: Duration = Duration::from_millis(2);

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum HostError {
    #[error("Rust process host specification is invalid")]
    InvalidLaunch,
    #[error("Rust process host is closed")]
    Closed,
    #[error("Rust process host event deadline expired")]
    Timeout,
    #[error("Rust process host exceeded its bounded output queue")]
    OutputOverflow,
}

/// Identifiers the generic host needs to match lifecycle events. Values are
/// never logged or formatted by this crate.
pub struct HostConnection {
    pub request_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub owner_token: String,
}

pub enum HostEvent {
    Lifecycle(serde_json::Value),
    Stdout(Vec<u8>),
    Failure,
}

enum InputEvent {
    Lifecycle(serde_json::Value),
    Stdout(Vec<u8>),
    Failure,
}

struct EventQueue {
    sender: mpsc::SyncSender<InputEvent>,
    open: AtomicBool,
    overflow: AtomicBool,
}

impl EventQueue {
    fn emit(&self, event: InputEvent) -> io::Result<()> {
        let deadline = std::time::Instant::now() + EVENT_SEND_TIMEOUT;
        let mut event = event;
        loop {
            if !self.open.load(Ordering::Acquire) {
                return Err(consumer_closed());
            }
            match self.sender.try_send(event) {
                Ok(()) => return Ok(()),
                Err(mpsc::TrySendError::Disconnected(_)) => {
                    self.open.store(false, Ordering::Release);
                    return Err(consumer_closed());
                }
                Err(mpsc::TrySendError::Full(returned)) => {
                    event = returned;
                    if !self.open.load(Ordering::Acquire) {
                        return Err(consumer_closed());
                    }
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        // Only the producer that closes an open queue owns the
                        // deadline overflow classification. An owner close
                        // that raced with the deadline remains ordinary close.
                        if self
                            .open
                            .compare_exchange(true, false, Ordering::AcqRel, Ordering::Acquire)
                            .is_ok()
                        {
                            self.overflow.store(true, Ordering::Release);
                            return Err(io::Error::new(
                                io::ErrorKind::TimedOut,
                                "host output queue deadline expired",
                            ));
                        }
                        return Err(consumer_closed());
                    }
                    thread::sleep(remaining.min(EVENT_SEND_RETRY_INTERVAL));
                }
            }
        }
    }
}

fn consumer_closed() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "host consumer closed")
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

struct HostStdout(Arc<EventQueue>, usize);
impl Write for HostStdout {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.1 == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "zero output chunk limit",
            ));
        }
        for chunk in bytes.chunks(self.1) {
            self.0.emit(InputEvent::Stdout(chunk.to_vec()))?;
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Owns one process-host session and the only channel that can command it.
/// Dropping the owner closes the command stream and joins the bounded host
/// monitor; host loss never fabricates a cleanup proof.
pub struct OwnedHost {
    commands: Option<mpsc::SyncSender<HostInput>>,
    events: mpsc::Receiver<InputEvent>,
    queue: Arc<EventQueue>,
    host: Option<JoinHandle<i32>>,
    identity: ConnectionIdentity,
    cleanup_proof: Option<HostCleanupProof>,
    terminal_received: bool,
    request_id: String,
    owner_token: String,
}

impl OwnedHost {
    /// Start the in-process process-host library. This path remains available
    /// for local transport tests and keeps the existing Rust consumer API.
    pub fn launch_embedded(
        connection: HostConnection,
        permit: Option<ConnectionLaunchPermit>,
        stdout_chunk_bytes: usize,
    ) -> Result<Self, HostError> {
        let identity = identity_for(&connection, permit)?;
        Self::launch_with(
            connection.request_id,
            connection.owner_token,
            identity,
            None,
            stdout_chunk_bytes,
        )
    }

    /// Start the installed `rudder-process-host` as a separately owned host.
    /// The host process receives no inherited environment except platform
    /// loader facts, and its command writer closes on owner drop.
    pub fn launch_external(
        connection: HostConnection,
        host_executable: &Path,
        permit: Option<ConnectionLaunchPermit>,
    ) -> Result<Self, HostError> {
        if !host_executable.is_absolute() {
            return Err(HostError::InvalidLaunch);
        }
        let executable = host_executable
            .canonicalize()
            .map_err(|_| HostError::InvalidLaunch)?;
        if !executable.is_file() {
            return Err(HostError::InvalidLaunch);
        }
        let identity = identity_for(&connection, permit)?;
        Self::launch_with(
            connection.request_id,
            connection.owner_token,
            identity,
            Some(executable),
            1,
        )
    }

    fn launch_with(
        request_id: String,
        owner_token: String,
        identity: ConnectionIdentity,
        external_host: Option<std::path::PathBuf>,
        stdout_chunk_bytes: usize,
    ) -> Result<Self, HostError> {
        let (sender, events) = mpsc::sync_channel(EVENT_CAPACITY);
        let queue = Arc::new(EventQueue {
            sender,
            open: AtomicBool::new(true),
            overflow: AtomicBool::new(false),
        });
        let (commands, input) = mpsc::sync_channel(COMMAND_CAPACITY);
        let sink = Arc::new(HostEvents(Arc::clone(&queue)));
        let output = Box::new(HostStdout(Arc::clone(&queue), stdout_chunk_bytes));
        let host_queue = Arc::clone(&queue);
        let host_request = request_id.clone();
        let host_owner = owner_token.clone();
        let host = thread::spawn(move || match external_host {
            Some(executable) => {
                external::run(executable, input, host_queue, &host_request, &host_owner)
            }
            None => run_host(input, sink, output, Box::new(io::sink())),
        });
        Ok(Self {
            commands: Some(commands),
            events,
            queue,
            host: Some(host),
            identity,
            cleanup_proof: None,
            terminal_received: false,
            request_id,
            owner_token,
        })
    }

    pub fn send(&self, command: Command) -> Result<(), HostError> {
        self.commands
            .as_ref()
            .ok_or(HostError::Closed)?
            .try_send(HostInput::Command(command))
            .map_err(|_| HostError::Closed)
    }

    pub fn receive(&mut self, timeout: Duration) -> Result<HostEvent, HostError> {
        if self.queue.overflow.load(Ordering::Acquire) {
            return Err(HostError::OutputOverflow);
        }
        let event = self
            .events
            .recv_timeout(timeout)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => HostError::Timeout,
                mpsc::RecvTimeoutError::Disconnected => HostError::Closed,
            })?;
        match event {
            InputEvent::Lifecycle(value) => {
                if value["type"] == "terminal" {
                    self.terminal_received = true;
                    if value["requestId"] == self.request_id
                        && value["ownerToken"] == self.owner_token
                        && value["cleanupProven"] == true
                        && value["receiptWritten"] == true
                    {
                        self.cleanup_proof = Some(HostCleanupProof::from_owned_host(
                            self.identity.duplicate_identity(),
                        ));
                    }
                }
                Ok(HostEvent::Lifecycle(value))
            }
            InputEvent::Stdout(bytes) => Ok(HostEvent::Stdout(bytes)),
            InputEvent::Failure => Ok(HostEvent::Failure),
        }
    }

    pub fn connection_identity(&self) -> ConnectionIdentity {
        self.identity.duplicate_identity()
    }

    pub fn take_cleanup_proof(&mut self) -> Option<HostCleanupProof> {
        if self.terminal_received {
            self.cleanup_proof.take()
        } else {
            None
        }
    }

    pub fn close(&mut self) {
        self.commands.take();
        self.queue.open.store(false, Ordering::Release);
    }
}

impl Drop for OwnedHost {
    fn drop(&mut self) {
        self.close();
        if let Some(host) = self.host.take() {
            let _ = host.join();
        }
    }
}

fn identity_for(
    connection: &HostConnection,
    permit: Option<ConnectionLaunchPermit>,
) -> Result<ConnectionIdentity, HostError> {
    if connection.request_id.is_empty()
        || connection.attempt_id != connection.request_id
        || connection.run_id.is_empty()
        || connection.owner_token.is_empty()
    {
        return Err(HostError::InvalidLaunch);
    }
    match permit {
        Some(permit) => permit
            .into_identity(
                &connection.run_id,
                &connection.attempt_id,
                &connection.owner_token,
            )
            .ok_or(HostError::InvalidLaunch),
        None => Ok(ConnectionIdentity::unbound(
            connection.run_id.clone(),
            connection.attempt_id.clone(),
            connection.owner_token.clone(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> HostConnection {
        HostConnection {
            request_id: "attempt-7".into(),
            run_id: "run-3".into(),
            attempt_id: "attempt-7".into(),
            owner_token: "owner-secret".into(),
        }
    }

    fn event_queue() -> (Arc<EventQueue>, mpsc::Receiver<InputEvent>) {
        let (sender, receiver) = mpsc::sync_channel(EVENT_CAPACITY);
        (
            Arc::new(EventQueue {
                sender,
                open: AtomicBool::new(true),
                overflow: AtomicBool::new(false),
            }),
            receiver,
        )
    }

    fn numbered_event(index: usize) -> InputEvent {
        InputEvent::Lifecycle(serde_json::json!({"index": index}))
    }

    #[test]
    fn event_queue_waits_for_a_slow_consumer_and_preserves_burst_order() {
        let (queue, receiver) = event_queue();
        let count = EVENT_CAPACITY * 2 + 17;
        let producer_queue = Arc::clone(&queue);
        let producer = thread::spawn(move || {
            for index in 0..count {
                producer_queue.emit(numbered_event(index)).unwrap();
            }
        });

        for expected in 0..count {
            match receiver.recv_timeout(Duration::from_secs(2)).unwrap() {
                InputEvent::Lifecycle(value) => assert_eq!(value["index"], expected),
                _ => panic!("unexpected event in ordered burst"),
            }
            thread::sleep(Duration::from_millis(1));
        }
        producer.join().unwrap();
        assert!(!queue.overflow.load(Ordering::Acquire));
    }

    #[test]
    fn event_queue_close_interrupts_a_blocked_producer_without_overflow() {
        let (queue, _receiver) = event_queue();
        for index in 0..EVENT_CAPACITY {
            queue.emit(numbered_event(index)).unwrap();
        }
        let producer_queue = Arc::clone(&queue);
        let (started_tx, started_rx) = mpsc::channel();
        let producer = thread::spawn(move || {
            started_tx.send(()).unwrap();
            producer_queue.emit(numbered_event(EVENT_CAPACITY))
        });
        started_rx.recv().unwrap();
        thread::sleep(Duration::from_millis(10));
        queue.open.store(false, Ordering::Release);

        assert_eq!(
            producer.join().unwrap().unwrap_err().kind(),
            io::ErrorKind::BrokenPipe
        );
        assert!(!queue.overflow.load(Ordering::Acquire));
    }

    #[test]
    fn event_queue_stalled_consumer_expires_one_bounded_deadline() {
        let (queue, _receiver) = event_queue();
        for index in 0..EVENT_CAPACITY {
            queue.emit(numbered_event(index)).unwrap();
        }
        let started = std::time::Instant::now();
        let error = queue.emit(numbered_event(EVENT_CAPACITY)).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= EVENT_SEND_TIMEOUT);
        assert!(queue.overflow.load(Ordering::Acquire));
        assert!(!queue.open.load(Ordering::Acquire));
    }

    #[test]
    fn launch_permit_binds_identity_to_the_exact_claim() {
        let connection = connection();
        let permit = ConnectionLaunchPermit::from_claim(
            "run-3".into(),
            "attempt-7".into(),
            "owner-secret".into(),
            4,
            "claim-random".into(),
        );
        let identity = identity_for(&connection, Some(permit)).unwrap();
        assert!(identity.matches_connection_claim(
            "run-3",
            "attempt-7",
            "owner-secret",
            4,
            "claim-random"
        ));
        assert!(!identity.matches_connection_claim(
            "run-3",
            "attempt-7",
            "owner-secret",
            4,
            "different-claim"
        ));
    }

    #[test]
    fn mismatched_or_unbound_permits_never_create_claimed_identity() {
        let connection = connection();
        for permit in [
            ConnectionLaunchPermit::from_claim(
                "another-run".into(),
                "attempt-7".into(),
                "owner-secret".into(),
                4,
                "claim-random".into(),
            ),
            ConnectionLaunchPermit::from_claim(
                "run-3".into(),
                "attempt-7".into(),
                "owner-secret".into(),
                0,
                "claim-random".into(),
            ),
            ConnectionLaunchPermit::from_claim(
                "run-3".into(),
                "attempt-7".into(),
                "owner-secret".into(),
                4,
                "".into(),
            ),
        ] {
            assert!(identity_for(&connection, Some(permit)).is_err());
        }
        let unbound = identity_for(&connection, None).unwrap();
        assert_eq!(unbound.connection_epoch(), None);
        assert!(!unbound.matches_connection_claim(
            "run-3",
            "attempt-7",
            "owner-secret",
            4,
            "claim-random"
        ));
    }
}
