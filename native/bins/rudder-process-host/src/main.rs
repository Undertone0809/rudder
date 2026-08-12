use rudder_native_protocol::{
    CAPABILITIES, Command, PROTOCOL_MAJOR, PROTOCOL_MINOR, PROTOCOL_VERSION,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const TERM_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_FRAME_BYTES: usize = 64 * 1024;

struct LifecycleWriter {
    writer: Mutex<BufWriter<Box<dyn Write + Send>>>,
    request_id: Mutex<String>,
    owner_token: Mutex<Option<String>>,
}

type Lifecycle = Arc<LifecycleWriter>;
type RawOutput = Arc<Mutex<BufWriter<Box<dyn Write + Send>>>>;

enum Input {
    Command(Command),
    Invalid(&'static str),
    Eof,
}

enum MainEvent {
    Input(Input),
    Monitor(MonitorEvent),
}

enum MonitorCommand {
    Stop,
}

enum MonitorEvent {
    ListenerVerified {
        port: u16,
    },
    ListenerOwnerMismatch,
    Exited {
        status: ExitStatus,
        was_stopped: bool,
        listener_owner_mismatch: bool,
        cleanup_proven: bool,
        had_surviving_group: bool,
    },
}

enum ListenerOwnership {
    NotListening,
    Owned,
    Foreign,
}

struct Counters {
    bytes_read: AtomicU64,
    bytes_written: AtomicU64,
}

struct ActiveChild {
    control: mpsc::Sender<MonitorCommand>,
    output_done: Vec<mpsc::Receiver<bool>>,
    evidence: Arc<OperationEvidence>,
}

struct SpawnSpec {
    executable: String,
    argv: Vec<String>,
    cwd: String,
    env: BTreeMap<String, String>,
    owner_token: String,
    port: u16,
    runtime_root: PathBuf,
}

struct OperationEvidence {
    operation_root: PathBuf,
    terminal_path: PathBuf,
    index: Mutex<BufWriter<File>>,
    sequence: AtomicU64,
    stdout_offset: AtomicU64,
    stderr_offset: AtomicU64,
    owner_token: String,
    child_pid: u32,
    process_group: u32,
    port: u16,
}

impl OperationEvidence {
    fn create(
        runtime_root: &Path,
        owner_token: String,
        child_pid: u32,
        process_group: u32,
        port: u16,
    ) -> Result<Arc<Self>, &'static str> {
        let canonical_root =
            fs::canonicalize(runtime_root).map_err(|_| "runtime_root_unavailable")?;
        if !canonical_root.is_dir() {
            return Err("runtime_root_unavailable");
        }
        let operation_root = canonical_root.join(&owner_token);
        fs::create_dir(&operation_root).map_err(|_| "operation_root_unavailable")?;
        let canonical_operation =
            fs::canonicalize(&operation_root).map_err(|_| "operation_root_unavailable")?;
        if !canonical_operation.starts_with(&canonical_root) {
            return Err("unsafe_operation_root");
        }
        let index_path = canonical_operation.join("output-index.jsonl");
        let index = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&index_path)
            .map_err(|_| "output_index_unavailable")?;
        let evidence = Arc::new(Self {
            terminal_path: canonical_operation.join("terminal-receipt.json"),
            operation_root: canonical_operation,
            index: Mutex::new(BufWriter::new(index)),
            sequence: AtomicU64::new(0),
            stdout_offset: AtomicU64::new(0),
            stderr_offset: AtomicU64::new(0),
            owner_token,
            child_pid,
            process_group,
            port,
        });
        evidence.write_owner_descriptor()?;
        Ok(evidence)
    }

    fn write_owner_descriptor(&self) -> Result<(), &'static str> {
        atomic_json(
            &self.operation_root.join("owner-descriptor.json"),
            &json!({
                "protocolVersion":{"major":PROTOCOL_MAJOR,"minor":PROTOCOL_MINOR},
                "ownerKind":"local_app_generation",
                "opaqueOwnerToken":self.owner_token,
                "hostPid":std::process::id(),
                "childPid":self.child_pid,
                "platformOwnerIdentity":format!("process-group:{}",self.process_group),
                "port":self.port,
                "outputIndexPath":"output-index.jsonl",
                "terminalReceiptPath":"terminal-receipt.json"
            }),
        )
    }

    fn record_output(&self, stream: &str, bytes: &[u8]) -> Result<(), &'static str> {
        let offset = match stream {
            "stdout" => self
                .stdout_offset
                .fetch_add(bytes.len() as u64, Ordering::SeqCst),
            "stderr" => self
                .stderr_offset
                .fetch_add(bytes.len() as u64, Ordering::SeqCst),
            _ => return Err("invalid_output_stream"),
        };
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst);
        let digest = format!("{:x}", Sha256::digest(bytes));
        let mut index = self.index.lock().map_err(|_| "output_index_unavailable")?;
        serde_json::to_writer(
            &mut *index,
            &json!({"sequence":sequence,"stream":stream,"offset":offset,"length":bytes.len(),"sha256":digest}),
        )
        .map_err(|_| "output_index_unavailable")?;
        index
            .write_all(b"\n")
            .map_err(|_| "output_index_unavailable")?;
        index.flush().map_err(|_| "output_index_unavailable")
    }

    fn write_terminal(&self, terminal: &Value) -> Result<(), &'static str> {
        self.index
            .lock()
            .map_err(|_| "output_index_unavailable")?
            .flush()
            .map_err(|_| "output_index_unavailable")?;
        atomic_json(
            &self.terminal_path,
            &json!({
                "protocolVersion":{"major":PROTOCOL_MAJOR,"minor":PROTOCOL_MINOR},
                "opaqueOwnerToken":self.owner_token,
                "childPid":self.child_pid,
                "processGroup":self.process_group,
                "port":self.port,
                "terminal":terminal
            }),
        )
    }
}

