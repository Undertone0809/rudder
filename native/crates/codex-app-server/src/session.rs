use crate::{Message, ProtocolError, RequestId, RpcError, encode_request};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;

pub const MAX_PENDING_REQUESTS: usize = 64;

/// Registered request identity and its single NDJSON frame. Sending this frame
/// still requires the durable supervisor's pre-submission checkpoint.
#[derive(PartialEq)]
pub struct PreparedRequest {
    id: RequestId,
    frame: Vec<u8>,
}

impl PreparedRequest {
    pub fn id(&self) -> &RequestId {
        &self.id
    }
    pub fn as_bytes(&self) -> &[u8] {
        &self.frame
    }
    pub fn into_bytes(self) -> Vec<u8> {
        self.frame
    }
}

impl fmt::Debug for PreparedRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedRequest")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("Codex RPC session no longer accepts messages")]
    Closed,
    #[error("Codex RPC pending request limit reached")]
    PendingLimit,
    #[error("Codex RPC response does not match an outstanding request")]
    UnmatchedResponse,
}

/// A correlated wire observation, not a durable Run or provider-turn outcome.
/// Server requests remain requests and require a separate governed decision.
#[derive(Clone, PartialEq)]
pub enum SessionObservation {
    Completed {
        id: RequestId,
        method: String,
        outcome: Result<Value, RpcError>,
    },
    Incoming(Message),
}

impl fmt::Debug for SessionObservation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Completed { .. } => formatter.debug_struct("Completed").finish_non_exhaustive(),
            Self::Incoming(message) => message.fmt(formatter),
        }
    }
}

/// Exact request correlation for one owned App Server process/connection.
///
/// Create a new session for each process epoch and never feed old-epoch output
/// into it. IDs are monotonically allocated and never recycled within a session.
/// A prepared request is registered *before* its frame is handed to transport.
/// Transport failure, timeout, or EOF must close the session; it must never
/// remove a request and retry user input. The durable supervisor determines
/// reconciliation from its checkpoint and process-quiescence evidence.
#[derive(Default)]
pub struct RpcSession {
    next_id: i64,
    pending: BTreeMap<i64, String>,
    closed: bool,
}

impl RpcSession {
    pub fn prepare(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<PreparedRequest, SessionError> {
        self.ensure_open()?;
        if self.pending.len() >= MAX_PENDING_REQUESTS {
            return Err(SessionError::PendingLimit);
        }
        let Some(next) = self.next_id.checked_add(1) else {
            self.closed = true;
            return Err(SessionError::Closed);
        };
        let id = RequestId::Number(self.next_id);
        let frame = encode_request(&id, method, params)?;
        self.pending.insert(self.next_id, method.to_owned());
        self.next_id = next;
        Ok(PreparedRequest { id, frame })
    }

    pub fn observe(&mut self, message: Message) -> Result<SessionObservation, SessionError> {
        self.ensure_open()?;
        let (id, outcome) = match message {
            Message::Response { id, result } => (id, Ok(result)),
            Message::Error { id, error } => (id, Err(error)),
            incoming => return Ok(SessionObservation::Incoming(incoming)),
        };
        let method = match &id {
            RequestId::Number(id) => self.pending.remove(id),
            RequestId::Text(_) => None,
        };
        let Some(method) = method else {
            // Unknown, duplicate and differently-typed IDs cannot be used to
            // claim success. Preserve all remaining pending entries for recovery.
            self.closed = true;
            return Err(SessionError::UnmatchedResponse);
        };
        Ok(SessionObservation::Completed {
            id,
            method,
            outcome,
        })
    }

    /// Stops wire progress without claiming that any pending operation failed
    /// before submission. Pending IDs remain observable for reconciliation.
    pub fn close(&mut self) {
        self.closed = true;
    }

    pub fn pending_ids(&self) -> impl Iterator<Item = RequestId> + '_ {
        self.pending.keys().copied().map(RequestId::Number)
    }

    pub fn is_closed(&self) -> bool {
        self.closed
    }

    fn ensure_open(&self) -> Result<(), SessionError> {
        if self.closed {
            Err(SessionError::Closed)
        } else {
            Ok(())
        }
    }
}
