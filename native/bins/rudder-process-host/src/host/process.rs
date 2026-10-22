use super::*;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as ProcessCommand, ExitStatus, Stdio};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};

pub(super) struct OwnedProcessBoundary {
    #[cfg(windows)]
    job: HANDLE,
}

#[derive(Clone, Copy)]
pub(super) struct CleanupResult {
    pub(super) proven: bool,
    pub(super) had_surviving_group: bool,
}

struct MonitorPanicCleanup {
    child: Child,
    boundary: OwnedProcessBoundary,
    pgid: u32,
    grace: Duration,
    last_cleanup: Option<CleanupResult>,
    cleanup_report: mpsc::Sender<CleanupResult>,
}

impl Drop for MonitorPanicCleanup {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            return;
        }
        let cleanup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if let Some(cleanup) = self.last_cleanup {
                return cleanup;
            }
            match self.child.try_wait() {
                // The still-owned leader pins the process-group identity until
                // terminate_owned_process signals and reaps it.
                Ok(None) => {
                    terminate_owned_process(&mut self.child, self.pgid, self.grace, &self.boundary)
                }
                // Do not signal a process-group ID after the owned child has
                // been reaped or its ownership can no longer be established.
                Ok(Some(_)) | Err(_) => CleanupResult {
                    proven: false,
                    had_surviving_group: false,
                },
            }
        }))
        .unwrap_or(CleanupResult {
            proven: false,
            had_surviving_group: false,
        });
        let _ = self.cleanup_report.send(cleanup);
    }
}

struct PtyMonitorPanicCleanup {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    pid: u32,
    last_cleanup: Option<CleanupResult>,
    cleanup_report: mpsc::Sender<CleanupResult>,
}

impl Drop for PtyMonitorPanicCleanup {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            return;
        }
        let cleanup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if let Some(cleanup) = self.last_cleanup {
                return cleanup;
            }
            match self.child.try_wait() {
                // Keep the PTY Child handle alive while terminating the known
                // process group so its identity cannot be reused mid-signal.
                Ok(None) => cleanup_spawned_pty_child(&mut self.child, Some(self.pid)),
                // An externally reaped or unknown child is no longer a safe
                // basis for signaling the remembered PID/process group.
                Ok(Some(_)) | Err(_) => CleanupResult {
                    proven: false,
                    had_surviving_group: false,
                },
            }
        }))
        .unwrap_or(CleanupResult {
            proven: false,
            had_surviving_group: false,
        });
        let _ = self.cleanup_report.send(cleanup);
    }
}

impl OwnedProcessBoundary {
    pub(super) fn attach(child: &Child) -> io::Result<Self> {
        #[cfg(unix)]
        {
            let _ = child;
            Ok(Self {})
        }
        #[cfg(windows)]
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0
            {
                CloseHandle(job);
                return Err(io::Error::last_os_error());
            }
            Ok(Self { job })
        }
    }

    #[cfg(windows)]
    fn terminate(&self) -> bool {
        unsafe { TerminateJobObject(self.job, 1) != 0 }
    }
}

#[cfg(windows)]
unsafe impl Send for OwnedProcessBoundary {}

#[cfg(windows)]
impl Drop for OwnedProcessBoundary {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.job);
        }
    }
}

pub(super) struct OperationEvidence {
    operation_root: PathBuf,
    terminal_path: PathBuf,
    index: Mutex<BufWriter<File>>,
    sequence: AtomicU64,
    stdout_offset: AtomicU64,
    stderr_offset: AtomicU64,
    owner_token: String,
    child_pid: u32,
    process_group: u32,
    port: Option<u16>,
    owner_kind: &'static str,
}

/// Durable receipt for an owned StartProcess request that is proven not to
/// have created a child. It deliberately contains no PID or process-group
/// identity; this evidence must never be used to clean up an unrelated process.
pub(super) struct PreSpawnOperationEvidence {
    terminal_path: PathBuf,
    request_id: String,
    owner_token: String,
}

