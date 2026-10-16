//! Interactive stdin uses one bounded writer worker per supervised child.
//! The existing process host still owns cancellation and reaping: terminating
//! its Unix process group or Windows Job Object closes the child's pipe reader
//! and releases a writer blocked by backpressure. Real shell fixtures are
//! Unix-only; Windows CI runs protocol tests and builds/lints the process-host
//! target, while interactive runtime tests still need a Windows-native fixture.

use rudder_native_protocol::{MAX_INTERACTIVE_STDIN_QUEUE_WRITES, MAX_INTERACTIVE_STDIN_WRITE_IDS};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{self, Write};
use std::process::ChildStdin;
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;

#[path = "interactive_stdin/protocol.rs"]
mod protocol;

pub(crate) use protocol::{
    drain_one_event, finish_after_exit, handle_close_command, handle_write_command,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum WriteOutcome {
    Complete {
        bytes_written: usize,
    },
    /// The command was rejected before entering the worker queue, so zero
    /// bytes could have reached the child.
    RejectedBeforeWrite {
        error_code: &'static str,
    },
    Failed {
        bytes_written: Option<usize>,
        error_code: &'static str,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Admission {
    Queued,
    PendingDuplicate,
    Replay(WriteOutcome),
    Rejected(WriteOutcome),
    ConflictingId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Event {
    WriteFinished {
        write_id: String,
        outcome: WriteOutcome,
    },
    Closed {
        close_id: String,
    },
    WorkerDone,
}

enum Request {
    Write { write_id: String, data: Vec<u8> },
    Close { close_id: String },
}

struct WriteRecord {
    digest: [u8; 32],
    outcome: Option<WriteOutcome>,
}

#[derive(Default)]
struct State {
    writes: HashMap<String, WriteRecord>,
    close_id: Option<String>,
    close_complete: bool,
    close_requested: bool,
    pipe_closed: bool,
    worker_done: bool,
}

pub(crate) struct InteractiveStdin {
    sender: Option<SyncSender<Request>>,
    receiver: Receiver<Event>,
    state: Arc<Mutex<State>>,
}

impl InteractiveStdin {
    pub(crate) fn spawn(stdin: ChildStdin) -> Self {
        let (sender, receiver) = mpsc::sync_channel(MAX_INTERACTIVE_STDIN_QUEUE_WRITES);
        let (event_sender, event_receiver) = mpsc::channel();
        let state = Arc::new(Mutex::new(State::default()));
        let worker_state = Arc::clone(&state);
        thread::spawn(move || writer_worker(stdin, receiver, event_sender, worker_state));
        Self {
            sender: Some(sender),
            receiver: event_receiver,
            state,
        }
    }

    pub(crate) fn submit_write(&mut self, write_id: String, data: String) -> Admission {
        let digest: [u8; 32] = Sha256::digest(data.as_bytes()).into();
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => {
                return Admission::Rejected(WriteOutcome::RejectedBeforeWrite {
                    error_code: "stdin_state_unavailable",
                });
            }
        };

        if let Some(existing) = state.writes.get(&write_id) {
            if existing.digest != digest {
                return Admission::ConflictingId;
            }
            return existing
                .outcome
                .clone()
                .map(Admission::Replay)
                .unwrap_or(Admission::PendingDuplicate);
        }
        if state.close_requested || state.pipe_closed {
            return Admission::Rejected(WriteOutcome::RejectedBeforeWrite {
                error_code: "stdin_closed",
            });
        }
        if state.writes.len() >= MAX_INTERACTIVE_STDIN_WRITE_IDS {
            return Admission::Rejected(WriteOutcome::RejectedBeforeWrite {
                error_code: "stdin_write_id_capacity",
            });
        }

        let request = Request::Write {
            write_id: write_id.clone(),
            data: data.into_bytes(),
        };
        let result = match self.sender.as_ref() {
            Some(sender) => sender.try_send(request),
            None => {
                return Admission::Rejected(WriteOutcome::RejectedBeforeWrite {
                    error_code: "stdin_writer_closed",
                });
            }
        };
        match result {
            Ok(()) => {
                state.writes.insert(
                    write_id,
                    WriteRecord {
                        digest,
                        outcome: None,
                    },
                );
                Admission::Queued
            }
            Err(TrySendError::Full(_)) => {
                let outcome = WriteOutcome::RejectedBeforeWrite {
                    error_code: "stdin_queue_full",
                };
                state.writes.insert(
                    write_id,
                    WriteRecord {
                        digest,
                        outcome: Some(outcome.clone()),
                    },
                );
                Admission::Rejected(outcome)
            }
            Err(TrySendError::Disconnected(_)) => {
                Admission::Rejected(WriteOutcome::RejectedBeforeWrite {
                    error_code: "stdin_writer_closed",
                })
            }
        }
    }

    pub(crate) fn submit_close(&mut self, close_id: String) -> Admission {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => {
                return Admission::Rejected(WriteOutcome::RejectedBeforeWrite {
                    error_code: "stdin_state_unavailable",
                });
            }
        };
        if let Some(existing_id) = state.close_id.as_ref() {
            if existing_id != &close_id {
                return Admission::Rejected(WriteOutcome::RejectedBeforeWrite {
                    error_code: "stdin_already_closing",
                });
            }
            return if state.close_complete {
                Admission::Replay(WriteOutcome::Complete { bytes_written: 0 })
            } else {
                Admission::PendingDuplicate
            };
        }
        if state.pipe_closed {
            state.close_id = Some(close_id);
            state.close_complete = true;
            state.close_requested = true;
            return Admission::Replay(WriteOutcome::Complete { bytes_written: 0 });
        }
        let request = Request::Close {
            close_id: close_id.clone(),
        };
        let result = match self.sender.as_ref() {
            Some(sender) => sender.try_send(request),
            None => {
                return Admission::Rejected(WriteOutcome::RejectedBeforeWrite {
                    error_code: "stdin_writer_closed",
                });
            }
        };
        match result {
            Ok(()) => {
                state.close_requested = true;
                state.close_id = Some(close_id);
                Admission::Queued
            }
            Err(TrySendError::Full(_)) => Admission::Rejected(WriteOutcome::RejectedBeforeWrite {
                error_code: "stdin_queue_full",
            }),
            Err(TrySendError::Disconnected(_)) => {
                Admission::Rejected(WriteOutcome::RejectedBeforeWrite {
                    error_code: "stdin_writer_closed",
                })
            }
        }
    }

    pub(crate) fn try_recv(&mut self) -> Result<Option<Event>, TryRecvError> {
        match self.receiver.try_recv() {
            Ok(event) => {
                self.record_event(&event);
                Ok(Some(event))
            }
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err(TryRecvError::Disconnected),
        }
    }

    #[cfg(all(test, unix))]
    pub(crate) fn recv(&mut self) -> Result<Event, mpsc::RecvError> {
        let event = self.receiver.recv()?;
        self.record_event(&event);
        Ok(event)
    }

    pub(crate) fn recv_timeout(
        &mut self,
        timeout: std::time::Duration,
    ) -> Result<Event, mpsc::RecvTimeoutError> {
        let event = self.receiver.recv_timeout(timeout)?;
        self.record_event(&event);
        Ok(event)
    }

    pub(crate) fn shutdown(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.close_requested = true;
        }
        self.sender.take();
    }

    pub(crate) fn worker_done(&self) -> bool {
        self.state
            .lock()
            .map(|state| state.worker_done)
            .unwrap_or(false)
    }

    fn record_event(&self, event: &Event) {
        if let Ok(mut state) = self.state.lock() {
            match event {
                Event::WriteFinished { write_id, outcome } => {
                    if let Some(record) = state.writes.get_mut(write_id) {
                        record.outcome = Some(outcome.clone());
                    }
                    if matches!(outcome, WriteOutcome::Failed { .. }) {
                        state.pipe_closed = true;
                        state.close_requested = true;
                    }
                }
                Event::Closed { close_id } => {
                    state.pipe_closed = true;
                    state.close_requested = true;
                    state.close_complete = true;
                    state.close_id = Some(close_id.clone());
                }
                Event::WorkerDone => {
                    state.pipe_closed = true;
                    state.close_requested = true;
                    state.worker_done = true;
                }
            }
        }
    }
}

