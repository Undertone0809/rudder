//! Persisted Agent execution, separate from Native Chat configuration policy.
//!
//! Foundation supplies trusted materialized instructions, workspace and runtime
//! configuration. This boundary executes one Attempt and returns observations;
//! D1 alone settles Runs, sessions, budgets and terminal control effects.
mod billing;
mod codex_failure;
mod config;
mod gateway;
mod http;
mod meta;
mod process;
mod projection;
mod session;
mod transcript;

pub use config::{AgentProcessLaunch, resolve_agent_process};
pub use session::{agent_session_for_workspace, normalize_agent_session};
pub use transcript::{parse_agent_provider_event, parse_agent_stdout_line};

use rudder_d1_persistence::agent_execution::{AgentRunClaim, SettledRequestProof, lifecycle};
use rudder_native_process_transport::HostCleanupProof;
use serde_json::Value;
use sqlx::PgPool;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

/// These inputs must come from Foundation's persisted Run context preparation,
/// never directly from a public invoke request. `config` is the effective Agent
/// config after workspace/assignee overrides and managed artifact provisioning.
pub struct AgentRunRequest {
    pub prompt: String,
    pub context: Value,
    pub config: Value,
    pub cwd: PathBuf,
    pub process_host: PathBuf,
    pub runtime_root: PathBuf,
    pub env: BTreeMap<String, String>,
    /// Provider flags for native, per-invocation managed MCP/skill artifacts.
    /// Materialization and resource leases remain with Foundation.
    pub managed_args: Vec<String>,
    pub output: Option<tokio::sync::mpsc::Sender<AgentRunOutput>>,
    pub cancelled: Arc<AtomicBool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentRunStream {
    Stdout,
    Stderr,
}

/// Logs retain bytes and per-stream byte offsets; provider events use a
/// separate ordinal. Foundation owns redaction, incremental UTF-8 decoding,
/// and attempt-bound durable replay keys.
pub enum AgentRunOutput {
    InvocationMeta {
        metadata: Value,
    },
    Log {
        stream: AgentRunStream,
        offset: u64,
        chunk: Vec<u8>,
    },
    Event {
        offset: u64,
        event: Value,
    },
    ApprovalRequest {
        offset: u64,
        provider_run_id: String,
        session_id: String,
        event: Value,
        timeout: Duration,
        reply: tokio::sync::oneshot::Sender<AgentRunApprovalDecision>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentRunApprovalChoice {
    Once,
    Deny,
}

pub struct AgentRunApprovalDecision {
    pub approval_id: Option<String>,
    /// None means still pending/unavailable; it never authorizes provider work.
    pub choice: Option<AgentRunApprovalChoice>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentRunExecutionState {
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    Suspended,
    Unresolved,
}

/// Both proof types are move-only and bound to the claimed Run/Attempt. A
/// request receipt proves local I/O settled, never that a remote job stopped.
pub enum AgentRunCleanupProof {
    Process(HostCleanupProof),
    Request(SettledRequestProof),
}

pub struct AgentRunExecutionObservation {
    pub state: AgentRunExecutionState,
    pub error_code: Option<String>,
    pub error: Option<String>,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub usage: Value,
    pub result: Value,
    pub session_id: Option<String>,
    pub session_params: Option<Value>,
    pub clear_session: bool,
    pub stdout: String,
    pub stderr: String,
    /// Parsed provider protocol events in original order, including tool and
    /// error events. Foundation may persist/redact them as Run log artifacts.
    pub events: Vec<Value>,
    pub cleanup_proof: Option<AgentRunCleanupProof>,
}

impl AgentRunExecutionObservation {
    fn failure(state: AgentRunExecutionState, code: &str, error: impl Into<String>) -> Self {
        Self {
            state,
            error_code: Some(code.into()),
            error: Some(error.into()),
            exit_code: None,
            signal: None,
            usage: Value::Null,
            result: Value::Null,
            session_id: None,
            session_params: None,
            clear_session: false,
            stdout: String::new(),
            stderr: String::new(),
            events: Vec::new(),
            cleanup_proof: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AgentRunExecutorError {
    #[error("Agent runtime worker ended before returning its owned claim")]
    WorkerInterrupted,
}

struct CancelOnDrop(Option<Arc<AtomicBool>>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(cancelled) = self.0.as_ref() {
            cancelled.store(true, Ordering::Release);
        }
    }
}

/// Executes exactly one owned Attempt. Session recovery and model fallback
/// require a new persisted attempt/permit and remain the caller's decision.
pub async fn execute_agent_run(
    pool: PgPool,
    claim: AgentRunClaim,
    request: AgentRunRequest,
) -> Result<(AgentRunClaim, AgentRunExecutionObservation), AgentRunExecutorError> {
    let mut cancel_on_drop = CancelOnDrop(Some(Arc::clone(&request.cancelled)));
    let outcome = execute_owned_attempt(pool, claim, request).await;
    // The owned worker returned normally; its observation carries the actual
    // cancellation state. Do not cancel the next model attempt or its services.
    cancel_on_drop.0 = None;
    outcome
}

async fn execute_owned_attempt(
    pool: PgPool,
    mut claim: AgentRunClaim,
    request: AgentRunRequest,
) -> Result<(AgentRunClaim, AgentRunExecutionObservation), AgentRunExecutorError> {
    let preflight = if request.cancelled.load(Ordering::Acquire) {
        Ok(true)
    } else {
        lifecycle::cancellation_requested(&pool, &claim.owned).await
    };
    match preflight {
        Ok(true) => {
            return Ok((
                claim,
                AgentRunExecutionObservation::failure(
                    AgentRunExecutionState::Cancelled,
                    "cancelled",
                    "Agent Run cancelled before runtime invocation",
                ),
            ));
        }
        Err(error) => {
            return Ok((
                claim,
                AgentRunExecutionObservation::failure(
                    AgentRunExecutionState::Unresolved,
                    "agent_run_persistence",
                    error.to_string(),
                ),
            ));
        }
        Ok(false) => (),
    }
    match lifecycle::renew_lease(&pool, &claim.owned, Duration::from_secs(30)).await {
        Ok(true) => (),
        result => {
            return Ok((
                claim,
                AgentRunExecutionObservation::failure(
                    AgentRunExecutionState::Unresolved,
                    "agent_run_ownership_lost",
                    result
                        .err()
                        .map(|e| e.to_string())
                        .unwrap_or_else(|| "Agent Run ownership was lost before invocation".into()),
                ),
            ));
        }
    }
    if matches!(
        claim.runtime_type.as_str(),
        "http" | "hermes_gateway" | "openclaw_gateway"
    ) {
        if claim.runtime_type != "http"
            && let Err(error) = meta::emit(&claim.runtime_type, &request, None).await
        {
            return Ok((
                claim,
                AgentRunExecutionObservation::failure(
                    AgentRunExecutionState::Failed,
                    "run_output_persistence_failed",
                    error,
                ),
            ));
        }
        match rudder_d1_persistence::agent_execution::record_request_started(
            &pool,
            &claim.owned,
            &claim.runtime_type,
        )
        .await
        {
            Ok(true) => (),
            result => {
                return Ok((
                    claim,
                    AgentRunExecutionObservation::failure(
                        AgentRunExecutionState::Unresolved,
                        "agent_run_ownership_lost",
                        result
                            .err()
                            .map(|error| error.to_string())
                            .unwrap_or_else(|| {
                                "Agent Run request ownership was lost before invocation".into()
                            }),
                    ),
                ));
            }
        }
        let Some(owner) = claim.owned.take_request_execution() else {
            return Ok((
                claim,
                AgentRunExecutionObservation::failure(
                    AgentRunExecutionState::Unresolved,
                    "agent_run_ownership_lost",
                    "Agent Run request capability was already consumed",
                ),
            ));
        };
        // The complete I/O operation, deadline, durable cancellation polling,
        // and response body reading live INSIDE this owned future. Dropping an
        // outer select must never manufacture a request-settlement receipt.
        let (mut observation, proof) = owner.settle(http::execute(&pool, &claim, &request)).await;
        observation.cleanup_proof = Some(AgentRunCleanupProof::Request(proof));
        return Ok((claim, observation));
    }
    let launch = match resolve_agent_process(&claim, &request) {
        Ok(launch) => launch,
        Err(message) => {
            return Ok((
                claim,
                AgentRunExecutionObservation::failure(
                    AgentRunExecutionState::Failed,
                    "invalid_runtime_config",
                    message,
                ),
            ));
        }
    };
    if let Err(error) = meta::emit(&claim.runtime_type, &request, Some(&launch)).await {
        return Ok((
            claim,
            AgentRunExecutionObservation::failure(
                AgentRunExecutionState::Failed,
                "run_output_persistence_failed",
                error,
            ),
        ));
    }
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || process::execute(&handle, &pool, claim, request, launch))
        .await
        .map_err(|_| AgentRunExecutorError::WorkerInterrupted)
}
