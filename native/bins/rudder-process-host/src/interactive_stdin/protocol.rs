use super::{Admission, Event, WriteOutcome};
use crate::host::{ActiveChild, ChildIdentity, Lifecycle, TERM_TIMEOUT, command_request_id, send};
use rudder_native_protocol::Command;
use serde_json::json;
use std::sync::mpsc;
use std::time::Instant;

pub(crate) fn handle_write_command(
    writer: &Lifecycle,
    active: Option<&mut ActiveChild>,
    command: Command,
) {
    let request_id = command_request_id(&command).unwrap_or_default();
    let Command::WriteStdin {
        owner_token,
        write_id,
        data,
        ..
    } = &command
    else {
        unreachable!("write handler only accepts WriteStdin");
    };
    if let Err(code) = command.validate() {
        send_write_rejected(writer, &request_id, write_id.as_deref(), code);
        return;
    }
    let Some(child) = active else {
        send_write_rejected(
            writer,
            &request_id,
            write_id.as_deref(),
            "child_not_running",
        );
        return;
    };
    let identity_matches = child.identity.as_ref().is_some_and(|identity| {
        Some(&identity.request_id) == command_request_id(&command).as_ref()
            && Some(&identity.owner_token) == owner_token.as_ref()
    });
    if !identity_matches {
        send_write_rejected(
            writer,
            &request_id,
            write_id.as_deref(),
            "child_identity_mismatch",
        );
        return;
    }
    let Some(stdin) = child.interactive_stdin.as_mut() else {
        send_write_rejected(
            writer,
            &request_id,
            write_id.as_deref(),
            "interactive_stdin_not_enabled",
        );
        return;
    };
    let write_id = write_id.clone().expect("validated write id");
    let identity = child.identity.as_ref().expect("identity checked");
    match stdin.submit_write(write_id.clone(), data.clone()) {
        Admission::Queued | Admission::PendingDuplicate => {}
        Admission::Replay(WriteOutcome::RejectedBeforeWrite { error_code }) => {
            // A duplicate of a pre-write rejection receives the same receipt
            // shape as the original attempt; replay must not imply bytes may
            // have reached the child.
            send_write_rejected(writer, &request_id, Some(&write_id), error_code);
        }
        Admission::Replay(outcome) => {
            send_write_outcome(writer, identity, &write_id, outcome, true);
        }
        Admission::Rejected(outcome) => match outcome {
            WriteOutcome::RejectedBeforeWrite { error_code } => {
                send_write_rejected(writer, &request_id, Some(&write_id), error_code)
            }
            other => send_write_outcome(writer, identity, &write_id, other, false),
        },
        Admission::ConflictingId => {
            send_write_rejected(writer, &request_id, Some(&write_id), "write_id_conflict");
        }
    }
}

pub(crate) fn handle_close_command(
    writer: &Lifecycle,
    active: Option<&mut ActiveChild>,
    command: Command,
) {
    let request_id = command_request_id(&command).unwrap_or_default();
    let Command::CloseStdin {
        owner_token,
        close_id,
        ..
    } = &command
    else {
        unreachable!("close handler only accepts CloseStdin");
    };
    if let Err(code) = command.validate() {
        send_close_rejected(writer, &request_id, close_id.as_deref(), code);
        return;
    }
    let Some(child) = active else {
        send_close_rejected(
            writer,
            &request_id,
            close_id.as_deref(),
            "child_not_running",
        );
        return;
    };
    let identity_matches = child.identity.as_ref().is_some_and(|identity| {
        Some(&identity.request_id) == command_request_id(&command).as_ref()
            && Some(&identity.owner_token) == owner_token.as_ref()
    });
    if !identity_matches {
        send_close_rejected(
            writer,
            &request_id,
            close_id.as_deref(),
            "child_identity_mismatch",
        );
        return;
    }
    let Some(stdin) = child.interactive_stdin.as_mut() else {
        send_close_rejected(
            writer,
            &request_id,
            close_id.as_deref(),
            "interactive_stdin_not_enabled",
        );
        return;
    };
    let close_id = close_id.clone().expect("validated close id");
    match stdin.submit_close(close_id.clone()) {
        Admission::Queued | Admission::PendingDuplicate => {}
        Admission::Replay(WriteOutcome::Complete { .. }) => {
            send(
                writer,
                json!({
                    "type": "stdin-closed",
                    "requestId": request_id,
                    "ownerToken": owner_token,
                    "closeId": close_id,
                    "replayed": true,
                }),
            );
        }
        Admission::Replay(WriteOutcome::RejectedBeforeWrite { error_code }) => {
            send_close_rejected(writer, &request_id, Some(&close_id), error_code);
        }
        Admission::Replay(WriteOutcome::Failed { error_code, .. })
        | Admission::Rejected(WriteOutcome::RejectedBeforeWrite { error_code })
        | Admission::Rejected(WriteOutcome::Failed { error_code, .. }) => {
            send_close_rejected(writer, &request_id, Some(&close_id), error_code);
        }
        Admission::ConflictingId => {
            send_close_rejected(writer, &request_id, Some(&close_id), "close_id_conflict");
        }
        Admission::Rejected(WriteOutcome::Complete { .. }) => {
            send_close_rejected(writer, &request_id, Some(&close_id), "stdin_close_rejected");
        }
    }
}

