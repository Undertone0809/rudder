//! External ownership host bridge. No PID-based adoption or cleanup is allowed.
use super::{EventQueue, InputEvent};
use rudder_native_protocol::{PROTOCOL_MAJOR, PROTOCOL_MINOR};
use rudder_process_host::{HostInput, MUX_MAX_FRAME_BYTES, MUX_MAX_RAW_BYTES, MUX_VERSION};
use serde_json::Value;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(50);
const EXIT_DEADLINE: Duration = Duration::from_secs(10);

pub(super) fn run(
    executable: PathBuf,
    input: mpsc::Receiver<HostInput>,
    queue: Arc<EventQueue>,
    request_id: &str,
    owner_token: &str,
) -> i32 {
    let result = bridge(executable, input, &queue, request_id, owner_token);
    // Queue this after all observed envelopes. A terminal receipt, if present,
    // is consumed first. EOF alone is not a fabricated terminal/cleanup event.
    let _ = queue.emit(InputEvent::Failure);
    result.unwrap_or(1)
}

fn bridge(
    executable: PathBuf,
    input: mpsc::Receiver<HostInput>,
    queue: &Arc<EventQueue>,
    request_id: &str,
    owner_token: &str,
) -> io::Result<i32> {
    let mut command = Command::new(executable);
    command.arg("--stdio-mux").env_clear();
    // These are OS loader facts, not provider credentials or configuration.
    #[cfg(windows)]
    for key in ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let Some(mut stdin) = child.stdin.take() else {
        kill_then_reap(child);
        return Err(invalid());
    };
    let Some(stdout) = child.stdout.take() else {
        drop(stdin);
        let _ = finish(child);
        return Err(invalid());
    };
    let stop = Arc::new(AtomicBool::new(false));
    let handshake = Arc::new(AtomicBool::new(false));
    let writer_stop = Arc::clone(&stop);
    let writer_handshake = Arc::clone(&handshake);
    let writer_queue = Arc::clone(queue);
    let writer = thread::spawn(move || {
        while !writer_stop.load(Ordering::Acquire) && writer_queue.open.load(Ordering::Acquire) {
            if !writer_handshake.load(Ordering::Acquire) {
                thread::sleep(POLL);
                continue;
            }
            match input.recv_timeout(POLL) {
                Ok(HostInput::Command(command)) => {
                    let Ok(mut frame) = serde_json::to_vec(&command) else {
                        break;
                    };
                    if frame.len() > rudder_process_host::MAX_FRAME_BYTES {
                        break;
                    }
                    frame.push(b'\n');
                    if stdin.write_all(&frame).is_err() || stdin.flush().is_err() {
                        break;
                    }
                }
                Ok(HostInput::Eof | HostInput::Invalid(_))
                | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => (),
            }
        }
        // Closing the only parent command writer delegates orderly cleanup to
        // the external host even if no explicit Stop could be queued.
        drop(stdin);
    });
    let reader_queue = Arc::clone(queue);
    let reader_handshake = Arc::clone(&handshake);
    let request_id = request_id.to_owned();
    let owner_token = owner_token.to_owned();
    let reader = thread::spawn(move || {
        read_envelopes(
            &mut BufReader::new(stdout),
            &reader_queue,
            &request_id,
            &owner_token,
            &reader_handshake,
        )
    });
    // Never wait on an unbounded read while owning shutdown. The command pipe
    // and reader are separate from this monitor, so a silent/broken helper
    // cannot prevent Drop from requesting closure and bounding its wait.
    let mut closing_at = None;
    let started_at = Instant::now();
    let exit = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.code().unwrap_or(1)),
            Ok(None) => (),
            Err(_) => {
                // Query failure is not permission to bypass host EOF cleanup.
                stop.store(true, Ordering::Release);
                closing_at.get_or_insert_with(Instant::now);
            }
        }
        if writer.is_finished()
            || reader.is_finished()
            || !queue.open.load(Ordering::Acquire)
            || (!handshake.load(Ordering::Acquire)
                && started_at.elapsed() >= Duration::from_secs(5))
        {
            stop.store(true, Ordering::Release);
            closing_at.get_or_insert_with(Instant::now);
        }
        if closing_at.is_some_and(|at: Instant| at.elapsed() >= EXIT_DEADLINE) {
            kill_then_reap(child);
            break Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Rust host shutdown unproven",
            ));
        }
        thread::sleep(POLL);
    };
    stop.store(true, Ordering::Release);
    // The exact helper has exited. Its pipe readers/writers normally finish
    // immediately. A leaked descriptor in a broken helper cannot hold our
    // shutdown hostage or authorize releasing a durable admission hold.
    let drain_deadline = Instant::now() + Duration::from_secs(1);
    while !(reader.is_finished() && writer.is_finished()) && Instant::now() < drain_deadline {
        thread::sleep(POLL);
    }
    if !(reader.is_finished() && writer.is_finished()) {
        return Err(invalid());
    }
    let _ = writer.join();
    reader.join().map_err(|_| invalid())??;
    exit
}

