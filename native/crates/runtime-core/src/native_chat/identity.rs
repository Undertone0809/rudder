use super::super::{MAX_IDENTITY_PART_BYTES, RuntimeError, bounded_string};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeChatTurnIdentity {
    pub org_id: String,
    pub conversation_id: String,
    pub segment_id: String,
    pub generation_id: String,
    pub binding_id: String,
    pub run_id: String,
    pub attempt_id: String,
    /// Epoch of the Chat Generation's provider-control attempt.
    pub generation_attempt_epoch: u64,
    /// Epoch of the current durable heartbeat Run Attempt fence.
    pub run_attempt_epoch: u64,
    pub connection_epoch: u64,
}

impl NativeChatTurnIdentity {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        org_id: impl Into<String>,
        conversation_id: impl Into<String>,
        segment_id: impl Into<String>,
        generation_id: impl Into<String>,
        binding_id: impl Into<String>,
        run_id: impl Into<String>,
        attempt_id: impl Into<String>,
        generation_attempt_epoch: u64,
        run_attempt_epoch: u64,
        connection_epoch: u64,
    ) -> Result<Self, RuntimeError> {
        let identity = Self {
            org_id: bounded_string(org_id, "org_id", MAX_IDENTITY_PART_BYTES)?,
            conversation_id: bounded_string(
                conversation_id,
                "conversation_id",
                MAX_IDENTITY_PART_BYTES,
            )?,
            segment_id: bounded_string(segment_id, "segment_id", MAX_IDENTITY_PART_BYTES)?,
            generation_id: bounded_string(generation_id, "generation_id", MAX_IDENTITY_PART_BYTES)?,
            binding_id: bounded_string(binding_id, "binding_id", MAX_IDENTITY_PART_BYTES)?,
            run_id: bounded_string(run_id, "run_id", MAX_IDENTITY_PART_BYTES)?,
            attempt_id: bounded_string(attempt_id, "attempt_id", MAX_IDENTITY_PART_BYTES)?,
            generation_attempt_epoch,
            run_attempt_epoch,
            connection_epoch,
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn validate(&self) -> Result<(), RuntimeError> {
        for (value, field) in [
            (&self.org_id, "org_id"),
            (&self.conversation_id, "conversation_id"),
            (&self.segment_id, "segment_id"),
            (&self.generation_id, "generation_id"),
            (&self.binding_id, "binding_id"),
            (&self.run_id, "run_id"),
            (&self.attempt_id, "attempt_id"),
        ] {
            bounded_string(value.clone(), field, MAX_IDENTITY_PART_BYTES)?;
        }
        if self.generation_attempt_epoch == 0 {
            return Err(RuntimeError::invalid(
                "native chat generation attempt epoch must be greater than zero",
            ));
        }
        if self.run_attempt_epoch == 0 {
            return Err(RuntimeError::invalid(
                "native chat Run attempt epoch must be greater than zero",
            ));
        }
        if self.connection_epoch == 0 {
            return Err(RuntimeError::invalid(
                "native chat connection epoch must be greater than zero",
            ));
        }
        Ok(())
    }
}