fn atomic_json(path: &Path, value: &Value) -> Result<(), &'static str> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("receipt_write_failed")?;
    let temporary = path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| "receipt_write_failed")?;
    serde_json::to_writer(&mut file, value).map_err(|_| "receipt_write_failed")?;
    file.write_all(b"\n").map_err(|_| "receipt_write_failed")?;
    file.sync_all().map_err(|_| "receipt_write_failed")?;
    fs::rename(&temporary, path).map_err(|_| "receipt_write_failed")?;
    if let Some(parent) = path.parent() {
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "receipt_write_failed")?;
    }
    Ok(())
}

fn main() {
    if handle_metadata_args() {
        return;
    }

    let lifecycle = match lifecycle_writer() {
        Ok(writer) => writer,
        Err(error) => {
            eprintln!("rudder-process-host: lifecycle channel unavailable: {error}");
            std::process::exit(2);
        }
    };
    let stdout = match raw_output_writer(4) {
        Ok(writer) => writer,
        Err(error) => {
            send(
                &lifecycle,
                json!({"type":"terminal","status":"failed","errorCode":"channel_unavailable","message":"stdout channel unavailable","metrics":empty_metrics()}),
            );
            eprintln!("rudder-process-host: stdout channel unavailable: {error}");
            std::process::exit(1);
        }
    };
    let stderr = match raw_output_writer(5) {
        Ok(writer) => writer,
        Err(error) => {
            send(
                &lifecycle,
                json!({"type":"terminal","status":"failed","errorCode":"channel_unavailable","message":"stderr channel unavailable","metrics":empty_metrics()}),
            );
            eprintln!("rudder-process-host: stderr channel unavailable: {error}");
            std::process::exit(1);
        }
    };

    send(
        &lifecycle,
        json!({
            "type": "handshake",
            "protocolVersion": { "major": PROTOCOL_MAJOR, "minor": PROTOCOL_MINOR },
            "capabilities": CAPABILITIES,
            "binary": "rudder-process-host",
        }),
    );

    let (event_tx, event_rx) = mpsc::channel();
    let input_tx = event_tx.clone();
    thread::spawn(move || read_commands(input_tx));

    let started_at = Instant::now();
    let counters = Arc::new(Counters {
        bytes_read: AtomicU64::new(0),
        bytes_written: AtomicU64::new(0),
    });
    let mut active: Option<ActiveChild> = None;
    let mut stop_admitted = false;
    let mut terminal_sent = false;
    let mut process_exit_code = 0;

    while !terminal_sent {
        match event_rx.recv() {
            Ok(MainEvent::Monitor(event)) => match event {
                MonitorEvent::ListenerVerified { port } => {
                    send(&lifecycle, json!({"type":"listener-verified","port":port}));
                }
                MonitorEvent::ListenerOwnerMismatch => {
                    if let Some(child) = active.as_ref() {
                        let _ = child.control.send(MonitorCommand::Stop);
                    }
                }
                MonitorEvent::Exited {
                    status,
                    was_stopped,
                    listener_owner_mismatch,
                    cleanup_proven,
                    had_surviving_group,
                } => {
                    let mut output_relay_proven = true;
                    if let Some(child) = active.as_ref() {
                        for output_done in &child.output_done {
                            output_relay_proven &=
                                matches!(output_done.recv_timeout(TERM_TIMEOUT), Ok(true));
                        }
                    }
                    let code = status.code();
                    send(
                        &lifecycle,
                        json!({
                            "type": "app-exit",
                            "code": code,
                            "signal": signal_name(&status),
                        }),
                    );
                    if was_stopped && cleanup_proven && !listener_owner_mismatch {
                        send(&lifecycle, json!({"type":"stopped"}));
                    }
                    let terminal_succeeded = cleanup_proven
                        && output_relay_proven
                        && !listener_owner_mismatch
                        && (was_stopped || (code == Some(0) && !had_surviving_group));
                    let error_code = if listener_owner_mismatch {
                        Some("listener_owner_mismatch")
                    } else if !cleanup_proven {
                        Some("process_group_cleanup_unproven")
                    } else if !output_relay_proven {
                        Some("output_relay_failed")
                    } else if had_surviving_group {
                        Some("descendant_cleanup")
                    } else if was_stopped || code == Some(0) {
                        None
                    } else {
                        Some("child_exit")
                    };
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
                    terminal["receiptWritten"] = Value::Bool(true);
                    let receipt_written = active
                        .as_ref()
                        .is_some_and(|child| child.evidence.write_terminal(&terminal).is_ok());
                    if !receipt_written {
                        terminal = terminal_message(
                            "failed",
                            Some("receipt_write_failed"),
                            cleanup_proven,
                            started_at,
                            &counters,
                        );
                        terminal["receiptWritten"] = Value::Bool(false);
                    }
                    send(&lifecycle, terminal);
                    process_exit_code = if terminal_succeeded && receipt_written {
                        0
                    } else {
                        1
                    };
                    terminal_sent = true;
                }
            },
            Ok(MainEvent::Input(Input::Command(Command::Start {
                protocol_version,
                request_id,
                executable,
                argv,
                cwd,
                env,
                owner_token,
                port,
                runtime_root,
            }))) => {
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
                send(
                    &lifecycle,
                    json!({"type":"accepted","ownerToken":owner_token,"port":port}),
                );
                match spawn_child(
                    SpawnSpec {
                        executable,
                        argv,
                        cwd,
                        env,
                        owner_token: owner_token.clone(),
                        port,
                        runtime_root: PathBuf::from(runtime_root),
                    },
                    stdout.clone(),
                    stderr.clone(),
                    counters.clone(),
                    event_tx.clone(),
                ) {
                    Ok((active_child, pid, pgid)) => {
                        send(
                            &lifecycle,
                            json!({"type":"spawned","pid":pid,"pgid":pgid,"ownerToken":owner_token}),
                        );
                        active = Some(active_child);
                    }
                    Err(error) => {
                        send_error(&lifecycle, error);
                        send(
                            &lifecycle,
                            terminal_message(
                                "failed",
                                Some("spawn_failed"),
                                false,
                                started_at,
                                &counters,
                            ),
                        );
                        process_exit_code = 1;
                        terminal_sent = true;
                    }
                }
            }
            Ok(MainEvent::Input(Input::Command(command @ Command::Stop { .. }))) => {
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
                    process_exit_code = 2;
                    terminal_sent = true;
                    continue;
                }
                if let Some(child) = active.as_ref() {
                    if !stop_admitted {
                        stop_admitted = true;
                        send(&lifecycle, json!({"type":"stop-accepted"}));
                        let _ = child.control.send(MonitorCommand::Stop);
                    }
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
            Ok(MainEvent::Input(Input::Invalid(code))) => {
                send_error(&lifecycle, code);
                send(
                    &lifecycle,
                    terminal_message("failed", Some(code), false, started_at, &counters),
                );
                process_exit_code = 2;
                terminal_sent = true;
            }
            Ok(MainEvent::Input(Input::Eof)) => {
                if let Some(child) = active.as_ref() {
                    let _ = child.control.send(MonitorCommand::Stop);
                } else {
                    send(
                        &lifecycle,
                        terminal_message("succeeded", None, true, started_at, &counters),
                    );
                    terminal_sent = true;
                }
            }
            Err(_) => {
                if let Some(child) = active.as_ref() {
                    let _ = child.control.send(MonitorCommand::Stop);
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

    let _ = lifecycle.writer.lock().map(|mut writer| writer.flush());
    std::process::exit(process_exit_code);
}

fn handle_metadata_args() -> bool {
    let argument = std::env::args().nth(1);
    match argument.as_deref() {
        Some("--version") => {
            println!("rudder-process-host {}", env!("CARGO_PKG_VERSION"));
            true
        }
        Some("--protocol-version") => {
            println!("{PROTOCOL_VERSION}");
            true
        }
        Some("--capabilities") => {
            println!(
                "{}",
                serde_json::to_string(CAPABILITIES).expect("static capabilities serialize")
            );
            true
        }
        _ => false,
    }
}

fn read_commands(sender: mpsc::Sender<MainEvent>) {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    loop {
        match read_bounded_frame(&mut reader) {
            Ok(Some(frame)) => match serde_json::from_slice::<Command>(&frame) {
                Ok(command) => {
                    if sender
                        .send(MainEvent::Input(Input::Command(command)))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(_) => {
                    let _ = sender.send(MainEvent::Input(Input::Invalid("invalid_command")));
                    return;
                }
            },
            Err(FrameError::TooLarge) => {
                let _ = sender.send(MainEvent::Input(Input::Invalid("command_too_large")));
                return;
            }
            Err(FrameError::Io) => {
                let _ = sender.send(MainEvent::Input(Input::Invalid("command_read_failed")));
                return;
            }
            Ok(None) => break,
        }
    }
    let _ = sender.send(MainEvent::Input(Input::Eof));
}

enum FrameError {
    TooLarge,
    Io,
}

fn read_bounded_frame(reader: &mut impl Read) -> Result<Option<Vec<u8>>, FrameError> {
    let mut frame = Vec::with_capacity(MAX_FRAME_BYTES.min(1024));
    let mut byte = [0_u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) if frame.is_empty() => return Ok(None),
            Ok(0) => return Err(FrameError::Io),
            Ok(1) if byte[0] == b'\n' => {
                if frame.last() == Some(&b'\r') {
                    frame.pop();
                }
                return Ok(Some(frame));
            }
            Ok(1) => {
                if frame.len() >= MAX_FRAME_BYTES {
                    return Err(FrameError::TooLarge);
                }
                frame.push(byte[0]);
            }
            Ok(_) => unreachable!(),
            Err(_) => return Err(FrameError::Io),
        }
    }
}

fn spawn_child(
    spec: SpawnSpec,
    stdout: RawOutput,
    stderr: RawOutput,
    counters: Arc<Counters>,
    events: mpsc::Sender<MainEvent>,
) -> Result<(ActiveChild, u32, u32), &'static str> {
    if !Path::new(&spec.executable).exists() || !Path::new(&spec.cwd).is_dir() {
        return Err("launch_path_unavailable");
    }
    let mut command = ProcessCommand::new(spec.executable);
    command
        .args(spec.argv)
        .current_dir(spec.cwd)
        .env_clear()
        .envs(spec.env);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| "spawn_failed")?;
    let pid = child.id();
    let pgid = pid;
    let evidence =
        match OperationEvidence::create(&spec.runtime_root, spec.owner_token, pid, pgid, spec.port)
        {
            Ok(evidence) => evidence,
            Err(error) => {
                let _ = terminate_owned_process(&mut child, pgid);
                return Err(error);
            }
        };
    let child_stdout = child.stdout.take().ok_or("stdout_unavailable")?;
    let child_stderr = child.stderr.take().ok_or("stderr_unavailable")?;
    let stdout_done = relay(
        child_stdout,
        stdout,
        counters.clone(),
        evidence.clone(),
        "stdout",
    );
    let stderr_done = relay(
        child_stderr,
        stderr,
        counters.clone(),
        evidence.clone(),
        "stderr",
    );

    let (control_tx, control_rx) = mpsc::channel();
    thread::spawn(move || monitor_child(&mut child, control_rx, events, pgid, spec.port));
    Ok((
        ActiveChild {
            control: control_tx,
            output_done: vec![stdout_done, stderr_done],
            evidence,
        },
        pid,
        pgid,
    ))
}

fn relay<R: Read + Send + 'static>(
    mut input: R,
    output: RawOutput,
    counters: Arc<Counters>,
    evidence: Arc<OperationEvidence>,
    stream: &'static str,
) -> mpsc::Receiver<bool> {
    let (done_tx, done_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buffer = [0_u8; 16 * 1024];
        let mut successful = true;
        loop {
            let read = match input.read(&mut buffer) {
                Ok(0) => break,
                Err(_) => {
                    successful = false;
                    break;
                }
                Ok(read) => read,
            };
            counters
                .bytes_read
                .fetch_add(read as u64, Ordering::Relaxed);
            if evidence.record_output(stream, &buffer[..read]).is_err() {
                successful = false;
                break;
            }
            let Ok(mut writer) = output.lock() else {
                successful = false;
                break;
            };
            if writer.write_all(&buffer[..read]).is_err() || writer.flush().is_err() {
                successful = false;
                break;
            }
            counters
                .bytes_written
                .fetch_add(read as u64, Ordering::Relaxed);
        }
        let _ = done_tx.send(successful);
    });
    done_rx
}