fn writer_worker(
    stdin: ChildStdin,
    receiver: Receiver<Request>,
    sender: mpsc::Sender<Event>,
    state: Arc<Mutex<State>>,
) {
    let mut pipe = Some(stdin);
    while let Ok(request) = receiver.recv() {
        match request {
            Request::Write { write_id, data } => {
                let outcome = match pipe.as_mut() {
                    Some(pipe) => write_all_count(pipe, &data),
                    None => WriteOutcome::Failed {
                        bytes_written: Some(0),
                        error_code: "stdin_closed",
                    },
                };
                if matches!(outcome, WriteOutcome::Failed { .. }) {
                    pipe.take();
                    if let Ok(mut state) = state.lock() {
                        state.pipe_closed = true;
                        state.close_requested = true;
                    }
                }
                let _ = sender.send(Event::WriteFinished { write_id, outcome });
            }
            Request::Close { close_id } => {
                pipe.take();
                if let Ok(mut state) = state.lock() {
                    state.pipe_closed = true;
                    state.close_requested = true;
                    state.close_complete = true;
                    state.close_id = Some(close_id.clone());
                }
                let _ = sender.send(Event::Closed { close_id });
                break;
            }
        }
    }
    pipe.take();
    if let Ok(mut state) = state.lock() {
        state.pipe_closed = true;
        state.close_requested = true;
        state.worker_done = true;
    }
    let _ = sender.send(Event::WorkerDone);
}

