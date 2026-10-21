//! Owned Hermes ACP process transport.
//!
//! ACP session IDs and prompt receipts remain Hermes-specific. This crate
//! delegates process ownership to `rudder-native-process-transport`; it does
//! not create a Run claim or fabricate cleanup evidence.

mod rpc;
mod strict_json;

pub use rpc::{
    HermesAcpTransport, HermesCancellation, HermesCleanupReceipt, HermesInstructionBootstrap,
    HermesLaunch, HermesProgressKind, HermesProgressReceipt, HermesPromptErrorAfterCancel,
    HermesSessionSelector, HermesSessionStartReceipt, HermesStopReason, HermesTransportError,
    HermesTurnReceipt, HermesUsage, HermesUsageScope, MAX_EPHEMERAL_INSTRUCTION_BYTES,
    resolve_instruction_bootstrap,
};
pub use rudder_native_process_transport::{
    ConnectionIdentity, ConnectionLaunchPermit, ConnectionReceipt,
};
