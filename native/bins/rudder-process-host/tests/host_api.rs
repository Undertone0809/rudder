#![cfg(unix)]

use rudder_native_protocol::{Command, ProtocolVersion};
use rudder_process_host::{HostInput, LifecycleEventReceiver, lifecycle_channel, run_host};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
    fn contents(&self) -> Vec<u8> {
        self.0.lock().unwrap().clone()
    }
}

impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct FailingWriter;

impl Write for FailingWriter {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::other("simulated raw output failure"))
    }

    fn flush(&mut self) -> io::Result<()> {
        Err(io::Error::other("simulated raw output failure"))
    }
}

struct TestHost {
    commands: Option<mpsc::SyncSender<HostInput>>,
    events: Option<LifecycleEventReceiver>,
    done: mpsc::Receiver<i32>,
    thread: Option<JoinHandle<()>>,
    root: PathBuf,
    stdout: Capture,
    stderr: Capture,
}

impl Drop for TestHost {
    fn drop(&mut self) {
        if let Some(commands) = self.commands.take() {
            let _ = commands.send(HostInput::Command(Command::Stop {
                protocol_version: Some(ProtocolVersion::default()),
                request_id: Some("library-test".into()),
                grace_ms: Some(100),
            }));
        }
        self.events.take();
        if let Some(thread) = self.thread.take() {
            let _ = self.done.recv_timeout(Duration::from_secs(5));
            let _ = thread.join();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl TestHost {
    fn start(script: &str, fail_stdout: bool) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "rudder-host-api-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root_string = root.to_string_lossy().into_owned();
        let stdout = Capture::default();
        let stderr = Capture::default();
        let stdout_sink: Box<dyn Write + Send> = if fail_stdout {
            Box::new(FailingWriter)
        } else {
            Box::new(stdout.clone())
        };
        let (lifecycle_sink, events) = lifecycle_channel(16);
        let (commands, command_rx) = mpsc::sync_channel(16);
        let (done_tx, done) = mpsc::channel();
        let stderr_sink: Box<dyn Write + Send> = Box::new(stderr.clone());
        let thread = thread::spawn(move || {
            let code = run_host(command_rx, lifecycle_sink, stdout_sink, stderr_sink);
            let _ = done_tx.send(code);
        });
        let host = Self {
            commands: Some(commands),
            events: Some(events),
            done,
            thread: Some(thread),
            root,
            stdout,
            stderr,
        };
        host.commands
            .as_ref()
            .unwrap()
            .send(HostInput::Command(Command::StartProcess {
                protocol_version: Some(ProtocolVersion::default()),
                request_id: Some("library-test".into()),
                executable: "/bin/sh".into(),
                argv: vec!["-c".into(), script.into()],
                cwd: root_string.clone(),
                env: BTreeMap::new(),
                owner_token: Some("library-operation".into()),
                runtime_root: Some(root_string),
                stdin: None,
                interactive_stdin: true,
                grace_ms: Some(500),
            }))
            .unwrap();
        host.wait_for("spawned", None);
        host
    }

    fn send(&self, command: Command) {
        self.commands
            .as_ref()
            .unwrap()
            .send(HostInput::Command(command))
            .unwrap();
    }

    fn wait_for(&self, kind: &str, field_value: Option<(&str, &str)>) -> Value {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let event = self
                .events
                .as_ref()
                .unwrap()
                .recv_timeout(Duration::from_secs(1))
                .expect("lifecycle event timeout")
                .into_value();
            if event["type"] == kind
                && field_value.is_none_or(|(field, value)| event[field] == value)
            {
                return event;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {kind}");
        }
    }

    fn finish(&mut self) -> i32 {
        let code = self.done.recv_timeout(Duration::from_secs(5)).unwrap();
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
        self.commands.take();
        code
    }
}

fn write_command(write_id: &str, data: &str) -> Command {
    Command::WriteStdin {
        protocol_version: Some(ProtocolVersion::default()),
        request_id: Some("library-test".into()),
        owner_token: Some("library-operation".into()),
        write_id: Some(write_id.into()),
        data: data.into(),
    }
}

fn stop_command() -> Command {
    Command::Stop {
        protocol_version: Some(ProtocolVersion::default()),
        request_id: Some("library-test".into()),
        grace_ms: Some(100),
    }
}

#[test]
fn in_process_caller_drives_two_interactive_requests_then_stop_quiesces() {
    let mut host = TestHost::start(
        "IFS= read -r first; printf 'first:%s\\n' \"$first\"; IFS= read -r second; printf 'second:%s\\n' \"$second\"; IFS= read -r ignored || exit 0",
        false,
    );
    host.send(write_command("write-1", "你好🌱\n"));
    host.wait_for("stdin-write-complete", Some(("writeId", "write-1")));
    host.send(write_command("write-2", "second request\n"));
    host.wait_for("stdin-write-complete", Some(("writeId", "write-2")));

    let deadline = Instant::now() + Duration::from_secs(3);
    let expected = "first:你好🌱\nsecond:second request\n".as_bytes();
    while !host.stdout.contents().starts_with(expected) {
        assert!(Instant::now() < deadline, "child output was not relayed");
        thread::sleep(Duration::from_millis(5));
    }

    host.send(stop_command());
    host.wait_for("stopped", None);
    let terminal = host.wait_for("terminal", None);
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(host.finish(), 0);
    assert_eq!(host.stdout.contents(), expected);
    assert!(host.stderr.contents().is_empty());

    assert!(matches!(
        host.events
            .as_ref()
            .unwrap()
            .recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
}

#[test]
fn dropping_lifecycle_consumer_stops_and_reaps_the_active_child() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let marker = std::env::temp_dir().join(format!(
        "rudder-host-api-late-marker-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let script = format!("sleep 2; touch '{}'", marker.display());
    let mut host = TestHost::start(&script, false);
    host.events.take();
    let started = Instant::now();
    let code = host.done.recv_timeout(Duration::from_secs(4)).unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(code, 1);
    if let Some(thread) = host.thread.take() {
        thread.join().unwrap();
    }
    assert!(!marker.exists(), "child survived lifecycle consumer loss");
    let _ = fs::remove_file(marker);
}

#[test]
fn dropping_command_sender_stops_an_active_child() {
    let mut host = TestHost::start("while :; do :; done", false);
    host.commands.take();
    let terminal = host.wait_for("terminal", None);
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(host.finish(), 0);
}

#[test]
fn raw_output_sink_failure_stops_and_reaps_the_active_child() {
    let mut host = TestHost::start("printf 'trigger'; while :; do :; done", true);
    let terminal = host.wait_for("terminal", None);
    assert_eq!(terminal["status"], "failed");
    assert_eq!(terminal["errorCode"], "output_relay_failed");
    assert_eq!(host.finish(), 1);
}
