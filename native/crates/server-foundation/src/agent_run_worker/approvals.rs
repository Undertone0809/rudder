use rudder_d1_persistence::agent_execution::{self, AgentRunObserver};
use rudder_native_chat_executor::agent_run::{AgentRunApprovalChoice, AgentRunApprovalDecision};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::oneshot,
    time::{Instant, sleep},
};

#[allow(clippy::too_many_arguments)]
pub(super) async fn resolve(
    pool: PgPool,
    owner: AgentRunObserver,
    id: String,
    initial_status: String,
    timeout: Duration,
    cancelled: Arc<AtomicBool>,
    reply: oneshot::Sender<AgentRunApprovalDecision>,
) {
    let deadline =
        Instant::now() + timeout.clamp(Duration::from_secs(1), Duration::from_secs(30 * 60));
    let mut status = initial_status;
    let mut error = None;
    let choice = loop {
        if cancelled.load(Ordering::Acquire) || reply.is_closed() {
            error = Some("Runtime approval wait was cancelled".into());
            break None;
        }
        match status.as_str() {
            "approved" => break Some(AgentRunApprovalChoice::Once),
            "rejected" | "cancelled" => break Some(AgentRunApprovalChoice::Deny),
            "pending" | "revision_requested" => {}
            _ => {
                error = Some("Runtime approval has no executable decision".into());
                break None;
            }
        }
        if Instant::now() >= deadline {
            error = Some("Runtime approval wait timed out".into());
            break None;
        }
        sleep(Duration::from_millis(500)).await;
        match agent_execution::read_runtime_approval(&pool, &owner, &id).await {
            Ok(row) => status = row.status,
            Err(e) => {
                error = Some(e.to_string());
                break None;
            }
        }
    };
    let _ = reply.send(AgentRunApprovalDecision {
        approval_id: Some(id),
        choice,
        error,
    });
}
pub(super) fn payload(mut event: Value, provider_run_id: &str, session_id: &str) -> Value {
    if !event.is_object() {
        event = json!({"event":event});
    }
    event["providerRunId"] = json!(provider_run_id);
    event["sessionId"] = json!(session_id);
    event
}