fn monitor_child(
    child: &mut Child,
    control: mpsc::Receiver<MonitorCommand>,
    events: mpsc::Sender<MainEvent>,
    pgid: u32,
    port: u16,
) {
    let mut stopping = false;
    let mut listener_owner_mismatch = false;
    let mut cleanup = None;
    let mut listener_verified = false;
    loop {
        if matches!(control.try_recv(), Ok(MonitorCommand::Stop)) {
            stopping = true;
            cleanup = Some(terminate_owned_process(child, pgid));
        }
        if !stopping && !listener_verified {
            match listener_owned_by_process_group(port, pgid) {
                Ok(ListenerOwnership::Owned) => {
                    listener_verified = true;
                    let _ =
                        events.send(MainEvent::Monitor(MonitorEvent::ListenerVerified { port }));
                }
                Ok(ListenerOwnership::Foreign) => {
                    stopping = true;
                    listener_owner_mismatch = true;
                    cleanup = Some(terminate_owned_process(child, pgid));
                    let _ = events.send(MainEvent::Monitor(MonitorEvent::ListenerOwnerMismatch));
                }
                Ok(ListenerOwnership::NotListening) | Err(_) => {}
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let cleanup = cleanup.unwrap_or_else(|| cleanup_after_child_exit(pgid));
                let _ = events.send(MainEvent::Monitor(MonitorEvent::Exited {
                    status,
                    was_stopped: stopping,
                    listener_owner_mismatch,
                    cleanup_proven: cleanup.proven,
                    had_surviving_group: cleanup.had_surviving_group,
                }));
                return;
            }
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(_) => {
                let cleanup = cleanup.unwrap_or_else(|| cleanup_after_child_exit(pgid));
                let _ = events.send(MainEvent::Monitor(MonitorEvent::Exited {
                    status: synthetic_failure_status(),
                    was_stopped: stopping,
                    listener_owner_mismatch,
                    cleanup_proven: cleanup.proven,
                    had_surviving_group: cleanup.had_surviving_group,
                }));
                return;
            }
        }
    }
}

