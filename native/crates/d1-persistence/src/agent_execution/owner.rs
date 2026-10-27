//! One persisted native Run/Attempt owner and its one-use process capability.

use rudder_native_process_transport::{ConnectionLaunchPermit, HostCleanupProof};
use serde_json::{Value, json};

/// Created only by a committed D1 claim. This type intentionally has no Debug
/// implementation because its owner token is an execution capability.
pub struct OwnedAgentRun {
    pub organization_id: String,
    pub agent_id: String,
    pub run_id: String,
    pub wakeup_request_id: String,
    pub attempt_id: String,
    pub owner_token: String,
    pub attempt_epoch: i32,
    pub(crate) connection_epoch: i32,
    pub(crate) connection_claim_id: String,
    pub(crate) connection_launch_permit: Option<ConnectionLaunchPermit>,
    settlement: Settlement,
}

#[derive(Clone, Copy)]
pub(crate) enum Settlement {
    Goal,
    Agent,
}

impl OwnedAgentRun {
    #[allow(clippy::too_many_arguments)] // Keep the committed Run/Attempt identity together.
    pub(crate) fn from_claim(
        organization_id: String,
        agent_id: String,
        run_id: String,
        wakeup_request_id: String,
        attempt_id: String,
        owner_token: String,
        attempt_epoch: i32,
        settlement: Settlement,
    ) -> Self {
        let connection_claim_id = attempt_id.clone();
        let connection_launch_permit = ConnectionLaunchPermit::from_claim(
            run_id.clone(),
            attempt_id.clone(),
            owner_token.clone(),
            attempt_epoch,
            connection_claim_id.clone(),
        );
        Self {
            organization_id,
            agent_id,
            run_id,
            wakeup_request_id,
            attempt_id,
            owner_token,
            attempt_epoch,
            connection_epoch: attempt_epoch,
            connection_claim_id,
            connection_launch_permit: Some(connection_launch_permit),
            settlement,
        }
    }

    /// Read-only validation of the same exact process connection identity used
    /// by durable finalization. This cannot mint or replace cleanup evidence.
    pub fn matches_process_cleanup(&self, proof: &HostCleanupProof) -> bool {
        proof.matches_connection_claim(
            &self.run_id,
            &self.attempt_id,
            &self.owner_token,
            self.connection_epoch,
            &self.connection_claim_id,
        )
    }

    pub fn launch_permit_unspent(&self) -> bool {
        self.connection_launch_permit.is_some()
    }

    pub fn take_connection_launch_permit(&mut self) -> Option<ConnectionLaunchPermit> {
        self.connection_launch_permit.take()
    }

    pub(crate) fn is_generic(&self) -> bool {
        matches!(self.settlement, Settlement::Agent)
    }

    pub(crate) fn terminal_effects_intent(&self) -> Value {
        match self.settlement {
            Settlement::Goal => json!({"version":1,"goalRunCostSettlement":true}),
            Settlement::Agent => json!({"version":1,"nativeAgentRunSettlement":true}),
        }
    }

    pub(crate) fn cancellation_event_key(&self) -> String {
        let prefix = match self.settlement {
            Settlement::Goal => "goal-run-cancel",
            Settlement::Agent => "agent-run-cancel",
        };
        format!("{prefix}:{}", self.run_id)
    }

    pub(crate) fn terminal_event_key(&self) -> String {
        let prefix = match self.settlement {
            Settlement::Goal => "goal-run-terminal",
            Settlement::Agent => "agent-run-terminal",
        };
        format!("{prefix}:{}", self.run_id)
    }
}

/// Copy of the existing durable owner identity for a concurrent output/approval
/// observer. It carries no launch or request-execution capability. Every write
/// through this snapshot must revalidate the same persisted Run and Attempt.
#[derive(Clone)]
pub struct AgentRunObserver {
    pub(crate) organization_id: String,
    pub(crate) agent_id: String,
    pub(crate) run_id: String,
    pub(crate) attempt_id: String,
    pub(crate) owner_token: String,
    pub(crate) attempt_epoch: i32,
}
impl OwnedAgentRun {
    pub fn observer(&self) -> AgentRunObserver {
        AgentRunObserver {
            organization_id: self.organization_id.clone(),
            agent_id: self.agent_id.clone(),
            run_id: self.run_id.clone(),
            attempt_id: self.attempt_id.clone(),
            owner_token: self.owner_token.clone(),
            attempt_epoch: self.attempt_epoch,
        }
    }
}
impl AgentRunObserver {
    pub fn organization_id(&self) -> &str {
        &self.organization_id
    }
    pub fn agent_id(&self) -> &str {
        &self.agent_id
    }
    pub fn run_id(&self) -> &str {
        &self.run_id
    }
    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }
}
