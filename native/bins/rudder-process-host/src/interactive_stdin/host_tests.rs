use super::*;

static SPAWN_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct PanicAfterSpawnSink {
    pgid: Arc<Mutex<Option<u32>>>,
}

impl LifecycleSink for PanicAfterSpawnSink {
    fn emit(&self, event: LifecycleEvent) -> io::Result<()> {
        if event.as_value()["type"] == "spawned" {
            *self.pgid.lock().unwrap() = event.as_value()["pgid"].as_u64().map(|pgid| pgid as u32);
            panic!("injected lifecycle sink panic");
        }
        Ok(())
    }
}

struct BlockOnAppExitSink {
    inner: Arc<dyn LifecycleSink>,
    app_exit_seen: mpsc::Sender<()>,
    resume: Mutex<mpsc::Receiver<()>>,
}

impl LifecycleSink for BlockOnAppExitSink {
    fn emit(&self, event: LifecycleEvent) -> io::Result<()> {
        if event.as_value()["type"] == "app-exit" {
            self.app_exit_seen
                .send(())
                .map_err(|_| io::Error::other("terminal test receiver closed"))?;
            self.resume
                .lock()
                .map_err(|_| io::Error::other("terminal test gate poisoned"))?
                .recv()
                .map_err(|_| io::Error::other("terminal test gate closed"))?;
        }
        self.inner.emit(event)
    }

    fn is_closed(&self) -> bool {
        self.inner.is_closed()
    }
}

struct ReleaseWriter {
    started: Option<mpsc::Sender<()>>,
    release: mpsc::Receiver<()>,
    bytes: Arc<Mutex<Vec<u8>>>,
}