fn listener_owned_by_process_group(port: u16, expected_pgid: u32) -> io::Result<ListenerOwnership> {
    #[cfg(target_os = "macos")]
    {
        let output = ProcessCommand::new("/usr/sbin/lsof")
            .args(["-nP", "-Fpg", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
            .output()?;
        if !output.status.success() && output.stdout.is_empty() {
            return Ok(ListenerOwnership::NotListening);
        }
        let mut pids = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some(pid) = line
                .strip_prefix('p')
                .and_then(|value| value.parse::<u32>().ok())
            {
                pids.push(pid);
            }
        }
        if pids.is_empty() {
            return Ok(ListenerOwnership::NotListening);
        }
        for pid in pids {
            let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
            if pgid < 0 || pgid as u32 != expected_pgid {
                return Ok(ListenerOwnership::Foreign);
            }
        }
        Ok(ListenerOwnership::Owned)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (port, expected_pgid);
        Ok(ListenerOwnership::NotListening)
    }
}

struct CleanupResult {
    proven: bool,
    had_surviving_group: bool,
}

fn terminate_owned_process(child: &mut Child, pgid: u32) -> CleanupResult {
    #[cfg(unix)]
    {
        if process_group_exists(pgid).unwrap_or(true) {
            unsafe {
                libc::kill(-(pgid as libc::pid_t), libc::SIGTERM);
            }
        }
        let deadline = Instant::now() + TERM_TIMEOUT;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            thread::sleep(POLL_INTERVAL);
        }
        if matches!(child.try_wait(), Ok(None)) {
            unsafe {
                libc::kill(-(pgid as libc::pid_t), libc::SIGKILL);
            }
        }
        let _ = child.wait();
        wait_for_process_group_cleanup(pgid, true)
    }
    #[cfg(windows)]
    {
        let _ = child.kill();
        let _ = child.wait();
        return CleanupResult {
            proven: true,
            had_surviving_group: false,
        };
    }
}