fn write_all_count(writer: &mut impl Write, bytes: &[u8]) -> WriteOutcome {
    let mut written = 0;
    while written < bytes.len() {
        match writer.write(&bytes[written..]) {
            Ok(0) => {
                return WriteOutcome::Failed {
                    bytes_written: Some(written),
                    error_code: "stdin_write_zero",
                };
            }
            Ok(count) => written += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => {
                return WriteOutcome::Failed {
                    bytes_written: Some(written),
                    error_code: "stdin_write_failed",
                };
            }
        }
    }
    WriteOutcome::Complete {
        bytes_written: written,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command;

    struct PartialThenError(bool);

    impl Write for PartialThenError {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.0 {
                Err(io::ErrorKind::BrokenPipe.into())
            } else {
                self.0 = true;
                Ok(bytes.len().min(3))
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn partial_write_failure_reports_confirmed_side_effect_bytes() {
        assert_eq!(
            write_all_count(&mut PartialThenError(false), b"payload"),
            WriteOutcome::Failed {
                bytes_written: Some(3),
                error_code: "stdin_write_failed",
            }
        );
    }

    #[test]
    fn preserves_unicode_and_fifo_order_on_a_real_child_pipe() {
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                "while IFS= read -r line; do printf 'echo:%s\\n' \"$line\"; done",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut writer = InteractiveStdin::spawn(stdin);
        assert_eq!(
            writer.submit_write("w1".into(), "第一\n".into()),
            Admission::Queued
        );
        assert_eq!(
            writer.submit_write("w2".into(), "second\n".into()),
            Admission::Queued
        );
        assert_eq!(
            writer.recv().unwrap(),
            Event::WriteFinished {
                write_id: "w1".into(),
                outcome: WriteOutcome::Complete { bytes_written: 7 },
            }
        );
        assert_eq!(
            writer.recv().unwrap(),
            Event::WriteFinished {
                write_id: "w2".into(),
                outcome: WriteOutcome::Complete { bytes_written: 7 },
            }
        );
        writer.submit_close("close-1".into());
        assert!(matches!(writer.recv().unwrap(), Event::Closed { .. }));
        assert!(matches!(writer.recv().unwrap(), Event::WorkerDone));
        let output = child.wait_with_output().unwrap();
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "echo:第一\necho:second\n"
        );
    }

    #[test]
    fn duplicate_write_id_replays_result_without_writing_twice() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "cat"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut writer = InteractiveStdin::spawn(child.stdin.take().unwrap());
        assert_eq!(
            writer.submit_write("same".into(), "once\n".into()),
            Admission::Queued
        );
        assert_eq!(
            writer.submit_write("same".into(), "once\n".into()),
            Admission::PendingDuplicate
        );
        let event = writer.recv().unwrap();
        assert!(matches!(event, Event::WriteFinished { .. }));
        assert_eq!(
            writer.submit_write("same".into(), "once\n".into()),
            Admission::Replay(WriteOutcome::Complete { bytes_written: 5 })
        );
        assert_eq!(
            writer.submit_write("same".into(), "twice\n".into()),
            Admission::ConflictingId
        );
        writer.shutdown();
        assert!(matches!(writer.recv().unwrap(), Event::WorkerDone));
        assert_eq!(child.wait_with_output().unwrap().stdout, b"once\n");
    }

    #[test]
    fn dedupe_id_window_fails_closed_without_evicting_old_ids() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "cat"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut writer = InteractiveStdin::spawn(child.stdin.take().unwrap());
        for index in 0..MAX_INTERACTIVE_STDIN_WRITE_IDS {
            match writer.submit_write(format!("write-{index}"), "x".into()) {
                Admission::Queued
                | Admission::Rejected(WriteOutcome::RejectedBeforeWrite {
                    error_code: "stdin_queue_full",
                }) => {}
                other => panic!("unexpected admission while filling write-ID window: {other:?}"),
            }
        }
        assert_eq!(
            writer.submit_write("window-full".into(), "x".into()),
            Admission::Rejected(WriteOutcome::RejectedBeforeWrite {
                error_code: "stdin_write_id_capacity",
            })
        );
        assert!(matches!(
            writer.submit_write("write-0".into(), "x".into()),
            Admission::PendingDuplicate | Admission::Replay(_)
        ));
        assert_eq!(
            writer.submit_write("write-0".into(), "different".into()),
            Admission::ConflictingId
        );
        writer.shutdown();
        while !writer.worker_done() {
            let _ = writer
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap();
        }
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn child_exit_rejects_late_writes_and_marks_pipe_closed() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut writer = InteractiveStdin::spawn(child.stdin.take().unwrap());
        child.wait().unwrap();
        assert_eq!(
            writer.submit_write("probe".into(), "x".repeat(1024 * 1024)),
            Admission::Queued
        );
        assert!(matches!(
            writer.recv().unwrap(),
            Event::WriteFinished {
                outcome: WriteOutcome::Failed { .. },
                ..
            }
        ));
        assert_eq!(
            writer.submit_write("late".into(), "late\n".into()),
            Admission::Rejected(WriteOutcome::RejectedBeforeWrite {
                error_code: "stdin_closed",
            })
        );
        writer.shutdown();
        while !writer.worker_done() {
            let _ = writer.recv();
        }
    }
}