fn read_envelopes(
    reader: &mut impl BufRead,
    queue: &EventQueue,
    request_id: &str,
    owner_token: &str,
    handshake: &AtomicBool,
) -> io::Result<()> {
    loop {
        let mut frame = Vec::new();
        let size = (&mut *reader)
            .take((MUX_MAX_FRAME_BYTES + 1) as u64)
            .read_until(b'\n', &mut frame)?;
        if size == 0 {
            return Ok(());
        }
        if size > MUX_MAX_FRAME_BYTES || frame.last() != Some(&b'\n') {
            return Err(invalid());
        }
        match decode(&frame, request_id, owner_token)? {
            Envelope::Handshake(value) if !handshake.load(Ordering::Acquire) => {
                queue.emit(InputEvent::Lifecycle(value))?;
                handshake.store(true, Ordering::Release);
            }
            Envelope::Lifecycle(value) if handshake.load(Ordering::Acquire) => {
                queue.emit(InputEvent::Lifecycle(value))?
            }
            Envelope::Stdout(bytes) if handshake.load(Ordering::Acquire) => {
                queue.emit(InputEvent::Stdout(bytes))?
            }
            Envelope::Stderr if handshake.load(Ordering::Acquire) => (),
            _ => return Err(invalid()),
        }
    }
}

enum Envelope {
    Handshake(Value),
    Lifecycle(Value),
    Stdout(Vec<u8>),
    Stderr,
}

fn decode(frame: &[u8], request_id: &str, owner_token: &str) -> io::Result<Envelope> {
    let envelope = serde_json::from_slice::<crate::value::StrictValue>(frame)
        .map_err(|_| invalid())?
        .0;
    let object = envelope.as_object().ok_or_else(invalid)?;
    if object.get("muxVersion").and_then(Value::as_u64) != Some(u64::from(MUX_VERSION)) {
        return Err(invalid());
    }
    match object.get("type").and_then(Value::as_str) {
        Some("lifecycle") if object.len() == 3 => {
            let event = object
                .get("event")
                .filter(|value| value.is_object())
                .ok_or_else(invalid)?;
            if event["protocolVersion"]["major"] != PROTOCOL_MAJOR
                || event["protocolVersion"]["minor"] != PROTOCOL_MINOR
                || !event["type"].is_string()
            {
                return Err(invalid());
            }
            if event["type"] == "handshake" {
                let capabilities = event["capabilities"].as_array().ok_or_else(invalid)?;
                if event["requestId"] != "bootstrap"
                    || !event["ownerToken"].is_null()
                    || event["binary"] != "rudder-process-host"
                    || event["effectiveEngine"] != "rust"
                    || event["binaryVersion"] != env!("CARGO_PKG_VERSION")
                    || ![
                        "interactive_process_stdin",
                        "parent_eof_cleanup",
                        "process_group_cleanup",
                    ]
                    .iter()
                    .all(|cap| capabilities.iter().any(|item| item == cap))
                {
                    return Err(invalid());
                }
                return Ok(Envelope::Handshake(event.clone()));
            }
            if event["requestId"] != request_id || event["ownerToken"] != owner_token {
                return Err(invalid());
            }
            Ok(Envelope::Lifecycle(event.clone()))
        }
        Some(kind @ ("stdout" | "stderr")) if object.len() == 4 => {
            if object.get("encoding").and_then(Value::as_str) != Some("hex") {
                return Err(invalid());
            }
            let data = object
                .get("data")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            if data.len() > MUX_MAX_RAW_BYTES * 2 || data.len() % 2 != 0 {
                return Err(invalid());
            }
            let bytes = data
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| Ok(hex(pair[0])? * 16 + hex(pair[1])?))
                .collect::<io::Result<Vec<u8>>>()?;
            Ok(if kind == "stdout" {
                Envelope::Stdout(bytes)
            } else {
                Envelope::Stderr
            })
        }
        _ => Err(invalid()),
    }
}

fn hex(byte: u8) -> io::Result<u8> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(invalid()),
    }
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Invalid external Rust host frame",
    )
}

fn finish(mut child: Child) -> io::Result<i32> {
    let deadline = Instant::now() + EXIT_DEADLINE;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Ok(status.code().unwrap_or(1));
        }
        if Instant::now() >= deadline {
            // This is our unreaped Child handle, never a recovered numeric PID.
            // Killing the helper does not prove its provider tree is quiescent.
            kill_then_reap(child);
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Rust host shutdown unproven",
            ));
        }
        thread::sleep(POLL);
    }
}

