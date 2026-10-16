//! Private Rust ownership and durable provider-effect checkpoints for Native Chat.
//!
//! These APIs accept verified actors and typed in-process fences. They are not
//! HTTP DTOs and deliberately have no serde implementation.

mod checkpoint;
mod claim;
mod context;
mod lease;
mod submission;
mod types;

pub use checkpoint::{
    CheckpointReceipt, CheckpointTransition, EffectKind, EffectPermit, advance_checkpoint,
    current_checkpoint,
};
pub use claim::{ClaimedExecution, claim};
pub use lease::{LeaseReceipt, renew_lease};
pub use submission::{SubmissionInput, load_submission};
pub use types::{CheckpointSnapshot, ExecutionFence, ExecutionIdentity};

use crate::runtime_bindings::Error;

pub type Result<T> = std::result::Result<T, Error>;

fn http(status: u16, message: impl Into<String>) -> Error {
    Error::Http(status, message.into())
}

const NATIVE_WRITE_MARKER: &str = "native_chat:execution";
const GENERATION_CONTROL_LEASE_SECONDS: f64 = 30.0;
const RUN_EXECUTION_LEASE_SECONDS: f64 = 60.0;