#[derive(Debug)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum ListenerOwnership {
    NotListening,
    Owned,
    Foreign,
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
        let pids: Vec<u32> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.strip_prefix('p').and_then(|v| v.parse().ok()))
            .collect();
        if pids.is_empty() {
            return Ok(ListenerOwnership::NotListening);
        }
        Ok(
            if pids.iter().all(
                |pid| unsafe { libc::getpgid(*pid as libc::pid_t) } == expected_pgid as libc::pid_t,
            ) {
                ListenerOwnership::Owned
            } else {
                ListenerOwnership::Foreign
            },
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (port, expected_pgid);
        Ok(ListenerOwnership::NotListening)
    }
}

impl OperationEvidence {
    fn create(
        runtime_root: &Path,
        owner_token: String,
        child_pid: u32,
        process_group: u32,
        port: Option<u16>,
        owner_kind: &'static str,
    ) -> Result<Arc<Self>, &'static str> {
        let root = fs::canonicalize(runtime_root).map_err(|_| "runtime_root_unavailable")?;
        if !root.is_dir() {
            return Err("runtime_root_unavailable");
        }
        let operation_root = root.join(&owner_token);
        fs::create_dir(&operation_root).map_err(|_| "operation_root_unavailable")?;
        let index_path = operation_root.join("output-index.jsonl");
        let index = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&index_path)
            .map_err(|_| "output_index_unavailable")?;
        let evidence = Arc::new(Self {
            terminal_path: operation_root.join("terminal-receipt.json"),
            operation_root,
            index: Mutex::new(BufWriter::new(index)),
            sequence: AtomicU64::new(0),
            stdout_offset: AtomicU64::new(0),
            stderr_offset: AtomicU64::new(0),
            owner_token,
            child_pid,
            process_group,
            port,
            owner_kind,
        });
        evidence.write_owner_descriptor()?;
        Ok(evidence)
    }
    fn write_owner_descriptor(&self) -> Result<(), &'static str> {
        atomic_json(
            &self.operation_root.join("owner-descriptor.json"),
            &json!({"protocolVersion":{"major":PROTOCOL_MAJOR,"minor":PROTOCOL_MINOR},"ownerKind":self.owner_kind,"opaqueOwnerToken":self.owner_token,"hostPid":std::process::id(),"childPid":self.child_pid,"platformOwnerIdentity":format!("process-group:{}",self.process_group),"port":self.port,"outputIndexPath":"output-index.jsonl","terminalReceiptPath":"terminal-receipt.json"}),
        )
    }
    fn record_output(&self, stream: &str, bytes: &[u8]) -> Result<(), &'static str> {
        let offset = if stream == "stdout" {
            self.stdout_offset
                .fetch_add(bytes.len() as u64, Ordering::SeqCst)
        } else {
            self.stderr_offset
                .fetch_add(bytes.len() as u64, Ordering::SeqCst)
        };
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst);
        let digest = format!("{:x}", Sha256::digest(bytes));
        let mut index = self.index.lock().map_err(|_| "output_index_unavailable")?;
        serde_json::to_writer(&mut *index, &json!({"sequence":sequence,"stream":stream,"offset":offset,"length":bytes.len(),"sha256":digest})).map_err(|_| "output_index_unavailable")?;
        index
            .write_all(b"\n")
            .map_err(|_| "output_index_unavailable")?;
        index.flush().map_err(|_| "output_index_unavailable")
    }
    pub(super) fn write_terminal(&self, terminal: &Value) -> Result<(), &'static str> {
        self.index
            .lock()
            .map_err(|_| "output_index_unavailable")?
            .flush()
            .map_err(|_| "output_index_unavailable")?;
        atomic_json(
            &self.terminal_path,
            &json!({"protocolVersion":{"major":PROTOCOL_MAJOR,"minor":PROTOCOL_MINOR},"opaqueOwnerToken":self.owner_token,"childPid":self.child_pid,"processGroup":self.process_group,"port":self.port,"terminal":terminal}),
        )
    }
}

