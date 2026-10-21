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
use std::time::{Duration, Instant};

const MUX_QUEUE_FRAMES: usize = 32;
const WRITER_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const MUX_SEND_TIMEOUT: Duration = Duration::from_secs(2);
const MUX_SEND_RETRY_INTERVAL: Duration = Duration::from_millis(2);

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
        let deadline = Instant::now() + MUX_SEND_TIMEOUT;
        let mut message = WriterMessage::Frame(frame);
        loop {
            if self.is_closed() {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "stdio mux is closed",
                ));
            }
            match self.sender.try_send(message) {
                Ok(()) => return Ok(()),
                Err(TrySendError::Disconnected(_)) => {
                    return self.fail(io::ErrorKind::BrokenPipe, "stdio mux writer is closed");
                }
                Err(TrySendError::Full(returned)) => {
                    message = returned;
                    if self.is_closed() {
                        return Err(io::Error::new(
                            io::ErrorKind::BrokenPipe,
                            "stdio mux is closed",
                        ));
                    }
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return self
                            .fail(io::ErrorKind::TimedOut, "stdio mux queue deadline expired");
                    }
                    thread::sleep(remaining.min(MUX_SEND_RETRY_INTERVAL));
                }
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
        self.finish_with_queue_full_observer(WRITER_DRAIN_TIMEOUT, || {})
    }

    fn finish_with_queue_full_observer(
        &self,
        drain_timeout: Duration,
        mut on_full_queue: impl FnMut(),
    ) -> bool {
        if self.is_closed() {
            return false;
        }
        let (ack_tx, ack_rx) = mpsc::channel();
        let deadline = Instant::now() + drain_timeout;
        let mut finish = WriterMessage::Finish(ack_tx);
        loop {
            if self.is_closed() {
                return false;
            }
            match self.sender.try_send(finish) {
                Ok(()) => break,
                Err(TrySendError::Disconnected(_)) => {
                    self.closed.store(true, Ordering::Release);
                    return false;
                }
                Err(TrySendError::Full(returned)) => {
                    finish = returned;
                    on_full_queue();
                    if self.is_closed() {
                        return false;
                    }
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        self.closed.store(true, Ordering::Release);
                        return false;
                    }
                    thread::sleep(remaining.min(MUX_SEND_RETRY_INTERVAL));
                }
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        match ack_rx.recv_timeout(remaining) {
            Ok(true) => true,
            Ok(false) | Err(_) => {
                self.closed.store(true, Ordering::Release);
                false
            }
        }
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

    fn sender_with_queue() -> (MuxSender, mpsc::Receiver<WriterMessage>) {
        let (sender, receiver) = mpsc::sync_channel(MUX_QUEUE_FRAMES);
        let closed = Arc::new(AtomicBool::new(false));
        (MuxSender { sender, closed }, receiver)
    }

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

    #[test]
    fn sender_waits_for_a_slow_writer_and_keeps_frame_order() {
        let (sender, receiver) = sender_with_queue();
        let count = MUX_QUEUE_FRAMES * 3 + 7;
        let writer = thread::spawn(move || {
            let mut received = Vec::with_capacity(count);
            for _ in 0..count {
                match receiver.recv().unwrap() {
                    WriterMessage::Frame(frame) => {
                        received.push(u32::from_be_bytes(frame.try_into().unwrap()));
                        thread::sleep(Duration::from_millis(1));
                    }
                    WriterMessage::Finish(_) => panic!("unexpected finish frame"),
                }
            }
            received
        });

        for index in 0..count {
            sender
                .send_frame((index as u32).to_be_bytes().to_vec())
                .unwrap();
        }

        let received = writer.join().unwrap();
        assert_eq!(received, (0..count as u32).collect::<Vec<_>>());
    }

    #[test]
    fn closing_mux_interrupts_a_producer_waiting_for_queue_space() {
        let (sender, _receiver) = sender_with_queue();
        for index in 0..MUX_QUEUE_FRAMES {
            sender.send_frame(vec![index as u8]).unwrap();
        }
        let blocked_sender = sender.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let producer = thread::spawn(move || {
            started_tx.send(()).unwrap();
            blocked_sender.send_frame(vec![255])
        });
        started_rx.recv().unwrap();
        thread::sleep(Duration::from_millis(10));
        sender.closed.store(true, Ordering::Release);

        assert_eq!(
            producer.join().unwrap().unwrap_err().kind(),
            io::ErrorKind::BrokenPipe
        );
    }

    #[test]
    fn stalled_mux_writer_expires_one_bounded_send_deadline() {
        let (sender, _receiver) = sender_with_queue();
        for index in 0..MUX_QUEUE_FRAMES {
            sender.send_frame(vec![index as u8]).unwrap();
        }
        let started = Instant::now();
        let error = sender.send_frame(vec![255]).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= MUX_SEND_TIMEOUT);
        assert!(sender.is_closed());
    }

    #[test]
    fn finish_waits_for_full_queue_space_and_follows_terminal_frame() {
        let (sender, receiver) = sender_with_queue();
        let mut expected = Vec::with_capacity(MUX_QUEUE_FRAMES);
        for index in 0..MUX_QUEUE_FRAMES {
            let frame = if index + 1 == MUX_QUEUE_FRAMES {
                b"terminal".to_vec()
            } else {
                format!("output-{index}").into_bytes()
            };
            expected.push(frame.clone());
            sender.send_frame(frame).unwrap();
        }

        let (start_writer_tx, start_writer_rx) = mpsc::channel();
        let (reader_drained_tx, reader_drained_rx) = mpsc::sync_channel(0);
        let writer_closed = Arc::clone(&sender.closed);
        let writer = thread::spawn(move || {
            start_writer_rx.recv().unwrap();
            let mut frames = Vec::with_capacity(MUX_QUEUE_FRAMES);
            for index in 0..MUX_QUEUE_FRAMES {
                match receiver.recv().unwrap() {
                    WriterMessage::Frame(frame) => {
                        frames.push(frame);
                        if index == 0 {
                            reader_drained_tx.send(()).unwrap();
                        }
                    }
                    WriterMessage::Finish(_) => panic!("finish overtook a queued frame"),
                }
            }
            match receiver.recv().unwrap() {
                WriterMessage::Finish(ack) => {
                    writer_closed.store(true, Ordering::Release);
                    ack.send(true).unwrap();
                    frames
                }
                WriterMessage::Frame(_) => panic!("unexpected frame after terminal output"),
            }
        });

        let finish_sender = sender.clone();
        let (full_queue_tx, full_queue_rx) = mpsc::sync_channel(0);
        let (resume_finish_tx, resume_finish_rx) = mpsc::channel();
        let finisher = thread::spawn(move || {
            let mut observed_full_queue = false;
            // This test checks queue ordering, not the production deadline.
            // Give the explicit handshakes their own bounded scheduling budget;
            // the stalled-writer test below still checks the real deadline.
            finish_sender.finish_with_queue_full_observer(Duration::from_secs(5), || {
                if !observed_full_queue {
                    observed_full_queue = true;
                    full_queue_tx.send(()).unwrap();
                    resume_finish_rx.recv().unwrap();
                }
            })
        });

        // Do not release the reader until finish has actually observed the
        // full bounded queue and is waiting to retry its terminal message.
        full_queue_rx
            .recv_timeout(WRITER_DRAIN_TIMEOUT + Duration::from_secs(1))
            .expect("finish never observed the full writer queue");
        start_writer_tx.send(()).unwrap();
        reader_drained_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("reader did not release a writer queue slot");
        resume_finish_tx.send(()).unwrap();

        assert!(finisher.join().unwrap());
        assert_eq!(writer.join().unwrap(), expected);
    }

    #[test]
    fn finish_stalled_on_a_full_queue_fails_closed_at_its_deadline() {
        let (sender, _receiver) = sender_with_queue();
        for index in 0..MUX_QUEUE_FRAMES {
            sender.send_frame(vec![index as u8]).unwrap();
        }
        let started = Instant::now();

        assert!(!sender.finish());
        assert!(started.elapsed() >= WRITER_DRAIN_TIMEOUT);
        assert!(sender.is_closed());
    }
}
