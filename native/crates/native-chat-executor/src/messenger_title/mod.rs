//! Ephemeral Messenger group-title execution through existing provider/process
//! transports. It never creates an Agent, Run, Attempt, Issue or scheduler task.
mod gateway;
mod local;
#[cfg(test)]
mod tests;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

/// This guard outlives any blocking process owner on HTTP cancellation.
/// Only a fresh directory created by this title workflow is ever removed.
pub struct Workspace(PathBuf);
impl Workspace {
    pub fn create() -> Result<Arc<Self>, Error> {
        let path =
            std::env::temp_dir().join(format!("rudder-messenger-title-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path)
            .map_err(|_| Error::Failed("Title workspace is unavailable".into()))?;
        let path = path
            .canonicalize()
            .map_err(|_| Error::Failed("Title workspace is unavailable".into()))?;
        Ok(Arc::new(Self(path)))
    }
    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
pub struct Request {
    pub workspace_guard: Arc<Workspace>,
    pub org_id: String,
    pub run_id: String,
    pub prompt: String,
    pub cwd: PathBuf,
    pub process_host: PathBuf,
    pub runtime_root: PathBuf,
    pub env: BTreeMap<String, String>,
    pub cancelled: Arc<AtomicBool>,
}
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Failed(String),
    #[error("Messenger title execution cancelled")]
    Cancelled,
    #[error("Messenger title execution timed out")]
    Timeout,
    #[error("Messenger title provider cleanup was not proven")]
    Cleanup,
}
pub struct Output {
    pub text: String,
    pub success: bool,
    pub auth_failure: bool,
    pub readiness_scope: Option<String>,
    pub suspended: bool,
}
impl Output {
    pub fn success(text: String) -> Self {
        Self {
            text,
            success: true,
            auth_failure: false,
            readiness_scope: None,
            suspended: false,
        }
    }
    pub fn failed(text: String) -> Self {
        Self {
            text,
            success: false,
            auth_failure: false,
            readiness_scope: None,
            suspended: false,
        }
    }
}
pub fn timeout(config: &Value) -> Option<Duration> {
    config
        .get("timeoutSec")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(Duration::from_secs_f64)
}
pub async fn execute(
    runtime_type: &str,
    config: &Value,
    request: &Request,
) -> Result<Output, Error> {
    if request.cancelled.load(Ordering::Acquire) {
        return Err(Error::Cancelled);
    }
    let result = if matches!(runtime_type, "hermes_gateway" | "openclaw_gateway") {
        gateway::execute(runtime_type, config, request).await
    } else {
        local::execute(runtime_type, config, request).await
    };
    match result {
        Ok(mut output) => {
            if !output.success && !output.suspended {
                output.suspended = local::network(&output.text, false);
            }
            Ok(output)
        }
        Err(Error::Failed(message)) if local::network(&message, false) => {
            let mut output = Output::failed(message);
            output.suspended = true;
            Ok(output)
        }
        result => result,
    }
}