impl PreSpawnOperationEvidence {
    pub(super) fn create(
        runtime_root: &Path,
        request_id: String,
        owner_token: String,
    ) -> Result<Self, &'static str> {
        let root = fs::canonicalize(runtime_root).map_err(|_| "runtime_root_unavailable")?;
        if !root.is_dir() {
            return Err("runtime_root_unavailable");
        }
        let operation_root = root.join(&owner_token);
        fs::create_dir(&operation_root).map_err(|_| "operation_root_unavailable")?;
        write_pre_spawn_owner_descriptor(&operation_root, &request_id, &owner_token)?;
        Ok(Self {
            terminal_path: operation_root.join("terminal-receipt.json"),
            request_id,
            owner_token,
        })
    }

    pub(super) fn write_terminal(&self, terminal: &mut Value) -> bool {
        if terminal["type"] != "terminal" || terminal["cleanupProven"] != true {
            return false;
        }
        terminal["receiptWritten"] = Value::Bool(true);
        let written = atomic_json(
            &self.terminal_path,
            &json!({
                "protocolVersion":{"major":PROTOCOL_MAJOR,"minor":PROTOCOL_MINOR},
                "requestId":self.request_id,
                "opaqueOwnerToken":self.owner_token,
                "childPid":null,
                "processGroup":null,
                "platformOwnerIdentity":null,
                "launchDisposition":"not_started",
                "terminal":terminal
            }),
        )
        .is_ok();
        if !written {
            terminal["receiptWritten"] = Value::Bool(false);
        }
        written
    }
}

fn write_pre_spawn_owner_descriptor(
    operation_root: &Path,
    request_id: &str,
    owner_token: &str,
) -> Result<(), &'static str> {
    atomic_json(
        &operation_root.join("owner-descriptor.json"),
        &json!({
            "protocolVersion":{"major":PROTOCOL_MAJOR,"minor":PROTOCOL_MINOR},
            "ownerKind":"agent_run_attempt",
            "requestId":request_id,
            "opaqueOwnerToken":owner_token,
            "hostPid":std::process::id(),
            "childPid":null,
            "processGroup":null,
            "platformOwnerIdentity":null,
            "port":null,
            "outputIndexPath":null,
            "terminalReceiptPath":"terminal-receipt.json",
            "launchDisposition":"not_started"
        }),
    )
}

fn atomic_json(path: &Path, value: &Value) -> Result<(), &'static str> {
    let tmp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|v| v.to_str())
            .ok_or("receipt_write_failed")?,
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&tmp)
        .map_err(|_| "receipt_write_failed")?;
    serde_json::to_writer(&mut file, value).map_err(|_| "receipt_write_failed")?;
    file.write_all(b"\n").map_err(|_| "receipt_write_failed")?;
    file.sync_all().map_err(|_| "receipt_write_failed")?;
    fs::rename(&tmp, path).map_err(|_| "receipt_write_failed")?;
    Ok(())
}

pub(super) struct TerminalStartError {
    pub(super) code: &'static str,
    pub(super) cleanup_proven: bool,
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

#[derive(Debug)]
pub(super) struct SpawnChildError {
    pub(super) code: &'static str,
    pub(super) cleanup_proven: bool,
    pub(super) spawn_disposition: SpawnDisposition,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SpawnDisposition {
    NotStarted,
    ChildCreated,
}

impl SpawnChildError {
    pub(super) fn before_spawn(code: &'static str) -> Self {
        Self {
            code,
            cleanup_proven: true,
            spawn_disposition: SpawnDisposition::NotStarted,
        }
    }

