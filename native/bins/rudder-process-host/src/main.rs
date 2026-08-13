use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use rudder_native_protocol::{
    CAPABILITIES, Command, PROTOCOL_MAJOR, PROTOCOL_MINOR, PROTOCOL_VERSION,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::Path;
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

enum MonitorCommand {
    Stop,
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16 },
}

enum MonitorEvent {
    Exited {
        code: Option<i32>,
        signal: Option<&'static str>,
        was_stopped: bool,
        cleanup_proven: bool,
        had_surviving_group: bool,
    },
}

struct Counters {
    bytes_read: AtomicU64,
    bytes_written: AtomicU64,
}

struct ActiveChild {
    control: mpsc::Sender<MonitorCommand>,
    events: mpsc::Receiver<MonitorEvent>,
    output_done: Vec<mpsc::Receiver<bool>>,
}

struct TerminalStartError {
    code: &'static str,
    cleanup_proven: bool,
}

impl TerminalStartError {
    fn before_spawn(code: &'static str) -> Self {
        Self {
            code,
            cleanup_proven: true,
        }
    }

    fn after_spawn(code: &'static str, cleanup: CleanupResult) -> Self {
        Self {
            code,
            cleanup_proven: cleanup.proven,
        }
    }
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

    let (input_tx, input_rx) = mpsc::channel();
    thread::spawn(move || read_commands(input_tx));

    let started_at = Instant::now();
    let counters = Arc::new(Counters {
        bytes_read: AtomicU64::new(0),
        bytes_written: AtomicU64::new(0),
    });
    let mut active: Option<ActiveChild> = None;
    let mut terminal_sent = false;
    let mut process_exit_code = 0;

