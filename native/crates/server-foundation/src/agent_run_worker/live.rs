//! Live frames are observations of committed D1 state, never execution owners.
use crate::live_events::{LiveEventError, LiveEventPublisher};
use rudder_d1_persistence::agent_execution::{AgentExecutionError, output};
use serde_json::{Value, json};
use sqlx::PgPool;
pub(super) fn publish(
    events: &LiveEventPublisher,
    org: &str,
    kind: &str,
    payload: Value,
    key: Option<&str>,
) {
    if let Err(error) = events.publish(org, kind, payload, key)
        && error != LiveEventError::Closed
    {
        tracing::warn!(event="native_agent_live_publish_failed",error=%error);
    }
}
pub(super) async fn committed(
    pool: &PgPool,
    events: &LiveEventPublisher,
    org: &str,
    run: &str,
    last: &mut i32,
    all: bool,
) -> Result<(), AgentExecutionError> {
    loop {
        let rows = output::committed_events(pool, org, run, *last).await?;
        let count = rows.len();
        for row in rows {
            let Some(seq) = row["seq"].as_i64().and_then(|n| i32::try_from(n).ok()) else {
                continue;
            };
            let key = format!("native-run-event:{run}:{seq}");
            publish(events, org, "heartbeat.run.event", row, Some(&key));
            *last = seq;
        }
        if !all || count < 512 {
            break;
        }
    }
    Ok(())
}
pub(super) async fn status(
    pool: &PgPool,
    events: &LiveEventPublisher,
    org: &str,
    run: &str,
) -> Result<(), AgentExecutionError> {
    let Some(mut snapshot) = output::live_status(pool, org, run).await? else {
        return Ok(());
    };
    let status = snapshot.run["status"].as_str().unwrap_or("").to_owned();
    if status == "queued" {
        publish(
            events,
            org,
            "heartbeat.run.queued",
            snapshot.queued,
            Some(&format!("heartbeat.run.queued:{run}")),
        );
    } else {
        let key = format!(
            "native-run-status:{run}:{status}:{}:{}",
            snapshot.run["executionPhase"], snapshot.run["networkWaitAttemptCount"]
        );
        publish(
            events,
            org,
            "heartbeat.run.status",
            snapshot.run,
            Some(&key),
        );
    }
    if !matches!(
        snapshot.agent["status"].as_str(),
        Some("paused" | "terminated" | "pending_approval")
    ) {
        if matches!(
            status.as_str(),
            "succeeded" | "failed" | "cancelled" | "timed_out"
        ) {
            snapshot.agent["outcome"] = json!(status);
        }
        let key = format!(
            "native-agent-status:{run}:{}:{status}",
            snapshot.agent["status"]
        );
        publish(events, org, "agent.status", snapshot.agent, Some(&key));
    }
    Ok(())
}
