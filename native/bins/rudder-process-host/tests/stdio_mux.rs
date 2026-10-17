#![cfg(unix)]

use serde_json::{Value, json};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use rudder_process_host::{MUX_MAX_FRAME_BYTES, MUX_VERSION};

struct Host {
    child: Child,
    frames: Receiver<Value>,
    reader: Option<JoinHandle<()>>,
    root: PathBuf,
    process_group: Option<i32>,
}

impl Drop for Host {
    fn drop(&mut self) {
        self.child.stdin.take();
        if !wait_for_exit(&mut self.child, Duration::from_secs(3)) {
            if let Some(process_group) = self.process_group {
                // SAFETY: this test created and observed this process group.
                unsafe {
                    libc::kill(-process_group, libc::SIGKILL);
                }
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let (_, disconnected_frames) = mpsc::channel::<Value>();
        self.frames = disconnected_frames;
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl Host {
    fn start() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "rudder-process-host-mux-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).expect("create mux test root");
        let mut child = Command::new(env!("CARGO_BIN_EXE_rudder-process-host"))
            .arg("--stdio-mux")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start stdio-mux host process");
        let stdout = child.stdout.take().expect("capture mux stdout");
        let (frame_tx, frames) = mpsc::sync_channel(1);
        let reader = thread::spawn(move || read_mux_frames(stdout, frame_tx));
        Self {
            child,
            frames,
            reader: Some(reader),
            root,
            process_group: None,
        }
    }

    fn next_frame(&self) -> Value {
        self.frames
            .recv_timeout(Duration::from_secs(8))
            .expect("mux frame should arrive")
    }

    fn wait_lifecycle(&self, kind: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            let event = self.next_frame();
            assert_eq!(event["muxVersion"], MUX_VERSION);
            if event["type"] == "lifecycle" && event["event"]["type"] == kind {
                return event["event"].clone();
            }
            assert!(Instant::now() < deadline, "timed out waiting for {kind}");
        }
    }

    fn start_child(&mut self, request_id: &str, script: &str) -> Value {
        let root = self.root.to_string_lossy().into_owned();
        let command = json!({
            "type": "startProcess",
            "protocolVersion": { "major": 1, "minor": 0 },
            "requestId": request_id,
            "executable": "/bin/sh",
            "argv": ["-c", script],
            "cwd": root.clone(),
            "env": {},
            "ownerToken": "mux-test-owner",
            "runtimeRoot": root,
            "interactiveStdin": true,
            "graceMs": 100,
        });
        let stdin = self.child.stdin.as_mut().expect("host command stdin");
        serde_json::to_writer(&mut *stdin, &command).expect("serialize StartProcess");
        stdin
            .write_all(b"\n")
            .expect("terminate StartProcess frame");
        stdin.flush().expect("flush StartProcess frame");
        let spawned = self.wait_lifecycle("spawned");
        self.process_group = spawned["pgid"].as_i64().map(|group| group as i32);
        assert!(
            self.process_group.is_some(),
            "spawn event must identify its process group"
        );
        spawned
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> std::process::ExitStatus {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().expect("poll host exit") {
                return status;
            }
            assert!(Instant::now() < deadline, "mux host did not exit in time");
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn read_mux_frames(stdout: ChildStdout, sender: mpsc::SyncSender<Value>) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut frame = Vec::new();
        match reader.read_until(b'\n', &mut frame) {
            Ok(0) => return,
            Ok(_) if frame.len() <= MUX_MAX_FRAME_BYTES => {
                if frame.last() != Some(&b'\n') {
                    return;
                }
                let Ok(value) = serde_json::from_slice::<Value>(&frame) else {
                    return;
                };
                if sender.send(value).is_err() {
                    return;
                }
            }
            _ => return,
        }
    }
}

fn decode_hex(frame: &Value) -> Vec<u8> {
    assert_eq!(frame["encoding"], "hex");
    let encoded = frame["data"].as_str().expect("hex payload");
    assert_eq!(encoded.len() % 2, 0, "hex payload has complete bytes");
    encoded
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|digits| {
            let value = |digit: u8| match digit {
                b'0'..=b'9' => digit - b'0',
                b'a'..=b'f' => digit - b'a' + 10,
                _ => panic!("mux hex must use lowercase ASCII"),
            };
            value(digits[0]) * 16 + value(digits[1])
        })
        .collect()
}

fn assert_process_group_gone(process_group: i32) {
    // SAFETY: signal zero only queries the exact group reported by this test's host.
    let result = unsafe { libc::kill(-process_group, 0) };
    assert_eq!(result, -1, "owned child process group is still present");
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH),
        "only ESRCH proves the owned process group is gone"
    );
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait().ok().flatten().is_some() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn stdio_mux_frames_keep_lifecycle_and_binary_streams_discriminated_and_eof_reaps_child() {
    let mut host = Host::start();
    let handshake = host.wait_lifecycle("handshake");
    assert_eq!(handshake["binary"], "rudder-process-host");
    let spawned = host.start_child(
        "mux-eof",
        r"printf 'out\000\377\n'; printf 'err\200\n' >&2; exec sleep 30",
    );
    let process_group = spawned["pgid"].as_i64().unwrap() as i32;

    // This is the kernel EOF a Rust caller receives at the host when its own
    // process is killed and the last command-pipe writer closes.
    host.child.stdin.take();
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    let terminal = loop {
        let frame = host.next_frame();
        assert_eq!(frame["muxVersion"], MUX_VERSION);
        match frame["type"].as_str().expect("mux frame type") {
            "stdout" => stdout_bytes.extend(decode_hex(&frame)),
            "stderr" => stderr_bytes.extend(decode_hex(&frame)),
            "lifecycle" if frame["event"]["type"] == "terminal" => {
                break frame["event"].clone();
            }
            "lifecycle" => {}
            other => panic!("unexpected mux frame kind {other}"),
        }
    };
    assert_eq!(stdout_bytes, b"out\0\xff\n");
    assert_eq!(stderr_bytes, b"err\x80\n");
    assert_eq!(terminal["status"], "succeeded");
    assert!(host.wait_for_exit(Duration::from_secs(5)).success());
    assert_process_group_gone(process_group);
}

#[test]
fn stalled_mux_consumer_causes_bounded_owned_child_cleanup() {
    let mut host = Host::start();
    host.wait_lifecycle("handshake");
    let spawned = host.start_child(
        "mux-stalled-output",
        "dd if=/dev/zero bs=1048576 count=16 2>/dev/null; exec sleep 30",
    );
    let process_group = spawned["pgid"].as_i64().unwrap() as i32;

    // Stop draining stdout after the spawn receipt. Raw frames fill the OS
    // pipe and bounded mux queue, forcing run_host to stop and reap the child.
    let status = host.wait_for_exit(Duration::from_secs(8));
    assert!(
        !status.success(),
        "mux backpressure must fail the host receipt"
    );
    assert_process_group_gone(process_group);
}
