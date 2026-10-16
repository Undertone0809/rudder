use super::super::RuntimeError;
use super::{NativeChatTurnIdentity, validate_event_type, validate_safe_reference};
use serde::{Deserialize, Serialize};

/// Provider submission certainty. `Unknown` and `Indeterminate` always
/// reconnect to the existing event stream; neither authorizes resubmitting
/// user input.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeChatSubmissionPhase {
    PreSubmission,
    Accepted,
    Indeterminate,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeChatReconnectAction {
    PrepareSubmission,
    ReattachEventsOnly,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeChatTurnRequest {
    pub identity: NativeChatTurnIdentity,
    /// Set to `PreSubmission` only while the host can prove no provider send
    /// has begun. Persist `Indeterminate` before crossing that boundary so a
    /// restart cannot replay input after an unknown submission outcome.
    pub submission_phase: NativeChatSubmissionPhase,
}

impl NativeChatTurnRequest {
    pub fn new(
        identity: NativeChatTurnIdentity,
        submission_phase: NativeChatSubmissionPhase,
    ) -> Result<Self, RuntimeError> {
        identity.validate()?;
        Ok(Self {
            identity,
            submission_phase,
        })
    }
}

/// Safe event metadata only. No variant carries prompt text, tool arguments,
/// credentials, or arbitrary provider payload values. `safe_reference` must
/// be a non-secret opaque identifier supplied by the adapter.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeChatTurnEventKind {
    Commentary {
        event_type: String,
        safe_reference: Option<String>,
    },
    ToolActivity {
        event_type: String,
        safe_reference: Option<String>,
    },
    ProviderFinal {
        event_type: String,
        safe_reference: Option<String>,
    },
    SubmissionAccepted,
    SubmissionIndeterminate,
    Unknown {
        event_type: String,
        safe_reference: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeChatTurnEvent {
    pub identity: NativeChatTurnIdentity,
    pub sequence: u64,
    pub event: NativeChatTurnEventKind,
}

impl NativeChatTurnEvent {
    pub fn new(
        identity: NativeChatTurnIdentity,
        sequence: u64,
        event: NativeChatTurnEventKind,
    ) -> Result<Self, RuntimeError> {
        let value = Self {
            identity,
            sequence,
            event,
        };
        value.validate()?;
        Ok(value)
    }

    pub(super) fn validate(&self) -> Result<(), RuntimeError> {
        self.identity.validate()?;
        if self.sequence == 0 {
            return Err(RuntimeError::invalid(
                "native chat event sequence must be greater than zero",
            ));
        }
        match &self.event {
            NativeChatTurnEventKind::Commentary {
                event_type,
                safe_reference,
            }
            | NativeChatTurnEventKind::ToolActivity {
                event_type,
                safe_reference,
            }
            | NativeChatTurnEventKind::ProviderFinal {
                event_type,
                safe_reference,
            }
            | NativeChatTurnEventKind::Unknown {
                event_type,
                safe_reference,
            } => {
                validate_event_type(event_type)?;
                validate_safe_reference(safe_reference.as_deref())?;
            }
            NativeChatTurnEventKind::SubmissionAccepted
            | NativeChatTurnEventKind::SubmissionIndeterminate => {}
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeChatEventDisposition {
    Applied,
    Duplicate,
}
