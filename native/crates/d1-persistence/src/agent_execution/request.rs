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
    pub fn matches(&self, claim: &OwnedAgentRun) -> bool {
        self.0.organization_id == claim.organization_id
            && self.0.run_id == claim.run_id
            && self.0.attempt_id == claim.attempt_id
            && self.0.owner_token == claim.owner_token
            && self.0.attempt_epoch == claim.attempt_epoch
    }
}

/// Persist the effective request transport before starting any network I/O.
/// An expired request owner can then be failed honestly as interrupted without
/// fabricating a process-host cleanup receipt or replaying remote work.
pub async fn record_request_started(
    pool: &sqlx::PgPool,
    claim: &OwnedAgentRun,
    runtime_type: &str,
) -> Result<bool, crate::goal_runs::GoalRunError> {
    if !matches!(runtime_type, "http" | "hermes_gateway" | "openclaw_gateway") {
        return Err(crate::goal_runs::GoalRunError::InvalidWakeup);
    }
    let mut tx = pool.begin().await?;
    super::mark_native_write(&mut tx).await?;
    let changed=sqlx::query("UPDATE heartbeat_run_attempts a SET checkpoint_json=COALESCE(checkpoint_json,'{}'::jsonb)||$6::jsonb WHERE a.org_id=$1::uuid AND a.run_id=$2::uuid AND a.id=$4::uuid AND a.owner_token=$3 AND a.attempt_epoch=$5 AND a.status='started' AND EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.org_id=a.org_id AND r.id=a.run_id AND r.execution_authority='native_rust' AND r.scene='heartbeat' AND r.status='running' AND r.execution_owner_token=$3 AND r.error_code IS DISTINCT FROM 'cancel_requested' AND r.execution_lease_expires_at>statement_timestamp() AND r.process_pid IS NULL AND r.process_started_at IS NULL)")
        .bind(&claim.organization_id).bind(&claim.run_id).bind(&claim.owner_token).bind(&claim.attempt_id).bind(claim.attempt_epoch).bind(serde_json::json!({"executionTransport":{"kind":"request","runtimeType":runtime_type,"state":"in_flight","remoteState":"unknown"}})).execute(&mut *tx).await?.rows_affected()==1;
    tx.commit().await?;
    Ok(changed)
}
