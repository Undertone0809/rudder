//! Opaque connection ownership and cleanup evidence.

use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_CONNECTION_RECEIPT_ID: AtomicU64 = AtomicU64::new(1);

/// One-use D1 claim capability consumed by exactly one owned host launch.
/// Fields are deliberately private and the type has no `Clone`, `Debug`, or
/// serialization implementation.
pub struct ConnectionLaunchPermit {
    run_id: String,
    attempt_id: String,
    owner_token: String,
    connection_epoch: i32,
    claim_id: String,
}

impl ConnectionLaunchPermit {
    /// The caller must hold the random claim ID minted by the successful D1
    /// execution claim. The permit is consumed by `OwnedHost`.
    pub fn from_claim(
        run_id: String,
        attempt_id: String,
        owner_token: String,
        connection_epoch: i32,
        claim_id: String,
    ) -> Self {
        Self {
            run_id,
            attempt_id,
            owner_token,
            connection_epoch,
            claim_id,
        }
    }

    pub fn matches_launch(&self, run_id: &str, attempt_id: &str, owner_token: &str) -> bool {
        self.connection_epoch > 0
            && !self.claim_id.is_empty()
            && self.run_id == run_id
            && self.attempt_id == attempt_id
            && self.owner_token == owner_token
    }

    pub(crate) fn into_identity(
        self,
        run_id: &str,
        attempt_id: &str,
        owner_token: &str,
    ) -> Option<ConnectionIdentity> {
        self.matches_launch(run_id, attempt_id, owner_token)
            .then(|| {
                ConnectionIdentity::new(
                    self.run_id,
                    self.attempt_id,
                    self.owner_token,
                    Some(self.connection_epoch),
                    Some(self.claim_id),
                )
            })
    }
}

/// Opaque identity for one concrete owned connection. It is not cleanup
/// evidence and cannot be constructed from a serialized receipt.
pub struct ConnectionIdentity {
    run_id: String,
    attempt_id: String,
    owner_token: String,
    connection_epoch: Option<i32>,
    connection_claim_id: Option<String>,
    connection_receipt_id: String,
}

impl ConnectionIdentity {
    /// Create an unclaimed identity for compatibility transports and protocol
    /// tests. It cannot match an execution claim or produce cleanup evidence.
    pub fn unbound(run_id: String, attempt_id: String, owner_token: String) -> Self {
        Self::new(run_id, attempt_id, owner_token, None, None)
    }

    fn new(
        run_id: String,
        attempt_id: String,
        owner_token: String,
        connection_epoch: Option<i32>,
        connection_claim_id: Option<String>,
    ) -> Self {
        let counter = NEXT_CONNECTION_RECEIPT_ID.fetch_add(1, Ordering::Relaxed);
        Self {
            run_id,
            attempt_id,
            owner_token,
            connection_epoch,
            connection_claim_id,
            connection_receipt_id: format!("{}-{counter}", std::process::id()),
        }
    }

    pub fn connection_receipt_id(&self) -> &str {
        &self.connection_receipt_id
    }
    pub fn connection_epoch(&self) -> Option<i32> {
        self.connection_epoch
    }

    pub fn matches_execution(&self, run_id: &str, attempt_id: &str, owner_token: &str) -> bool {
        self.run_id == run_id && self.attempt_id == attempt_id && self.owner_token == owner_token
    }

    /// Compatibility spelling used by protocol-specific receipts.
    pub fn matches(&self, run_id: &str, attempt_id: &str, owner_token: &str) -> bool {
        self.matches_execution(run_id, attempt_id, owner_token)
    }

    pub fn matches_connection_claim(
        &self,
        run_id: &str,
        attempt_id: &str,
        owner_token: &str,
        connection_epoch: i32,
        claim_id: &str,
    ) -> bool {
        self.matches_execution(run_id, attempt_id, owner_token)
            && self.connection_epoch == Some(connection_epoch)
            && self.connection_claim_id.as_deref() == Some(claim_id)
    }

    pub fn connection_receipt(&self) -> ConnectionReceipt {
        ConnectionReceipt {
            identity: self.duplicate_identity(),
        }
    }

    /// Duplicate only this non-authoritative identity for an adapter receipt.
    /// This does not create or duplicate cleanup proof.
    pub fn duplicate_identity(&self) -> Self {
        Self {
            run_id: self.run_id.clone(),
            attempt_id: self.attempt_id.clone(),
            owner_token: self.owner_token.clone(),
            connection_epoch: self.connection_epoch,
            connection_claim_id: self.connection_claim_id.clone(),
            connection_receipt_id: self.connection_receipt_id.clone(),
        }
    }

    pub(crate) fn same_identity(&self, other: &Self) -> bool {
        self.run_id == other.run_id
            && self.attempt_id == other.attempt_id
            && self.owner_token == other.owner_token
            && self.connection_epoch == other.connection_epoch
            && self.connection_claim_id == other.connection_claim_id
            && self.connection_receipt_id == other.connection_receipt_id
    }
}

/// Opaque identity for a connection, useful only with the matching execution
/// fence. It does not prove the provider process has stopped.
pub struct ConnectionReceipt {
    identity: ConnectionIdentity,
}

impl ConnectionReceipt {
    pub fn matches_execution(&self, run_id: &str, attempt_id: &str, owner_token: &str) -> bool {
        self.identity
            .matches_execution(run_id, attempt_id, owner_token)
    }
    pub fn connection_epoch(&self) -> Option<i32> {
        self.identity.connection_epoch()
    }
    pub fn connection_receipt_id(&self) -> &str {
        self.identity.connection_receipt_id()
    }
    pub fn matches_connection_claim(
        &self,
        run_id: &str,
        attempt_id: &str,
        owner_token: &str,
        connection_epoch: i32,
        claim_id: &str,
    ) -> bool {
        self.identity.matches_connection_claim(
            run_id,
            attempt_id,
            owner_token,
            connection_epoch,
            claim_id,
        )
    }
}

/// Cleanup proof minted only by `OwnedHost` after it observes a matching host
/// terminal lifecycle event with both cleanup flags set.
pub struct HostCleanupProof {
    identity: ConnectionIdentity,
}

impl HostCleanupProof {
    pub(crate) fn from_owned_host(identity: ConnectionIdentity) -> Self {
        Self { identity }
    }

    pub fn matches_execution(&self, run_id: &str, attempt_id: &str, owner_token: &str) -> bool {
        self.identity
            .matches_execution(run_id, attempt_id, owner_token)
    }
    pub fn connection_receipt_id(&self) -> &str {
        self.identity.connection_receipt_id()
    }
    pub fn connection_epoch(&self) -> Option<i32> {
        self.identity.connection_epoch()
    }
    pub fn connection_receipt(&self) -> ConnectionReceipt {
        self.identity.connection_receipt()
    }
    pub fn matches_connection_claim(
        &self,
        run_id: &str,
        attempt_id: &str,
        owner_token: &str,
        connection_epoch: i32,
        claim_id: &str,
    ) -> bool {
        self.identity.matches_connection_claim(
            run_id,
            attempt_id,
            owner_token,
            connection_epoch,
            claim_id,
        )
    }
    pub fn matches_identity(&self, identity: &ConnectionIdentity) -> bool {
        self.identity.same_identity(identity)
    }
}
