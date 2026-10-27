//! Ownership proof for a client-side asynchronous runtime request.
//!
//! This proves only that the owned future settled. It never asserts that an
//! external service cancelled a remote job. Dropping the future yields no proof.

use super::OwnedAgentRun;
use std::future::Future;

/// Mutually exclusive with the same Run's process launch capability.
/// No Clone/Debug/Serialize: the owner must consume this exact capability.
pub struct OwnedRequestExecution {
    organization_id: String,
    run_id: String,
    attempt_id: String,
    owner_token: String,
    attempt_epoch: i32,
}

/// Minted only when the owned request future returned. Cancellation that drops
/// the request owner cannot manufacture a successful settlement receipt.
pub struct SettledRequestProof(OwnedRequestExecution);

impl OwnedAgentRun {
    pub fn take_request_execution(&mut self) -> Option<OwnedRequestExecution> {
        // Both runtime classes consume the same one-use launch authority.
        // An HTTP request cannot coexist with a process launched by this claim.
        self.connection_launch_permit.take()?;
        Some(OwnedRequestExecution {
            organization_id: self.organization_id.clone(),
            run_id: self.run_id.clone(),
            attempt_id: self.attempt_id.clone(),
            owner_token: self.owner_token.clone(),
            attempt_epoch: self.attempt_epoch,
        })
    }
}

impl OwnedRequestExecution {
    pub async fn settle<F: Future>(self, request: F) -> (F::Output, SettledRequestProof) {
        let result = request.await;
        (result, SettledRequestProof(self))
    }
}

impl SettledRequestProof {
    pub(crate) fn matches(&self, claim: &OwnedAgentRun) -> bool {
        self.0.organization_id == claim.organization_id
            && self.0.run_id == claim.run_id
            && self.0.attempt_id == claim.attempt_id
            && self.0.owner_token == claim.owner_token
            && self.0.attempt_epoch == claim.attempt_epoch
    }
}
