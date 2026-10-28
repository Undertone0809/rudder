mod chat;
mod goal;
use super::*;
use crate::agent_execution::{AgentExecutionActor, AgentWakeRequest};
pub(super) use goal::decide_goal;

pub(super) fn recoverable_branding(approval: &LockedApproval) -> bool {
    let payload = &approval.value()["payload"];
    let proposal = payload.get("operationProposal").unwrap_or(payload);
    approval.value()["type"] == "chat_operation"
        && proposal["targetType"] == "organization"
        && (proposal["patch"].get("brandColor").is_some()
            || proposal["patch"].get("logoAssetId").is_some())
}
pub(super) async fn recover_branding(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    approval: &LockedApproval,
) -> Result<()> {
    chat::operation(tx, context, approval).await?;
    audit(tx,context,approval.organization_id(),"approval.approved","approval",approval.id(),json!({"type":approval.value()["type"],"requestedByAgentId":approval.value()["requestedByAgentId"]}),Some(&format!("approval-approved:{}",approval.id()))).await
}

pub(super) async fn apply(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    approval: &LockedApproval,
    approved: bool,
    staged_assets: &mut Vec<String>,
    post_commit: &mut ApprovalPostCommit,
) -> Result<()> {
    match approval.value()["type"].as_str() {
        Some("hire_agent" | "chat_operation") => {
            let agent = crate::agent_core::apply_approved_agent_change(
                tx,
                approval,
                context.actor,
                context.agent_host,
                approved,
            )
            .await?;
            if agent.is_some() {
                sqlx::query("UPDATE organization_mutation_state SET mutation_version=mutation_version+1,updated_at=now() WHERE org_id=$1::uuid").bind(approval.organization_id()).execute(&mut **tx).await?;
            }
            if approved
                && approval.value()["type"] == "hire_agent"
                && !approval.value()["payload"]["agentId"].is_string()
            {
                post_commit.created_agent_id =
                    agent.and_then(|agent| agent["id"].as_str().map(str::to_owned));
            }
        }
        _ => {}
    }
    if !approved {
        return Ok(());
    }
    match approval.value()["type"].as_str() {
        Some("chat_issue_creation") => {
            chat::create_issue(tx, context, approval, staged_assets).await?;
        }
        Some("chat_operation") => {
            chat::operation(tx, context, approval).await?;
        }
        _ => {}
    }
    let org = approval.organization_id();
    let ids=sqlx::query_scalar::<_,String>("SELECT i.id::text FROM issue_approvals l JOIN issues i ON i.id=l.issue_id AND i.org_id=l.org_id WHERE l.org_id=$1::uuid AND l.approval_id=$2::uuid ORDER BY l.created_at DESC FOR UPDATE OF i")
        .bind(org).bind(approval.id()).fetch_all(&mut **tx).await?;
    let mut reactivated = Vec::new();
    for id in &ids {
        let raw = sqlx::query_scalar::<_, String>(
            "SELECT to_jsonb(i)::text FROM issues i WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(org)
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
        let issue: Value = serde_json::from_str(&raw)?;
        if issue["status"] != "blocked" {
            continue;
        }
        let assigned =
            issue["assignee_agent_id"].is_string() || issue["assignee_user_id"].is_string();
        let next = if assigned { "in_progress" } else { "todo" };
        let (issue, analytics) = crate::issue_core_writes::reactivate_approved_issue(
            tx,
            approval,
            &context.actor.actor().id,
            id,
            next,
        )
        .await?;
        if let Some(analytics) = analytics {
            post_commit.issue_updates.push(analytics);
        }
        reactivated.push(id.clone());
        if let Some(agent) = issue["assigneeAgentId"]
            .as_str()
            .filter(|agent| Some(*agent) != approval.value()["requestedByAgentId"].as_str())
        {
            let payload = json!({"approvalId":approval.id(),"approvalStatus":"approved","issueId":id,"source":"approval.approved","mutation":"approval_approved"});
            let snapshot = json!({"approvalId":approval.id(),"approvalStatus":"approved","issueId":id,"issue":issue,"wakeReason":"approval_approved","source":"approval.approved"});
            wake_best_effort(
                tx,
                context,
                approval,
                agent,
                "assignment",
                "approval_approved",
                payload,
                snapshot,
                "approval.linked_issue_assignee_wakeup",
            )
            .await?;
        }
    }
    if let Some(agent) = approval.value()["requestedByAgentId"].as_str() {
        let primary = ids.first();
        let issue = if let Some(id) = primary {
            let raw = sqlx::query_scalar::<_, String>(
                "SELECT to_jsonb(i)::text FROM issues i WHERE org_id=$1::uuid AND id=$2::uuid",
            )
            .bind(org)
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
            crate::issue_checkout::project_issue(tx, &raw)
                .await
                .map_err(|e| http(500, e.to_string()))?
        } else {
            Value::Null
        };
        wake_best_effort(tx,context,approval,agent,"automation","approval_approved",json!({"approvalId":approval.id(),"approvalStatus":"approved","issueId":primary,"issueIds":ids}),json!({"approvalId":approval.id(),"approvalStatus":"approved","issueId":primary,"issueIds":ids,"issue":issue,"wakeReason":"approval_approved"}),"approval.requester_wakeup").await?;
    }
    // Record the same association evidence on the terminal decision activity.
    audit(tx,context,org,"approval.approved","approval",approval.id(),json!({"type":approval.value()["type"],"requestedByAgentId":approval.value()["requestedByAgentId"],"linkedIssueIds":ids,"reactivatedIssueIds":reactivated}),Some(&format!("approval-approved:{}",approval.id()))).await?;
    Ok(())
}

pub(super) async fn wake_best_effort(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    approval: &LockedApproval,
    agent: &str,
    source: &str,
    reason: &str,
    payload: Value,
    snapshot: Value,
    action: &str,
) -> Result<()> {
    sqlx::query("SAVEPOINT approval_wakeup")
        .execute(&mut **tx)
        .await?;
    let result = wake(
        tx, context, approval, agent, source, reason, payload, snapshot, None,
    )
    .await;
    let (suffix, details) = match result {
        Ok(receipt) => {
            sqlx::query("RELEASE SAVEPOINT approval_wakeup")
                .execute(&mut **tx)
                .await?;
            (
                "queued",
                json!({"agentId":agent,"wakeupRequestId":receipt.wakeup_request_id,"runId":receipt.run_id,"status":receipt.status}),
            )
        }
        Err(error) => {
            sqlx::query("ROLLBACK TO SAVEPOINT approval_wakeup")
                .execute(&mut **tx)
                .await?;
            sqlx::query("RELEASE SAVEPOINT approval_wakeup")
                .execute(&mut **tx)
                .await?;
            ("failed", json!({"agentId":agent,"error":error.to_string()}))
        }
    };
    audit(
        tx,
        context,
        approval.organization_id(),
        &format!("{action}_{suffix}"),
        "approval",
        approval.id(),
        details,
        None,
    )
    .await
}

pub(super) async fn wake(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    approval: &LockedApproval,
    agent: &str,
    source: &str,
    reason: &str,
    mut payload: Value,
    snapshot: Value,
    key: Option<String>,
) -> Result<crate::agent_execution::AgentRunAdmission> {
    let org = approval.organization_id();
    let agent = uuid(agent)?;
    payload[crate::agent_execution::GOAL_PRODUCER_KEY] = json!("agent_wakeup_v1");
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("agent-run-state:{agent}"))
        .execute(&mut **tx)
        .await?;
    let row=sqlx::query("SELECT name,status,pause_reason,runtime_config,agent_runtime_type FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE").bind(org).bind(&agent).fetch_optional(&mut **tx).await?.ok_or_else(||http(404,"Agent not found"))?;
    let request = AgentWakeRequest {
        organization_id: org.into(),
        agent_id: agent.clone(),
        source: source.into(),
        trigger_detail: Some("system".into()),
        reason: Some(reason.into()),
        payload: Some(payload.clone()),
        idempotency_key: key,
        context_snapshot: snapshot.clone(),
    };
    let actor = AgentExecutionActor {
        actor_type: context.audit().actor_type,
        actor_id: context.actor.actor().id.clone(),
        run_id: context.run_id.map(str::to_owned),
    };
    let receipt = crate::agent_execution::admit_in_transaction(
        tx,
        &actor,
        &request,
        org,
        &agent,
        snapshot["issueId"].as_str(),
        snapshot.clone(),
        &payload,
        &row,
    )
    .await?;
    if let Some(run) = receipt.run_id.as_deref() {
        audit(
            tx,
            context,
            org,
            "heartbeat.invoked",
            "heartbeat_run",
            run,
            json!({"agentId":agent}),
            None,
        )
        .await?;
    }
    Ok(receipt)
}
