use super::read_commands;
use rudder_process_host::{
    LifecycleEvent, LifecycleSink, MUX_MAX_FRAME_BYTES, MUX_MAX_RAW_BYTES, MUX_VERSION, run_host,
};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::thread;
use std::time::Duration;

const MUX_QUEUE_FRAMES: usize = 32;
const WRITER_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);

enum WriterMessage {
    Frame(Vec<u8>),
    Finish(mpsc::Sender<bool>),
}

#[derive(Clone)]
struct MuxSender {
    sender: SyncSender<WriterMessage>,
    closed: Arc<AtomicBool>,
}

impl MuxSender {
    fn send_envelope(&self, envelope: Value) -> io::Result<()> {
        let mut frame = serde_json::to_vec(&envelope)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid mux envelope"))?;
        if frame.len().saturating_add(1) > MUX_MAX_FRAME_BYTES {
            return self.fail(io::ErrorKind::InvalidData, "mux frame exceeds limit");
        }
        frame.push(b'\n');
        self.send_frame(frame)
    }

    fn send_frame(&self, frame: Vec<u8>) -> io::Result<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "stdio mux is closed",
            ));
        }
        match self.sender.try_send(WriterMessage::Frame(frame)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.fail(io::ErrorKind::WouldBlock, "stdio mux queue is full")
            }
            Err(TrySendError::Disconnected(_)) => {
                self.fail(io::ErrorKind::BrokenPipe, "stdio mux writer is closed")
            }
        }
    }

    fn fail<T>(&self, kind: io::ErrorKind, message: &'static str) -> io::Result<T> {
        self.closed.store(true, Ordering::Release);
        Err(io::Error::new(kind, message))
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn finish(&self) -> bool {
        if self.is_closed() {
            return false;
        }
        let (ack_tx, ack_rx) = mpsc::channel();
        if self.sender.try_send(WriterMessage::Finish(ack_tx)).is_err() {
            self.closed.store(true, Ordering::Release);
            return false;
        }
        ack_rx
            .recv_timeout(WRITER_DRAIN_TIMEOUT)
            .is_ok_and(|flushed| flushed)
    }
}

struct MuxLifecycleSink(MuxSender);

impl LifecycleSink for MuxLifecycleSink {
    fn emit(&self, event: LifecycleEvent) -> io::Result<()> {
        self.0.send_envelope(json!({
            "muxVersion": MUX_VERSION,
            "type": "lifecycle",
            "event": event.into_value(),
        }))
    }

    fn is_closed(&self) -> bool {
        self.0.is_closed()
    }
}

struct MuxOutputWriter {
    sender: MuxSender,
    stream: &'static str,
}

impl MuxOutputWriter {
    fn new(sender: MuxSender, stream: &'static str) -> Self {
        Self { sender, stream }
    }
}

impl Write for MuxOutputWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.is_empty() {
            return Ok(0);
        }
        for chunk in bytes.chunks(MUX_MAX_RAW_BYTES) {
            self.sender.send_envelope(json!({
                "muxVersion": MUX_VERSION,
                "type": self.stream,
                "encoding": "hex",
                "data": encode_hex(chunk),
            }))?;
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.sender.is_closed() {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "stdio mux is closed",
            ))
        } else {
            Ok(())
        }
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn writer_loop(receiver: mpsc::Receiver<WriterMessage>, closed: Arc<AtomicBool>) {
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    while let Ok(message) = receiver.recv() {
        match message {
            WriterMessage::Frame(frame) => {
                if stdout.write_all(&frame).is_err() || stdout.flush().is_err() {
                    closed.store(true, Ordering::Release);
                    return;
                }
            }
            WriterMessage::Finish(ack) => {
                let flushed = stdout.flush().is_ok();
                closed.store(true, Ordering::Release);
                let _ = ack.send(flushed);
                return;
            }
        }
    }
}

/// Runs the opt-in stdout multiplexer. The writer is detached if downstream
/// stdout stops draining; run_host has already settled its owned child before
/// this bounded final flush is attempted.
pub(super) fn run() -> i32 {
    let (writer_tx, writer_rx) = mpsc::sync_channel(MUX_QUEUE_FRAMES);
    let closed = Arc::new(AtomicBool::new(false));
    let sender = MuxSender {
        sender: writer_tx,
        closed: Arc::clone(&closed),
    };
    let writer = match thread::Builder::new()
        .name("process-host-stdio-mux".to_string())
        .spawn(move || writer_loop(writer_rx, closed))
    {
        Ok(writer) => writer,
        Err(_) => return 2,
    };

    let lifecycle: Arc<dyn LifecycleSink> = Arc::new(MuxLifecycleSink(sender.clone()));
    let (input_tx, input_rx) = mpsc::sync_channel(1);
    thread::spawn(move || read_commands(input_tx));
    let code = run_host(
        input_rx,
        lifecycle,
        Box::new(MuxOutputWriter::new(sender.clone(), "stdout")),
        Box::new(MuxOutputWriter::new(sender.clone(), "stderr")),
    );
    if !sender.finish() {
        return 1;
    }
    match writer.join() {
        Ok(()) => code,
        Err(_) => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_encoding_preserves_bytes_in_lowercase() {
        assert_eq!(encode_hex(&[0x00, 0x09, 0xa0, 0xff]), "0009a0ff");
    }

    #[test]
    fn raw_output_frame_stays_within_the_protocol_limit() {
        let encoded = encode_hex(&vec![0x7f; MUX_MAX_RAW_BYTES]);
        let frame = serde_json::to_vec(&json!({
            "muxVersion": MUX_VERSION,
            "type": "stdout",
            "encoding": "hex",
            "data": encoded,
        }))
        .unwrap();
        assert!(frame.len() < MUX_MAX_FRAME_BYTES);
    }
}
