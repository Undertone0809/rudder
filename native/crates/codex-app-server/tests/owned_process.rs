//! Process/codec integration, not model execution or Native Chat acceptance.
use rudder_codex_app_server::{
    FrameDecoder, MAX_CHUNK_BYTES, Message, RpcSession, SessionObservation,
};
use rudder_native_protocol::{Command, ProtocolVersion};
use rudder_process_host::{HostInput, LifecycleEventReceiver, lifecycle_channel, run_host};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{self, Write};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut buffer = self.0.lock().unwrap();
        if buffer.len().saturating_add(bytes.len()) > 8 * 1024 * 1024 {
            return Err(io::Error::other("test capture bound exceeded"));
        }
        buffer.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct OwnedServer {
    commands: Option<mpsc::SyncSender<HostInput>>,
    lifecycle: Option<LifecycleEventReceiver>,
    thread: Option<JoinHandle<i32>>,
    stdout: Capture,
    _root: tempfile::TempDir,
}

impl OwnedServer {
    fn start(executable: String, argv: Vec<String>) -> Self {
        let root = tempfile::tempdir().unwrap();
        let root_path = root
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let home = root.path().join("codex-home");
        std::fs::create_dir(&home).unwrap();
        let mut env = BTreeMap::from([
            ("CODEX_HOME".into(), home.to_string_lossy().into_owned()),
            ("HOME".into(), root_path.clone()),
            ("USERPROFILE".into(), root_path.clone()),
        ]);
        if let Some(path) = std::env::var_os("PATH") {
            env.insert("PATH".into(), path.to_string_lossy().into_owned());
        }
        let (commands, command_rx) = mpsc::sync_channel(16);
        let (sink, lifecycle) = lifecycle_channel(32);
        let stdout = Capture::default();
        let out = stdout.clone();
        let handle =
            thread::spawn(move || run_host(command_rx, sink, Box::new(out), Box::new(io::sink())));
        let server = Self {
            commands: Some(commands),
            lifecycle: Some(lifecycle),
            thread: Some(handle),
            stdout,
            _root: root,
        };
        server.send(Command::StartProcess {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some("codex-wire-test".into()),
            executable,
            argv,
            cwd: root_path.clone(),
            env,
            owner_token: Some("codex-wire-owner".into()),
            runtime_root: Some(root_path),
            stdin: None,
            interactive_stdin: true,
            grace_ms: Some(500),
        });
        server.wait_lifecycle("spawned");
        server
    }

    fn send(&self, command: Command) {
        self.commands
            .as_ref()
            .unwrap()
            .send(HostInput::Command(command))
            .unwrap();
    }

    fn write(&self, id: &str, bytes: Vec<u8>) {
        self.send(Command::WriteStdin {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some("codex-wire-test".into()),
            owner_token: Some("codex-wire-owner".into()),
            write_id: Some(id.into()),
            data: String::from_utf8(bytes).unwrap(),
        });
        let receipt = self.wait_lifecycle("stdin-write-complete");
        assert_eq!(receipt["writeId"], id);
    }

