//! Internal native Agent execution entry into the existing Issue admission.

use super::*;

/// Shared Issue admission result. The existing mutation callers expose only
/// its Run link; generic wakeup also needs durable skipped/deferred identity.
pub(crate) struct IssueWakeupAdmission {
    pub(crate) wakeup_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) status: String,
}

pub(crate) struct NativeIssueWakeup<'a> {
    pub(crate) agent_id: &'a str,
    pub(crate) source: &'a str,
    pub(crate) trigger_detail: Option<&'a str>,
    pub(crate) reason: Option<&'a str>,
    pub(crate) payload: &'a Value,
    pub(crate) context: &'a Value,
    pub(crate) idempotency_key: Option<&'a str>,
}

/// Caller holds the Issue before the Agent lock and has revalidated access.
/// No existing Issue mutation calls this native-consumer entry point.
pub(crate) async fn enqueue_native_agent_issue_wakeup(
    tx: &mut Tx<'_>,
    org: &str,
    issue_id: &str,
    input: &NativeIssueWakeup<'_>,
    actor: &IssueWakeupActor<'_>,
) -> std::result::Result<IssueWakeupAdmission, IssueCheckoutError> {
    let agent = sqlx::query("SELECT name,status,pause_reason,runtime_config,agent_runtime_type FROM agents WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org).bind(input.agent_id).fetch_optional(&mut **tx).await?
        .ok_or_else(|| http(404,"Agent not found"))?;
    let name: String = agent.try_get("name")?;
    let status: String = agent.try_get("status")?;
    let pause_reason: Option<String> = agent.try_get("pause_reason")?;
    let runtime_config: Value = agent.try_get("runtime_config")?;
    let runtime_type: String = agent.try_get("agent_runtime_type")?;
    let agent = WakeupAgent {
        id: input.agent_id,
        name: &name,
        status: &status,
        pause_reason: pause_reason.as_deref(),
        runtime_config: &runtime_config,
        runtime_type: &runtime_type,
    };
    let intent = IssueWakeupIntent {
        agent_id: input.agent_id.into(),
        source: "on_demand",
        reason: "agent_wakeup",
        mutation: "wakeup".into(),
        context_source: "agent.wakeup",
        wake_source: "on_demand",
        role: None,
        comment: None,
        relationship: None,
        expected_issue_execution_run_id: None,
        payload_extra: None,
        context_extra: None,
    };
    enqueue_issue_wakeup_with_agent(tx, org, issue_id, &agent, &intent, actor, Some(input)).await
}
