//! Codex App Server JSON-RPC wire transport primitives.
//!
//! The Rust supervisor owns admission, profile/permission decisions, durable
//! checkpoints, retries and terminal state. This crate does not spawn a process,
//! write the database, approve server requests or retry user input. In particular,
//! receiving a provider response is not Run execution-terminal authority.

mod framing;
mod message;
mod session;
mod value;

pub use framing::{FrameDecoder, MAX_CHUNK_BYTES, MAX_FRAME_BYTES};
pub use message::{Message, RequestId, RpcError, encode_notification, encode_request};
pub use session::{
    MAX_PENDING_REQUESTS, PreparedRequest, RpcSession, SessionError, SessionObservation,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ProtocolError {
    #[error("Codex protocol chunk exceeds its bound")]
    ChunkTooLarge,
    #[error("Codex protocol frame exceeds its bound")]
    FrameTooLarge,
    #[error("Codex protocol stream ended inside a frame")]
    TruncatedFrame,
    #[error("Codex protocol frame is invalid")]
    InvalidFrame,
    #[error("Codex protocol message is invalid")]
    InvalidMessage,
    #[error("Codex protocol stream no longer accepts input")]
    StreamFailed,
}