fn kill_then_reap(mut child: Child) {
    let _ = child.kill();
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        if Instant::now() >= deadline {
            // A pathological OS wait must not block the caller. Retain the
            // owned Child solely for eventual reaping, never for provider
            // cleanup proof. This path always reports indeterminate failure.
            thread::spawn(move || {
                let _ = child.wait();
            });
            return;
        }
        thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mux_rejects_identity_version_shape_and_byte_corruption() {
        let good = json!({"muxVersion":1,"type":"lifecycle","event":{
            "requestId":"request","ownerToken":"owner","type":"terminal",
            "protocolVersion":{"major":PROTOCOL_MAJOR,"minor":PROTOCOL_MINOR}
        }});
        assert!(decode(&serde_json::to_vec(&good).unwrap(), "request", "owner").is_ok());
        for (field, value) in [
            ("requestId", json!("other")),
            ("ownerToken", json!("other")),
            ("protocolVersion", json!({"major":999,"minor":0})),
        ] {
            let mut bad = good.clone();
            bad["event"][field] = value;
            assert!(decode(&serde_json::to_vec(&bad).unwrap(), "request", "owner").is_err());
        }
        for data in ["0", "0g", "FF"] {
            let bad = json!({"muxVersion":1,"type":"stdout","encoding":"hex","data":data});
            assert!(decode(&serde_json::to_vec(&bad).unwrap(), "request", "owner").is_err());
        }
        for bad in [
            json!({"muxVersion":2,"type":"stdout","encoding":"hex","data":"00"}),
            json!({"muxVersion":1,"type":"stdout","encoding":"utf8","data":"00"}),
            json!({"muxVersion":1,"type":"stdout","encoding":"hex","data":"00","extra":true}),
            json!({"muxVersion":1,"type":"stdout","encoding":"hex","data":"00".repeat(MUX_MAX_RAW_BYTES+1)}),
        ] {
            assert!(decode(&serde_json::to_vec(&bad).unwrap(), "request", "owner").is_err());
        }
        let raw = json!({"muxVersion":1,"type":"stdout","encoding":"hex","data":"00ff0a"});
        match decode(&serde_json::to_vec(&raw).unwrap(), "request", "owner").unwrap() {
            Envelope::Stdout(bytes) => assert_eq!(bytes, [0, 255, 10]),
            _ => panic!("wrong stream"),
        }
    }

    #[test]
    fn mux_reader_rejects_unterminated_and_oversized_frames() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let queue = EventQueue {
            sender,
            open: AtomicBool::new(true),
            overflow: AtomicBool::new(false),
        };
        for bytes in [b"{}".to_vec(), vec![b'x'; MUX_MAX_FRAME_BYTES + 1]] {
            assert!(
                read_envelopes(
                    &mut bytes.as_slice(),
                    &queue,
                    "r",
                    "o",
                    &AtomicBool::new(false)
                )
                .is_err()
            );
        }
    }

    #[test]
    fn mux_requires_one_handshake_before_output_and_rejects_duplicate_keys() {
        let (sender, _receiver) = mpsc::sync_channel(8);
        let queue = EventQueue {
            sender,
            open: AtomicBool::new(true),
            overflow: AtomicBool::new(false),
        };
        let handshake = json!({"muxVersion":1,"type":"lifecycle","event":{
            "type":"handshake","requestId":"bootstrap","binary":"rudder-process-host",
            "effectiveEngine":"rust","binaryVersion":env!("CARGO_PKG_VERSION"),
            "protocolVersion":{"major":PROTOCOL_MAJOR,"minor":PROTOCOL_MINOR},
            "capabilities":["interactive_process_stdin","parent_eof_cleanup","process_group_cleanup"]
        }});
        let line = format!("{handshake}\n");
        let duplicate = format!("{line}{line}");
        assert!(
            read_envelopes(
                &mut duplicate.as_bytes(),
                &queue,
                "r",
                "o",
                &AtomicBool::new(false)
            )
            .is_err()
        );
        let early =
            b"{\"muxVersion\":1,\"type\":\"stdout\",\"encoding\":\"hex\",\"data\":\"00\"}\n";
        assert!(
            read_envelopes(
                &mut early.as_slice(),
                &queue,
                "r",
                "o",
                &AtomicBool::new(false)
            )
            .is_err()
        );
        let duplicate_key = b"{\"muxVersion\":2,\"muxVersion\":1,\"type\":\"stdout\",\"encoding\":\"hex\",\"data\":\"00\"}";
        assert!(decode(duplicate_key, "r", "o").is_err());
    }
}