impl Write for ReleaseWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if let Some(started) = self.started.take() {
            started
                .send(())
                .map_err(|_| io::Error::other("output test receiver closed"))?;
            self.release
                .recv()
                .map_err(|_| io::Error::other("output test gate closed"))?;
        }
        self.bytes.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct Fixture {
    child: ActiveChild,
    pid: u32,
    root: PathBuf,
    stdout: Captured,
    stderr: Captured,
    lifecycle: Captured,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.control.send(MonitorCommand::Stop {
            grace: Some(Duration::from_millis(50)),
        });
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn launch(script: &str) -> Fixture {
    launch_with_stdin(script, Some("x".repeat(4 * 1024 * 1024)), false)
}

fn launch_one_shot(script: &str, input: &str) -> Fixture {
    launch_with_stdin(script, Some(input.into()), false)
}

fn launch_interactive(script: &str) -> Fixture {
    launch_with_stdin(script, None, true)
}

fn launch_with_stdin(script: &str, stdin: Option<String>, interactive: bool) -> Fixture {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "rudder-host-stdin-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir(&root).unwrap();
    let stdout = Captured::default();
    let stderr = Captured::default();
    let lifecycle_output = Captured::default();
    let lifecycle = lifecycle_for_writer(lifecycle_output.clone(), "test", Some("operation"));
    let counters = Arc::new(Counters {
        bytes_read: AtomicU64::new(0),
        bytes_written: AtomicU64::new(0),
    });
    let started = Instant::now();
    let spawn_lock = SPAWN_LOCK.lock().unwrap();
    let (child, pid, _) = spawn_child(
        "/bin/sh".into(),
        vec!["-c".into(), script.into()],
        root.to_str().unwrap().into(),
        BTreeMap::new(),
        stdin,
        Arc::new(Mutex::new(BufWriter::new(Box::new(stdout.clone())))),
        Arc::new(Mutex::new(BufWriter::new(Box::new(stderr.clone())))),
        lifecycle,
        counters,
        root.to_str().unwrap().into(),
        "operation".into(),
        "test".into(),
        None,
        "process",
        Duration::from_millis(100),
        interactive,
        false,
    )
    .unwrap();
    drop(spawn_lock);
    assert!(started.elapsed() < Duration::from_secs(1));
    Fixture {
        child,
        pid,
        root,
        stdout,
        stderr,
        lifecycle: lifecycle_output,
    }
}

fn command_version() -> Option<rudder_native_protocol::ProtocolVersion> {
    Some(rudder_native_protocol::ProtocolVersion::default())
}

fn write_stdin(fixture: &mut Fixture, write_id: &str, data: &str) {
    write_stdin_as(fixture, "test", "operation", write_id, data);
}

fn write_stdin_as(
    fixture: &mut Fixture,
    request_id: &str,
    owner_token: &str,
    write_id: &str,
    data: &str,
) {
    let command = Command::WriteStdin {
        protocol_version: command_version(),
        request_id: Some(request_id.into()),
        owner_token: Some(owner_token.into()),
        write_id: Some(write_id.into()),
        data: data.into(),
    };
    interactive_stdin::handle_write_command(
        &lifecycle_for_writer(fixture.lifecycle.clone(), "test", Some("operation")),
        Some(&mut fixture.child),
        command,
    );
}

fn close_stdin(fixture: &mut Fixture, close_id: &str) {
    let command = Command::CloseStdin {
        protocol_version: command_version(),
        request_id: Some("test".into()),
        owner_token: Some("operation".into()),
        close_id: Some(close_id.into()),
    };
    let lifecycle = lifecycle_for_writer(fixture.lifecycle.clone(), "test", Some("operation"));
    interactive_stdin::handle_close_command(&lifecycle, Some(&mut fixture.child), command);
}

fn lifecycle_messages(fixture: &Fixture) -> Vec<Value> {
    let bytes = fixture.lifecycle.0.lock().unwrap().clone();
    String::from_utf8(bytes)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn wait_for_lifecycle(fixture: &mut Fixture, kind: &str, field: &str, value: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        interactive_stdin::drain_one_event(
            &lifecycle_for_writer(fixture.lifecycle.clone(), "test", Some("operation")),
            &mut fixture.child,
        );
        if let Some(message) = lifecycle_messages(fixture)
            .into_iter()
            .find(|message| message["type"] == kind && message[field] == value)
        {
            return message;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {kind} {field}={value}"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn wait_for_lifecycle_after(
    fixture: &mut Fixture,
    kind: &str,
    field: &str,
    value: &str,
    after: usize,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        interactive_stdin::drain_one_event(
            &lifecycle_for_writer(fixture.lifecycle.clone(), "test", Some("operation")),
            &mut fixture.child,
        );
        if let Some(message) = lifecycle_messages(fixture)
            .into_iter()
            .skip(after)
            .find(|message| message["type"] == kind && message[field] == value)
        {
            return message;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {kind} {field}={value} after {after}"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn wait_for_stdout(fixture: &Fixture, expected: &[u8]) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if fixture.stdout.0.lock().unwrap().starts_with(expected) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for child stdout"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn finish_interactive(fixture: &mut Fixture, expected_exit: Option<i32>, stopped: bool) {
    let event = fixture
        .child
        .events
        .recv_timeout(Duration::from_secs(4))
        .unwrap();
    let MonitorEvent::Exited {
        code,
        was_stopped,
        cleanup_proven,
        ..
    } = event
    else {
        panic!("unexpected monitor event");
    };
    assert_eq!(code, expected_exit);
    assert_eq!(was_stopped, stopped);
    assert!(cleanup_proven);
    assert!(drain_output(Some(&fixture.child)));
    assert!(interactive_stdin::finish_after_exit(
        &lifecycle_for_writer(fixture.lifecycle.clone(), "test", Some("operation")),
        &mut fixture.child,
    ));
}

fn finish(fixture: &Fixture, expected_exit: Option<i32>, stopped: bool) {
    let event = fixture
        .child
        .events
        .recv_timeout(Duration::from_secs(4))
        .unwrap();
    let MonitorEvent::Exited {
        code,
        was_stopped,
        cleanup_proven,
        stdin_error,
        had_surviving_group,
        ..
    } = event
    else {
        panic!("unexpected monitor event");
    };
    if let Some(expected) = expected_exit {
        assert_eq!(code, Some(expected));
    }
    assert_eq!(was_stopped, stopped);
    assert!(cleanup_proven);
    assert_eq!(stdin_error, Some("stdin_write_failed"));
    assert!(drain_output(Some(&fixture.child)));
    let counters = Counters {
        bytes_read: AtomicU64::new(0),
        bytes_written: AtomicU64::new(0),
    };
    let (succeeded, error) = exit_outcome(
        code,
        was_stopped,
        cleanup_proven,
        had_surviving_group,
        false,
        true,
        stdin_error,
    );
    assert!(!succeeded);
    let mut terminal = terminal_message(
        if succeeded { "succeeded" } else { "failed" },
        error,
        cleanup_proven,
        Instant::now(),
        &counters,
    );
    assert!(persist_terminal(Some(&fixture.child), &mut terminal));
    let receipt: Value = serde_json::from_slice(
        &fs::read(fixture.root.join("operation/terminal-receipt.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(receipt["childPid"], fixture.pid);
    assert_eq!(receipt["terminal"], terminal);
    assert_eq!(receipt["terminal"]["receiptWritten"], true);
    assert_eq!(unsafe { libc::kill(-(fixture.pid as i32), 0) }, -1);
}

#[test]
fn externally_reaped_child_reports_unknown_exit_and_wait_failure() {
    use std::os::unix::process::CommandExt;
    let mut command = std::process::Command::new("/bin/sh");
    command.args(["-c", "exit 0"]).process_group(0);
    let mut child = command.spawn().unwrap();
    let pid = child.id();
    let boundary = OwnedProcessBoundary::attach(&child).unwrap();
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(pid as i32, &mut status, 0) },
        pid as i32
    );
    assert!(child.try_wait().is_err());
    let (_control_tx, control_rx) = mpsc::channel();
    let (events_tx, events_rx) = mpsc::channel();
    monitor_child(
        &mut child,
        control_rx,
        events_tx,
        pid,
        None,
        Duration::from_millis(50),
        &boundary,
        None,
        &mut None,
    );
    assert!(matches!(
        events_rx.recv().unwrap(),
        MonitorEvent::Exited {
            code: None,
            stdin_error: Some("child_wait_failed"),
            cleanup_proven: true,
            ..
        }
    ));
}

#[test]
fn monitor_panic_cleans_owned_child_before_reporting_lost_monitor() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "rudder-host-monitor-panic-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir(&root).unwrap();
    let root_string = root.to_string_lossy().into_owned();
    let (input_tx, input_rx) = mpsc::sync_channel(64);
    let (lifecycle, events) = lifecycle_channel(256);
    let stdout_bytes = Arc::new(Mutex::new(Vec::new()));
    let (output_started_tx, output_started_rx) = mpsc::channel();
    let (output_release_tx, output_release_rx) = mpsc::channel();
    let stdout = ReleaseWriter {
        started: Some(output_started_tx),
        release: output_release_rx,
        bytes: Arc::clone(&stdout_bytes),
    };
    let host = thread::spawn(move || {
        run_host(
            input_rx,
            lifecycle,
            Box::new(stdout),
            Box::new(Vec::<u8>::new()),
        )
    });
    input_tx
        .send(HostInput::Command(Command::StartProcess {
            protocol_version: Some(rudder_native_protocol::ProtocolVersion::default()),
            request_id: Some("monitor-panic".into()),
            executable: "/bin/sh".into(),
            argv: vec![
                "-c".into(),
                "printf 'buffered-output'; exec /bin/sleep 30".into(),
            ],
            cwd: root_string.clone(),
            env: BTreeMap::new(),
            owner_token: Some("operation".into()),
            runtime_root: Some(root_string),
            stdin: None,
            interactive_stdin: true,
            grace_ms: Some(50),
        }))
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    let pgid = loop {
        let event = events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("host should report the spawned child");
        let value = event.into_value();
        if value["type"] == "spawned" {
            break value["pgid"].as_u64().unwrap() as u32;
        }
        assert!(Instant::now() < deadline, "timed out waiting for spawn");
    };

    output_started_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("raw output relay should block with produced bytes buffered");
    for index in 0..64 {
        input_tx
            .send(HostInput::Command(Command::WriteStdin {
                protocol_version: command_version(),
                request_id: Some("monitor-panic".into()),
                owner_token: Some("operation".into()),
                write_id: Some(format!("pending-{index}")),
                data: "x".repeat(64 * 1024),
            }))
            .unwrap();
    }
    input_tx.send(HostInput::PanicMonitor).unwrap();
    output_release_tx.send(()).unwrap();
    let mut failed_write_seen = false;
    let terminal = loop {
        let event = events
            .recv_timeout(Duration::from_secs(10))
            .expect("host should report monitor loss after cleanup");
        let value = event.into_value();
        if value["type"] == "terminal" {
            break value;
        }
        failed_write_seen |= value["type"] == "stdin-write-failed";
    };
    assert_eq!(terminal["status"], "failed");
    assert_eq!(terminal["errorCode"], "monitor_lost");
    assert_eq!(terminal["cleanupProven"], true);
    assert!(
        failed_write_seen,
        "pending writes should settle after child kill"
    );
    assert_eq!(host.join().unwrap(), 1);
    assert_eq!(&*stdout_bytes.lock().unwrap(), b"buffered-output");

    let receipt: Value =
        serde_json::from_slice(&fs::read(root.join("operation/terminal-receipt.json")).unwrap())
            .unwrap();
    assert_eq!(receipt["terminal"]["errorCode"], "monitor_lost");
    assert_eq!(receipt["terminal"]["cleanupProven"], true);
    assert_eq!(unsafe { libc::kill(-(pgid as i32), 0) }, -1);
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    drop(input_tx);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn queued_stdin_commands_get_correlated_rejections_before_exit_terminal() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "rudder-host-terminal-drain-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir(&root).unwrap();
    let root_string = root.to_string_lossy().into_owned();
    let (input_tx, input_rx) = mpsc::sync_channel(8);
    let (inner, events) = lifecycle_channel(32);
    let (app_exit_seen_tx, app_exit_seen_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let lifecycle: Arc<dyn LifecycleSink> = Arc::new(BlockOnAppExitSink {
        inner,
        app_exit_seen: app_exit_seen_tx,
        resume: Mutex::new(resume_rx),
    });
    let host = thread::spawn(move || {
        run_host(
            input_rx,
            lifecycle,
            Box::new(Vec::<u8>::new()),
            Box::new(Vec::<u8>::new()),
        )
    });
    input_tx
        .send(HostInput::Command(Command::StartProcess {
            protocol_version: command_version(),
            request_id: Some("terminal-drain".into()),
            executable: "/bin/sh".into(),
            argv: vec!["-c".into(), "exit 0".into()],
            cwd: root_string.clone(),
            env: BTreeMap::new(),
            owner_token: Some("operation".into()),
            runtime_root: Some(root_string),
            stdin: None,
            interactive_stdin: true,
            grace_ms: Some(50),
        }))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let event = events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("host should report its child");
        if event.as_value()["type"] == "spawned" {
            break;
        }
        assert!(Instant::now() < deadline, "timed out waiting for spawn");
    }
    app_exit_seen_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("exit path should reach the app-exit frame");
    input_tx
        .send(HostInput::Command(Command::WriteStdin {
            protocol_version: command_version(),
            request_id: Some("terminal-drain".into()),
            owner_token: Some("operation".into()),
            write_id: Some("queued-write".into()),
            data: "must-not-be-written\n".into(),
        }))
        .unwrap();
    input_tx
        .send(HostInput::Command(Command::CloseStdin {
            protocol_version: command_version(),
            request_id: Some("terminal-drain".into()),
            owner_token: Some("operation".into()),
            close_id: Some("queued-close".into()),
        }))
        .unwrap();
    resume_tx.send(()).unwrap();

    let mut write_rejected = false;
    let mut close_rejected = false;
    loop {
        let event = events
            .recv_timeout(Duration::from_secs(5))
            .expect("queued stdin commands must be answered before terminal");
        let value = event.into_value();
        match value["type"].as_str() {
            Some("stdin-write-rejected") if value["writeId"] == "queued-write" => {
                assert_eq!(value["requestId"], "terminal-drain");
                assert_eq!(value["errorCode"], "child_not_running");
                write_rejected = true;
            }
            Some("stdin-close-rejected") if value["closeId"] == "queued-close" => {
                assert_eq!(value["requestId"], "terminal-drain");
                assert_eq!(value["errorCode"], "child_not_running");
                close_rejected = true;
            }
            Some("terminal") => {
                assert!(
                    write_rejected,
                    "terminal must follow the queued write receipt"
                );
                assert!(
                    close_rejected,
                    "terminal must follow the queued close receipt"
                );
                assert_eq!(value["status"], "succeeded");
                break;
            }
            _ => {}
        }
    }
    assert_eq!(host.join().unwrap(), 0);
    drop(input_tx);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn lifecycle_sink_panic_disconnects_monitor_and_reaps_real_child() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "rudder-host-sink-panic-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir(&root).unwrap();
    let root_string = root.to_string_lossy().into_owned();
    let pgid = Arc::new(Mutex::new(None));
    let sink: Arc<dyn LifecycleSink> = Arc::new(PanicAfterSpawnSink {
        pgid: Arc::clone(&pgid),
    });
    let (input_tx, input_rx) = mpsc::sync_channel(4);
    let host = thread::spawn(move || {
        run_host(
            input_rx,
            sink,
            Box::new(Vec::<u8>::new()),
            Box::new(Vec::<u8>::new()),
        )
    });
    input_tx
        .send(HostInput::Command(Command::StartProcess {
            protocol_version: Some(rudder_native_protocol::ProtocolVersion::default()),
            request_id: Some("sink-panic".into()),
            executable: "/bin/sh".into(),
            argv: vec!["-c".into(), "exec /bin/sleep 30".into()],
            cwd: root_string.clone(),
            env: BTreeMap::new(),
            owner_token: Some("operation".into()),
            runtime_root: Some(root_string),
            stdin: None,
            interactive_stdin: false,
            grace_ms: Some(50),
        }))
        .unwrap();

    assert!(
        host.join().is_err(),
        "the injected sink panic should unwind the host"
    );
    let pgid = pgid
        .lock()
        .unwrap()
        .expect("spawned event captures process group");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let result = unsafe { libc::kill(-(pgid as i32), 0) };
        if result == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "host panic should not orphan the child group"
        );
        thread::sleep(POLL_INTERVAL);
    }
    assert!(
        !root.join("operation/terminal-receipt.json").exists(),
        "a panicking sink must not leave a success receipt"
    );
    drop(input_tx);
    fs::remove_dir_all(root).unwrap();
}

struct PanicWriter;

impl Write for PanicWriter {
    fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
        panic!("injected raw output writer panic");
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn raw_output_writer_panic_stops_and_reaps_real_child() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "rudder-host-output-panic-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir(&root).unwrap();
    let root_string = root.to_string_lossy().into_owned();
    let (input_tx, input_rx) = mpsc::sync_channel(4);
    let (lifecycle, events) = lifecycle_channel(32);
    let host = thread::spawn(move || {
        run_host(
            input_rx,
            lifecycle,
            Box::new(PanicWriter),
            Box::new(Vec::<u8>::new()),
        )
    });
    input_tx
        .send(HostInput::Command(Command::StartProcess {
            protocol_version: Some(rudder_native_protocol::ProtocolVersion::default()),
            request_id: Some("output-panic".into()),
            executable: "/bin/sh".into(),
            argv: vec!["-c".into(), "printf 'ready'; exec /bin/sleep 30".into()],
            cwd: root_string.clone(),
            env: BTreeMap::new(),
            owner_token: Some("operation".into()),
            runtime_root: Some(root_string),
            stdin: None,
            interactive_stdin: false,
            grace_ms: Some(50),
        }))
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    let pgid = loop {
        let value = events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("host should report the spawned child");
        let value = value.into_value();
        if value["type"] == "spawned" {
            break value["pgid"].as_u64().unwrap() as u32;
        }
        assert!(Instant::now() < deadline, "timed out waiting for spawn");
    };
    let terminal = loop {
        let value = events
            .recv_timeout(Duration::from_secs(5))
            .expect("host should stop the child after output delivery fails");
        let value = value.into_value();
        if value["type"] == "terminal" {
            break value;
        }
    };
    assert_eq!(terminal["status"], "failed");
    assert_eq!(terminal["errorCode"], "output_relay_failed");
    assert_eq!(terminal["cleanupProven"], true);
    assert_eq!(host.join().unwrap(), 1);
    assert_eq!(unsafe { libc::kill(-(pgid as i32), 0) }, -1);
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    drop(input_tx);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn early_success_with_closed_stdin_preserves_real_exit_and_output() {
    let fixture = launch("exec 0<&-; printf 'completed-without-input'; exit 0");
    finish(&fixture, Some(0), false);
    assert_eq!(
        &*fixture.stdout.0.lock().unwrap(),
        b"completed-without-input"
    );
}

#[test]
fn closed_stdin_does_not_kill_a_still_running_child() {
    let fixture = launch("exec 0<&-; sleep 1; printf 'completed-after-closing-input'; exit 0");
    finish(&fixture, Some(0), false);
    assert_eq!(
        &*fixture.stdout.0.lock().unwrap(),
        b"completed-after-closing-input"
    );
}

#[test]
fn closed_stdin_preserves_diagnostics_real_exit_and_receipt() {
    let fixture =
        launch("exec 0<&-; printf 'startup-out'; printf 'startup-diagnostic' >&2; exit 23");
    finish(&fixture, Some(23), false);
    assert_eq!(&*fixture.stdout.0.lock().unwrap(), b"startup-out");
    assert_eq!(&*fixture.stderr.0.lock().unwrap(), b"startup-diagnostic");
    let index = fs::read_to_string(fixture.root.join("operation/output-index.jsonl")).unwrap();
    assert!(index.contains("stdout"));
    assert!(index.contains("stderr"));
}

#[test]
fn blocked_stdin_remains_cancellable_and_drains_receipt() {
    let fixture = launch("printf 'waiting' >&2; exec /bin/sleep 30");
    // Input exceeds the pipe capacity. Stop must work without waiting for it.
    fixture
        .child
        .control
        .send(MonitorCommand::Stop {
            grace: Some(Duration::from_millis(50)),
        })
        .unwrap();
    finish(&fixture, None, true);
}

#[test]
fn interactive_child_supports_two_unicode_round_trips_and_fifo_close() {
    let mut fixture =
        launch_interactive("while IFS= read -r line; do printf 'reply:%s\\n' \"$line\"; done");
    write_stdin(&mut fixture, "write-1", "第一\n");
    write_stdin(&mut fixture, "write-2", "second\n");
    close_stdin(&mut fixture, "close-1");
    write_stdin(&mut fixture, "late-write", "must-not-be-written\n");
    let first = wait_for_lifecycle(&mut fixture, "stdin-write-complete", "writeId", "write-1");
    let second = wait_for_lifecycle(&mut fixture, "stdin-write-complete", "writeId", "write-2");
    assert_eq!(first["bytesWritten"], "第一\n".len());
    assert_eq!(second["bytesWritten"], "second\n".len());
    let closed = wait_for_lifecycle(&mut fixture, "stdin-closed", "closeId", "close-1");
    assert_eq!(closed["ownerToken"], "operation");
    let messages = lifecycle_messages(&fixture);
    let late = messages
        .iter()
        .find(|message| {
            message["type"] == "stdin-write-rejected" && message["writeId"] == "late-write"
        })
        .expect("post-close write should be rejected before reaching the child");
    assert_eq!(late["errorCode"], "stdin_closed");
    let first_index = messages
        .iter()
        .position(|message| {
            message["type"] == "stdin-write-complete" && message["writeId"] == "write-1"
        })
        .unwrap();
    let second_index = messages
        .iter()
        .position(|message| {
            message["type"] == "stdin-write-complete" && message["writeId"] == "write-2"
        })
        .unwrap();
    let closed_index = messages
        .iter()
        .position(|message| message["type"] == "stdin-closed" && message["closeId"] == "close-1")
        .unwrap();
    assert!(first_index < second_index && second_index < closed_index);
    finish_interactive(&mut fixture, Some(0), false);
    assert_eq!(
        &*fixture.stdout.0.lock().unwrap(),
        "reply:第一\nreply:second\n".as_bytes()
    );
    assert!(fixture.stderr.0.lock().unwrap().is_empty());
}

#[test]
fn child_exit_drains_every_accepted_write_receipt_before_terminal_cleanup() {
    let mut fixture = launch_interactive("cat >/dev/null");
    write_stdin(&mut fixture, "write-a", "first\n");
    write_stdin(&mut fixture, "write-b", "second\n");
    close_stdin(&mut fixture, "close");

    // Do not drain worker events while the child exits. The exit path itself
    // must emit both write results before accepting WorkerDone as completion.
    finish_interactive(&mut fixture, Some(0), false);
    let messages = lifecycle_messages(&fixture);
    let first = messages
        .iter()
        .position(|message| {
            message["type"] == "stdin-write-complete" && message["writeId"] == "write-a"
        })
        .unwrap();
    let second = messages
        .iter()
        .position(|message| {
            message["type"] == "stdin-write-complete" && message["writeId"] == "write-b"
        })
        .unwrap();
    let closed = messages
        .iter()
        .position(|message| message["type"] == "stdin-closed" && message["closeId"] == "close")
        .unwrap();
    assert!(first < second && second < closed);
}

#[test]
fn interactive_stop_cancels_a_blocked_writer_and_reaps_child() {
    let mut fixture = launch_interactive("exec /bin/sleep 30");
    for index in 0..128 {
        write_stdin(
            &mut fixture,
            &format!("write-{index}"),
            &"x".repeat(64 * 1024),
        );
    }
    let pressure = wait_for_lifecycle(
        &mut fixture,
        "stdin-write-rejected",
        "errorCode",
        "stdin_queue_full",
    );
    assert_eq!(pressure["phase"], "before_write");
    let rejected_id = pressure["writeId"].as_str().unwrap();
    write_stdin(&mut fixture, rejected_id, &"x".repeat(64 * 1024));
    let rejections: Vec<_> = lifecycle_messages(&fixture)
        .into_iter()
        .filter(|message| {
            message["type"] == "stdin-write-rejected" && message["writeId"] == rejected_id
        })
        .collect();
    assert_eq!(rejections.len(), 2);
    assert_eq!(rejections[1], pressure);
    let started = Instant::now();
    fixture
        .child
        .control
        .send(MonitorCommand::Stop {
            grace: Some(Duration::from_millis(50)),
        })
        .unwrap();
    assert!(started.elapsed() < Duration::from_millis(100));
    finish_interactive(&mut fixture, None, true);
    assert_eq!(unsafe { libc::kill(-(fixture.pid as i32), 0) }, -1);
}

#[test]
fn child_closing_interactive_stdin_reports_failure_and_rejects_late_write() {
    let mut fixture = launch_interactive("exec 0<&-; printf 'stdin-closed\\n'; sleep 1");
    wait_for_stdout(&fixture, b"stdin-closed\n");
    write_stdin(&mut fixture, "closed-pipe-write", "hello\n");
    let failure = wait_for_lifecycle(
        &mut fixture,
        "stdin-write-failed",
        "writeId",
        "closed-pipe-write",
    );
    assert_eq!(failure["errorCode"], "stdin_write_failed");
    assert_eq!(failure["bytesWritten"], 0);
    let before_replay = lifecycle_messages(&fixture).len();
    write_stdin(&mut fixture, "closed-pipe-write", "hello\n");
    let replay = wait_for_lifecycle_after(
        &mut fixture,
        "stdin-write-failed",
        "writeId",
        "closed-pipe-write",
        before_replay,
    );
    assert_eq!(replay["requestId"], failure["requestId"]);
    assert_eq!(replay["ownerToken"], failure["ownerToken"]);
    assert_eq!(replay["errorCode"], failure["errorCode"]);
    assert_eq!(replay["bytesWritten"], failure["bytesWritten"]);
    assert_eq!(replay["replayed"], true);
    assert_eq!(failure["replayed"], false);
    write_stdin(&mut fixture, "late-write", "later\n");
    let rejected = wait_for_lifecycle(
        &mut fixture,
        "stdin-write-rejected",
        "writeId",
        "late-write",
    );
    assert_eq!(rejected["errorCode"], "stdin_closed");
    finish_interactive(&mut fixture, Some(0), false);
}

#[test]
fn legacy_one_shot_process_stdin_still_writes_once_then_eof() {
    let fixture = launch_one_shot(
        "IFS= read -r line; printf 'legacy:%s\\n' \"$line\"",
        "hello\n",
    );
    let event = fixture
        .child
        .events
        .recv_timeout(Duration::from_secs(3))
        .unwrap();
    assert!(matches!(
        event,
        MonitorEvent::Exited {
            code: Some(0),
            cleanup_proven: true,
            stdin_error: None,
            ..
        }
    ));
    assert!(drain_output(Some(&fixture.child)));
    assert!(fixture.child.interactive_stdin.is_none());
    assert_eq!(&*fixture.stdout.0.lock().unwrap(), b"legacy:hello\n");
}

#[test]
fn pty_terminal_input_remains_separate_from_interactive_process_stdin() {
    let root = std::env::temp_dir().join(format!(
        "rudder-host-terminal-compat-{}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let stdout = Captured::default();
    let counters = Arc::new(Counters {
        bytes_read: AtomicU64::new(0),
        bytes_written: AtomicU64::new(0),
    });
    let (child, _) = match spawn_terminal(
        "/bin/sh".into(),
        vec![
            "-c".into(),
            "IFS= read -r line; printf 'terminal:%s\\n' \"$line\"".into(),
        ],
        root.to_str().unwrap().into(),
        BTreeMap::new(),
        80,
        24,
        Arc::new(Mutex::new(BufWriter::new(Box::new(stdout.clone())))),
        counters,
    ) {
        Ok(child) => child,
        Err(error) => panic!("terminal compatibility fixture failed: {}", error.code),
    };
    assert!(child.interactive_stdin.is_none());
    assert!(child.identity.is_none());
    child
        .control
        .send(MonitorCommand::Input(b"terminal-ok\n".to_vec()))
        .unwrap();
    let event = child.events.recv_timeout(Duration::from_secs(4)).unwrap();
    assert!(matches!(
        event,
        MonitorEvent::Exited {
            code: Some(0),
            cleanup_proven: true,
            ..
        }
    ));
    assert!(drain_output(Some(&child)));
    assert!(String::from_utf8_lossy(&stdout.0.lock().unwrap()).contains("terminal:terminal-ok"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_child_identity_and_oversize_write_have_no_child_side_effect() {
    let mut fixture =
        launch_interactive("while IFS= read -r line; do printf 'accepted:%s\\n' \"$line\"; done");
    write_stdin_as(
        &mut fixture,
        "old-child-request",
        "operation",
        "stale-request",
        "bad\n",
    );
    write_stdin_as(
        &mut fixture,
        "test",
        "old-child-owner",
        "stale-owner",
        "bad\n",
    );
    write_stdin(
        &mut fixture,
        "oversize",
        &"x".repeat(rudder_native_protocol::MAX_INTERACTIVE_STDIN_WRITE_BYTES + 1),
    );
    let messages = lifecycle_messages(&fixture);
    let stale_request = messages
        .iter()
        .find(|message| message["writeId"] == "stale-request")
        .unwrap();
    assert_eq!(stale_request["errorCode"], "child_identity_mismatch");
    let stale_owner = messages
        .iter()
        .find(|message| message["writeId"] == "stale-owner")
        .unwrap();
    assert_eq!(stale_owner["errorCode"], "child_identity_mismatch");
    let oversize = messages
        .iter()
        .find(|message| message["writeId"] == "oversize")
        .unwrap();
    assert_eq!(oversize["errorCode"], "invalid_stdin_write_size");

    write_stdin(&mut fixture, "accepted", "okay\n");
    wait_for_lifecycle(&mut fixture, "stdin-write-complete", "writeId", "accepted");
    close_stdin(&mut fixture, "close");
    wait_for_lifecycle(&mut fixture, "stdin-closed", "closeId", "close");
    finish_interactive(&mut fixture, Some(0), false);
    assert_eq!(&*fixture.stdout.0.lock().unwrap(), b"accepted:okay\n");
}

#[test]
fn interactive_startup_failure_uses_existing_child_cleanup() {
    let root = std::env::temp_dir().join(format!(
        "rudder-host-interactive-start-failure-{}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let spawn_lock = SPAWN_LOCK.lock().unwrap();
    unsafe {
        std::env::set_var(
            "RUDDER_PROCESS_HOST_TEST_PROCESS_SETUP_FAILURE",
            "after_spawn",
        );
    }
    let lifecycle = lifecycle_for_writer(io::sink(), "test", Some("operation"));
    let counters = Arc::new(Counters {
        bytes_read: AtomicU64::new(0),
        bytes_written: AtomicU64::new(0),
    });
    let result = spawn_child(
        "/bin/sh".into(),
        vec!["-c".into(), "exec /bin/sleep 30".into()],
        root.to_str().unwrap().into(),
        BTreeMap::new(),
        None,
        Arc::new(Mutex::new(BufWriter::new(Box::new(io::sink())))),
        Arc::new(Mutex::new(BufWriter::new(Box::new(io::sink())))),
        lifecycle,
        counters,
        root.to_str().unwrap().into(),
        "operation".into(),
        "test".into(),
        None,
        "process",
        Duration::from_millis(50),
        true,
        false,
    );
    unsafe {
        std::env::remove_var("RUDDER_PROCESS_HOST_TEST_PROCESS_SETUP_FAILURE");
    }
    drop(spawn_lock);
    let error = match result {
        Err(error) => error,
        Ok(_) => panic!("injected post-spawn setup failure unexpectedly succeeded"),
    };
    assert_eq!(error.code, "process_setup_failed");
    assert!(error.cleanup_proven);
    assert!(fs::read_dir(&root).unwrap().next().is_none());
    fs::remove_dir_all(root).unwrap();
}
