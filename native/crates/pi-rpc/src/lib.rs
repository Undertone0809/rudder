//! Owned Pi RPC transport and exact session-tree reads.
//!
//! Pi's JSONL/RPC observations remain provider-specific. This crate owns no
//! database authority and cannot create a launch permit or cleanup proof.

mod receipts;
mod rpc;
mod session;
mod strict_json;

pub use receipts::{PiCleanupReceipt, PiTurnReceipt, PiTurnStatus};
pub use rpc::{
    PiCommand, PiEvent, PiProfileMode, PiResponse, PiRpcMessage, PiRpcTransport, PiTransportError,
    ProcessLaunch,
};
pub use session::{PiSessionEntry, PiSessionTree, PiSessionTreeError, PiSessionView};

pub use rudder_native_process_transport::{
    ConnectionIdentity, ConnectionLaunchPermit, ConnectionReceipt, HostCleanupProof,
};
