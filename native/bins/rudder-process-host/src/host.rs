#[path = "interactive_stdin.rs"]
mod interactive_stdin;
#[path = "host/process.rs"]
mod process;

use interactive_stdin::InteractiveStdin;
use process::{
    CleanupResult, OperationEvidence, PreSpawnOperationEvidence, SpawnChildError, SpawnDisposition,
    spawn_child, spawn_path_preflight, spawn_terminal,
};
use rudder_native_protocol::{
    CAPABILITIES, Command, MAX_INTERACTIVE_STDIN_WRITE_IDS, PROTOCOL_MAJOR, PROTOCOL_MINOR,
};
use serde_json::{Value, json};
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(all(test, unix))]
use process::{OwnedProcessBoundary, monitor_child};
#[cfg(all(test, unix))]
use std::collections::BTreeMap;
#[cfg(all(test, unix))]
use std::fs;
#[cfg(all(test, unix))]
use std::path::PathBuf;

const TERM_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_TERMINAL_STDIN_REJECTIONS: usize = MAX_INTERACTIVE_STDIN_WRITE_IDS + 1;
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

fn native_target() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else {
        "unsupported"
    }
}

/// One lifecycle event emitted by the process host.
///
/// The inner JSON object is the existing process-host wire frame. Keeping it
/// as a distinct type lets in-process Rust consumers receive events without
/// mixing them with the raw stdout/stderr byte streams.
#[derive(Clone, Debug)]
pub struct LifecycleEvent {
    value: Value,
}

impl LifecycleEvent {
    pub fn new(value: Value) -> Self {
        Self { value }
    }

    pub fn into_value(self) -> Value {
        self.value
    }

    pub fn as_value(&self) -> &Value {
        &self.value
    }
}

/// Receives structured lifecycle events from the supervisor.
///
/// Implementations should keep delivery bounded and return an error as soon as
/// the consumer is gone or its transport fails. The supervisor stops and
/// reaps an active child when delivery fails.
pub trait LifecycleSink: Send + Sync {
    fn emit(&self, event: LifecycleEvent) -> io::Result<()>;

    fn is_closed(&self) -> bool {
        false
    }
}

/// A lifecycle sink backed by a bounded Rust channel.
pub struct ChannelLifecycleSink {
    sender: mpsc::SyncSender<LifecycleEvent>,
    receiver_open: Arc<AtomicBool>,
}

/// The receiving half returned by [`lifecycle_channel`].
pub struct LifecycleEventReceiver {
    receiver: mpsc::Receiver<LifecycleEvent>,
    receiver_open: Arc<AtomicBool>,
}

impl LifecycleEventReceiver {
    pub fn recv(&self) -> Result<LifecycleEvent, mpsc::RecvError> {
        self.receiver.recv()
    }

    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<LifecycleEvent, mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(timeout)
    }
}

impl Drop for LifecycleEventReceiver {
    fn drop(&mut self) {
        self.receiver_open.store(false, Ordering::Release);
    }
}

impl LifecycleSink for ChannelLifecycleSink {
    fn emit(&self, event: LifecycleEvent) -> io::Result<()> {
        if self.is_closed() {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "lifecycle event receiver closed",
            ));
        }
        self.sender
            .send(event)
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "lifecycle receiver dropped"))
    }

    fn is_closed(&self) -> bool {
        !self.receiver_open.load(Ordering::Acquire)
    }
}

/// Creates a bounded lifecycle channel. The caller must keep draining its
/// receiver while [`run_host`] is active; a full channel applies backpressure.
pub fn lifecycle_channel(capacity: usize) -> (Arc<dyn LifecycleSink>, LifecycleEventReceiver) {
    let (sender, receiver) = mpsc::sync_channel(capacity);
    let receiver_open = Arc::new(AtomicBool::new(true));
    (
        Arc::new(ChannelLifecycleSink {
            sender,
            receiver_open: Arc::clone(&receiver_open),
        }),
        LifecycleEventReceiver {
            receiver,
            receiver_open,
        },
    )
}

/// A direct writer-backed lifecycle sink used by the CLI fd adapter.
pub struct WriterLifecycleSink {
    writer: Mutex<BufWriter<Box<dyn Write + Send>>>,
    failed: AtomicBool,
}

impl WriterLifecycleSink {
    pub fn new(writer: impl Write + Send + 'static) -> Self {
        Self {
            writer: Mutex::new(BufWriter::new(Box::new(writer))),
            failed: AtomicBool::new(false),
        }
    }
}

