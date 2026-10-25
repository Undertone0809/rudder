//! Opaque connection ownership and cleanup evidence.

use rudder_native_protocol::{PROTOCOL_MAJOR, PROTOCOL_MINOR};
use serde_json::Value;
use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
use thiserror::Error;

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

/// Validated cleanup evidence recovered from the process host's fsync-backed
/// operation receipt after the original caller is gone. The proof remains
/// opaque; callers cannot construct it from JSON or a PID alone.
pub struct DurableHostCleanupReceipt {
    proof: HostCleanupProof,
    process_id: Option<i32>,
    host_status: String,
    host_error_code: Option<String>,
}

impl DurableHostCleanupReceipt {
    pub fn cleanup_proof(&self) -> &HostCleanupProof {
        &self.proof
    }

    /// The child PID is descriptive identity only; it is never a cleanup
    /// capability and must not be signalled or adopted by the recovering
    /// process.
    pub fn process_id(&self) -> Option<i32> {
        self.process_id
    }

    pub fn host_status(&self) -> &str {
        &self.host_status
    }

    pub fn host_error_code(&self) -> Option<&str> {
        self.host_error_code.as_deref()
    }
}

#[derive(Debug, Error)]
pub enum DurableCleanupReceiptError {
    #[error("durable process-host cleanup receipt identity is invalid")]
    InvalidIdentity,
    #[error("durable process-host cleanup receipt is invalid")]
    InvalidReceipt,
    #[error("durable process-host cleanup receipt could not be read")]
    Io(#[from] std::io::Error),
    #[error("durable process-host cleanup receipt JSON is invalid")]
    Json(#[from] serde_json::Error),
}

/// Recover typed cleanup proof from the process host's existing durable
/// receipt for one exact claimed execution. The operation directory is keyed
/// by the persisted opaque owner token, and both descriptor and terminal
/// receipt must repeat the exact attempt request ID and owner token.
pub fn read_durable_cleanup_receipt(
    runtime_root: &Path,
    run_id: &str,
    attempt_id: &str,
    owner_token: &str,
    connection_epoch: i32,
    claim_id: &str,
) -> Result<Option<DurableHostCleanupReceipt>, DurableCleanupReceiptError> {
    if run_id.trim().is_empty()
        || attempt_id.trim().is_empty()
        || connection_epoch <= 0
        || claim_id.trim().is_empty()
        || owner_token.len() != 36
        || !owner_token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err(DurableCleanupReceiptError::InvalidIdentity);
    }
    let operation_root = runtime_root.join(owner_token);
    let descriptor_path = operation_root.join("owner-descriptor.json");
    let receipt_path = operation_root.join("terminal-receipt.json");
    // A different supplied owner token simply names a different managed
    // operation directory. Absence there means no receipt for this identity.
    let Some(descriptor) = read_receipt_json(&descriptor_path)? else {
        return Ok(None);
    };
    let Some(receipt) = read_receipt_json(&receipt_path)? else {
        return Ok(None);
    };
    if !protocol_matches(&descriptor)
        || !protocol_matches(&receipt)
        || descriptor["requestId"].as_str() != Some(attempt_id)
        || receipt["requestId"].as_str() != Some(attempt_id)
        || descriptor["opaqueOwnerToken"].as_str() != Some(owner_token)
        || receipt["opaqueOwnerToken"].as_str() != Some(owner_token)
        || descriptor["ownerKind"].as_str() != Some("agent_run_attempt")
    {
        return Err(DurableCleanupReceiptError::InvalidReceipt);
    }

    let child_id = receipt["childPid"].as_u64();
    let no_child = receipt["launchDisposition"].as_str() == Some("not_started")
        && descriptor["launchDisposition"].as_str() == Some("not_started")
        && child_id.is_none()
        && descriptor["childPid"].is_null()
        && receipt["processGroup"].is_null()
        && descriptor["processGroup"].is_null();
    let process_id = if no_child {
        None
    } else {
        let child_id = child_id
            .filter(|pid| *pid > 1 && *pid <= i32::MAX as u64)
            .ok_or(DurableCleanupReceiptError::InvalidReceipt)?;
        let descriptor_child = descriptor["childPid"]
            .as_u64()
            .filter(|pid| *pid > 1 && *pid <= i32::MAX as u64);
        let process_group = receipt["processGroup"].as_u64();
        if descriptor_child != Some(child_id)
            || process_group.filter(|pid| *pid > 1) != Some(child_id)
        {
            return Err(DurableCleanupReceiptError::InvalidReceipt);
        }
        Some(child_id as i32)
    };
    let terminal = receipt
        .get("terminal")
        .and_then(Value::as_object)
        .ok_or(DurableCleanupReceiptError::InvalidReceipt)?;
    if terminal.get("type").and_then(Value::as_str) != Some("terminal")
        || terminal.get("cleanupProven").and_then(Value::as_bool) != Some(true)
        || terminal.get("receiptWritten").and_then(Value::as_bool) != Some(true)
    {
        return Err(DurableCleanupReceiptError::InvalidReceipt);
    }
    let host_status = terminal
        .get("status")
        .and_then(Value::as_str)
        .filter(|status| matches!(*status, "succeeded" | "failed"))
        .ok_or(DurableCleanupReceiptError::InvalidReceipt)?
        .to_owned();
    let host_error_code = terminal
        .get("errorCode")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let identity = ConnectionIdentity::new(
        run_id.to_owned(),
        attempt_id.to_owned(),
        owner_token.to_owned(),
        Some(connection_epoch),
        Some(claim_id.to_owned()),
    );
    Ok(Some(DurableHostCleanupReceipt {
        proof: HostCleanupProof::from_owned_host(identity),
        process_id,
        host_status,
        host_error_code,
    }))
}

fn protocol_matches(value: &Value) -> bool {
    value["protocolVersion"]["major"].as_u64() == Some(u64::from(PROTOCOL_MAJOR))
        && value["protocolVersion"]["minor"].as_u64() == Some(u64::from(PROTOCOL_MINOR))
}

fn read_receipt_json(path: &Path) -> Result<Option<Value>, DurableCleanupReceiptError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err(DurableCleanupReceiptError::InvalidReceipt);
    }
    let bytes = fs::read(path)?;
    if bytes.len() > 64 * 1024 {
        return Err(DurableCleanupReceiptError::InvalidReceipt);
    }
    Ok(Some(serde_json::from_slice(&bytes)?))
}