fn cleanup_after_child_exit(pgid: u32) -> CleanupResult {
    #[cfg(unix)]
    {
        let group_exists = process_group_exists(pgid).unwrap_or(true);
        if group_exists {
            unsafe {
                libc::kill(-(pgid as libc::pid_t), libc::SIGTERM);
            }
        }
        wait_for_process_group_cleanup(pgid, group_exists)
    }
    #[cfg(windows)]
    {
        let _ = pgid;
        CleanupResult {
            proven: true,
            had_surviving_group: false,
        }
    }
}

#[cfg(unix)]
fn process_group_exists(pgid: u32) -> io::Result<bool> {
    let result = unsafe { libc::kill(-(pgid as libc::pid_t), 0) };
    if result == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error() {
        Some(code) if code == libc::ESRCH => Ok(false),
        Some(code) if code == libc::EPERM => Ok(true),
        _ => Err(error),
    }
}

#[cfg(unix)]
fn wait_for_process_group_cleanup(pgid: u32, had_surviving_group: bool) -> CleanupResult {
    let deadline = Instant::now() + TERM_TIMEOUT;
    while Instant::now() < deadline {
        match process_group_exists(pgid) {
            Ok(false) => {
                return CleanupResult {
                    proven: true,
                    had_surviving_group,
                };
            }
            Ok(true) => thread::sleep(POLL_INTERVAL),
            Err(_) => {
                return CleanupResult {
                    proven: false,
                    had_surviving_group,
                };
            }
        }
    }
    if process_group_exists(pgid).unwrap_or(true) {
        unsafe {
            libc::kill(-(pgid as libc::pid_t), libc::SIGKILL);
        }
        let kill_deadline = Instant::now() + TERM_TIMEOUT;
        while Instant::now() < kill_deadline {
            match process_group_exists(pgid) {
                Ok(false) => {
                    return CleanupResult {
                        proven: true,
                        had_surviving_group,
                    };
                }
                Ok(true) => thread::sleep(POLL_INTERVAL),
                Err(_) => break,
            }
        }
    }
    CleanupResult {
        proven: !process_group_exists(pgid).unwrap_or(true),
        had_surviving_group,
    }
}

