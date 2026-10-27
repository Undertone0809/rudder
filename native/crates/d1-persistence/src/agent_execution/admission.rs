//! Native wake admission. This entry is deliberately not mounted by a public
//! router until the generic executor and terminal effects are qualified.

use super::{AgentExecutionError, claim, context, http, mark_native_write};
use crate::{
    activity::{self, ActivityActor},
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

pub struct AgentExecutionActor {
    pub actor_type: &'static str,
    pub actor_id: String,
    pub run_id: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentWakeRequest {
    pub organization_id: String,
    pub agent_id: String,
    pub source: String,
    pub trigger_detail: Option<String>,
    pub reason: Option<String>,
    pub payload: Option<Value>,
    pub idempotency_key: Option<String>,
    pub context_snapshot: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunAdmission {
    pub wakeup_request_id: String,
    pub run_id: Option<String>,
    pub status: String,
    pub replayed: bool,
    #[serde(skip)]
    pub(crate) invocation_block: Option<super::budget::InvocationBlock>,
}

pub async fn admit(
    pool: &PgPool,
    authorizer: &dyn NativeAgentAuthorizer,
    actor: &AgentExecutionActor,
    request: &AgentWakeRequest,
) -> Result<AgentRunAdmission, AgentExecutionError> {
    validate_request(actor, request)?;
    let org = claim::canonical_id(&request.organization_id)?;
    let agent_id = claim::canonical_id(&request.agent_id)?;
    let payload = request.payload.clone().unwrap_or_else(|| json!({}));
    let mut snapshot = context::enrich_wake_context(
        request.context_snapshot.clone(),
        &payload,
        &request.source,
        request.trigger_detail.as_deref(),
        request.reason.as_deref(),
    );
    let mut tx = pool.begin().await?;
    let runtime_type: Option<String> = sqlx::query_scalar(
        "SELECT agent_runtime_type FROM agents WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&org)
    .bind(&agent_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(runtime_type) = runtime_type {
        super::resume::hydrate_explicit_resume(
            &mut tx,
            &org,
            &agent_id,
            &runtime_type,
            &payload,
            &mut snapshot,
        )
        .await?;
    }
    let issue_id = context::nonempty(snapshot.get("issueId"))
        .map(|value| claim::canonical_id(&value))
        .transpose()?;
    if let Some(issue_id) = issue_id.as_deref() {
        sqlx::query("SELECT p.id FROM projects p JOIN issues i ON i.project_id=p.id WHERE i.org_id=$1::uuid AND i.id=$2::uuid FOR KEY SHARE")
            .bind(&org).bind(issue_id).execute(&mut *tx).await?;
        sqlx::query("SELECT id FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
            .bind(&org)
            .bind(issue_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("agent-run-state:{agent_id}"))
        .execute(&mut *tx)
        .await?;
    let agent = sqlx::query("SELECT name,status,pause_reason,runtime_config,agent_runtime_type FROM agents WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(&org).bind(&agent_id).fetch_optional(&mut *tx).await?.ok_or_else(|| http(404,"Agent not found"))?;
    authorize(&mut tx, authorizer, &org).await?;
    let admission = admit_in_transaction(
        &mut tx,
        actor,
        request,
        &org,
        &agent_id,
        issue_id.as_deref(),
        snapshot,
        &payload,
        &agent,
    )
    .await?;
    if let Some(run_id) = admission.run_id.as_deref() {
        activity::write_activity(
            &mut tx,
            &org,
            &ActivityActor {
                actor_type: actor.actor_type,
                actor_id: actor.actor_id.clone(),
                run_id: actor.run_id.clone(),
            },
            "heartbeat.invoked",
            "heartbeat_run",
            run_id,
            Some(&json!({"agentId":agent_id})),
        )
        .await?;
    }
    tx.commit().await?;
    if let Some(block) = admission.invocation_block.as_ref() {
        return Err(AgentExecutionError::Http(
            409,
            block.reason.into(),
            Some(json!({"scopeType":block.scope_type,"scopeId":block.scope_id})),
        ));
    }
    Ok(admission)
}

#[allow(clippy::too_many_arguments)] // All values come from one admission transaction.
pub(crate) async fn admit_in_transaction(
    tx: &mut Transaction<'_, Postgres>,
    actor: &AgentExecutionActor,
    request: &AgentWakeRequest,
    org: &str,
    agent_id: &str,
    issue_id: Option<&str>,
    mut snapshot: Value,
    payload: &Value,
    agent: &sqlx::postgres::PgRow,
) -> Result<AgentRunAdmission, AgentExecutionError> {
    if let Some(key) = request.idempotency_key.as_deref() {
        let previous = sqlx::query("SELECT id::text AS id,run_id::text AS run_id,status FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid AND idempotency_key=$3 FOR UPDATE")
            .bind(org).bind(agent_id).bind(key).fetch_optional(&mut **tx).await?;
        if let Some(previous) = previous {
            return Ok(AgentRunAdmission {
                wakeup_request_id: previous.try_get("id")?,
                run_id: previous.try_get("run_id")?,
                status: previous.try_get("status")?,
                replayed: true,
                invocation_block: None,
            });
        }
    }
    let status: String = agent.try_get("status")?;
    if matches!(status.as_str(), "terminated" | "pending_approval") {
        return Err(AgentExecutionError::Http(
            409,
            "Agent is not invokable in its current state".into(),
            Some(json!({"status":status})),
        ));
    }
    let goal_id = context::nonempty(snapshot.get("goalId"))
        .or_else(|| context::nonempty(snapshot.get("goal").and_then(|value| value.get("id"))))
        .or_else(|| context::nonempty(payload.get("goalId")));
    if let Some(goal_id) = goal_id.as_deref() {
        let goal_id = claim::canonical_id(goal_id)?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM goals WHERE org_id=$1::uuid AND id=$2::uuid)",
        )
        .bind(org)
        .bind(&goal_id)
        .fetch_one(&mut **tx)
        .await?;
        if !exists {
            return Err(http(409, "Goal does not belong to the Agent organization"));
        }
        snapshot["goalId"] = json!(goal_id);
    }
    let runtime_config: Value = agent.try_get("runtime_config")?;
    let pause_reason: Option<String> = agent.try_get("pause_reason")?;
    let budget_block =
        super::budget::invocation_block(tx, org, agent_id, &status, pause_reason.as_deref())
            .await?;
    if let Some(block) = budget_block {
        mark_native_write(tx).await?;
        let mut admission = insert_wakeup_only(
            tx,
            org,
            agent_id,
            actor,
            request,
            payload,
            "skipped",
            Some("budget.blocked"),
            true,
        )
        .await?;
        admission.invocation_block = Some(block);
        return Ok(admission);
    }
    let mut skip_reason = None;
    if request.source == "timer" && runtime_config["heartbeat"]["enabled"] == false {
        skip_reason = Some("heartbeat.disabled");
    }
    if request.source != "timer" && !wake_on_demand_enabled(&runtime_config) {
        skip_reason = Some("heartbeat.wakeOnDemand.disabled");
    }
    if let Some(issue_id) = issue_id {
        let issue = sqlx::query("SELECT status,assignee_agent_id::text AS assignee_agent_id,reviewer_agent_id::text AS reviewer_agent_id FROM issues WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(org).bind(issue_id).fetch_optional(&mut **tx).await?;
        if let Some(issue) = issue {
            let issue_status: String = issue.try_get("status")?;
            if matches!(issue_status.as_str(), "done" | "cancelled")
                && !context::comment_mention(request.reason.as_deref(), &snapshot, payload)
            {
                skip_reason = Some("issue_execution_issue_not_actionable");
            }
            let assignee: Option<String> = issue.try_get("assignee_agent_id")?;
            let reviewer: Option<String> = issue.try_get("reviewer_agent_id")?;
            if context::nonempty(payload.get("expectedAssigneeAgentId"))
                .is_some_and(|expected| assignee.as_deref() != Some(&expected))
            {
                skip_reason = Some("issue_assignee_changed");
            }
            if context::nonempty(payload.get("expectedIssueStatus"))
                .is_some_and(|expected| issue_status != expected)
            {
                skip_reason = Some("issue_status_changed");
            }
            if context::comment_mention(request.reason.as_deref(), &snapshot, payload) {
                snapshot["relationship"] = json!(if assignee.as_deref() == Some(agent_id) {
                    "assignee"
                } else if reviewer.as_deref() == Some(agent_id) {
                    "reviewer"
                } else {
                    "collaborator"
                });
            }
        } else {
            skip_reason = Some("issue_execution_issue_not_found");
        }
    }
    mark_native_write(tx).await?;
    if let Some(reason) = skip_reason {
        return insert_wakeup_only(
            tx,
            org,
            agent_id,
            actor,
            request,
            payload,
            "skipped",
            Some(reason),
            true,
        )
        .await;
    }
    if let Some(issue_id) = issue_id {
        // The Issue bridge hydrates trusted context and reuses the existing
        // same-name coalescing, deferred wakes, task session, and pointer TX.
        let result = crate::issue_checkout::enqueue_native_agent_issue_wakeup(
            tx,
            org,
            issue_id,
            &crate::issue_checkout::NativeIssueWakeup {
                agent_id,
                source: &request.source,
                trigger_detail: request.trigger_detail.as_deref(),
                reason: request.reason.as_deref(),
                payload,
                context: &snapshot,
                idempotency_key: request.idempotency_key.as_deref(),
            },
            &crate::issue_checkout::IssueWakeupActor {
                kind: actor.actor_type,
                id: &actor.actor_id,
            },
        )
        .await
        .map_err(issue_error)?;
        return Ok(AgentRunAdmission {
            wakeup_request_id: result.wakeup_id,
            run_id: result.run_id,
            status: result.status,
            replayed: false,
            invocation_block: None,
        });
    }
    if status == "paused" {
        let mut deferred = payload.as_object().cloned().unwrap_or_default();
        deferred.insert("_paperclipWakeContext".into(), snapshot);
        return insert_wakeup_only(
            tx,
            org,
            agent_id,
            actor,
            request,
            &Value::Object(deferred),
            "deferred_agent_paused",
            request.reason.as_deref(),
            false,
        )
        .await;
    }
    let active = sqlx::query("SELECT id::text AS id,status,goal_id::text AS goal_id,context_snapshot,invocation_source FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid AND status IN ('queued','running') ORDER BY CASE WHEN status='queued' THEN 0 ELSE 1 END,created_at DESC")
        .bind(org).bind(agent_id).fetch_all(&mut **tx).await?;
    let task_key = context::task_key(&snapshot, payload);
    for active in active {
        let old = active
            .try_get::<Option<Value>, _>("context_snapshot")?
            .unwrap_or_else(|| json!({}));
        let old_key = context::task_key(&old, &Value::Null);
        let old_source: String = active.try_get("invocation_source")?;
        let same_scope =
            task_key == old_key && (task_key.is_some() || old_source == request.source);
        let running: String = active.try_get("status")?;
        let has_comment = context::nonempty(snapshot.get("wakeCommentId")).is_some();
        if !same_scope || (running == "running" && has_comment) {
            continue;
        }
        let run_id: String = active.try_get("id")?;
        let old_goal: Option<String> = active.try_get("goal_id")?;
        if old_goal.is_some() && goal_id.is_some() && old_goal != goal_id {
            return Err(http(409, "An active run cannot be coalesced across Goals"));
        }
        let merged = context::merge_coalesced_context(&old, &snapshot);
        sqlx::query("UPDATE heartbeat_runs SET context_snapshot=$3::jsonb,goal_id=COALESCE(goal_id,$4::uuid),updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid AND status IN ('queued','running')")
            .bind(org).bind(&run_id).bind(merged).bind(goal_id.as_deref()).execute(&mut **tx).await?;
        let mut result = insert_wakeup_only(
            tx,
            org,
            agent_id,
            actor,
            request,
            payload,
            "coalesced",
            request.reason.as_deref(),
            true,
        )
        .await?;
        sqlx::query("UPDATE agent_wakeup_requests SET run_id=$3::uuid,coalesced_count=1 WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(org).bind(&result.wakeup_request_id).bind(&run_id).execute(&mut **tx).await?;
        result.run_id = Some(run_id);
        return Ok(result);
    }
    let mut result = insert_wakeup_only(
        tx,
        org,
        agent_id,
        actor,
        request,
        payload,
        "queued",
        request.reason.as_deref(),
        false,
    )
    .await?;
    let session = claim::select_claim_session(
        tx,
        org,
        agent_id,
        &agent.try_get::<String, _>("agent_runtime_type")?,
        &snapshot,
    )
    .await?;
    let session_id = session.display_id.clone().or_else(|| {
        session
            .params
            .as_ref()
            .and_then(|value| context::nonempty(value.get("sessionId")))
    });
    let intent = json!({"kind":if session.reuse_scope=="none" {"fresh"} else {"resume"},"reuseScope":session.reuse_scope,"sourceRunId":context::nonempty(snapshot.get("resumeFromRunId")),"sessionId":session_id,"sessionParams":session.params});
    let run_id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO heartbeat_runs(id,org_id,agent_id,invocation_source,trigger_detail,status,wakeup_request_id,execution_authority,goal_id,context_snapshot,session_reuse_scope,session_id_before,session_params_before_json,scene,target_type,target_id,session_intent_json) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,'queued',$6::uuid,'native_rust',$7::uuid,$8::jsonb,$9,$10,$11::jsonb,'heartbeat','wakeup_request',$6::text,$12::jsonb)")
        .bind(&run_id).bind(org).bind(agent_id).bind(&request.source).bind(&request.trigger_detail).bind(&result.wakeup_request_id).bind(goal_id.as_deref()).bind(snapshot).bind(session.reuse_scope).bind(session_id).bind(session.params).bind(intent).execute(&mut **tx).await?;
    sqlx::query("UPDATE agent_wakeup_requests SET run_id=$3::uuid,updated_at=statement_timestamp() WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org).bind(&result.wakeup_request_id).bind(&run_id).execute(&mut **tx).await?;
    result.run_id = Some(run_id);
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
async fn insert_wakeup_only(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    agent_id: &str,
    actor: &AgentExecutionActor,
    request: &AgentWakeRequest,
    payload: &Value,
    status: &str,
    reason: Option<&str>,
    finished: bool,
) -> Result<AgentRunAdmission, AgentExecutionError> {
    let id: String=sqlx::query_scalar("INSERT INTO agent_wakeup_requests(org_id,agent_id,source,trigger_detail,reason,payload,status,execution_authority,requested_by_actor_type,requested_by_actor_id,idempotency_key,finished_at) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7,'native_rust',$8,$9,$10,CASE WHEN $11 THEN statement_timestamp() ELSE NULL END) RETURNING id::text")
        .bind(org).bind(agent_id).bind(&request.source).bind(&request.trigger_detail).bind(reason).bind(payload).bind(status).bind(actor.actor_type).bind(&actor.actor_id).bind(&request.idempotency_key).bind(finished).fetch_one(&mut **tx).await?;
    Ok(AgentRunAdmission {
        wakeup_request_id: id,
        run_id: None,
        status: status.into(),
        replayed: false,
        invocation_block: None,
    })
}

pub(crate) async fn authorize(
    tx: &mut Transaction<'_, Postgres>,
    authorizer: &dyn NativeAgentAuthorizer,
    org: &str,
) -> Result<(), AgentExecutionError> {
    match authorizer.revalidate(tx, org).await? {
        NativeAgentAccess::Authorized => Ok(()),
        NativeAgentAccess::Unauthorized => Err(http(401, "Unauthorized")),
        NativeAgentAccess::Forbidden => Err(http(403, "Forbidden")),
    }
}

fn validate_request(
    actor: &AgentExecutionActor,
    request: &AgentWakeRequest,
) -> Result<(), AgentExecutionError> {
    if !matches!(actor.actor_type, "agent" | "user") {
        return Err(http(401, "Agent or Board authentication required"));
    }
    if actor.actor_type == "agent" && actor.actor_id != request.agent_id {
        return Err(http(403, "Agent can only invoke itself"));
    }
    if !matches!(
        request.source.as_str(),
        "timer" | "assignment" | "review" | "on_demand" | "automation"
    ) || request
        .trigger_detail
        .as_deref()
        .is_some_and(|value| !matches!(value, "manual" | "ping" | "callback" | "system"))
        || request
            .payload
            .as_ref()
            .is_some_and(|value| !value.is_object())
        || !request.context_snapshot.is_object()
    {
        return Err(http(422, "Invalid Agent wakeup request"));
    }
    Ok(())
}

pub(crate) fn wake_on_demand_enabled(config: &Value) -> bool {
    [
        "wakeOnDemand",
        "wakeOnAssignment",
        "wakeOnOnDemand",
        "wakeOnAutomation",
    ]
    .into_iter()
    .find_map(|key| {
        config["heartbeat"]
            .get(key)
            .filter(|value| !value.is_null())
    })
    .and_then(Value::as_bool)
    .unwrap_or(true)
}

fn issue_error(error: crate::issue_checkout::IssueCheckoutError) -> AgentExecutionError {
    match error {
        crate::issue_checkout::IssueCheckoutError::Database(error) => error.into(),
        crate::issue_checkout::IssueCheckoutError::Http(status, message, details) => {
            AgentExecutionError::Http(status, message, details)
        }
        crate::issue_checkout::IssueCheckoutError::Json(_) => {
            http(500, "Issue wake context could not be projected")
        }
    }
}