    fn after_spawn(code: &'static str, cleanup: CleanupResult) -> Self {
        Self {
            code,
            cleanup_proven: cleanup.proven,
            spawn_disposition: SpawnDisposition::ChildCreated,
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_child(
    executable: String,
    argv: Vec<String>,
    cwd: String,
    env: BTreeMap<String, String>,
    stdin: Option<String>,
    stdout: RawOutput,
    stderr: RawOutput,
    lifecycle: Lifecycle,
    counters: Arc<Counters>,
    runtime_root: String,
    owner_token: String,
    request_id: String,
    port: Option<u16>,
    owner_kind: &'static str,
    grace: Duration,
    interactive_stdin: bool,
    relay_lifecycle: bool,
) -> Result<(ActiveChild, u32, u32), SpawnChildError> {
    spawn_path_preflight(&executable, &cwd).map_err(SpawnChildError::before_spawn)?;
    let mut command = ProcessCommand::new(executable);
    command.args(argv).current_dir(cwd);
    apply_process_environment(&mut command, &env);
    command
        .stdin(if stdin.is_some() || interactive_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| SpawnChildError::before_spawn("spawn_failed"))?;
    let pid = child.id();
    let pgid = pid;
    let identity = ChildIdentity {
        request_id,
        owner_token: owner_token.clone(),
    };
    let boundary = match OwnedProcessBoundary::attach(&child) {
        Ok(boundary) => boundary,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SpawnChildError::after_spawn(
                "process_boundary_unavailable",
                CleanupResult {
                    proven: false,
                    had_surviving_group: false,
                },
            ));
        }
    };
    if injected_process_setup_failure() {
        let cleanup = terminate_owned_process(&mut child, pgid, grace, &boundary);
        return Err(SpawnChildError::after_spawn(
            "process_setup_failed",
            cleanup,
        ));
    }
    let evidence = match OperationEvidence::create(
        Path::new(&runtime_root),
        owner_token,
        pid,
        pgid,
        port,
        owner_kind,
    ) {
        Ok(evidence) => evidence,
        Err(error) => {
            let cleanup = terminate_owned_process(&mut child, pgid, grace, &boundary);
            return Err(SpawnChildError::after_spawn(error, cleanup));
        }
    };
    let child_stdout = match child.stdout.take() {
        Some(output) => output,
        None => {
            let cleanup = terminate_owned_process(&mut child, pgid, grace, &boundary);
            return Err(SpawnChildError::after_spawn("stdout_unavailable", cleanup));
        }
    };
    let child_stderr = match child.stderr.take() {
        Some(output) => output,
        None => {
            let cleanup = terminate_owned_process(&mut child, pgid, grace, &boundary);
            return Err(SpawnChildError::after_spawn("stderr_unavailable", cleanup));
        }
    };
    let interactive_stdin_pipe = if interactive_stdin {
        match child.stdin.take() {
            Some(pipe) => Some(pipe),
            None => {
                let cleanup = terminate_owned_process(&mut child, pgid, grace, &boundary);
                return Err(SpawnChildError::after_spawn("stdin_unavailable", cleanup));
            }
        }
    } else {
        None
    };
    let output_gate = relay_lifecycle.then(|| Arc::new(AtomicBool::new(false)));
    let output_failed = Arc::new(AtomicBool::new(false));
    let stdout_done = relay(
        child_stdout,
        stdout,
        RelayConfig {
            lifecycle: relay_lifecycle.then(|| lifecycle.clone()),
            counters: counters.clone(),
            evidence: Some(Arc::clone(&evidence)),
            output_gate: output_gate.clone(),
            output_failed: Arc::clone(&output_failed),
            stream: "stdout",
        },
    );
    let stderr_done = relay(
        child_stderr,
        stderr,
        RelayConfig {
            lifecycle: relay_lifecycle.then_some(lifecycle),
            counters: counters.clone(),
            evidence: Some(Arc::clone(&evidence)),
            output_gate: output_gate.clone(),
            output_failed: Arc::clone(&output_failed),
            stream: "stderr",
        },
    );

    let (control_tx, control_rx) = mpsc::channel();
    let (event_tx, event_rx) = mpsc::channel();
    let (cleanup_tx, cleanup_rx) = mpsc::channel();
    let interactive_stdin = interactive_stdin_pipe.map(InteractiveStdin::spawn);
    // Never block command handling on a child that does not consume stdin.
    // Both output relays are already running before input delivery starts.
    let input_done = stdin.map(|input| {
        let (tx, rx) = mpsc::channel();
        let child_stdin = child.stdin.take();
        thread::spawn(move || {
            let result = match child_stdin {
                Some(mut pipe) => match pipe.write_all(input.as_bytes()) {
                    Ok(()) => Ok(()),
                    // Preserve the real exit when a one-shot child closes stdin early.
                    Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
                    Err(_) => Err("stdin_write_failed"),
                },
                None => Err("stdin_unavailable"),
            };
            let _ = tx.send(result);
        });
        rx
    });
    thread::spawn(move || {
        let mut owner = MonitorPanicCleanup {
            child,
            boundary,
            pgid,
            grace,
            last_cleanup: None,
            cleanup_report: cleanup_tx,
        };
        monitor_child(
            &mut owner.child,
            control_rx,
            event_tx,
            pgid,
            port,
            grace,
            &owner.boundary,
            input_done,
            &mut owner.last_cleanup,
        )
    });
    Ok((
        ActiveChild {
            control: control_tx,
            events: event_rx,
            output_done: vec![stdout_done, stderr_done],
            evidence: Some(evidence),
            output_gate,
            output_failed,
            identity: Some(identity),
            interactive_stdin,
            monitor_cleanup: cleanup_rx,
            monitor_cleanup_timeout: grace
                + TERM_TIMEOUT
                + TERM_TIMEOUT
                + Duration::from_millis(250),
        },
        pid,
        pgid,
    ))
}

pub(super) fn spawn_path_preflight(executable: &str, cwd: &str) -> Result<(), &'static str> {
    if !Path::new(executable).exists() || !Path::new(cwd).is_dir() {
        return Err("launch_path_unavailable");
    }
    Ok(())
}

fn injected_process_setup_failure() -> bool {
    std::env::var("RUDDER_PROCESS_HOST_TEST_PROCESS_SETUP_FAILURE")
        .ok()
        .as_deref()
        == Some("after_spawn")
}

#[allow(clippy::too_many_arguments)]
pub(super) fn spawn_terminal(
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
    apply_pty_environment(&mut command, &env);
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
    let output_failed = Arc::new(AtomicBool::new(false));
    let output_done = relay(
        reader,
        stdout,
        RelayConfig {
            lifecycle: None,
            counters,
            evidence: None,
            output_gate: None,
            output_failed: Arc::clone(&output_failed),
            stream: "stdout",
        },
    );
    let (control_tx, control_rx) = mpsc::channel();
    let (event_tx, event_rx) = mpsc::channel();
    let (cleanup_tx, cleanup_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut owner = PtyMonitorPanicCleanup {
            child,
            pid,
            last_cleanup: None,
            cleanup_report: cleanup_tx,
        };
        let mut writer = writer;
        let mut stopping = false;
        let mut requested_cleanup = None;
        loop {
            let control_result = control_rx.try_recv();
            match control_result {
                Ok(control) => match control {
                    MonitorCommand::Stop { .. } => {
                        stopping = true;
                        requested_cleanup = Some(request_pty_tree_termination(pid));
                        let _ = owner.child.kill();
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
                    #[cfg(test)]
                    MonitorCommand::PanicForTest => {}
                },
                Err(mpsc::TryRecvError::Disconnected) if !stopping => {
                    // The embedding host owns the control sender. A dropped
                    // caller must stop the PTY before this monitor releases it.
                    stopping = true;
                    requested_cleanup = Some(request_pty_tree_termination(pid));
                    let _ = owner.child.kill();
                }
                Err(mpsc::TryRecvError::Disconnected | mpsc::TryRecvError::Empty) => {}
            }
            match owner.child.try_wait() {
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
                    owner.last_cleanup = Some(cleanup);
                    let _ = event_tx.send(MonitorEvent::Exited {
                        code: status.exit_code().try_into().ok(),
                        signal: None,
                        was_stopped: stopping,
                        cleanup_proven: cleanup.proven,
                        had_surviving_group: cleanup.had_surviving_group,
                        stdin_error: None,
                    });
                    return;
                }
                Ok(None) => thread::sleep(POLL_INTERVAL),
                Err(_) => {
                    owner.last_cleanup = Some(CleanupResult {
                        proven: false,
                        had_surviving_group: false,
                    });
                    let _ = event_tx.send(MonitorEvent::Exited {
                        code: Some(1),
                        signal: None,
                        was_stopped: stopping,
                        cleanup_proven: false,
                        had_surviving_group: false,
                        stdin_error: None,
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
            evidence: None,
            output_gate: None,
            output_failed,
            identity: None,
            interactive_stdin: None,
            monitor_cleanup: cleanup_rx,
            monitor_cleanup_timeout: TERM_TIMEOUT + TERM_TIMEOUT + Duration::from_millis(250),
        },
        pid,
    ))
}

fn windows_runtime_environment() -> Vec<(String, std::ffi::OsString)> {
    #[cfg(windows)]
    {
        [
            "SystemRoot",
            "WINDIR",
            "ComSpec",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "LOCALAPPDATA",
            "PROGRAMDATA",
            "PATHEXT",
        ]
        .into_iter()
        .filter_map(|name| std::env::var_os(name).map(|value| (name.to_string(), value)))
        .collect()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

fn apply_process_environment(command: &mut ProcessCommand, env: &BTreeMap<String, String>) {
    command.env_clear();
    for (name, value) in windows_runtime_environment() {
        command.env(name, value);
    }
    for (name, value) in env {
        command.env(name, value);
    }
}

fn apply_pty_environment(command: &mut CommandBuilder, env: &BTreeMap<String, String>) {
    command.env_clear();
    for (name, value) in windows_runtime_environment() {
        command.env(name, value);
    }
    for (name, value) in env {
        command.env(name, value);
    }
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

struct RelayConfig {
    lifecycle: Option<Lifecycle>,
    counters: Arc<Counters>,
    evidence: Option<Arc<OperationEvidence>>,
    output_gate: Option<Arc<AtomicBool>>,
    output_failed: Arc<AtomicBool>,
    stream: &'static str,
}

struct RelayCompletion {
    output_failed: Arc<AtomicBool>,
    done: Option<mpsc::Sender<bool>>,
}

impl RelayCompletion {
    fn finish(&mut self, successful: bool) {
        if !successful {
            self.output_failed.store(true, Ordering::Release);
        }
        if let Some(done) = self.done.take() {
            let _ = done.send(successful);
        }
    }
}

impl Drop for RelayCompletion {
    fn drop(&mut self) {
        if let Some(done) = self.done.take() {
            // Callback panics unwind through this guard. Tell the host that
            // output delivery failed so it stops the owned child instead of
            // waiting forever for a completion receipt that can never arrive.
            self.output_failed.store(true, Ordering::Release);
            let _ = done.send(false);
        }
    }
}

fn relay<R: Read + Send + 'static>(
    mut input: R,
    output: RawOutput,
    config: RelayConfig,
) -> mpsc::Receiver<bool> {
    let RelayConfig {
        lifecycle,
        counters,
        evidence,
        output_gate,
        output_failed,
        stream,
    } = config;
    let (done_tx, done_rx) = mpsc::channel();
    thread::spawn(move || {
        let mut completion = RelayCompletion {
            output_failed: Arc::clone(&output_failed),
            done: Some(done_tx),
        };
        if let Some(gate) = output_gate {
            while !gate.load(Ordering::Acquire) {
                thread::sleep(POLL_INTERVAL);
            }
        }
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
            if evidence
                .as_ref()
                .is_some_and(|evidence| evidence.record_output(stream, &buffer[..read]).is_err())
            {
                successful = false;
                break;
            }
            if let Some(lifecycle) = lifecycle.as_ref() {
                send(
                    lifecycle,
                    json!({
                        "type": "output",
                        "stream": stream,
                        "data": String::from_utf8_lossy(&buffer[..read]),
                    }),
                );
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
        completion.finish(successful);
    });
    done_rx
}

#[allow(clippy::too_many_arguments)]
pub(super) fn monitor_child(
    child: &mut Child,
    control: mpsc::Receiver<MonitorCommand>,
    events: mpsc::Sender<MonitorEvent>,
    pgid: u32,
    port: Option<u16>,
    grace: Duration,
    boundary: &OwnedProcessBoundary,
    mut input_done: Option<mpsc::Receiver<Result<(), &'static str>>>,
    last_cleanup: &mut Option<CleanupResult>,
) {
    let mut stopping = false;
    let mut cleanup = None;
    let mut listener_verified = false;
    let mut listener_owner_mismatch = false;
    let mut stdin_error = None;
    let mut input_failed_at = None;
    loop {
        if let Some(done) = input_done.as_ref() {
            let result = match done.try_recv() {
                Ok(result) => Some(result),
                Err(mpsc::TryRecvError::Disconnected) => Some(Err("stdin_writer_lost")),
                Err(mpsc::TryRecvError::Empty) => None,
            };
            if let Some(result) = result {
                stdin_error = result.err();
                input_failed_at = stdin_error.map(|_| Instant::now());
                input_done = None;
            }
        }
        match control.try_recv() {
            Ok(MonitorCommand::Stop {
                grace: requested_grace,
            }) => {
                stopping = true;
                let result = terminate_owned_process(
                    child,
                    pgid,
                    requested_grace.unwrap_or(grace),
                    boundary,
                );
                *last_cleanup = Some(result);
                cleanup = Some(result);
            }
            #[cfg(test)]
            Ok(MonitorCommand::PanicForTest) => panic!("injected monitor panic"),
            Ok(MonitorCommand::Input(_)) | Ok(MonitorCommand::Resize { .. }) => {}
            Err(mpsc::TryRecvError::Disconnected) if !stopping => {
                // The host owns the sender. If its callback panics or the
                // embedding caller otherwise disappears, stop while the
                // monitor still owns the Child and can safely reap its group.
                stopping = true;
                let result = terminate_owned_process(child, pgid, grace, boundary);
                *last_cleanup = Some(result);
                cleanup = Some(result);
            }
            Err(mpsc::TryRecvError::Disconnected | mpsc::TryRecvError::Empty) => {}
        }
        if let Some(expected_port) = port.filter(|_| !stopping && !listener_verified) {
            match listener_owned_by_process_group(expected_port, pgid) {
                Ok(ListenerOwnership::Owned) => {
                    listener_verified = true;
                    let _ = events.send(MonitorEvent::ListenerVerified {
                        port: expected_port,
                    });
                }
                Ok(ListenerOwnership::Foreign) => {
                    stopping = true;
                    listener_owner_mismatch = true;
                    let result = terminate_owned_process(child, pgid, grace, boundary);
                    *last_cleanup = Some(result);
                    cleanup = Some(result);
                    let _ = events.send(MonitorEvent::ListenerOwnerMismatch);
                }
                Ok(ListenerOwnership::NotListening) | Err(_) => {}
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let cleanup = cleanup.unwrap_or_else(|| cleanup_after_child_exit(pgid, boundary));
                *last_cleanup = Some(cleanup);
                if let Some(done) = input_done.take() {
                    stdin_error = match done.recv_timeout(TERM_TIMEOUT) {
                        Ok(result) => result.err(),
                        Err(_) => Some("stdin_writer_lost"),
                    };
                }
                let _ = events.send(MonitorEvent::Exited {
                    code: status.code(),
                    signal: signal_name(&status),
                    was_stopped: stopping,
                    cleanup_proven: cleanup.proven,
                    had_surviving_group: cleanup.had_surviving_group || listener_owner_mismatch,
                    stdin_error,
                });
                return;
            }
            Ok(None) => {
                // Allow a startup failure to finish and retain its real exit code,
                // but do not leave a live child behind after failed input delivery.
                if cleanup.is_none() && input_failed_at.is_some_and(|at| at.elapsed() >= grace) {
                    let result = terminate_owned_process(child, pgid, grace, boundary);
                    *last_cleanup = Some(result);
                    cleanup = Some(result);
                }
                thread::sleep(POLL_INTERVAL);
            }
            Err(_) => {
                let cleanup = cleanup.unwrap_or_else(|| cleanup_after_child_exit(pgid, boundary));
                *last_cleanup = Some(cleanup);
                let _ = events.send(MonitorEvent::Exited {
                    code: None,
                    signal: None,
                    was_stopped: stopping,
                    cleanup_proven: cleanup.proven,
                    had_surviving_group: cleanup.had_surviving_group,
                    stdin_error: Some(stdin_error.unwrap_or("child_wait_failed")),
                });
                return;
            }
        }
    }
}

fn terminate_owned_process(
    child: &mut Child,
    pgid: u32,
    grace: Duration,
    _boundary: &OwnedProcessBoundary,
) -> CleanupResult {
    #[cfg(unix)]
    {
        if process_group_exists(pgid).unwrap_or(true) {
            unsafe {
                libc::kill(-(pgid as libc::pid_t), libc::SIGTERM);
            }
        }
        let deadline = Instant::now() + grace;
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
        let _ = (pgid, grace);
        let terminated = _boundary.terminate();
        let _ = child.wait();
        CleanupResult {
            proven: terminated,
            had_surviving_group: false,
        }
    }
}

fn cleanup_after_child_exit(pgid: u32, _boundary: &OwnedProcessBoundary) -> CleanupResult {
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
        let terminated = _boundary.terminate();
        CleanupResult {
            proven: terminated,
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

#[cfg(test)]
mod pre_spawn_operation_evidence_tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    fn test_root(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "rudder-prespawn-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("create isolated receipt test root");
        path
    }

    #[test]
    fn pre_spawn_descriptor_contains_only_exact_owner_and_no_child_identity() {
        let root = test_root("descriptor");
        let operation = root.join("owner-opaque-1");
        fs::create_dir(&operation).unwrap();

        write_pre_spawn_owner_descriptor(&operation, "request-exact-1", "owner-opaque-1")
            .expect("write pre-spawn descriptor");
        let descriptor: Value =
            serde_json::from_slice(&fs::read(operation.join("owner-descriptor.json")).unwrap())
                .unwrap();
        assert_eq!(descriptor["requestId"], "request-exact-1");
        assert_eq!(descriptor["opaqueOwnerToken"], "owner-opaque-1");
        assert_eq!(descriptor["launchDisposition"], "not_started");
        assert!(descriptor["childPid"].is_null());
        assert!(descriptor["processGroup"].is_null());
        assert!(descriptor["platformOwnerIdentity"].is_null());
        assert!(descriptor.get("executable").is_none());
        assert!(descriptor.get("argv").is_none());
        assert!(descriptor.get("providerData").is_none());
        assert!(!operation.join("output-index.jsonl").exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pre_spawn_descriptor_write_failure_leaves_no_valid_descriptor_or_terminal() {
        let root = test_root("descriptor-failure");
        let operation = root.join("owner-opaque-2");
        fs::create_dir(&operation).unwrap();
        // A directory at the destination forces atomic rename to fail after
        // the temporary descriptor has been written.
        fs::create_dir(operation.join("owner-descriptor.json")).unwrap();

        assert_eq!(
            write_pre_spawn_owner_descriptor(&operation, "request-exact-2", "owner-opaque-2"),
            Err("receipt_write_failed")
        );
        assert!(operation.join("owner-descriptor.json").is_dir());
        assert!(!operation.join("terminal-receipt.json").exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pre_spawn_terminal_write_failure_resets_receipt_written() {
        let root = test_root("terminal-failure");
        let evidence = PreSpawnOperationEvidence::create(
            &root,
            "request-exact-3".into(),
            "owner-opaque-3".into(),
        )
        .expect("create descriptor before terminal failure");
        fs::create_dir(root.join("owner-opaque-3/terminal-receipt.json")).unwrap();
        let mut terminal = json!({"type":"terminal","status":"failed","cleanupProven":true});

        assert!(!evidence.write_terminal(&mut terminal));
        assert_eq!(terminal["receiptWritten"], false);
        assert!(root.join("owner-opaque-3/terminal-receipt.json").is_dir());

        fs::remove_dir_all(root).unwrap();
    }
}