impl LifecycleSink for WriterLifecycleSink {
    fn emit(&self, event: LifecycleEvent) -> io::Result<()> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("lifecycle writer lock poisoned"))?;
        let result = (|| {
            serde_json::to_writer(&mut *writer, event.as_value()).map_err(io::Error::other)?;
            writer.write_all(b"\n")?;
            writer.flush()
        })();
        if result.is_err() {
            self.failed.store(true, Ordering::Release);
        }
        result
    }

    fn is_closed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }
}

struct LifecycleWriter {
    sink: Arc<dyn LifecycleSink>,
    failed: AtomicBool,
    request_id: Mutex<String>,
    owner_token: Mutex<Option<String>>,
}

type Lifecycle = Arc<LifecycleWriter>;
type RawOutput = Arc<Mutex<BufWriter<Box<dyn Write + Send>>>>;

fn lifecycle_with_sink(
    sink: Arc<dyn LifecycleSink>,
    request_id: String,
    owner_token: Option<String>,
) -> Lifecycle {
    Arc::new(LifecycleWriter {
        sink,
        failed: AtomicBool::new(false),
        request_id: Mutex::new(request_id),
        owner_token: Mutex::new(owner_token),
    })
}

#[cfg(all(test, unix))]
fn lifecycle_for_writer(
    writer: impl Write + Send + 'static,
    request_id: &str,
    owner_token: Option<&str>,
) -> Lifecycle {
    lifecycle_with_sink(
        Arc::new(WriterLifecycleSink::new(writer)),
        request_id.to_string(),
        owner_token.map(str::to_string),
    )
}

