//! Bounded native-chat event projection.
//!
//! This module reduces provider/host event metadata into evidence that the
//! existing Run Attempt and [`super::ChatGenerationStatus`] authorities can
//! consume. It does not create, schedule, or transition a Run or generation.
//! Event payload text and request values are deliberately absent from this
//! wire contract; unknown events retain only a machine event type and an
//! optional bounded opaque reference.

mod checkpoint;
mod event;
mod identity;
mod protocol;
mod reducer;
mod validation;

pub use checkpoint::{
    NativeChatExecutionTerminal, NativeChatTurnCheckpoint, NativeChatTurnProjection,
};
pub use event::{
    NativeChatEventDisposition, NativeChatReconnectAction, NativeChatSubmissionPhase,
    NativeChatTurnEvent, NativeChatTurnEventKind, NativeChatTurnRequest,
};
pub use identity::NativeChatTurnIdentity;
pub use protocol::{
    ClaudeSessionSelector, CursorSessionSelector, HermesSessionSelector,
    MAX_NATIVE_CHAT_PROVIDER_ID_BYTES, NativeChatProtocolCheckpoint, NativeChatProtocolPhase,
    NativeChatProtocolStart, NativeChatProvider, OpenCodeSessionSelector, PiSessionSelector,
};
pub use reducer::NativeChatTurnReducer;

pub const NATIVE_CHAT_TURN_PROTOCOL_VERSION: u16 = 1;
pub const MAX_NATIVE_CHAT_EVENT_TYPE_BYTES: usize = 128;
pub const MAX_NATIVE_CHAT_SAFE_REFERENCE_BYTES: usize = 255;
pub const MAX_NATIVE_CHAT_REPLAY_EVENTS: usize = 256;

use validation::{
    reconciliation_required, replay_conflict, stale_identity, validate_event_type,
    validate_evidence_sequence, validate_safe_reference,
};
