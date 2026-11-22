//! The existing workspace-operation local_file NDJSON contract.
use super::{AgentRunContextHost, ContextError, artifacts::private_write};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
pub(super) struct OperationLog {
    path: PathBuf,
    pub reference: String,
}
impl OperationLog {
    pub fn begin(
        host: &AgentRunContextHost,
        organization: &str,
        operation: &str,
    ) -> Result<Self, ContextError> {
        if uuid::Uuid::parse_str(organization).is_err() || uuid::Uuid::parse_str(operation).is_err()
        {
            return Err(ContextError::Invalid(
                "Invalid workspace operation log identity",
            ));
        }
        let root = host
            .environment
            .get("WORKSPACE_OPERATION_LOG_BASE_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(&host.workspace.instance_root).join("data/workspace-operation-logs")
            });
        let reference = format!("{organization}/{operation}.ndjson");
        let path = root.join(&reference);
        fs::create_dir_all(path.parent().unwrap())?;
        private_write(&path, b"")?;
        Ok(Self { path, reference })
    }
    pub fn finish(&self, stdout: &str, stderr: &str) -> Result<(i64, String), ContextError> {
        let timestamp = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default();
        let mut bytes = Vec::new();
        for (stream, chunk) in [("stdout", stdout), ("stderr", stderr)] {
            if chunk.is_empty() {
                continue;
            }
            serde_json::to_writer(
                &mut bytes,
                &json!({"ts":timestamp,"stream":stream,"chunk":chunk}),
            )
            .map_err(|_| ContextError::Invalid("Workspace operation log could not be encoded"))?;
            bytes.push(b'\n');
        }
        private_write(&self.path, &bytes)?;
        let sha = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Ok((bytes.len() as i64, sha))
    }
}
