//! Public Approval lifecycle and comments. Approval decisions and their domain
//! effects share the existing organization transaction and native execution queue.
mod effects;

use crate::{
    StoreError,
    activity::{self, ActivityActor, ActivityOptions, ActivityWrite},
    agent_core::{AgentCoreRequest, NativeAgentAccess, NativeAgentAuthorizer},
    goal_writes::lock_organization,
};
use rudder_auth_core::VerifiedActor;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use uuid::Uuid;

pub(super) type Tx<'a> = Transaction<'a, Postgres>;
pub(super) type Result<T> = std::result::Result<T, ApprovalWriteError>;

#[derive(Debug, thiserror::Error)]
pub enum ApprovalWriteError {
    #[error("{1}")]
    Http(u16, String, Option<Value>),
    #[error("Goal changed before the approved update could be applied")]
    StaleGoal(Value),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Agent(#[from] crate::agent_core::AgentCoreError),
    #[error(transparent)]
    Issue(#[from] crate::issue_core_writes::IssueCoreWriteError),
    #[error(transparent)]
    Execution(#[from] crate::agent_execution::AgentExecutionError),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalWriteOperation {
    Create,
    Approve,
    Reject,
    RequestRevision,
    Resubmit,
    ReadComments,
    CreateComment,
}

pub struct ApprovalWriteContext<'a> {
    pub organization_id: &'a str,
    pub actor: &'a VerifiedActor,
    pub run_id: Option<&'a str>,
    /// Native host facts, constructed by the trusted ingress, for the existing
    /// Agent writer. Caller JSON never supplies these fields.
    pub agent_host: &'a AgentCoreRequest,
    pub authorizer: &'a dyn NativeAgentAuthorizer,
    pub asset_storage: Option<&'a dyn crate::issue_core_writes::IssueAssetStorage>,
}

pub(super) fn http(code: u16, message: impl Into<String>) -> ApprovalWriteError {
    ApprovalWriteError::Http(code, message.into(), None)
}

impl ApprovalWriteContext<'_> {
    pub(super) fn agent_id(&self) -> Option<&str> {
        (self.actor.actor().kind == "agent").then_some(self.actor.actor().id.as_str())
    }
    pub(super) fn user_id(&self) -> Option<&str> {
        (self.actor.actor().kind == "user").then_some(self.actor.actor().id.as_str())
    }
    pub(super) fn audit(&self) -> ActivityActor {
        ActivityActor {
            actor_type: if self.agent_id().is_some() {
                "agent"
            } else {
                "user"
            },
            actor_id: self.actor.actor().id.clone(),
            run_id: self.run_id.map(str::to_owned),
        }
    }
}

/// This value is constructed only after the Approval row has been locked and
/// its decision validated; sibling domain adapters cannot accept public JSON as
/// permission to apply an approved operation.
#[derive(Default)]
pub(super) struct ApprovalPostCommit {
    created_agent_id: Option<String>,
    issue_updates: Vec<crate::issue_core_writes::IssueUpdatePostCommit>,
}

pub(crate) struct LockedApproval {
    id: String,
    organization_id: String,
    value: Value,
}
impl LockedApproval {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }
    pub(crate) fn organization_id(&self) -> &str {
        &self.organization_id
    }
    pub(crate) fn value(&self) -> &Value {
        &self.value
    }
}

pub fn validate_input(operation: ApprovalWriteOperation, input: &Value) -> Result<()> {
    if !input.is_object() {
        return Err(http(400, "Validation error"));
    }
    match operation {
        ApprovalWriteOperation::Create => {
            if !matches!(
                input["type"].as_str(),
                Some(
                    "hire_agent"
                        | "approve_ceo_strategy"
                        | "budget_override_required"
                        | "chat_issue_creation"
                        | "chat_operation"
                        | "agent_runtime"
                        | "goal_change"
                )
            ) || !input["payload"].is_object()
            {
                return Err(http(400, "Validation error"));
            }
            optional_uuid(input, "requestedByAgentId")?;
            if let Some(ids) = input.get("issueIds") {
                let ids = ids
                    .as_array()
                    .ok_or_else(|| http(400, "Validation error"))?;
                for id in ids {
                    uuid(id.as_str().ok_or_else(|| http(400, "Validation error"))?)?;
                }
            }
        }
        ApprovalWriteOperation::CreateComment => {
            if input["body"].as_str().is_none_or(str::is_empty) {
                return Err(http(400, "Validation error"));
            }
        }
        _ => {
            for key in ["decisionNote", "decidedByUserId"] {
                if !matches!(
                    operation,
                    ApprovalWriteOperation::Approve
                        | ApprovalWriteOperation::Reject
                        | ApprovalWriteOperation::RequestRevision
                ) {
                    continue;
                }
                if input
                    .get(key)
                    .is_some_and(|v| !(v.is_string() || (key == "decisionNote" && v.is_null())))
                {
                    return Err(http(400, "Validation error"));
                }
            }
            if matches!(
                operation,
                ApprovalWriteOperation::Approve
                    | ApprovalWriteOperation::Reject
                    | ApprovalWriteOperation::Resubmit
            ) && input.get("payload").is_some_and(|v| !v.is_object())
            {
                return Err(http(400, "Validation error"));
            }
        }
    }
    Ok(())
}