    fn wait_lifecycle(&self, kind: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let event = self
                .lifecycle
                .as_ref()
                .unwrap()
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("host lifecycle timeout")
                .into_value();
            if event["type"] == kind {
                return event;
            }
            assert_ne!(
                event["type"], "terminal",
                "host terminated before expected event"
            );
        }
    }

    fn response(&self, decoder: &mut FrameDecoder, session: &mut RpcSession) -> SessionObservation {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let bytes = std::mem::take(&mut *self.stdout.0.lock().unwrap());
            let mut completed = None;
            for chunk in bytes.chunks(MAX_CHUNK_BYTES) {
                for message in decoder.push(chunk).unwrap_or_else(|error| {
                    let shapes: Vec<_> = chunk
                        .split(|b| *b == b'\n')
                        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
                        .map(|value| {
                            let keys = value
                                .as_object()
                                .map(|o| o.keys().cloned().collect::<Vec<_>>());
                            let error_keys = value
                                .get("error")
                                .and_then(Value::as_object)
                                .map(|o| o.keys().cloned().collect::<Vec<_>>());
                            (
                                keys,
                                error_keys,
                                value.get("id").map(|id| {
                                    if id.is_null() {
                                        "null"
                                    } else if id.is_number() {
                                        "number"
                                    } else if id.is_string() {
                                        "string"
                                    } else {
                                        "other"
                                    }
                                }),
                            )
                        })
                        .collect();
                    panic!("{error}; wire field shapes: {shapes:?}");
                }) {
                    let observation = session.observe(message).unwrap();
                    if matches!(observation, SessionObservation::Completed { .. }) {
                        assert!(
                            completed.is_none(),
                            "fixture only sends one request at a time"
                        );
                        completed = Some(observation);
                    } else if matches!(
                        observation,
                        SessionObservation::Incoming(Message::Request { .. })
                    ) {
                        panic!("unexpected server request requires explicit handling");
                    }
                }
            }
            if let Some(completed) = completed {
                return completed;
            }
            assert!(Instant::now() < deadline, "provider response timeout");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn stop(mut self) {
        self.send(Command::Stop {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some("codex-wire-test".into()),
            grace_ms: Some(100),
        });
        let terminal = self.wait_lifecycle("terminal");
        assert_eq!(terminal["cleanupProven"], true);
        assert_eq!(terminal["status"], "succeeded");
        assert_eq!(self.thread.take().unwrap().join().unwrap(), 0);
        self.commands.take();
    }
}

impl Drop for OwnedServer {
    fn drop(&mut self) {
        // Channel closure causes host Stop, including during a test panic.
        self.commands.take();
        self.lifecycle.take();
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(unix)]
#[test]
fn real_child_responses_flow_through_rust_host_decoder_and_pending_map() {
    let server = OwnedServer::start("/bin/sh".into(), vec!["-c".into(),
        "IFS= read -r first; printf '%s\\n' '{\"id\":0,\"result\":{\"echo\":\"你好🦀\"}}'; IFS= read -r second; printf '%s\\n' '{\"id\":1,\"error\":{\"code\":-32601,\"message\":\"unsupported\"}}'; IFS= read -r wait".into()]);
    let mut session = RpcSession::default();
    let mut decoder = FrameDecoder::default();
    server.write(
        "first",
        session
            .prepare("initialize", json!({}))
            .unwrap()
            .into_bytes(),
    );
    assert!(
        matches!(server.response(&mut decoder, &mut session), SessionObservation::Completed { method, outcome: Ok(value), .. } if method == "initialize" && value["echo"] == "你好🦀")
    );
    server.write(
        "second",
        session
            .prepare("thread/read", json!({"threadId":"exact"}))
            .unwrap()
            .into_bytes(),
    );
    assert!(
        matches!(server.response(&mut decoder, &mut session), SessionObservation::Completed { method, outcome: Err(error), .. } if method == "thread/read" && error.code == -32601)
    );
    assert_eq!(session.pending_ids().count(), 0);
    server.stop();
    decoder.finish().unwrap();
}

#[test]
#[ignore = "requires an explicit installed Codex executable; no model or auth calls"]
fn installed_codex_initializes_and_errors_on_unknown_thread_without_node() {
    let executable = std::env::var("RUDDER_CODEX_PROTOCOL_TEST_EXECUTABLE")
        .expect("set explicit Codex executable");
    let server = OwnedServer::start(executable, vec!["app-server".into()]);
    let mut session = RpcSession::default();
    let mut decoder = FrameDecoder::default();
    server.write("initialize", session.prepare("initialize", json!({"clientInfo":{"name":"rudder-native-protocol-test","version":"0.0.0"},"capabilities":{"experimentalApi":true}})).unwrap().into_bytes());
    assert!(
        matches!(server.response(&mut decoder, &mut session), SessionObservation::Completed { method, outcome: Ok(_), .. } if method == "initialize")
    );
    server.write(
        "initialized",
        rudder_codex_app_server::encode_notification("initialized", json!({})).unwrap(),
    );
    server.write(
        "read",
        session
            .prepare(
                "thread/read",
                json!({"threadId":"00000000-0000-4000-8000-000000000000","includeTurns":false}),
            )
            .unwrap()
            .into_bytes(),
    );
    assert!(
        matches!(server.response(&mut decoder, &mut session), SessionObservation::Completed { method, outcome: Err(_), .. } if method == "thread/read")
    );
    assert_eq!(session.pending_ids().count(), 0);
    server.stop();
}