pub enum HostInput {
    Command(Command),
    Invalid(&'static str),
    Eof,
    #[cfg(test)]
    PanicMonitor,
}

enum MonitorCommand {
    Stop {
        grace: Option<Duration>,
    },
    Input(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
    },
    #[cfg(test)]
    PanicForTest,
}

enum MonitorEvent {
    ListenerVerified {
        port: u16,
    },
    ListenerOwnerMismatch,
    Exited {
        code: Option<i32>,
        signal: Option<&'static str>,
        was_stopped: bool,
        cleanup_proven: bool,
        had_surviving_group: bool,
        stdin_error: Option<&'static str>,
    },
}

struct Counters {
    bytes_read: AtomicU64,
    bytes_written: AtomicU64,
}

struct ActiveChild {
    control: mpsc::Sender<MonitorCommand>,
    events: mpsc::Receiver<MonitorEvent>,
    monitor_cleanup: mpsc::Receiver<CleanupResult>,
    monitor_cleanup_timeout: Duration,
    output_done: Vec<mpsc::Receiver<bool>>,
    evidence: Option<Arc<OperationEvidence>>,
    output_gate: Option<Arc<AtomicBool>>,
    output_failed: Arc<AtomicBool>,
    identity: Option<ChildIdentity>,
    interactive_stdin: Option<InteractiveStdin>,
}

struct ChildIdentity {
    request_id: String,
    owner_token: String,
}

/// Runs one owned process-host session. The input receiver is a bounded
/// command source; closing it is treated like stdin EOF and stops an active
/// child. Lifecycle events and raw child output always use separate channels.
///
/// Once the child-exit path emits `app-exit`, stdin commands are no longer
/// admitted. The host scans at most `MAX_INTERACTIVE_STDIN_WRITE_IDS + 1`
/// commands available to its nonblocking terminal drain, rejecting any
/// `WriteStdin`/`CloseStdin` commands found there with correlated
/// `child_not_running` receipts before the terminal event. Callers should keep
/// the bounded input queue at or below that cap to ensure all pending commands
/// are covered, and stop sending stdin commands when they observe `app-exit`.
/// Commands that arrive after the drain observes an empty queue, or after its
/// cap, are outside the session contract and may not receive a receipt; a live
/// producer cannot delay terminal cleanup indefinitely.
pub fn run_host(
    input_rx: mpsc::Receiver<HostInput>,
    lifecycle_sink: Arc<dyn LifecycleSink>,
    stdout_writer: Box<dyn Write + Send>,
    stderr_writer: Box<dyn Write + Send>,
) -> i32 {
    let lifecycle = lifecycle_with_sink(lifecycle_sink, "bootstrap".to_string(), None);
    let stdout = Arc::new(Mutex::new(BufWriter::new(stdout_writer)));
    let stderr = Arc::new(Mutex::new(BufWriter::new(stderr_writer)));

    if !send(
        &lifecycle,
        json!({
            "type": "handshake",
            "protocolVersion": { "major": PROTOCOL_MAJOR, "minor": PROTOCOL_MINOR },
            "capabilities": CAPABILITIES,
            "binary": "rudder-process-host",
            "target": native_target(),
            "binaryVersion": env!("CARGO_PKG_VERSION"),
            "effectiveEngine": "rust",
        }),
    ) {
        return 1;
    }

    let started_at = Instant::now();
    let counters = Arc::new(Counters {
        bytes_read: AtomicU64::new(0),
        bytes_written: AtomicU64::new(0),
    });
    let mut active: Option<ActiveChild> = None;
    let mut stop_admitted = false;
    let mut failure_stop_sent = false;
    let mut listener_mismatch = false;
    let mut terminal_sent = false;
    let mut process_exit_code = 0;

    while !terminal_sent {
        let lifecycle_delivery_failed =
            lifecycle.failed.load(Ordering::Acquire) || lifecycle.sink.is_closed();
        let output_failed = active
            .as_ref()
            .is_some_and(|child| child.output_failed.load(Ordering::Acquire));
        if (lifecycle_delivery_failed || output_failed) && !failure_stop_sent {
            failure_stop_sent = true;
            if let Some(child) = active.as_mut() {
                if let Some(stdin) = child.interactive_stdin.as_mut() {
                    stdin.shutdown();
                }
                let _ = child.control.send(MonitorCommand::Stop { grace: None });
                stop_admitted = true;
            } else {
                process_exit_code = 1;
                break;
            }
        }

        if let Some(child) = active.as_mut() {
            interactive_stdin::drain_one_event(&lifecycle, child);
        }
        if let Some(event_result) = active.as_mut().map(|child| child.events.try_recv()) {
            match event_result {
                Ok(MonitorEvent::ListenerVerified { port }) => {
                    send(&lifecycle, json!({"type":"listener-verified","port":port}));
                }
                Ok(MonitorEvent::ListenerOwnerMismatch) => {
                    listener_mismatch = true;
                    if let Some(child) = active.as_ref() {
                        let _ = child.control.send(MonitorCommand::Stop { grace: None });
                    }
                }
                Ok(MonitorEvent::Exited {
                    code,
                    signal,
                    was_stopped,
                    cleanup_proven,
                    had_surviving_group,
                    stdin_error,
                }) => {
                    let stdin_writer_proven = active
                        .as_mut()
                        .map(|child| interactive_stdin::finish_after_exit(&lifecycle, child))
                        .unwrap_or(true);
                    let output_relay_proven = drain_output(active.as_ref());
                    send(
                        &lifecycle,
                        json!({
                            "type": "app-exit",
                            "code": code,
                            "signal": signal,
                        }),
                    );
                    if was_stopped && cleanup_proven {
                        send(&lifecycle, json!({"type":"stopped"}));
                    }
                    reject_queued_stdin_after_exit(&lifecycle, &input_rx);
                    let stdin_error = if stdin_writer_proven {
                        stdin_error
                    } else {
                        Some("stdin_writer_lost")
                    };
                    let cleanup_proven = cleanup_proven && stdin_writer_proven;
                    let (terminal_succeeded, error_code) = exit_outcome(
                        code,
                        was_stopped,
                        cleanup_proven,
                        had_surviving_group,
                        listener_mismatch,
                        output_relay_proven,
                        stdin_error,
                    );
                    let mut terminal = terminal_message(
                        if terminal_succeeded {
                            "succeeded"
                        } else {
                            "failed"
                        },
                        error_code,
                        cleanup_proven,
                        started_at,
                        &counters,
                    );
                    let receipt_written = persist_terminal(active.as_ref(), &mut terminal);
                    send(&lifecycle, terminal);
                    process_exit_code = if terminal_succeeded && receipt_written {
                        0
                    } else {
                        1
                    };
                    terminal_sent = true;
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    // The monitor owns the Child. On panic its unwind guard
                    // terminates and reaps that child before reporting whether
                    // cleanup was proven. Wait for that receipt before ending
                    // the host so it cannot leave an owned process group behind.
                    let process_cleanup_proven = active.as_mut().is_some_and(|child| {
                        child
                            .monitor_cleanup
                            .recv_timeout(child.monitor_cleanup_timeout)
                            .is_ok_and(|cleanup| cleanup.proven)
                    });
                    let stdin_writer_proven = active.as_mut().is_some_and(|child| {
                        interactive_stdin::finish_after_exit(&lifecycle, child)
                    });
                    let output_relay_proven = drain_output(active.as_ref());
                    let cleanup_proven =
                        process_cleanup_proven && stdin_writer_proven && output_relay_proven;
                    let mut terminal = terminal_message(
                        "failed",
                        Some("monitor_lost"),
                        cleanup_proven,
                        started_at,
                        &counters,
                    );
                    let _ = persist_terminal(active.as_ref(), &mut terminal);
                    send(&lifecycle, terminal);
                    process_exit_code = 1;
                    terminal_sent = true;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }

        if terminal_sent {
            break;
        }

        if lifecycle_delivery_failed || output_failed {
            thread::sleep(POLL_INTERVAL);
            continue;
        }

        match input_rx.recv_timeout(POLL_INTERVAL) {
            Ok(HostInput::Command(Command::Start {
                protocol_version,
                request_id,
                executable,
                argv,
                cwd,
                env,
                owner_token,
                port,
                runtime_root,
            })) => {
                let operation_id = request_id
                    .clone()
                    .unwrap_or_else(|| "local-app".to_string());
                if active.is_some() {
                    send_error(&lifecycle, "already_started");
                    continue;
                }
                let command = Command::Start {
                    protocol_version,
                    request_id,
                    executable,
                    argv,
                    cwd,
                    env,
                    owner_token,
                    port,
                    runtime_root,
                };
                set_request_id(
                    &lifecycle,
                    command_request_id(&command).unwrap_or_else(|| "local-app".to_string()),
                );
                if let Err(code) = command.validate() {
                    send_error(&lifecycle, code);
                    send(
                        &lifecycle,
                        terminal_message("failed", Some(code), false, started_at, &counters),
                    );
                    process_exit_code = 3;
                    terminal_sent = true;
                    continue;
                }
                let Command::Start {
                    protocol_version: _,
                    request_id: _,
                    executable,
                    argv,
                    cwd,
                    env,
                    owner_token,
                    port,
                    runtime_root,
                } = command
                else {
                    unreachable!();
                };
                let owner_token = owner_token.expect("validated owner token");
                let port = port.expect("validated port");
                let runtime_root = runtime_root.expect("validated runtime root");
                set_owner_token(&lifecycle, owner_token.clone());
                if let Err(code) = spawn_path_preflight(&executable, &cwd) {
                    send_error(&lifecycle, code);
                    send(
                        &lifecycle,
                        terminal_message("failed", Some(code), true, started_at, &counters),
                    );
                    process_exit_code = 1;
                    terminal_sent = true;
                    continue;
                }
                send(
                    &lifecycle,
                    json!({"type":"accepted","ownerToken":owner_token,"port":port}),
                );
                if lifecycle_failed(&lifecycle) {
                    process_exit_code = 1;
                    terminal_sent = true;
                    continue;
                }
                match spawn_child(
                    executable,
                    argv,
                    cwd,
                    env,
                    None,
                    stdout.clone(),
                    stderr.clone(),
                    lifecycle.clone(),
                    counters.clone(),
                    runtime_root,
                    owner_token.clone(),
                    operation_id,
                    Some(port),
                    "local_app_generation",
                    TERM_TIMEOUT,
                    false,
                    false,
                ) {
                    Ok((active_child, pid, pgid)) => {
                        active = Some(active_child);
                        send(
                            &lifecycle,
                            json!({"type":"spawned","pid":pid,"pgid":pgid,"ownerToken":owner_token}),
                        );
                    }
                    Err(error) => {
                        send_error(&lifecycle, error.code);
                        let mut terminal = terminal_message(
                            "failed",
                            Some(error.code),
                            error.cleanup_proven,
                            started_at,
                            &counters,
                        );
                        terminal["receiptWritten"] = Value::Bool(false);
                        send(&lifecycle, terminal);
                        process_exit_code = 1;
                        terminal_sent = true;
                    }
                }
            }
            Ok(HostInput::Command(Command::StartProcess {
                protocol_version,
                request_id,
                executable,
                argv,
                cwd,
                env,
                owner_token,
                runtime_root,
                stdin,
                interactive_stdin,
                grace_ms,
            })) => {
                let operation_id = request_id
                    .clone()
                    .unwrap_or_else(|| "agent-run".to_string());
                if active.is_some() {
                    send_error(&lifecycle, "already_started");
                    continue;
                }
                let command = Command::StartProcess {
                    protocol_version,
                    request_id,
                    executable,
                    argv,
                    cwd,
                    env,
                    owner_token,
                    runtime_root,
                    stdin,
                    interactive_stdin,
                    grace_ms,
                };
                set_request_id(
                    &lifecycle,
                    command_request_id(&command).unwrap_or_else(|| "agent-run".to_string()),
                );
                if let Err(code) = command.validate() {
                    send_error(&lifecycle, code);
                    send(
                        &lifecycle,
                        terminal_message("failed", Some(code), true, started_at, &counters),
                    );
                    process_exit_code = 3;
                    terminal_sent = true;
                    continue;
                }
                let Command::StartProcess {
                    executable,
                    argv,
                    cwd,
                    env,
                    owner_token,
                    runtime_root,
                    stdin,
                    interactive_stdin,
                    grace_ms,
                    ..
                } = command
                else {
                    unreachable!();
                };
                let owner_token = owner_token.expect("validated owner token");
                let runtime_root = runtime_root.expect("validated runtime root");
                set_owner_token(&lifecycle, owner_token.clone());
                let grace = Duration::from_millis(grace_ms.unwrap_or(2_000).clamp(1, 60_000));
                if let Err(code) = spawn_path_preflight(&executable, &cwd) {
                    let error = SpawnChildError::before_spawn(code);
                    send_error(&lifecycle, error.code);
                    let mut terminal = terminal_message(
                        "failed",
                        Some(error.code),
                        error.cleanup_proven,
                        started_at,
                        &counters,
                    );
                    if error.spawn_disposition == SpawnDisposition::NotStarted
                        && error.cleanup_proven
                    {
                        persist_pre_spawn_terminal(
                            &runtime_root,
                            &operation_id,
                            &owner_token,
                            &mut terminal,
                        );
                    } else {
                        terminal["receiptWritten"] = Value::Bool(false);
                    }
                    send(&lifecycle, terminal);
                    process_exit_code = 1;
                    terminal_sent = true;
                    continue;
                }
                send(
                    &lifecycle,
                    json!({"type":"accepted","ownerToken":owner_token,"mode":"process","outputTransport":"raw"}),
                );
                if lifecycle_failed(&lifecycle) {
                    process_exit_code = 1;
                    terminal_sent = true;
                    continue;
                }
                match spawn_child(
                    executable,
                    argv,
                    cwd,
                    env,
                    stdin,
                    stdout.clone(),
                    stderr.clone(),
                    lifecycle.clone(),
                    counters.clone(),
                    runtime_root.clone(),
                    owner_token.clone(),
                    operation_id.clone(),
                    None,
                    "agent_run_attempt",
                    grace,
                    interactive_stdin,
                    false,
                ) {
                    Ok((active_child, pid, pgid)) => {
                        active = Some(active_child);
                        if let Some(gate) =
                            active.as_ref().and_then(|child| child.output_gate.as_ref())
                        {
                            gate.store(true, Ordering::Release);
                        }
                        if std::env::var("RUDDER_PROCESS_HOST_TEST_AFTER_ACCEPT_FRAME")
                            .ok()
                            .as_deref()
                            == Some("unknown")
                        {
                            send(&lifecycle, json!({"type":"injected-unknown-frame"}));
                        }
                        send(
                            &lifecycle,
                            json!({"type":"spawned","pid":pid,"pgid":pgid,"ownerToken":owner_token,"mode":"process"}),
                        );
                    }
                    Err(error) => {
                        send_error(&lifecycle, error.code);
                        let mut terminal = terminal_message(
                            "failed",
                            Some(error.code),
                            error.cleanup_proven,
                            started_at,
                            &counters,
                        );
                        if error.spawn_disposition == SpawnDisposition::NotStarted
                            && error.cleanup_proven
                        {
                            persist_pre_spawn_terminal(
                                &runtime_root,
                                &operation_id,
                                &owner_token,
                                &mut terminal,
                            );
                        } else {
                            terminal["receiptWritten"] = Value::Bool(false);
                        }
                        send(&lifecycle, terminal);
                        process_exit_code = 1;
                        terminal_sent = true;
                    }
                }
            }
            Ok(HostInput::Command(command @ Command::WriteStdin { .. })) => {
                interactive_stdin::handle_write_command(&lifecycle, active.as_mut(), command);
            }
            Ok(HostInput::Command(command @ Command::CloseStdin { .. })) => {
                interactive_stdin::handle_close_command(&lifecycle, active.as_mut(), command);
            }
            Ok(HostInput::Command(Command::StartTerminal {
                protocol_version,
                request_id,
                executable,
                argv,
                cwd,
                env,
                owner_token,
                cols,
                rows,
            })) => {
                if active.is_some() {
                    send_error(&lifecycle, "already_started");
                    continue;
                }
                let command = Command::StartTerminal {
                    protocol_version,
                    request_id,
                    executable,
                    argv,
                    cwd,
                    env,
                    owner_token,
                    cols,
                    rows,
                };
                set_request_id(
                    &lifecycle,
                    command_request_id(&command).unwrap_or_else(|| "terminal".to_string()),
                );
                if let Err(code) = command.validate() {
                    send_error(&lifecycle, code);
                    send(
                        &lifecycle,
                        terminal_message("failed", Some(code), true, started_at, &counters),
                    );
                    process_exit_code = 3;
                    terminal_sent = true;
                    continue;
                }
                let Command::StartTerminal {
                    executable,
                    argv,
                    cwd,
                    env,
                    owner_token,
                    cols,
                    rows,
                    ..
                } = command
                else {
                    unreachable!()
                };
                let owner_token = owner_token.expect("validated owner token");
                set_owner_token(&lifecycle, owner_token.clone());
                send(
                    &lifecycle,
                    json!({"type":"accepted","ownerToken":owner_token,"mode":"pty"}),
                );
                if lifecycle_failed(&lifecycle) {
                    process_exit_code = 1;
                    terminal_sent = true;
                    continue;
                }
                match spawn_terminal(
                    executable,
                    argv,
                    cwd,
                    env,
                    cols,
                    rows,
                    stdout.clone(),
                    counters.clone(),
                ) {
                    Ok((active_child, pid)) => {
                        send(
                            &lifecycle,
                            json!({"type":"spawned","pid":pid,"ownerToken":owner_token,"mode":"pty"}),
                        );
                        active = Some(active_child);
                    }
                    Err(error) => {
                        send_error(&lifecycle, error.code);
                        send(
                            &lifecycle,
                            terminal_message(
                                "failed",
                                Some(error.code),
                                error.cleanup_proven,
                                started_at,
                                &counters,
                            ),
                        );
                        process_exit_code = 1;
                        terminal_sent = true;
                    }
                }
            }
            Ok(HostInput::Command(ref command @ Command::Input { ref data, .. })) => {
                set_request_id(
                    &lifecycle,
                    command_request_id(command).unwrap_or_else(|| "terminal".to_string()),
                );
                if let Err(code) = command.validate() {
                    send_error(&lifecycle, code);
                    continue;
                }
                if let Some(child) = active.as_ref() {
                    let _ = child
                        .control
                        .send(MonitorCommand::Input(data.as_bytes().to_vec()));
                } else {
                    send_error(&lifecycle, "not_started");
                }
            }
            Ok(HostInput::Command(ref command @ Command::Resize { cols, rows, .. })) => {
                set_request_id(
                    &lifecycle,
                    command_request_id(command).unwrap_or_else(|| "terminal".to_string()),
                );
                if let Err(code) = command.validate() {
                    send_error(&lifecycle, code);
                    continue;
                }
                if let Some(child) = active.as_ref() {
                    let _ = child.control.send(MonitorCommand::Resize { cols, rows });
                } else {
                    send_error(&lifecycle, "not_started");
                }
            }
            Ok(HostInput::Command(ref command @ Command::Stop { grace_ms, .. })) => {
                set_request_id(
                    &lifecycle,
                    command_request_id(command).unwrap_or_else(|| "local-app".to_string()),
                );
                if let Err(code) = command.validate() {
                    send_error(&lifecycle, code);
                    send(
                        &lifecycle,
                        terminal_message("failed", Some(code), false, started_at, &counters),
                    );
                    process_exit_code = 2;
                    terminal_sent = true;
                    continue;
                }
                if let Some(child) = active.as_mut() {
                    if let Some(stdin) = child.interactive_stdin.as_mut() {
                        stdin.shutdown();
                    }
                    if !stop_admitted {
                        stop_admitted = true;
                        send(&lifecycle, json!({"type":"stop-accepted"}));
                    }
                    let _ = child.control.send(MonitorCommand::Stop {
                        grace: grace_ms.map(|value| Duration::from_millis(value.clamp(1, 60_000))),
                    });
                } else {
                    send(
                        &lifecycle,
                        terminal_message(
                            "failed",
                            Some("not_started"),
                            false,
                            started_at,
                            &counters,
                        ),
                    );
                    process_exit_code = 1;
                    terminal_sent = true;
                }
            }
            Ok(HostInput::Invalid(code)) => {
                if let Some(child) = active.as_mut() {
                    if let Some(stdin) = child.interactive_stdin.as_mut() {
                        stdin.shutdown();
                    }
                    let _ = child.control.send(MonitorCommand::Stop { grace: None });
                }
                send_error(&lifecycle, code);
                send(
                    &lifecycle,
                    terminal_message("failed", Some(code), false, started_at, &counters),
                );
                process_exit_code = 2;
                terminal_sent = true;
            }
            Ok(HostInput::Eof) => {
                if let Some(child) = active.as_mut() {
                    if let Some(stdin) = child.interactive_stdin.as_mut() {
                        stdin.shutdown();
                    }
                    let _ = child.control.send(MonitorCommand::Stop { grace: None });
                } else {
                    send(
                        &lifecycle,
                        terminal_message("succeeded", None, true, started_at, &counters),
                    );
                    terminal_sent = true;
                }
            }
            #[cfg(test)]
            Ok(HostInput::PanicMonitor) => {
                if let Some(child) = active.as_ref()
                    && child.identity.is_some()
                {
                    let _ = child.control.send(MonitorCommand::PanicForTest);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(child) = active.as_mut() {
                    if let Some(stdin) = child.interactive_stdin.as_mut() {
                        stdin.shutdown();
                    }
                    let _ = child.control.send(MonitorCommand::Stop { grace: None });
                } else {
                    send(
                        &lifecycle,
                        terminal_message("succeeded", None, true, started_at, &counters),
                    );
                    terminal_sent = true;
                }
            }
        }
    }

    let _ = stdout.lock().map(|mut writer| writer.flush());
    let _ = stderr.lock().map(|mut writer| writer.flush());
    if lifecycle.failed.load(Ordering::Acquire) || lifecycle.sink.is_closed() {
        1
    } else {
        process_exit_code
    }
}

fn lifecycle_failed(writer: &Lifecycle) -> bool {
    writer.failed.load(Ordering::Acquire) || writer.sink.is_closed()
}

fn send(writer: &Lifecycle, value: Value) -> bool {
    let mut value = value;
    if let Some(object) = value.as_object_mut() {
        object
            .entry("protocolVersion")
            .or_insert_with(|| json!({ "major": PROTOCOL_MAJOR, "minor": PROTOCOL_MINOR }));
        let request_id = writer
            .request_id
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "bootstrap".to_string());
        object
            .entry("requestId")
            .or_insert_with(|| json!(request_id));
        if let Some(owner_token) = writer
            .owner_token
            .lock()
            .ok()
            .and_then(|value| value.clone())
        {
            object
                .entry("ownerToken")
                .or_insert_with(|| json!(owner_token));
        }
    }
    let result = writer.sink.emit(LifecycleEvent { value });
    if result.is_err() {
        writer.failed.store(true, Ordering::Release);
        false
    } else {
        true
    }
}

fn set_request_id(writer: &Lifecycle, request_id: String) {
    if let Ok(mut current) = writer.request_id.lock() {
        *current = request_id;
    }
}

fn set_owner_token(writer: &Lifecycle, owner_token: String) {
    if let Ok(mut current) = writer.owner_token.lock() {
        *current = Some(owner_token);
    }
}

fn command_request_id(command: &Command) -> Option<String> {
    match command {
        Command::Start { request_id, .. }
        | Command::StartProcess { request_id, .. }
        | Command::WriteStdin { request_id, .. }
        | Command::CloseStdin { request_id, .. }
        | Command::StartTerminal { request_id, .. }
        | Command::Input { request_id, .. }
        | Command::Resize { request_id, .. }
        | Command::Stop { request_id, .. } => request_id.clone(),
    }
}

fn send_error(writer: &Lifecycle, code: &'static str) {
    send(
        writer,
        json!({"type":"error","errorCode":code,"message":code}),
    );
}

fn metrics(started_at: Instant, counters: &Counters) -> Value {
    let bytes_read = counters.bytes_read.load(Ordering::Relaxed);
    let bytes_written = counters.bytes_written.load(Ordering::Relaxed);
    json!({
        "elapsedMs": started_at.elapsed().as_millis(),
        "bytesRead": bytes_read,
        "bytesWritten": bytes_written,
        "peakBufferedBytes": 0,
    })
}

fn terminal_message(
    status: &str,
    error_code: Option<&str>,
    cleanup_proven: bool,
    started_at: Instant,
    counters: &Counters,
) -> Value {
    let mut message = json!({"type":"terminal","status":status,"cleanupProven":cleanup_proven,"metrics":metrics(started_at,counters)});
    if let Some(code) = error_code {
        message["errorCode"] = Value::String(code.to_string());
        message["message"] = Value::String(code.to_string());
    }
    message
}

fn drain_output(child: Option<&ActiveChild>) -> bool {
    let mut proven = true;
    if let Some(child) = child {
        for done in &child.output_done {
            proven &= matches!(done.recv_timeout(TERM_TIMEOUT), Ok(true));
        }
    }
    proven
}

/// Replies to stdin commands already waiting when the child has exited. The
/// input channel is bounded by its caller; the fixed cap also bounds teardown
/// if a producer races the terminal transition.
fn reject_queued_stdin_after_exit(lifecycle: &Lifecycle, input_rx: &mpsc::Receiver<HostInput>) {
    for _ in 0..MAX_TERMINAL_STDIN_REJECTIONS {
        match input_rx.try_recv() {
            Ok(HostInput::Command(command @ Command::WriteStdin { .. })) => {
                interactive_stdin::handle_write_command(lifecycle, None, command);
            }
            Ok(HostInput::Command(command @ Command::CloseStdin { .. })) => {
                interactive_stdin::handle_close_command(lifecycle, None, command);
            }
            Ok(_) => {}
            Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => break,
        }
    }
}

fn exit_outcome(
    code: Option<i32>,
    stopped: bool,
    cleanup: bool,
    surviving_group: bool,
    listener_mismatch: bool,
    relay_proven: bool,
    stdin_error: Option<&'static str>,
) -> (bool, Option<&'static str>) {
    let error = if listener_mismatch {
        Some("listener_owner_mismatch")
    } else if !cleanup {
        Some("process_group_cleanup_unproven")
    } else if !relay_proven {
        Some("output_relay_failed")
    } else if stdin_error.is_some() {
        stdin_error
    } else if surviving_group && !stopped {
        Some("descendant_cleanup")
    } else if stopped || code == Some(0) {
        None
    } else {
        Some("child_exit")
    };
    (error.is_none(), error)
}

fn persist_terminal(child: Option<&ActiveChild>, terminal: &mut Value) -> bool {
    terminal["receiptWritten"] = Value::Bool(true);
    let written = child
        .and_then(|child| child.evidence.as_ref())
        .is_none_or(|evidence| evidence.write_terminal(terminal).is_ok());
    if !written {
        terminal["status"] = json!("failed");
        terminal["errorCode"] = json!("receipt_write_failed");
        terminal["message"] = json!("receipt_write_failed");
        terminal["receiptWritten"] = Value::Bool(false);
    }
    written
}

/// Persist an exact owner/request receipt when StartProcess is proven not to
/// have created a child. The receipt contains no invented process identity.
/// If the runtime root cannot be durably written, keep receiptWritten false so
/// OwnedHost will not mint cleanup proof from the lifecycle terminal alone.
fn persist_pre_spawn_terminal(
    runtime_root: &str,
    request_id: &str,
    owner_token: &str,
    terminal: &mut Value,
) -> bool {
    terminal["receiptWritten"] = Value::Bool(false);
    let Ok(evidence) = PreSpawnOperationEvidence::create(
        Path::new(runtime_root),
        request_id.to_owned(),
        owner_token.to_owned(),
    ) else {
        return false;
    };
    evidence.write_terminal(terminal)
}

#[cfg(all(test, unix))]
#[path = "interactive_stdin/host_tests.rs"]
mod host_tests;