pub async fn apply_approval_write(
    pool: &PgPool,
    context: ApprovalWriteContext<'_>,
    operation: ApprovalWriteOperation,
    approval_id: Option<&str>,
    input: &Value,
) -> Result<Value> {
    validate_input(operation, input)?;
    let org = uuid(context.organization_id)?;
    if matches!(
        operation,
        ApprovalWriteOperation::Approve
            | ApprovalWriteOperation::Reject
            | ApprovalWriteOperation::RequestRevision
    ) && context.user_id().is_none()
    {
        return Err(http(403, "Board access required"));
    }
    let mut tx = pool.begin().await?;
    // Organization branding takes this component lock before the shared
    // organization row. Keep the established order when a Chat Approval can
    // compose a branding receipt in the same transaction.
    sqlx::query(
        "SELECT org_id FROM organization_branding_mutation_state WHERE org_id=$1::uuid FOR UPDATE",
    )
    .bind(&org)
    .execute(&mut *tx)
    .await?;
    // Match the existing Issue/Agent admission lock order before mutating rows
    // which can enqueue execution. This is an existing domain transaction, not
    // a second execution queue.
    lock_organization(&mut tx, &org).await?;
    revalidate(&mut tx, &context, &org).await?;
    let mut staged_assets = Vec::new();
    let mut post_commit = ApprovalPostCommit::default();
    let result: Result<Value> = async {
    let output = if operation == ApprovalWriteOperation::Create {
        create(&mut tx, &context, &org, input).await?
    } else {
        let id = uuid(approval_id.ok_or_else(|| http(404, "Approval not found"))?)?;
        let raw = sqlx::query_scalar::<_, String>(&format!(
            "SELECT {}::text FROM approvals t WHERE t.id=$1::uuid AND t.org_id=$2::uuid FOR UPDATE", crate::approval_reads::projection("approvals")
        )).bind(&id).bind(&org).fetch_optional(&mut *tx).await?.ok_or_else(|| http(404, "Approval not found"))?;
        let mut locked = LockedApproval { id, organization_id: org.clone(), value: serde_json::from_str(&raw)? };
        match operation {
            ApprovalWriteOperation::ReadComments => comments(&mut tx, &org, locked.id()).await?,
            ApprovalWriteOperation::CreateComment => comment(&mut tx, &context, &locked, input).await?,
            ApprovalWriteOperation::RequestRevision | ApprovalWriteOperation::Resubmit => revise(&mut tx, &context, &mut locked, operation, input).await?,
            ApprovalWriteOperation::Approve | ApprovalWriteOperation::Reject => decide(&mut tx, &context, &mut locked, operation == ApprovalWriteOperation::Approve, input, &mut staged_assets, &mut post_commit).await?,
            ApprovalWriteOperation::Create => unreachable!(),
        }
    };
    Ok(output)
    }.await;
    match result {
        Ok(output) => {
            // Match the existing Issue writer: an unknown COMMIT outcome is
            // not proof that copied asset objects are unreferenced.
            tx.commit().await?;
            if let Some(id) = post_commit.created_agent_id {
                crate::agent_core::finish_approved_agent_create(
                    pool,
                    context.actor,
                    context.agent_host,
                    &org,
                    &id,
                    context.authorizer,
                )
                .await;
            }
            for update in post_commit.issue_updates {
                update.apply(pool).await?;
            }
            Ok(output)
        }
        Err(error @ ApprovalWriteError::StaleGoal(_)) => {
            tx.commit().await?;
            Err(error)
        }
        Err(error) => {
            tx.rollback().await?;
            if let Some(storage) = context.asset_storage {
                crate::issue_core_writes::cleanup_staged_issue_asset_objects(
                    storage,
                    &org,
                    &staged_assets,
                )
                .await;
            }
            Err(error)
        }
    }
}

