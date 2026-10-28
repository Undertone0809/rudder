use rudder_codex_app_server::CleanupReceipt;
use rudder_hermes_acp::HermesCleanupReceipt;
use rudder_native_process_transport::HostCleanupProof;
use rudder_pi_rpc::PiCleanupReceipt;
use rudder_runtime_core::native_chat::{
    ClaudeSessionSelector, CursorSessionSelector, HermesSessionSelector, NativeChatProtocolPhase,
    NativeChatProvider, OpenCodeSessionSelector, PiSessionSelector,
};
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
    pub(super) runtime_type: String,
    pub(super) binding_id: String,
    pub(super) segment_id: String,
    pub(super) selected_model: Option<String>,
    pub(super) generation_attempt_epoch: i32,
    pub(super) run_attempt_epoch: i32,
    pub(super) connection_epoch: i32,
    /// Random claim capability shared only with the move-only launch permit.
    /// It distinguishes transports that otherwise share all durable identity.
    pub(super) connection_claim_id: String,
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

    pub fn runtime_type(&self) -> &str {
        &self.runtime_type
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

    /// Match a still-owned launch capability to every private claim dimension.
    /// This proves no launch; it does not create process cleanup evidence.
    pub fn matches_unspent_launch_permit(
        &self,
        permit: &rudder_codex_app_server::ConnectionLaunchPermit,
    ) -> bool {
        let id = self.identity();
        permit.matches_connection_claim(
            id.run_id,
            id.attempt_id,
            self.run_execution_owner_token(),
            id.connection_epoch,
            &self.connection_claim_id,
        )
    }

    pub fn matches_cleanup_receipt(&self, cleanup: &CleanupReceipt) -> bool {
        let identity = self.identity();
        cleanup.matches_connection_claim(
            identity.run_id,
            identity.attempt_id,
            self.run_execution_owner_token(),
            identity.connection_epoch,
            &self.connection_claim_id,
        )
    }

    pub fn matches_hermes_cleanup_receipt(&self, cleanup: &HermesCleanupReceipt) -> bool {
        let identity = self.identity();
        cleanup.matches_connection_claim(
            identity.run_id,
            identity.attempt_id,
            self.run_execution_owner_token(),
            identity.connection_epoch,
            &self.connection_claim_id,
        )
    }

    pub fn matches_pi_cleanup_receipt(&self, cleanup: &PiCleanupReceipt) -> bool {
        let identity = self.identity();
        cleanup.matches_connection_claim(
            identity.run_id,
            identity.attempt_id,
            self.run_execution_owner_token(),
            identity.connection_epoch,
            &self.connection_claim_id,
        )
    }

    pub fn matches_host_cleanup_proof(&self, cleanup: &HostCleanupProof) -> bool {
        let identity = self.identity();
        cleanup.matches_connection_claim(
            identity.run_id,
            identity.attempt_id,
            self.run_execution_owner_token(),
            identity.connection_epoch,
            &self.connection_claim_id,
        )
    }
}

impl fmt::Debug for ExecutionFence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExecutionFence")
            .field("identity", &self.identity())
            .field("connection_claim_id", &"[REDACTED]")
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
    pub provider: NativeChatProvider,
    pub phase: NativeChatProtocolPhase,
    pub revision: u64,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub pi_session: Option<PiSessionSelector>,
    pub pi_turn_entry_id: Option<String>,
    pub hermes_session: Option<HermesSessionSelector>,
    pub hermes_prompt_request_id: Option<u64>,
    pub claude_session: Option<ClaudeSessionSelector>,
    pub claude_prompt_request_id: Option<String>,
    pub opencode_session: Option<OpenCodeSessionSelector>,
    pub opencode_prompt_request_id: Option<String>,
    pub cursor_session: Option<CursorSessionSelector>,
    pub cursor_prompt_request_id: Option<String>,
    pub transport_session: Option<String>,
    pub transport_request_id: Option<String>,
}

impl fmt::Debug for CheckpointSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CheckpointSnapshot")
            .field("phase", &self.phase)
            .field("provider", &self.provider)
            .field("revision", &self.revision)
            .field("has_thread_id", &self.thread_id.is_some())
            .field("has_turn_id", &self.turn_id.is_some())
            .field("has_hermes_session", &self.hermes_session.is_some())
            .field(
                "has_hermes_prompt_request",
                &self.hermes_prompt_request_id.is_some(),
            )
            .field("has_claude_session", &self.claude_session.is_some())
            .field("has_opencode_session", &self.opencode_session.is_some())
            .field("has_cursor_session", &self.cursor_session.is_some())
            .finish()
    }
}
