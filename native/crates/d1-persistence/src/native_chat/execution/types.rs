use rudder_runtime_core::native_chat::NativeChatProtocolPhase;
use std::fmt;

/// Stable database identity and non-serializable owner capabilities for one
/// admitted Native Chat execution. Owner tokens are intentionally redacted
/// from `Debug` and can be read only by the internal supervisor.
#[derive(Clone, Eq, PartialEq)]
pub struct ExecutionFence {
    pub(super) organization_id: String,
    pub(super) conversation_id: String,
    pub(super) generation_id: String,
    pub(super) run_id: String,
    pub(super) attempt_id: String,
    pub(super) agent_id: String,
    pub(super) binding_id: String,
    pub(super) segment_id: String,
    pub(super) generation_attempt_epoch: i32,
    pub(super) run_attempt_epoch: i32,
    pub(super) connection_epoch: i32,
    pub(super) generation_owner_token: String,
    pub(super) run_owner_token: String,
}

impl ExecutionFence {
    pub fn identity(&self) -> ExecutionIdentity<'_> {
        ExecutionIdentity {
            organization_id: &self.organization_id,
            conversation_id: &self.conversation_id,
            generation_id: &self.generation_id,
            run_id: &self.run_id,
            attempt_id: &self.attempt_id,
            agent_id: &self.agent_id,
            generation_attempt_epoch: self.generation_attempt_epoch,
            run_attempt_epoch: self.run_attempt_epoch,
            connection_epoch: self.connection_epoch,
        }
    }

    /// The generation-control capability is used only by the trusted local
    /// supervisor. Never place it in JSON, logs, or user-facing activity.
    pub fn generation_control_owner_token(&self) -> &str {
        &self.generation_owner_token
    }

    /// The Run execution capability is used only by the trusted local
    /// supervisor. Never place it in JSON, logs, or user-facing activity.
    pub fn run_execution_owner_token(&self) -> &str {
        &self.run_owner_token
    }
}

impl fmt::Debug for ExecutionFence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExecutionFence")
            .field("identity", &self.identity())
            .field("generation_owner_token", &"[REDACTED]")
            .field("run_owner_token", &"[REDACTED]")
            .finish()
    }
}

/// Safe identity projection of an execution fence. This omits owner tokens.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ExecutionIdentity<'a> {
    pub organization_id: &'a str,
    pub conversation_id: &'a str,
    pub generation_id: &'a str,
    pub run_id: &'a str,
    pub attempt_id: &'a str,
    pub agent_id: &'a str,
    pub generation_attempt_epoch: i32,
    pub run_attempt_epoch: i32,
    pub connection_epoch: i32,
}

/// Durable safe view of the provider-effect checkpoint. Opaque provider IDs
/// are preserved exactly; credentials and owner tokens are not represented.
#[derive(Clone, Eq, PartialEq)]
pub struct CheckpointSnapshot {
    pub phase: NativeChatProtocolPhase,
    pub revision: u64,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
}

impl fmt::Debug for CheckpointSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CheckpointSnapshot")
            .field("phase", &self.phase)
            .field("revision", &self.revision)
            .field("has_thread_id", &self.thread_id.is_some())
            .field("has_turn_id", &self.turn_id.is_some())
            .finish()
    }
}
