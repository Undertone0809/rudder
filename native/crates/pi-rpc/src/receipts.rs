//! Opaque, owned-connection Pi turn and cleanup evidence.

use rudder_native_process_transport::{ConnectionIdentity, ConnectionReceipt, HostCleanupProof};
use std::fmt;

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum PiTurnStatus {
    Completed,
    Failed,
    Interrupted,
}

impl fmt::Debug for PiTurnStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Completed => "Completed",
            Self::Failed => "Failed",
            Self::Interrupted => "Interrupted",
        })
    }
}

/// Provider-native terminal observation. IDs are Pi session-tree IDs, never
/// Codex Thread/Turn IDs. Construction is restricted to `PiRpcTransport`.
pub struct PiTurnReceipt {
    identity: ConnectionIdentity,
    session_id: String,
    session_file: String,
    prior_leaf_id: Option<String>,
    input_entry_id: String,
    input_fingerprint: String,
    assistant_entry_id: String,
    leaf_id: String,
    status: PiTurnStatus,
    final_text: Option<String>,
}

impl PiTurnReceipt {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        identity: ConnectionIdentity,
        session_id: String,
        session_file: String,
        prior_leaf_id: Option<String>,
        input_entry_id: String,
        input_fingerprint: String,
        assistant_entry_id: String,
        leaf_id: String,
        status: PiTurnStatus,
        final_text: Option<String>,
    ) -> Self {
        Self {
            identity,
            session_id,
            session_file,
            prior_leaf_id,
            input_entry_id,
            input_fingerprint,
            assistant_entry_id,
            leaf_id,
            status,
            final_text,
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn session_file(&self) -> &str {
        &self.session_file
    }

    pub fn input_entry_id(&self) -> &str {
        &self.input_entry_id
    }

    /// Exact leaf that was current before this prompt. It remains private to
    /// trusted execution and lets D1 reject a valid receipt from a sibling
    /// session-tree branch.
    pub fn prior_leaf_id(&self) -> Option<&str> {
        self.prior_leaf_id.as_deref()
    }

    /// SHA-256 of the exact submitted prompt using the D1 source fingerprint
    /// format. The prompt itself is never retained in the receipt.
    pub fn input_fingerprint(&self) -> &str {
        &self.input_fingerprint
    }

    pub fn assistant_entry_id(&self) -> &str {
        &self.assistant_entry_id
    }

    pub fn leaf_id(&self) -> &str {
        &self.leaf_id
    }

    pub fn status(&self) -> PiTurnStatus {
        self.status
    }

    pub fn final_text(&self) -> Option<&str> {
        self.final_text.as_deref()
    }

    pub fn matches_execution(&self, run_id: &str, attempt_id: &str, owner_token: &str) -> bool {
        self.identity
            .matches_execution(run_id, attempt_id, owner_token)
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

impl fmt::Debug for PiTurnReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PiTurnReceipt")
            .field("has_session_id", &true)
            .field("has_session_file", &true)
            .field("has_prior_leaf_id", &self.prior_leaf_id.is_some())
            .field("has_input_entry_id", &true)
            .field("has_input_fingerprint", &true)
            .field("has_assistant_entry_id", &true)
            .field("has_leaf_id", &true)
            .field("status", &self.status)
            .field("has_final_text", &self.final_text.is_some())
            .finish()
    }
}

/// Pi cleanup evidence derived only from the exact owned host's terminal
/// lifecycle receipt. It never accepts a serialized/caller-constructed proof.
pub struct PiCleanupReceipt {
    proof: HostCleanupProof,
}

impl PiCleanupReceipt {
    pub(crate) fn new(proof: HostCleanupProof) -> Self {
        Self { proof }
    }

    pub fn matches_connection_claim(
        &self,
        run_id: &str,
        attempt_id: &str,
        owner_token: &str,
        connection_epoch: i32,
        claim_id: &str,
    ) -> bool {
        self.proof.matches_connection_claim(
            run_id,
            attempt_id,
            owner_token,
            connection_epoch,
            claim_id,
        )
    }

    pub fn proves_quiescence_for(&self, turn: &PiTurnReceipt) -> bool {
        self.proof.matches_identity(&turn.identity)
    }

    pub fn connection_receipt_id(&self) -> &str {
        self.proof.connection_receipt_id()
    }

    /// Return the opaque connection identity proven by this owned cleanup.
    /// D1 uses it to bind a stopped finalization to the same provider host.
    pub fn connection_receipt(&self) -> ConnectionReceipt {
        self.proof.connection_receipt()
    }

    pub fn evidence_fingerprint(&self) -> String {
        format!("pi-owned-cleanup-v1:{}", self.proof.connection_receipt_id())
    }
}

impl fmt::Debug for PiCleanupReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PiCleanupReceipt")
            .field("has_owned_host_proof", &true)
            .finish()
    }
}