    while !terminal_sent {
        if let Some(child) = active.as_ref() {
            match child.events.try_recv() {
                Ok(MonitorEvent::Exited {
                    code,
                    signal,
                    was_stopped,
                    cleanup_proven,
                    had_surviving_group,
                }) => {
                    let mut output_relay_proven = true;
                    if let Some(child) = active.as_ref() {
                        for output_done in &child.output_done {
                            output_relay_proven &=
                                matches!(output_done.recv_timeout(TERM_TIMEOUT), Ok(true));
                        }
                    }
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
                    let terminal_succeeded = cleanup_proven
                        && output_relay_proven
                        && (was_stopped || (code == Some(0) && !had_surviving_group));
                    let error_code = if !cleanup_proven {
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
                    send(
                        &lifecycle,
                        terminal_message(
                            if terminal_succeeded {
                                "succeeded"
                            } else {
                                "failed"
                            },
                            error_code,
                            cleanup_proven,
                            started_at,
                            &counters,
                        ),
                    );
                    process_exit_code = if terminal_succeeded { 0 } else { 1 };
                    terminal_sent = true;
                }
                Err(mpsc::TryRecvError::Disconnected) => {
                    send(
                        &lifecycle,
                        terminal_message(
                            "failed",
                            Some("monitor_lost"),
                            false,
                            started_at,
                            &counters,
                        ),
                    );
                    process_exit_code = 1;
                    terminal_sent = true;
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
        }

        if terminal_sent {
            break;
        }

        match input_rx.recv_timeout(POLL_INTERVAL) {
            Ok(Input::Command(Command::Start {
                protocol_version,
                request_id,
                executable,
                argv,
                cwd,
                env,
                owner_token,
                port,
            })) => {
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
                } = command
                else {
                    unreachable!();
                };
                let owner_token = owner_token.expect("validated owner token");
                set_owner_token(&lifecycle, owner_token.clone());
                send(
                    &lifecycle,
                    json!({"type":"accepted","ownerToken":owner_token,"port":port}),
                );
                match spawn_child(
                    executable,
                    argv,
                    cwd,
                    env,
                    stdout.clone(),
                    stderr.clone(),
                    counters.clone(),
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
            Ok(Input::Command(Command::StartTerminal {
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
            Ok(Input::Command(ref command @ Command::Input { ref data, .. })) => {
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
            Ok(Input::Command(ref command @ Command::Resize { cols, rows, .. })) => {
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
            Ok(Input::Command(ref command @ Command::Stop { .. })) => {
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
                if let Some(child) = active.as_ref() {
                    let _ = child.control.send(MonitorCommand::Stop);
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
            Ok(Input::Invalid(code)) => {
                send_error(&lifecycle, code);
                send(
                    &lifecycle,
                    terminal_message("failed", Some(code), false, started_at, &counters),
                );
                process_exit_code = 2;
                terminal_sent = true;
            }
            Ok(Input::Eof) => {
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
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
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

fn read_commands(sender: mpsc::Sender<Input>) {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    loop {
        match read_bounded_frame(&mut reader) {
            Ok(Some(frame)) => match serde_json::from_slice::<Command>(&frame) {
                Ok(command) => {
                    if sender.send(Input::Command(command)).is_err() {
                        return;
                    }
                }
                Err(_) => {
                    let _ = sender.send(Input::Invalid("invalid_command"));
                    return;
                }
            },
            Err(FrameError::TooLarge) => {
                let _ = sender.send(Input::Invalid("command_too_large"));
                return;
            }
            Err(FrameError::Io) => {
                let _ = sender.send(Input::Invalid("command_read_failed"));
                return;
            }
            Ok(None) => break,
        }
    }
    let _ = sender.send(Input::Eof);
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
    executable: String,
    argv: Vec<String>,
    cwd: String,
    env: BTreeMap<String, String>,
    stdout: RawOutput,
    stderr: RawOutput,
    counters: Arc<Counters>,
) -> Result<(ActiveChild, u32, u32), &'static str> {
    if !Path::new(&executable).exists() || !Path::new(&cwd).is_dir() {
        return Err("launch_path_unavailable");
    }
    let mut command = ProcessCommand::new(executable);
    command.args(argv).current_dir(cwd).env_clear().envs(env);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| "spawn_failed")?;
    let pid = child.id();
    let pgid = pid;
    let child_stdout = child.stdout.take().ok_or("stdout_unavailable")?;
    let child_stderr = child.stderr.take().ok_or("stderr_unavailable")?;
    let stdout_done = relay(child_stdout, stdout, counters.clone());
    let stderr_done = relay(child_stderr, stderr, counters.clone());

    let (control_tx, control_rx) = mpsc::channel();
    let (event_tx, event_rx) = mpsc::channel();
    thread::spawn(move || monitor_child(&mut child, control_rx, event_tx, pgid));
    Ok((
        ActiveChild {
            control: control_tx,
            events: event_rx,
            output_done: vec![stdout_done, stderr_done],
        },
        pid,
        pgid,
    ))
}

#[allow(clippy::too_many_arguments)]
fn spawn_terminal(
    executable: String,
    argv: Vec<String>,
    cwd: String,
    env: BTreeMap<String, String>,
    cols: u16,
    rows: u16,
    stdout: RawOutput,
    counters: Arc<Counters>,
) -> Result<(ActiveChild, u32), TerminalStartError> {
    if !Path::new(&executable).exists() || !Path::new(&cwd).is_dir() {
        return Err(TerminalStartError::before_spawn("launch_path_unavailable"));
    }
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|_| TerminalStartError::before_spawn("pty_open_failed"))?;
    let mut command = CommandBuilder::new(executable);
    command.args(argv);
    command.cwd(cwd);
    command.env_clear();
    for (name, value) in env {
        command.env(name, value);
    }
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|_| TerminalStartError::before_spawn("spawn_failed"))?;
    let pid = child.process_id().filter(|pid| *pid >= 2);
    drop(pair.slave);
    #[cfg(debug_assertions)]
    let pid = if injected_pty_setup_failure("missing_pid") {
        None
    } else {
        pid
    };
    let Some(pid) = pid else {
        let cleanup = cleanup_spawned_pty_child(&mut child, None);
        return Err(TerminalStartError::after_spawn(
            "process_identity_unavailable",
            cleanup,
        ));
    };
    #[cfg(debug_assertions)]
    if injected_pty_setup_failure("reader") {
        let cleanup = cleanup_spawned_pty_child(&mut child, Some(pid));
        return Err(TerminalStartError::after_spawn(
            "stdout_unavailable",
            cleanup,
        ));
    }
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(_) => {
            let cleanup = cleanup_spawned_pty_child(&mut child, Some(pid));
            return Err(TerminalStartError::after_spawn(
                "stdout_unavailable",
                cleanup,
            ));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(_) => {
            let cleanup = cleanup_spawned_pty_child(&mut child, Some(pid));
            return Err(TerminalStartError::after_spawn(
                "stdin_unavailable",
                cleanup,
            ));
        }
    };
    let output_done = relay(reader, stdout, counters);
    let (control_tx, control_rx) = mpsc::channel();
    let (event_tx, event_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut writer = writer;
        let mut stopping = false;
        let mut requested_cleanup = None;
        loop {
            while let Ok(control) = control_rx.try_recv() {
                match control {
                    MonitorCommand::Stop => {
                        stopping = true;
                        requested_cleanup = Some(request_pty_tree_termination(pid));
                        let _ = child.kill();
                    }
                    MonitorCommand::Input(data) => {
                        let _ = writer.write_all(&data);
                        let _ = writer.flush();
                    }
                    MonitorCommand::Resize { cols, rows } => {
                        let _ = pair.master.resize(PtySize {
                            rows,
                            cols,
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                }
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    let cleanup = if stopping {
                        finish_pty_tree_cleanup(
                            pid,
                            requested_cleanup.unwrap_or(CleanupResult {
                                proven: false,
                                had_surviving_group: false,
                            }),
                        )
                    } else {
                        cleanup_pty_descendants(pid)
                    };
                    let _ = event_tx.send(MonitorEvent::Exited {
                        code: status.exit_code().try_into().ok(),
                        signal: None,
                        was_stopped: stopping,
                        cleanup_proven: cleanup.proven,
                        had_surviving_group: cleanup.had_surviving_group,
                    });
                    return;
                }
                Ok(None) => thread::sleep(POLL_INTERVAL),
                Err(_) => {
                    let _ = event_tx.send(MonitorEvent::Exited {
                        code: Some(1),
                        signal: None,
                        was_stopped: stopping,
                        cleanup_proven: false,
                        had_surviving_group: false,
                    });
                    return;
                }
            }
        }
    });
    Ok((
        ActiveChild {
            control: control_tx,
            events: event_rx,
            output_done: vec![output_done],
        },
        pid,
    ))
}

#[cfg(debug_assertions)]
fn injected_pty_setup_failure(stage: &str) -> bool {
    if std::env::var("RUDDER_PROCESS_HOST_TEST_PTY_SETUP_FAILURE")
        .ok()
        .as_deref()
        != Some(stage)
    {
        return false;
    }
    let delay = std::env::var("RUDDER_PROCESS_HOST_TEST_PTY_SETUP_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
        .min(1_000);
    if delay > 0 {
        thread::sleep(Duration::from_millis(delay));
    }
    true
}

fn cleanup_spawned_pty_child(
    child: &mut Box<dyn portable_pty::Child + Send + Sync>,
    pid: Option<u32>,
) -> CleanupResult {
    let Some(pid) = pid.filter(|pid| *pid >= 2) else {
        let _ = child.kill();
        let _ = child.wait();
        return CleanupResult {
            // The child handle proves the root exited, but without a PID the
            // host cannot prove that an owned descendant group is empty.
            proven: false,
            had_surviving_group: false,
        };
    };
    let requested = request_pty_tree_termination(pid);
    let _ = child.kill();
    let waited = child.wait().is_ok();
    let finished = finish_pty_tree_cleanup(pid, requested);
    CleanupResult {
        proven: waited && finished.proven,
        had_surviving_group: finished.had_surviving_group,
    }
}

fn request_pty_tree_termination(pid: u32) -> CleanupResult {
    if pid < 2 {
        return CleanupResult {
            proven: false,
            had_surviving_group: false,
        };
    }
    #[cfg(unix)]
    {
        let had_surviving_group = process_group_exists(pid).unwrap_or(true);
        if had_surviving_group {
            unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGTERM) };
        }
        CleanupResult {
            proven: true,
            had_surviving_group,
        }
    }
    #[cfg(windows)]
    {
        let status = ProcessCommand::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
        CleanupResult {
            proven: status.is_ok_and(|status| status.success()),
            had_surviving_group: true,
        }
    }
}

fn cleanup_pty_descendants(pid: u32) -> CleanupResult {
    let requested = request_pty_tree_termination(pid);
    finish_pty_tree_cleanup(pid, requested)
}

fn finish_pty_tree_cleanup(pid: u32, requested: CleanupResult) -> CleanupResult {
    if pid < 2 {
        return CleanupResult {
            proven: false,
            had_surviving_group: requested.had_surviving_group,
        };
    }
    #[cfg(unix)]
    {
        if !requested.proven {
            return requested;
        }
        wait_for_process_group_cleanup(pid, requested.had_surviving_group)
    }
    #[cfg(windows)]
    {
        let _ = pid;
        requested
    }
}

fn relay<R: Read + Send + 'static>(
    mut input: R,
    output: RawOutput,
    counters: Arc<Counters>,
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
    events: mpsc::Sender<MonitorEvent>,
    pgid: u32,
) {
    let mut stopping = false;
    let mut cleanup = None;
    loop {
        match control.try_recv() {
            Ok(MonitorCommand::Stop) => {
                stopping = true;
                cleanup = Some(terminate_owned_process(child, pgid));
            }
            Ok(MonitorCommand::Input(_)) | Ok(MonitorCommand::Resize { .. }) => {}
            Err(_) => {}
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let cleanup = cleanup.unwrap_or_else(|| cleanup_after_child_exit(pgid));
                let _ = events.send(MonitorEvent::Exited {
                    code: status.code(),
                    signal: signal_name(&status),
                    was_stopped: stopping,
                    cleanup_proven: cleanup.proven,
                    had_surviving_group: cleanup.had_surviving_group,
                });
                return;
            }
            Ok(None) => thread::sleep(POLL_INTERVAL),
            Err(_) => {
                let cleanup = cleanup.unwrap_or_else(|| cleanup_after_child_exit(pgid));
                let _ = events.send(MonitorEvent::Exited {
                    code: Some(1),
                    signal: None,
                    was_stopped: stopping,
                    cleanup_proven: cleanup.proven,
                    had_surviving_group: cleanup.had_surviving_group,
                });
                return;
            }
        }
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
    if pgid < 2 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "process group identity is invalid",
        ));
    }
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
        Command::Start { request_id, .. }
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
