//! Bounded selection from Codex's persisted `thread/read` response.
//!
//! This is a provider-history observation only. It does not start or resume a
//! thread, submit a turn, or decide that a Native Chat turn is complete.

use crate::{MAX_FRAME_BYTES, Message, RequestId};
use serde_json::Value;
use std::fmt;

const MAX_DURABLE_ID_BYTES: usize = 4096;

/// Result of looking up one caller-supplied durable turn ID in a thread read.
#[derive(Clone, PartialEq)]
pub enum ThreadReadSelection {
    /// The returned turn is the unique turn whose `id` exactly matched the
    /// caller-supplied durable identity.
    Turn(Value),
    /// The response was valid, but it did not contain the requested turn ID.
    UnknownTurn,
    /// The provider does not implement `thread/read` on this connection.
    Unsupported,
}

impl fmt::Debug for ThreadReadSelection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Turn(_) => formatter.write_str("ThreadReadSelection::Turn(<redacted>)"),
            Self::UnknownTurn => formatter.write_str("ThreadReadSelection::UnknownTurn"),
            Self::Unsupported => formatter.write_str("ThreadReadSelection::Unsupported"),
        }
    }
}

/// Safe, bounded failure states for reading one exact persisted turn.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ThreadReadError {
    #[error("Codex thread/read frame exceeded its bound")]
    Oversized,
    #[error("Codex thread/read response is malformed or does not match its target")]
    Malformed,
    #[error("Codex rejected the thread/read request")]
    ProviderRejected,
}

/// Select one turn from a complete, already-correlated JSON-RPC response frame.
///
/// `includeTurns: true` must be sent in the associated `thread/read` request.
/// The caller still owns request registration, transport deadlines, durable
/// checkpointing and any pagination needed for large histories. This function
/// bounds and parses the supplied frame, verifies the exact thread and turn
/// identities, and never substitutes another (including the newest) turn.
pub fn select_thread_read_turn(
    response_frame: &[u8],
    expected_request_id: &RequestId,
    expected_thread_id: &str,
    durable_turn_id: &str,
) -> Result<ThreadReadSelection, ThreadReadError> {
    if response_frame.len() > MAX_FRAME_BYTES
        || !valid_durable_id(expected_thread_id)
        || !valid_durable_id(durable_turn_id)
    {
        return Err(if response_frame.len() > MAX_FRAME_BYTES {
            ThreadReadError::Oversized
        } else {
            ThreadReadError::Malformed
        });
    }

    let message = Message::decode(response_frame).map_err(|_| ThreadReadError::Malformed)?;
    let result = match message {
        Message::Response { id, result } if &id == expected_request_id => result,
        Message::Error { id, error } if &id == expected_request_id => {
            return if error.code == -32601 {
                Ok(ThreadReadSelection::Unsupported)
            } else {
                Err(ThreadReadError::ProviderRejected)
            };
        }
        _ => return Err(ThreadReadError::Malformed),
    };

    let thread = result
        .get("thread")
        .and_then(Value::as_object)
        .ok_or(ThreadReadError::Malformed)?;
    if thread.get("id").and_then(Value::as_str) != Some(expected_thread_id) {
        return Err(ThreadReadError::Malformed);
    }
    let turns = thread
        .get("turns")
        .and_then(Value::as_array)
        .ok_or(ThreadReadError::Malformed)?;

    let mut selected = None;
    for turn in turns {
        let object = turn.as_object().ok_or(ThreadReadError::Malformed)?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_durable_id(id))
            .ok_or(ThreadReadError::Malformed)?;
        if !object.get("items").is_some_and(Value::is_array)
            || !object.get("status").is_some_and(Value::is_string)
        {
            return Err(ThreadReadError::Malformed);
        }
        if id == durable_turn_id {
            if selected.is_some() {
                return Err(ThreadReadError::Malformed);
            }
            selected = Some(turn.clone());
        }
    }

    Ok(match selected {
        Some(turn) => ThreadReadSelection::Turn(turn),
        None => ThreadReadSelection::UnknownTurn,
    })
}

pub(crate) fn valid_durable_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_DURABLE_ID_BYTES
}
