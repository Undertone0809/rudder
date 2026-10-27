//! One persisted native Run/Attempt owner and its one-use process capability.

use rudder_native_process_transport::ConnectionLaunchPermit;
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