pub(crate) fn drain_one_event(writer: &Lifecycle, child: &mut ActiveChild) {
    let event = child
        .interactive_stdin
        .as_mut()
        .and_then(|stdin| stdin.try_recv().ok().flatten());
    if let (Some(event), Some(identity)) = (event, child.identity.as_ref()) {
        send_event(writer, identity, event);
    }
}

pub(crate) fn finish_after_exit(writer: &Lifecycle, child: &mut ActiveChild) -> bool {
    let Some(stdin) = child.interactive_stdin.as_mut() else {
        return true;
    };
    stdin.shutdown();
    let Some(identity) = child.identity.as_ref() else {
        return false;
    };
    let deadline = Instant::now() + TERM_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match stdin.recv_timeout(remaining) {
            Ok(Event::WorkerDone) => return true,
            Ok(event) => send_event(writer, identity, event),
            Err(mpsc::RecvTimeoutError::Timeout) => return false,
            Err(mpsc::RecvTimeoutError::Disconnected) => return stdin.worker_done(),
        }
    }
}

fn send_write_rejected(
    writer: &Lifecycle,
    request_id: &str,
    write_id: Option<&str>,
    code: &'static str,
) {
    send(
        writer,
        json!({
            "type": "stdin-write-rejected",
            "requestId": request_id,
            "writeId": write_id,
            "phase": "before_write",
            "bytesWritten": 0,
            "errorCode": code,
        }),
    );
}

fn send_close_rejected(
    writer: &Lifecycle,
    request_id: &str,
    close_id: Option<&str>,
    code: &'static str,
) {
    send(
        writer,
        json!({
            "type": "stdin-close-rejected",
            "requestId": request_id,
            "closeId": close_id,
            "errorCode": code,
        }),
    );
}

fn send_write_outcome(
    writer: &Lifecycle,
    identity: &ChildIdentity,
    write_id: &str,
    outcome: WriteOutcome,
    replayed: bool,
) {
    match outcome {
        WriteOutcome::Complete { bytes_written } => {
            send(
                writer,
                json!({
                    "type": "stdin-write-complete",
                    "requestId": identity.request_id,
                    "ownerToken": identity.owner_token,
                    "writeId": write_id,
                    "bytesWritten": bytes_written,
                    "replayed": replayed,
                }),
            );
        }
        WriteOutcome::Failed {
            bytes_written,
            error_code,
        } => {
            send(
                writer,
                json!({
                    "type": "stdin-write-failed",
                    "requestId": identity.request_id,
                    "ownerToken": identity.owner_token,
                    "writeId": write_id,
                    "bytesWritten": bytes_written,
                    "errorCode": error_code,
                    "replayed": replayed,
                }),
            );
        }
        WriteOutcome::RejectedBeforeWrite { error_code } => {
            send_write_rejected(writer, &identity.request_id, Some(write_id), error_code);
        }
    }
}

fn send_event(writer: &Lifecycle, identity: &ChildIdentity, event: Event) {
    match event {
        Event::WriteFinished { write_id, outcome } => {
            send_write_outcome(writer, identity, &write_id, outcome, false);
        }
        Event::Closed { close_id } => {
            send(
                writer,
                json!({
                    "type": "stdin-closed",
                    "requestId": identity.request_id,
                    "ownerToken": identity.owner_token,
                    "closeId": close_id,
                }),
            );
        }
        Event::WorkerDone => {}
    }
}