fn synthetic_failure_status() -> ExitStatus {
    // A monitor failure cannot provide a real child status. The process host
    // reports the failure through its terminal frame; this value only keeps
    // the event shape total on platforms where ExitStatus cannot be built.
    ProcessCommand::new(if cfg!(windows) { "cmd" } else { "/bin/false" })
        .status()
        .expect("system failure command must be available")
}

fn lifecycle_writer() -> io::Result<Lifecycle> {
    Ok(Arc::new(LifecycleWriter {
        writer: Mutex::new(BufWriter::new(
            Box::new(unsafe_fd(3)?) as Box<dyn Write + Send>
        )),
        request_id: Mutex::new("bootstrap".to_string()),
        owner_token: Mutex::new(None),
    }))
}

fn raw_output_writer(fd: i32) -> io::Result<RawOutput> {
    Ok(Arc::new(Mutex::new(BufWriter::new(
        Box::new(unsafe_fd(fd)?) as Box<dyn Write + Send>,
    ))))
}

#[cfg(unix)]
fn unsafe_fd(fd: i32) -> io::Result<std::fs::File> {
    use std::os::fd::FromRawFd;
    // The parent owns these inherited descriptors and closes them when the
    // host exits. File::from_raw_fd transfers that ownership to this process.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(windows)]
fn unsafe_fd(fd: i32) -> io::Result<std::fs::File> {
    use std::os::windows::io::FromRawHandle;
    Ok(unsafe { std::fs::File::from_raw_handle(fd as *mut std::ffi::c_void) })
}

fn send(writer: &Lifecycle, value: Value) {
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
    if let Ok(mut output) = writer.writer.lock() {
        let _ = serde_json::to_writer(&mut *output, &value);
        let _ = output.write_all(b"\n");
        let _ = output.flush();
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
        Command::Start { request_id, .. } | Command::Stop { request_id, .. } => request_id.clone(),
    }
}

fn send_error(writer: &Lifecycle, code: &'static str) {
    send(
        writer,
        json!({"type":"error","errorCode":code,"message":code}),
    );
}

fn empty_metrics() -> Value {
    json!({"elapsedMs":0,"bytesRead":0,"bytesWritten":0,"peakBufferedBytes":0})
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

fn signal_name(status: &ExitStatus) -> Option<&'static str> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|signal| match signal {
            2 => "SIGINT",
            9 => "SIGKILL",
            15 => "SIGTERM",
            _ => "signal",
        })
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}