#[cfg(test)]
mod durable_receipt_tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    const RUN_ID: &str = "21000000-0000-4000-8000-000000000701";
    const ATTEMPT_ID: &str = "22000000-0000-4000-8000-000000000701";
    const OWNER_TOKEN: &str = "33000000-0000-4000-8000-000000000701";

    fn fixture() -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "rudder-goal-cleanup-receipt-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join(OWNER_TOKEN)).expect("create managed runtime fixture");
        let protocol = json!({"major": PROTOCOL_MAJOR, "minor": PROTOCOL_MINOR});
        fs::write(
            root.join(OWNER_TOKEN).join("owner-descriptor.json"),
            json!({
                "protocolVersion": protocol.clone(),
                "ownerKind": "agent_run_attempt",
                "requestId": ATTEMPT_ID,
                "opaqueOwnerToken": OWNER_TOKEN,
                "childPid": 777,
                "terminalReceiptPath": "terminal-receipt.json"
            })
            .to_string(),
        )
        .expect("write owner descriptor");
        fs::write(
            root.join(OWNER_TOKEN).join("terminal-receipt.json"),
            json!({
                "protocolVersion": protocol,
                "requestId": ATTEMPT_ID,
                "opaqueOwnerToken": OWNER_TOKEN,
                "childPid": 777,
                "processGroup": 777,
                "terminal": {
                    "type": "terminal",
                    "status": "failed",
                    "cleanupProven": true,
                    "receiptWritten": true
                }
            })
            .to_string(),
        )
        .expect("write process-host terminal receipt");
        root
    }

    #[test]
    fn durable_receipt_reconstructs_only_exact_typed_cleanup_proof() {
        let root = fixture();
        let receipt =
            read_durable_cleanup_receipt(&root, RUN_ID, ATTEMPT_ID, OWNER_TOKEN, 1, ATTEMPT_ID)
                .expect("read exact receipt")
                .expect("receipt is present");
        assert!(receipt.cleanup_proof().matches_connection_claim(
            RUN_ID,
            ATTEMPT_ID,
            OWNER_TOKEN,
            1,
            ATTEMPT_ID
        ));
        assert_eq!(receipt.process_id(), Some(777));
        assert_eq!(receipt.host_status(), "failed");
        assert!(!receipt.cleanup_proof().matches_connection_claim(
            RUN_ID,
            "22000000-0000-4000-8000-000000000702",
            OWNER_TOKEN,
            1,
            ATTEMPT_ID
        ));
        fs::remove_dir_all(root).expect("remove receipt fixture");
    }

    #[test]
    fn durable_receipt_rejects_wrong_owner_or_unproven_cleanup() {
        let root = fixture();
        assert!(matches!(
            read_durable_cleanup_receipt(
                &root,
                RUN_ID,
                ATTEMPT_ID,
                "33000000-0000-4000-8000-000000000702",
                1,
                ATTEMPT_ID
            ),
            Ok(None)
        ));
        let receipt_path = root.join(OWNER_TOKEN).join("terminal-receipt.json");
        let mut receipt: Value = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
        receipt["terminal"]["cleanupProven"] = Value::Bool(false);
        fs::write(&receipt_path, receipt.to_string()).unwrap();
        assert!(matches!(
            read_durable_cleanup_receipt(&root, RUN_ID, ATTEMPT_ID, OWNER_TOKEN, 1, ATTEMPT_ID),
            Err(DurableCleanupReceiptError::InvalidReceipt)
        ));
        fs::remove_dir_all(root).expect("remove receipt fixture");
    }
}