async fn revalidate(tx: &mut Tx<'_>, context: &ApprovalWriteContext<'_>, org: &str) -> Result<()> {
    match context.authorizer.revalidate(tx, org).await? {
        NativeAgentAccess::Authorized => Ok(()),
        NativeAgentAccess::Unauthorized => Err(http(401, "Unauthorized")),
        NativeAgentAccess::Forbidden => {
            Err(http(403, "User does not have access to this organization"))
        }
    }
}

async fn create(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    org: &str,
    input: &Value,
) -> Result<Value> {
    let mut payload = input["payload"].clone();
    if input["type"] == "hire_agent" {
        crate::agent_core::normalize_hire_approval_payload(tx, org, &mut payload).await?;
    }
    let requester = optional_uuid(input, "requestedByAgentId")?
        .or_else(|| context.agent_id().map(str::to_owned));
    if let Some(agent) = requester.as_deref() {
        scoped_agent(tx, org, agent).await?;
    }
    let id = sqlx::query_scalar::<_, String>("INSERT INTO approvals (org_id,type,requested_by_agent_id,requested_by_user_id,status,payload) VALUES ($1::uuid,$2,$3::uuid,$4,'pending',$5::jsonb) RETURNING id::text")
        .bind(org).bind(input["type"].as_str()).bind(requester).bind(context.user_id()).bind(payload.to_string()).fetch_one(&mut **tx).await?;
    let mut ids = Vec::new();
    if let Some(values) = input["issueIds"].as_array() {
        for value in values {
            let id = uuid(
                value
                    .as_str()
                    .ok_or_else(|| http(400, "Validation error"))?,
            )?;
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    for issue in &ids {
        link_issue(tx, context, org, &id, issue).await?;
    }
    audit(
        tx,
        context,
        org,
        "approval.created",
        "approval",
        &id,
        json!({"type":input["type"],"issueIds":ids}),
        None,
    )
    .await?;
    public_approval(tx, org, &id).await
}

async fn revise(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    locked: &mut LockedApproval,
    operation: ApprovalWriteOperation,
    input: &Value,
) -> Result<Value> {
    let org = locked.organization_id();
    if locked.value["type"] == "goal_change" {
        return Err(http(
            422,
            if operation == ApprovalWriteOperation::RequestRevision {
                "Reject this Goal update with feedback so the Owner can submit a new proposal"
            } else {
                "A rejected Goal update requires a new proposal and approval"
            },
        ));
    }
    let resubmit = operation == ApprovalWriteOperation::Resubmit;
    let expected = if resubmit {
        "revision_requested"
    } else {
        "pending"
    };
    if locked.value["status"] != expected {
        return Err(http(
            422,
            if resubmit {
                "Only revision requested approvals can be resubmitted"
            } else {
                "Only pending approvals can request revision"
            },
        ));
    }
    if resubmit
        && context
            .agent_id()
            .is_some_and(|id| locked.value["requestedByAgentId"].as_str() != Some(id))
    {
        return Err(http(
            403,
            "Only requesting agent can resubmit this approval",
        ));
    }
    let mut payload = input
        .get("payload")
        .cloned()
        .unwrap_or_else(|| locked.value["payload"].clone());
    if resubmit && locked.value["type"] == "hire_agent" {
        crate::agent_core::normalize_hire_approval_payload(tx, org, &mut payload).await?;
    }
    sqlx::query("UPDATE approvals SET status=$3,payload=$4::jsonb,decision_note=$5,decided_by_user_id=$6,decided_at=CASE WHEN $3='pending' THEN NULL ELSE now() END,updated_at=now() WHERE id=$1::uuid AND org_id=$2::uuid")
        .bind(locked.id()).bind(org).bind(if resubmit { "pending" } else { "revision_requested" }).bind(payload.to_string()).bind(if resubmit { None } else { input["decisionNote"].as_str() }).bind(if resubmit { None } else { Some(input["decidedByUserId"].as_str().unwrap_or("board")) }).execute(&mut **tx).await?;
    audit(
        tx,
        context,
        org,
        if resubmit {
            "approval.resubmitted"
        } else {
            "approval.revision_requested"
        },
        "approval",
        locked.id(),
        json!({"type":locked.value["type"]}),
        None,
    )
    .await?;
    public_approval(tx, org, locked.id()).await
}

async fn decide(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    locked: &mut LockedApproval,
    approve: bool,
    input: &Value,
    staged_assets: &mut Vec<String>,
    post_commit: &mut ApprovalPostCommit,
) -> Result<Value> {
    let next = if approve { "approved" } else { "rejected" };
    if locked.value["type"] == "goal_change" {
        return effects::decide_goal(tx, context, locked, approve, input).await;
    }
    if locked.value["status"] == next {
        if approve && effects::recoverable_branding(locked) {
            if locked.value["decidedByUserId"]
                .as_str()
                .is_some_and(|id| Some(id) != context.user_id())
            {
                return Err(http(
                    403,
                    "Only the authenticated approver can resume this Rust-backed Chat branding change",
                ));
            }
            effects::recover_branding(tx, context, locked).await?;
        }
        return public_approval(tx, locked.organization_id(), locked.id()).await;
    }
    if !matches!(
        locked.value["status"].as_str(),
        Some("pending" | "revision_requested")
    ) {
        return Err(http(
            422,
            format!(
                "Only pending or revision requested approvals can be {}",
                if approve { "approved" } else { "rejected" }
            ),
        ));
    }
    if approve
        && locked.value["type"] == "chat_issue_creation"
        && let Some(payload) = input.get("payload")
    {
        locked.value["payload"] = payload.clone();
    }
    // Use the authenticated user for Chat organization recovery, never the
    // legacy caller-supplied decidedByUserId metadata as authority.
    let decider = if locked.value["type"] == "chat_operation" {
        context.user_id().unwrap_or("board")
    } else {
        input["decidedByUserId"].as_str().unwrap_or("board")
    };
    sqlx::query("UPDATE approvals SET status=$3,payload=$4::jsonb,decision_note=$5,decided_by_user_id=$6,decided_at=now(),updated_at=now() WHERE id=$1::uuid AND org_id=$2::uuid")
        .bind(locked.id()).bind(locked.organization_id()).bind(next).bind(locked.value["payload"].to_string()).bind(input["decisionNote"].as_str()).bind(decider).execute(&mut **tx).await?;
    locked.value["status"] = json!(next);
    locked.value["decisionNote"] = input["decisionNote"].clone();
    effects::apply(tx, context, locked, approve, staged_assets, post_commit).await?;
    audit(tx, context, locked.organization_id(), if approve { "approval.approved" } else { "approval.rejected" }, "approval", locked.id(), json!({"type":locked.value["type"],"requestedByAgentId":locked.value["requestedByAgentId"]}), Some(&format!("approval-{next}:{}",locked.id()))).await?;
    public_approval(tx, locked.organization_id(), locked.id()).await
}

pub(super) async fn public_approval(tx: &mut Tx<'_>, org: &str, id: &str) -> Result<Value> {
    let raw = sqlx::query_scalar::<_, String>(&format!(
        "SELECT {}::text FROM approvals t WHERE t.id=$1::uuid AND t.org_id=$2::uuid",
        crate::approval_reads::projection("approvals")
    ))
    .bind(id)
    .bind(org)
    .fetch_one(&mut **tx)
    .await?;
    Ok(serde_json::from_str(
        &crate::request_reads::redaction::row(&raw, true)?,
    )?)
}

pub(super) async fn audit(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    org: &str,
    action: &str,
    entity: &str,
    id: &str,
    details: Value,
    key: Option<&str>,
) -> Result<()> {
    let actor = context.audit();
    let write = ActivityWrite {
        org,
        audit: &actor,
        action,
        entity_type: entity,
        entity_id: id,
        details: Some(&details),
        options: ActivityOptions {
            agent_id: context.agent_id(),
            bind_run: context.agent_id().is_some(),
            ..Default::default()
        },
    };
    if let Some(key) = key {
        activity::write_activity_idempotent(tx, write, key).await?;
    } else {
        activity::write_activity_options(tx, write).await?;
    }
    Ok(())
}

pub(super) async fn link_issue(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    org: &str,
    approval: &str,
    issue: &str,
) -> Result<()> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM issues WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(org)
    .bind(issue)
    .fetch_one(&mut **tx)
    .await?;
    if !exists {
        return Err(http(404, "Issue not found"));
    }
    let created: Option<String> = sqlx::query_scalar("INSERT INTO issue_approvals (org_id,issue_id,approval_id,linked_by_agent_id,linked_by_user_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5) ON CONFLICT DO NOTHING RETURNING to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
        .bind(org).bind(issue).bind(approval).bind(context.agent_id()).bind(context.user_id()).fetch_optional(&mut **tx).await?;
    if let Some(created) = created {
        audit(
            tx,
            context,
            org,
            "issue.approval_linked",
            "issue",
            issue,
            json!({"approvalId":approval,"linkCreatedAt":created}),
            None,
        )
        .await?;
    }
    Ok(())
}

async fn censor_username(tx: &mut Tx<'_>) -> Result<bool> {
    Ok(sqlx::query_scalar("SELECT COALESCE((SELECT general->>'censorUsernameInLogs'='true' FROM instance_settings WHERE singleton_key='default'),false)").fetch_one(&mut **tx).await?)
}
fn comment_projection() -> String {
    format!(
        "jsonb_build_object('id',c.id,'orgId',c.org_id,'approvalId',c.approval_id,'authorAgentId',c.author_agent_id,'authorUserId',c.author_user_id,'body',c.body,'createdAt',{},'updatedAt',{})",
        crate::request_reads::timestamp("c.created_at"),
        crate::request_reads::timestamp("c.updated_at")
    )
}
async fn comments(tx: &mut Tx<'_>, org: &str, id: &str) -> Result<Value> {
    let rows = sqlx::query_scalar::<_, String>(&format!("SELECT {}::text FROM approval_comments c WHERE c.org_id=$1::uuid AND c.approval_id=$2::uuid ORDER BY c.created_at ASC", comment_projection())).bind(org).bind(id).fetch_all(&mut **tx).await?;
    let censor = censor_username(tx).await?;
    rows.into_iter()
        .map(|raw| {
            let mut v: Value = serde_json::from_str(&raw)?;
            if censor && let Some(body) = v["body"].as_str() {
                v["body"] = json!(activity::redact_current_user_text(body));
            }
            Ok(v)
        })
        .collect::<Result<Vec<_>>>()
        .map(Value::Array)
}
async fn comment(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    locked: &LockedApproval,
    input: &Value,
) -> Result<Value> {
    let body = input["body"]
        .as_str()
        .ok_or_else(|| http(400, "Validation error"))?;
    let body = if censor_username(tx).await? {
        activity::redact_current_user_text(body)
    } else {
        body.to_owned()
    };
    let id: String = sqlx::query_scalar("INSERT INTO approval_comments (org_id,approval_id,author_agent_id,author_user_id,body) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5) RETURNING id::text").bind(locked.organization_id()).bind(locked.id()).bind(context.agent_id()).bind(context.user_id()).bind(body).fetch_one(&mut **tx).await?;
    audit(
        tx,
        context,
        locked.organization_id(),
        "approval.comment_added",
        "approval",
        locked.id(),
        json!({"commentId":id}),
        None,
    )
    .await?;
    let raw: String = sqlx::query_scalar(&format!(
        "SELECT {}::text FROM approval_comments c WHERE c.org_id=$1::uuid AND c.id=$2::uuid",
        comment_projection()
    ))
    .bind(locked.organization_id())
    .bind(id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(serde_json::from_str(&raw)?)
}
pub(super) fn uuid(value: &str) -> Result<String> {
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| http(400, "Validation error"))
}
fn optional_uuid(input: &Value, key: &str) -> Result<Option<String>> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) => uuid(id).map(Some),
        _ => Err(http(400, "Validation error")),
    }
}
pub(super) async fn scoped_agent(tx: &mut Tx<'_>, org: &str, id: &str) -> Result<()> {
    if sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM agents WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(org)
    .bind(id)
    .fetch_one(&mut **tx)
    .await?
    {
        Ok(())
    } else {
        Err(http(404, "Agent not found"))
    }
}
