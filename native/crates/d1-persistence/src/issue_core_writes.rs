//! Public Issue row lifecycle writes. These operations keep the Issue row,
//! label projection, and activity evidence in one PostgreSQL transaction.

use crate::{
    StoreError,
    activity::{ActivityActor, ActivityOptions, ActivityWrite, write_activity_options},
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    goal_runs,
    goal_writes::lock_organization,
    issue_checkout::{
        IssueWakeupActor, IssueWakeupIntent, enqueue_issue_core_wakeup, project_issue,
    },
};
use regex_lite::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, QueryBuilder, Transaction};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    future::Future,
    path::Path,
    pin::Pin,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

type Tx<'a> = Transaction<'a, Postgres>;

const STATUSES: [&str; 7] = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "blocked",
    "done",
    "cancelled",
];
const PRIORITIES: [&str; 5] = ["urgent", "high", "medium", "low", "none"];
const BOARD_ORDER_STEP: i32 = 1000;
const BLOCK_AUDIT_REQUIRED_ATTEMPTS: i32 = 3;

pub struct IssueAssetObject {
    pub body: Vec<u8>,
    pub content_type: Option<String>,
}

pub type IssueAssetStorageFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Object I/O used by Issue creation and deletion. Implementations own no
/// Issue metadata or authorization decisions; those remain in this crate.
pub trait IssueAssetStorage: Send + Sync {
    fn provider(&self) -> &'static str;

    fn get_object<'a>(
        &'a self,
        org_id: &'a str,
        object_key: &'a str,
    ) -> IssueAssetStorageFuture<'a, std::result::Result<IssueAssetObject, String>>;

    fn put_object<'a>(
        &'a self,
        org_id: &'a str,
        object_key: &'a str,
        content_type: &'a str,
        body: &'a [u8],
    ) -> IssueAssetStorageFuture<'a, std::result::Result<(), String>>;

    fn delete_object<'a>(
        &'a self,
        org_id: &'a str,
        object_key: &'a str,
    ) -> IssueAssetStorageFuture<'a, std::result::Result<(), String>>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IssueCoreWriteOperation {
    Create,
    Update,
    Delete,
    Reorder,
}

pub struct IssueCoreWriteActor<'a> {
    pub kind: &'a str,
    pub id: &'a str,
    pub agent_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub authorizer: &'a dyn NativeAgentAuthorizer,
}

pub struct IssueCoreWriteRequest<'a> {
    pub org_id: &'a str,
    pub operation: IssueCoreWriteOperation,
    pub issue_id: Option<&'a str>,
    pub input: &'a Value,
    pub comment_activity_details: Option<&'a Value>,
    pub comment_reopen_wakeup: Option<&'a crate::issue_comments::ReopenCommentWakeup<'a>>,
}

#[derive(Debug, thiserror::Error)]
pub enum IssueCoreWriteError {
    #[error("{1}")]
    Http(u16, String),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

type Result<T> = std::result::Result<T, IssueCoreWriteError>;

#[derive(Clone, Copy)]
struct IssueMutationActor<'a> {
    kind: &'a str,
    id: &'a str,
    agent_id: Option<&'a str>,
    run_id: Option<&'a str>,
}

pub(crate) struct IssueUpdatePostCommit {
    org_id: String,
    issue_id: String,
    actor_kind: String,
    actor_id: String,
    actor_run_id: Option<String>,
    status: String,
    created_by_user_id: Option<String>,
    has_reviewer: bool,
    review_decision: Option<String>,
    review_activity_id: Option<String>,
    comment_created_at: Option<String>,
    reopened: bool,
}

struct StagedIssueDescriptionAssets {
    description: Option<String>,
    attachments: Vec<(String, String)>,
}

struct IssueCreateContext<'a> {
    org: &'a str,
    actor_kind: &'a str,
    actor_id: &'a str,
    actor_agent_id: Option<&'a str>,
    run_id: Option<&'a str>,
    input: &'a Value,
    asset_storage: Option<&'a dyn IssueAssetStorage>,
    staged_asset_objects: &'a mut Vec<String>,
    approved_chat: Option<&'a crate::approval_writes::LockedApproval>,
}

struct IssueDescriptionAssetStageInput<'a> {
    org: &'a str,
    issue_id: &'a str,
    description: Option<&'a str>,
    created_by_agent_id: Option<&'a str>,
    created_by_user_id: Option<&'a str>,
    storage: Option<&'a dyn IssueAssetStorage>,
    staged_objects: &'a mut Vec<String>,
}

impl IssueUpdatePostCommit {
    pub(crate) async fn apply(&self, pool: &PgPool) -> std::result::Result<(), StoreError> {
        crate::issue_lifecycle_analytics::after_issue_update(
            pool,
            crate::issue_lifecycle_analytics::IssueUpdateAnalytics {
                org_id: &self.org_id,
                issue_id: &self.issue_id,
                actor_kind: &self.actor_kind,
                actor_id: &self.actor_id,
                actor_run_id: self.actor_run_id.as_deref(),
                status: &self.status,
                created_by_user_id: self.created_by_user_id.as_deref(),
                has_reviewer: self.has_reviewer,
                review_decision: self.review_decision.as_deref(),
                review_activity_id: self.review_activity_id.as_deref(),
                comment_created_at: self.comment_created_at.as_deref(),
                reopened: self.reopened,
            },
        )
        .await
    }
}

/// Apply a public Issue mutation after revalidating its native credential.
/// `input` is untrusted JSON: every SQL field and reference is validated here.
pub async fn apply_issue_core_write(
    pool: &PgPool,
    actor: &IssueCoreWriteActor<'_>,
    request: &IssueCoreWriteRequest<'_>,
    asset_storage: Option<&dyn IssueAssetStorage>,
) -> Result<(u16, Value, Option<crate::issue_comments::IssueCommentError>)> {
    let actor_kind = actor.kind;
    let actor_id = actor.id;
    let actor_agent_id = actor.agent_id;
    let run_id = actor.run_id;
    let authorizer = actor.authorizer;
    let org_id = request.org_id;
    let operation = request.operation;
    let issue_id = request.issue_id;
    let input = request.input;
    let comment_activity_details = request.comment_activity_details;
    let org = canonical_uuid(org_id)?;
    let mut staged_asset_objects = Vec::new();
    if !matches!(actor_kind, "user" | "agent") || actor_id.trim().is_empty() {
        return Err(http(401, "Unauthorized"));
    }
    if actor_kind == "agent" && actor_agent_id != Some(actor_id) {
        return Err(http(401, "Unauthorized"));
    }
    if !input.is_object() {
        return Err(http(422, "Invalid Issue request"));
    }

    let mut tx = pool.begin().await?;
    let result = async {
        lock_organization(&mut tx, &org).await?;
        match authorizer.revalidate(&mut tx, &org).await? {
            NativeAgentAccess::Authorized => {}
            NativeAgentAccess::Unauthorized => return Err(http(401, "Unauthorized")),
            NativeAgentAccess::Forbidden => {
                return Err(http(403, "User does not have access to this organization"));
            }
        }
        if matches!(
            operation,
            IssueCoreWriteOperation::Create | IssueCoreWriteOperation::Update
        ) {
            crate::issue_input_validation::validate_nested_fields(input)
                .map_err(|message| http(422, message))?;
        }

        let (status, body, post_commit, deleted_asset_objects, comment_wakeup_error) =
            match operation {
                IssueCoreWriteOperation::Create => {
                    let value = create_issue(
                        &mut tx,
                        IssueCreateContext {
                            org: &org,
                            actor_kind,
                            actor_id,
                            actor_agent_id,
                            run_id,
                            input,
                            asset_storage,
                            staged_asset_objects: &mut staged_asset_objects,
                            approved_chat: None,
                        },
                    )
                    .await?;
                    (201, value, None, Vec::new(), None)
                }
                IssueCoreWriteOperation::Update => {
                    let id = required_issue_id(issue_id)?;
                    let mutation_actor = IssueMutationActor {
                        kind: actor_kind,
                        id: actor_id,
                        agent_id: actor_agent_id,
                        run_id,
                    };
                    let mut comment_activity_details = comment_activity_details.cloned();
                    let mut comment_reopen_wakeup = request.comment_reopen_wakeup.cloned();
                    if let Some(wakeup) = comment_reopen_wakeup.as_mut()
                        && let Some(run) = wakeup.interrupt_run
                    {
                        wakeup.interrupted_run_id =
                            crate::issue_comments::cancel_reopened_comment_interrupt(
                                &mut tx,
                                &org,
                                &id,
                                run,
                                wakeup.actor,
                            )
                            .await
                            .map_err(map_issue_comment_error)?;
                        if wakeup.interrupted_run_id.is_none()
                            && let Some(details) = comment_activity_details.as_mut()
                            && let Some(details) = details.as_object_mut()
                        {
                            details.remove("interruptedRunId");
                        }
                    }
                    let (value, post_commit) = update_issue(
                        &mut tx,
                        &org,
                        &mutation_actor,
                        &id,
                        input,
                        comment_activity_details.as_ref(),
                        None,
                    )
                    .await?;
                    let comment_wakeup_error = if let Some(wakeup) = comment_reopen_wakeup.as_ref()
                    {
                        crate::issue_comments::try_enqueue_reopened_comment_effects(
                            &mut tx,
                            &org,
                            &id,
                            &value["comment"],
                            wakeup,
                        )
                        .await
                        .map_err(map_issue_comment_error)?
                    } else {
                        None
                    };
                    (200, value, post_commit, Vec::new(), comment_wakeup_error)
                }
                IssueCoreWriteOperation::Delete => {
                    let id = required_issue_id(issue_id)?;
                    let (value, deleted_asset_objects) = delete_issue(
                        &mut tx,
                        &org,
                        actor_kind,
                        actor_id,
                        actor_agent_id,
                        run_id,
                        &id,
                    )
                    .await?;
                    (200, value, None, deleted_asset_objects, None)
                }
                IssueCoreWriteOperation::Reorder => {
                    if actor_kind != "user" {
                        return Err(http(403, "Board authentication required"));
                    }
                    let value = reorder_issue(&mut tx, &org, actor_id, input).await?;
                    (200, value, None, Vec::new(), None)
                }
            };
        Ok((
            status,
            body,
            post_commit,
            deleted_asset_objects,
            comment_wakeup_error,
        ))
    }
    .await;

    match result {
        Ok((status, body, post_commit, deleted_asset_objects, comment_wakeup_error)) => {
            // A lost COMMIT response does not prove a rollback. Keep the copied
            // objects when the database outcome is unknown.
            tx.commit().await?;
            if let Some(post_commit) = post_commit {
                post_commit.apply(pool).await?;
            }
            if let Some(storage) = asset_storage {
                for object_key in deleted_asset_objects {
                    if let Err(error) = storage.delete_object(&org, &object_key).await {
                        tracing::warn!(%error, org_id = org, object_key, "failed to delete Issue asset object after Issue deletion");
                    }
                }
            } else if !deleted_asset_objects.is_empty() {
                tracing::warn!(
                    org_id = org,
                    issue_id,
                    "Issue asset objects could not be deleted because storage is unavailable"
                );
            }
            Ok((status, body, comment_wakeup_error))
        }
        Err(error) => {
            if let Err(rollback_error) = tx.rollback().await {
                tracing::warn!(%rollback_error, org_id = org, "failed to roll back a public Issue mutation");
            }
            if let Some(storage) = asset_storage {
                cleanup_staged_issue_asset_objects(storage, &org, &staged_asset_objects).await;
            }
            Err(error)
        }
    }
}

pub(crate) async fn cleanup_staged_issue_asset_objects(
    storage: &dyn IssueAssetStorage,
    org_id: &str,
    object_keys: &[String],
) {
    for object_key in object_keys {
        if let Err(error) = storage.delete_object(org_id, object_key).await {
            tracing::warn!(%error, org_id, object_key, "failed to clean up a staged Issue asset object");
        }
    }
}

/// The Approval domain has already checked the proposal and decision. Keep
/// Issue validation, numbering, labels, asset handling and creation activity in
/// the same existing writer as the direct public workflow.
pub(crate) async fn create_approved_chat_issue(
    tx: &mut Tx<'_>,
    approval: &crate::approval_writes::LockedApproval,
    actor_id: &str,
    input: &Value,
    asset_storage: Option<&dyn IssueAssetStorage>,
    staged_asset_objects: &mut Vec<String>,
) -> Result<Value> {
    crate::issue_input_validation::validate_nested_fields(input)
        .map_err(|message| http(422, message))?;
    create_issue(
        tx,
        IssueCreateContext {
            org: approval.organization_id(),
            actor_kind: "user",
            actor_id,
            actor_agent_id: None,
            run_id: None,
            input,
            asset_storage,
            staged_asset_objects,
            approved_chat: Some(approval),
        },
    )
    .await
}

pub(crate) async fn reactivate_approved_issue(
    tx: &mut Tx<'_>,
    approval: &crate::approval_writes::LockedApproval,
    actor_id: &str,
    issue_id: &str,
    status: &str,
) -> Result<(Value, Option<IssueUpdatePostCommit>)> {
    let actor = IssueMutationActor {
        kind: "user",
        id: actor_id,
        agent_id: None,
        run_id: None,
    };
    let result = update_issue(
        tx,
        approval.organization_id(),
        &actor,
        issue_id,
        &json!({"status":status}),
        None,
        Some(approval),
    )
    .await?;
    Ok(result)
}

async fn create_issue(tx: &mut Tx<'_>, context: IssueCreateContext<'_>) -> Result<Value> {
    let IssueCreateContext {
        org,
        actor_kind,
        actor_id,
        actor_agent_id,
        run_id,
        input,
        asset_storage,
        staged_asset_objects,
        approved_chat,
    } = context;
    let agent_issue_creation_request_id = if actor_kind == "agent" {
        match (actor_agent_id, run_id) {
            (Some(agent_id), Some(run_id)) => {
                crate::agent_issue_creation::resolve_for_run(tx, org, agent_id, run_id)
                    .await
                    .map_err(map_agent_issue_creation_error)?
            }
            _ => None,
        }
    } else {
        None
    };
    let title = required_text(input, "title")?;
    if title.trim().is_empty() {
        return Err(http(422, "Issue title is required"));
    }
    let mut status = text_or(input, "status", "backlog")?;
    if agent_issue_creation_request_id.is_some() {
        status = "todo".to_owned();
    }
    let priority = text_or(input, "priority", "medium")?;
    validate_choice(&status, &STATUSES, "Invalid Issue status")?;
    validate_choice(&priority, &PRIORITIES, "Invalid Issue priority")?;
    let description = optional_text(input, "description")?;
    let project_id =
        resolve_optional_entity_ref(tx, org, input, "projectId", "projects", "prj", "Project ID")
            .await?;
    let project_workspace_id = optional_uuid(input, "projectWorkspaceId")?;
    let goal_id =
        resolve_optional_entity_ref(tx, org, input, "goalId", "goals", "gol", "Goal ID").await?;
    let parent_id = resolve_optional_entity_ref(
        tx,
        org,
        input,
        "parentId",
        "issues",
        "iss",
        "Parent issue ID",
    )
    .await?;
    let mut assignee_agent_id = resolve_optional_entity_ref(
        tx,
        org,
        input,
        "assigneeAgentId",
        "agents",
        "agt",
        "Assignee agent ID",
    )
    .await?;
    let assignee_user_id =
        resolve_optional_user_ref(tx, org, input, "assigneeUserId", "Assignee user ID").await?;
    let reviewer_agent_id = resolve_optional_entity_ref(
        tx,
        org,
        input,
        "reviewerAgentId",
        "agents",
        "agt",
        "Reviewer agent ID",
    )
    .await?;
    let reviewer_user_id =
        resolve_optional_user_ref(tx, org, input, "reviewerUserId", "Reviewer user ID").await?;
    let request_depth = match input.get("requestDepth") {
        None => 0,
        Some(Value::Number(value)) => value
            .as_i64()
            .ok_or_else(|| http(422, "requestDepth must be a nonnegative integer"))?,
        _ => return Err(http(422, "requestDepth must be a nonnegative integer")),
    };
    let billing_code = optional_text(input, "billingCode")?;
    let label_ids = optional_uuid_array(input, "labelIds")?;
    let execution_workspace_id = alias_uuid(input, "runWorkspaceId", "executionWorkspaceId")?;
    let execution_workspace_preference = alias_text(
        input,
        "runWorkspacePreference",
        "executionWorkspacePreference",
    )?;
    if let Some(preference) = execution_workspace_preference.as_deref() {
        validate_choice(
            preference,
            &[
                "inherit",
                "shared_workspace",
                "isolated_workspace",
                "operator_branch",
                "reuse_existing",
                "agent_default",
            ],
            "Invalid run workspace preference",
        )?;
    }
    let execution_workspace_settings =
        alias_json(input, "runWorkspaceSettings", "executionWorkspaceSettings")?;
    let runtime_overrides = json_field(input, "assigneeAgentRuntimeOverrides")?;

    let (origin_kind, origin_id, origin_run_id) = if let Some(request_id) =
        agent_issue_creation_request_id.as_deref()
    {
        let existing = sqlx::query_scalar::<_, String>(
            "SELECT to_jsonb(i)::text FROM issues i WHERE i.org_id=$1::uuid AND i.origin_kind='agent_issue_creation' AND i.origin_id=$2 LIMIT 1",
        )
        .bind(org)
        .bind(request_id)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(existing) = existing {
            let issue = project_issue(tx, &existing).await.map_err(project_error)?;
            if let (Some(agent_id), Some(run_id)) = (actor_agent_id, run_id) {
                crate::agent_issue_creation::complete_for_created_issue(
                    tx,
                    org,
                    agent_id,
                    run_id,
                    request_id,
                    issue["id"].as_str().unwrap_or_default(),
                )
                .await
                .map_err(map_agent_issue_creation_error)?;
            }
            return Ok(issue);
        }
        (
            "agent_issue_creation",
            Some(request_id.to_owned()),
            run_id.map(ToOwned::to_owned),
        )
    } else {
        ("manual", None, None)
    };

    if request_depth < 0 || request_depth > i32::MAX as i64 {
        return Err(http(422, "requestDepth must be a nonnegative integer"));
    }
    if assignee_agent_id.is_some() && assignee_user_id.is_some() {
        return Err(http(422, "Issue can only have one assignee"));
    }
    if reviewer_agent_id.is_some() && reviewer_user_id.is_some() {
        return Err(http(422, "Issue can only have one reviewer"));
    }
    if let Some(agent) = actor_agent_id {
        // The public route makes an unassigned Agent-created Issue its own work.
        if assignee_agent_id.is_none() && assignee_user_id.is_none() {
            assignee_agent_id = Some(canonical_uuid(agent)?);
        }
    }
    if status == "in_progress" && assignee_agent_id.is_none() && assignee_user_id.is_none() {
        return Err(http(422, "in_progress issues require an assignee"));
    }
    if status == "in_review" && reviewer_agent_id.is_none() && reviewer_user_id.is_none() {
        return Err(http(
            422,
            "An in_review Issue requires a reviewer agent or user",
        ));
    }
    if actor_kind == "agent"
        && [
            "assigneeAgentId",
            "assigneeUserId",
            "reviewerAgentId",
            "reviewerUserId",
        ]
        .iter()
        .any(|field| input.get(*field).is_some())
    {
        require_task_assign(
            tx,
            org,
            actor_agent_id.ok_or_else(|| http(401, "Agent authentication required"))?,
        )
        .await?;
    }

    validate_agent(tx, org, assignee_agent_id.as_deref(), "Assignee").await?;
    validate_user(tx, org, assignee_user_id.as_deref(), "Assignee").await?;
    validate_agent(tx, org, reviewer_agent_id.as_deref(), "Reviewer").await?;
    validate_user(tx, org, reviewer_user_id.as_deref(), "Reviewer").await?;
    validate_reference(
        tx,
        "projects",
        org,
        project_id.as_deref(),
        "Project not found",
    )
    .await?;
    validate_reference(tx, "goals", org, goal_id.as_deref(), "Goal not found").await?;
    validate_reference(
        tx,
        "project_workspaces",
        org,
        project_workspace_id.as_deref(),
        "Project run directory not found",
    )
    .await?;
    validate_reference(
        tx,
        "execution_workspaces",
        org,
        execution_workspace_id.as_deref(),
        "Run workspace not found",
    )
    .await?;
    let parent_project_id = if let Some(parent) = parent_id.as_deref() {
        if Uuid::parse_str(parent).is_err() {
            return Err(http(
                422,
                "Parent issue must belong to the same organization",
            ));
        }
        let row = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT org_id::text,project_id::text FROM issues WHERE id=$1::uuid",
        )
        .bind(parent)
        .fetch_optional(&mut **tx)
        .await?;
        let Some((parent_org, parent_project)) = row else {
            return Err(http(
                422,
                "Parent issue must belong to the same organization",
            ));
        };
        if parent_org != org {
            return Err(http(
                422,
                "Parent issue must belong to the same organization",
            ));
        }
        parent_project
    } else {
        None
    };
    let project_id = project_id.or(parent_project_id);
    let mut project_workspace_id = project_workspace_id;
    let mut execution_workspace_settings = execution_workspace_settings;
    if let Some(project_id) = project_id.as_deref() {
        let policy = sqlx::query_scalar::<_, Option<Value>>(
            "SELECT execution_workspace_policy FROM projects WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(org)
        .bind(project_id)
        .fetch_optional(&mut **tx)
        .await?
        .flatten()
        .unwrap_or_else(|| json!({}));
        if execution_workspace_settings.is_none() && policy["enabled"] == true {
            let mode = match policy["defaultMode"].as_str() {
                Some("isolated_workspace" | "isolated") => "isolated_workspace",
                Some("operator_branch") => "operator_branch",
                Some("adapter_default") => "agent_default",
                _ => "shared_workspace",
            };
            execution_workspace_settings = Some(json!({"mode":mode}));
        }
        if project_workspace_id.is_none() {
            if let Some(default_workspace) = policy["defaultProjectWorkspaceId"].as_str() {
                project_workspace_id = Some(
                    canonical_uuid(default_workspace)
                        .map_err(|_| http(422, "Default project workspace is invalid"))?,
                );
            } else {
                project_workspace_id = sqlx::query_scalar::<_, String>(
                    "SELECT id::text FROM project_workspaces WHERE org_id=$1::uuid AND project_id=$2::uuid ORDER BY is_primary DESC,created_at,id LIMIT 1",
                )
                .bind(org)
                .bind(project_id)
                .fetch_optional(&mut **tx)
                .await?;
            }
        }
    }
    validate_workspace_project(
        tx,
        org,
        project_id.as_deref(),
        project_workspace_id.as_deref(),
        execution_workspace_id.as_deref(),
    )
    .await?;
    let mut label_ids = label_ids;
    if label_ids.is_empty()
        && let Some(parent_id) = parent_id.as_deref()
    {
        label_ids = sqlx::query_scalar::<_, String>(
                "SELECT il.label_id::text FROM issue_labels il JOIN issues parent ON parent.org_id=il.org_id AND parent.id=il.issue_id WHERE il.org_id=$1::uuid AND parent.id=$2::uuid ORDER BY il.label_id",
            )
            .bind(org)
            .bind(parent_id)
            .fetch_all(&mut **tx)
            .await?;
    }
    if label_ids.is_empty() && actor_agent_id.is_some() {
        let label_count =
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM labels WHERE org_id=$1::uuid")
                .bind(org)
                .fetch_one(&mut **tx)
                .await?;
        if label_count >= 5 {
            return Err(http(
                422,
                &format!(
                    "当前组织有 {label_count} 个 labels，agent 创建 issue 需要选择至少一个 label"
                ),
            ));
        }
    }
    validate_labels(tx, org, &label_ids).await?;

    let counter = sqlx::query_as::<_, (i32, String)>(
        "UPDATE organizations SET issue_counter=issue_counter+1 WHERE id=$1::uuid RETURNING issue_counter,issue_prefix",
    )
    .bind(org)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| http(404, "Organization not found"))?;
    let (issue_number, prefix) = counter;
    let identifier = format!("{prefix}-{issue_number}");
    let board_order = sqlx::query_scalar::<_, i32>(
        "SELECT COALESCE(MAX(board_order),0)+$2 FROM issues WHERE org_id=$1::uuid AND status=$3",
    )
    .bind(org)
    .bind(BOARD_ORDER_STEP)
    .bind(&status)
    .fetch_one(&mut **tx)
    .await?;
    let id = Uuid::new_v4().to_string();
    let created_by_user_id = (actor_kind == "user").then_some(actor_id);
    let created_by_agent_id = approved_chat
        .and_then(|approval| approval.value()["payload"]["proposedByAgentId"].as_str())
        .or(actor_agent_id);
    let staged_description_assets = stage_issue_description_assets(
        tx,
        IssueDescriptionAssetStageInput {
            org,
            issue_id: &id,
            description: description.as_deref(),
            created_by_agent_id,
            created_by_user_id,
            storage: asset_storage,
            staged_objects: staged_asset_objects,
        },
    )
    .await?;
    let row = sqlx::query_scalar::<_, String>(
        "INSERT INTO issues (id,org_id,project_id,project_workspace_id,goal_id,parent_id,title,description,status,priority,board_order,assignee_agent_id,assignee_user_id,reviewer_agent_id,reviewer_user_id,created_by_agent_id,created_by_user_id,issue_number,identifier,request_depth,billing_code,assignee_agent_runtime_overrides,execution_workspace_id,execution_workspace_preference,execution_workspace_settings,origin_kind,origin_id,origin_run_id,started_at,completed_at,cancelled_at,execution_cancellation_at) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9,$10,$11,$12::uuid,$13,$14::uuid,$15,$16::uuid,$17,$18,$19,$20,$21,$22::jsonb,$23::uuid,$24,$25::jsonb,$26,$27,$28,CASE WHEN $9='in_progress' THEN clock_timestamp() ELSE NULL END,CASE WHEN $9='done' THEN clock_timestamp() ELSE NULL END,CASE WHEN $9='cancelled' THEN clock_timestamp() ELSE NULL END,CASE WHEN $9='cancelled' THEN clock_timestamp() ELSE NULL END) RETURNING to_jsonb(issues)::text",
    )
    .bind(&id).bind(org).bind(project_id).bind(project_workspace_id).bind(goal_id).bind(parent_id)
    .bind(&title).bind(staged_description_assets.description).bind(status).bind(priority).bind(board_order)
    .bind(assignee_agent_id).bind(assignee_user_id).bind(reviewer_agent_id).bind(reviewer_user_id)
    .bind(created_by_agent_id).bind(created_by_user_id).bind(issue_number).bind(&identifier)
    .bind(request_depth as i32).bind(billing_code).bind(runtime_overrides.map(|value| value.to_string()))
    .bind(execution_workspace_id).bind(execution_workspace_preference).bind(execution_workspace_settings.map(|value| value.to_string()))
    .bind(origin_kind).bind(origin_id).bind(origin_run_id)
    .fetch_one(&mut **tx).await?;
    for (attachment_id, asset_id) in staged_description_assets.attachments {
        sqlx::query(
            "INSERT INTO issue_attachments (id,org_id,issue_id,asset_id,usage) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'description_inline')",
        )
        .bind(attachment_id)
        .bind(org)
        .bind(&id)
        .bind(asset_id)
        .execute(&mut **tx)
        .await?;
    }
    if !label_ids.is_empty() {
        let mut query =
            QueryBuilder::<Postgres>::new("INSERT INTO issue_labels (org_id,issue_id,label_id) ");
        query.push_values(label_ids.iter(), |mut row, label| {
            row.push_bind(org)
                .push("::uuid,")
                .push_bind(&id)
                .push("::uuid,")
                .push_bind(label)
                .push("::uuid");
        });
        query.build().execute(&mut **tx).await?;
    }
    let issue = project_issue(tx, &row).await.map_err(|error| match error {
        crate::issue_checkout::IssueCheckoutError::Database(error) => {
            IssueCoreWriteError::Database(error)
        }
        crate::issue_checkout::IssueCheckoutError::Json(error) => IssueCoreWriteError::Json(error),
        crate::issue_checkout::IssueCheckoutError::Http(_, message, _) => http(422, &message),
    })?;
    let audit = ActivityActor {
        actor_type: activity_actor_type(actor_kind),
        actor_id: actor_id.to_owned(),
        run_id: run_id.map(ToOwned::to_owned),
    };
    write_activity_options(
        tx,
        ActivityWrite {
            org,
            audit: &audit,
            action: "issue.created",
            entity_type: "issue",
            entity_id: &id,
            details: Some(&json!({"title":title,"identifier":identifier})),
            options: ActivityOptions {
                agent_id: actor_agent_id,
                effects: None,
                bind_run: true,
            },
        },
    )
    .await?;
    crate::issue_lifecycle_analytics::record_issue_created(tx, org, &issue).await?;
    let mut wakeups = Vec::new();
    if let Some(agent_id) = issue["assigneeAgentId"].as_str()
        && is_assignment_wakeup_status(issue["status"].as_str())
    {
        wakeups.push(IssueWakeupIntent::assignment(
            agent_id,
            "assignment",
            "issue_assigned",
            "create",
            "issue.create",
        ));
    }
    if matches!(issue["status"].as_str(), Some("in_review" | "blocked"))
        && let Some(agent_id) = issue["reviewerAgentId"].as_str()
    {
        wakeups.push(IssueWakeupIntent {
            agent_id: agent_id.to_owned(),
            source: "review",
            reason: "issue_review_requested",
            mutation: "create_in_review".to_owned(),
            context_source: "issue.create",
            wake_source: "review",
            role: Some("reviewer"),
            comment: None,
            relationship: None,
            expected_issue_execution_run_id: None,
            payload_extra: None,
            context_extra: None,
        });
    }
    if approved_chat.is_none() {
        enqueue_issue_wakeups(tx, org, &id, actor_kind, actor_id, wakeups).await?;
    }
    if let (Some(request_id), Some(agent_id), Some(run_id)) = (
        agent_issue_creation_request_id.as_deref(),
        actor_agent_id,
        run_id,
    ) {
        crate::agent_issue_creation::complete_for_created_issue(
            tx, org, agent_id, run_id, request_id, &id,
        )
        .await
        .map_err(map_agent_issue_creation_error)?;
    }
    Ok(issue)
}

async fn stage_issue_description_assets(
    tx: &mut Tx<'_>,
    input: IssueDescriptionAssetStageInput<'_>,
) -> Result<StagedIssueDescriptionAssets> {
    let IssueDescriptionAssetStageInput {
        org,
        issue_id,
        description,
        created_by_agent_id,
        created_by_user_id,
        storage,
        staged_objects,
    } = input;
    let Some(description) = description else {
        return Ok(StagedIssueDescriptionAssets {
            description: None,
            attachments: Vec::new(),
        });
    };
    let asset_path_regex = Regex::new(r"/api/assets/([^/?#\s)]+)/content")
        .expect("Issue description asset path expression is valid");
    let mut source_asset_ids = Vec::new();
    let mut unique_ids = HashSet::new();
    for captures in asset_path_regex.captures_iter(description) {
        let Some(raw_id) = captures.get(1).map(|value| value.as_str().trim()) else {
            continue;
        };
        if is_uuid_like(raw_id) {
            let id = raw_id.to_ascii_lowercase();
            if unique_ids.insert(id.clone()) {
                source_asset_ids.push(id);
            }
        }
    }
    if source_asset_ids.is_empty() {
        return Ok(StagedIssueDescriptionAssets {
            description: Some(description.to_owned()),
            attachments: Vec::new(),
        });
    }
    let storage = storage.ok_or_else(|| {
        http(
            422,
            "Issue description image storage is unavailable; please retry the Issue creation",
        )
    })?;

    let source_rows = sqlx::query_as::<_, (String, String, String, String, Option<String>)>(
        "SELECT id::text,provider,object_key,content_type,original_filename FROM assets WHERE org_id=$1::uuid AND id=ANY($2::uuid[])",
    )
    .bind(org)
    .bind(&source_asset_ids)
    .fetch_all(&mut **tx)
    .await?;
    let source_assets = source_rows
        .into_iter()
        .map(
            |(id, provider, object_key, content_type, original_filename)| {
                (
                    id.to_ascii_lowercase(),
                    (provider, object_key, content_type, original_filename),
                )
            },
        )
        .collect::<HashMap<_, _>>();

    let mut replacements = HashMap::new();
    let mut attachments = Vec::with_capacity(source_asset_ids.len());
    for source_id in source_asset_ids {
        let Some((_, object_key, source_content_type, original_filename)) =
            source_assets.get(&source_id)
        else {
            return Err(http(
                422,
                "Issue description image asset is missing or outside the organization",
            ));
        };
        if !object_key.starts_with(&format!("{org}/")) || object_key.contains("..") {
            return Err(http(
                422,
                "Issue description image could not be saved; please retry the Issue creation",
            ));
        }
        let object = storage.get_object(org, object_key).await.map_err(|_| {
            http(
                422,
                "Issue description image could not be saved; please retry the Issue creation",
            )
        })?;
        if object.body.is_empty() {
            return Err(http(
                422,
                "Issue description image could not be saved; please retry the Issue creation",
            ));
        }
        let content_type = if source_content_type.trim().is_empty() {
            object
                .content_type
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("application/octet-stream")
        } else {
            source_content_type
        }
        .trim()
        .to_ascii_lowercase();
        let copied_object_key =
            issue_description_object_key(org, issue_id, original_filename.as_deref());
        storage
            .put_object(org, &copied_object_key, &content_type, &object.body)
            .await
            .map_err(|_| {
                http(
                    422,
                    "Issue description image could not be saved; please retry the Issue creation",
                )
            })?;
        staged_objects.push(copied_object_key.clone());

        let byte_size = i32::try_from(object.body.len()).map_err(|_| {
            http(
                422,
                "Issue description image could not be saved; please retry the Issue creation",
            )
        })?;
        let sha256 = format!("{:x}", Sha256::digest(&object.body));
        let copied_asset_id = sqlx::query_scalar::<_, String>(
            "INSERT INTO assets (org_id,provider,object_key,content_type,byte_size,sha256,original_filename,created_by_agent_id,created_by_user_id) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::uuid,$9) RETURNING id::text",
        )
        .bind(org)
        .bind(storage.provider())
        .bind(&copied_object_key)
        .bind(&content_type)
        .bind(byte_size)
        .bind(sha256)
        .bind(original_filename)
        .bind(created_by_agent_id)
        .bind(created_by_user_id)
        .fetch_one(&mut **tx)
        .await?;
        let attachment_id = Uuid::new_v4().to_string();
        replacements.insert(
            source_id,
            format!("/api/attachments/{attachment_id}/content"),
        );
        attachments.push((attachment_id, copied_asset_id));
    }

    let rewritten =
        asset_path_regex.replace_all(description, |captures: &regex_lite::Captures<'_>| {
            let Some(asset_id) = captures
                .get(1)
                .map(|value| value.as_str().to_ascii_lowercase())
            else {
                return captures
                    .get(0)
                    .map(|value| value.as_str())
                    .unwrap_or_default()
                    .to_owned();
            };
            replacements.get(&asset_id).cloned().unwrap_or_else(|| {
                captures
                    .get(0)
                    .map(|value| value.as_str())
                    .unwrap_or_default()
                    .to_owned()
            })
        });
    Ok(StagedIssueDescriptionAssets {
        description: Some(rewritten.into_owned()),
        attachments,
    })
}

fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && matches!(bytes[14], b'1'..=b'5')
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

fn issue_description_object_key(
    org: &str,
    issue_id: &str,
    original_filename: Option<&str>,
) -> String {
    let namespace = format!("issues/{issue_id}/description");
    let now = OffsetDateTime::now_utc();
    let date = format!(
        "{:04}/{:02}/{:02}",
        now.year(),
        now.month() as u8,
        now.day()
    );
    let (stem, extension) = split_storage_filename(original_filename);
    format!(
        "{org}/{namespace}/{date}/{}-{stem}{extension}",
        Uuid::new_v4()
    )
}

fn split_storage_filename(filename: Option<&str>) -> (String, String) {
    let Some(filename) = filename else {
        return ("file".to_owned(), String::new());
    };
    let base = Path::new(filename)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .trim();
    if base.is_empty() {
        return ("file".to_owned(), String::new());
    }
    let extension = Path::new(base)
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default()
        .to_ascii_lowercase()
        .chars()
        .filter(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || *character == '.'
        })
        .take(16)
        .collect::<String>();
    let stem_source = if extension.is_empty() {
        base
    } else {
        base.strip_suffix(&format!(
            ".{}",
            Path::new(base).extension().unwrap().to_string_lossy()
        ))
        .unwrap_or(base)
    };
    (sanitize_storage_segment(stem_source), extension)
}

fn sanitize_storage_segment(value: &str) -> String {
    let mut cleaned = String::new();
    for character in value.trim().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            cleaned.push(character);
        } else if !cleaned.ends_with('_') {
            cleaned.push('_');
        }
    }
    let cleaned = cleaned.trim_matches('_');
    if cleaned.is_empty() {
        return "file".to_owned();
    }
    cleaned.chars().take(120).collect()
}

async fn update_issue(
    tx: &mut Tx<'_>,
    org: &str,
    actor: &IssueMutationActor<'_>,
    id: &str,
    input: &Value,
    comment_activity_details: Option<&Value>,
    approved: Option<&crate::approval_writes::LockedApproval>,
) -> Result<(Value, Option<IssueUpdatePostCommit>)> {
    let actor_kind = actor.kind;
    let actor_id = actor.id;
    let actor_agent_id = actor.agent_id;
    let run_id = actor.run_id;
    let current = sqlx::query_scalar::<_, String>(
        "SELECT to_jsonb(i)::text FROM issues i WHERE i.org_id=$1::uuid AND i.id=$2::uuid FOR UPDATE",
    )
    .bind(org).bind(id).fetch_optional(&mut **tx).await?.ok_or_else(|| http(404,"Issue not found"))?;
    let current_value: Value = serde_json::from_str(&current)?;
    let current_status = current_value["status"].as_str().unwrap_or("backlog");
    let current_issue = project_issue(tx, &current).await.map_err(project_error)?;
    if let Some(agent_id) = actor_agent_id.filter(|_| actor_kind == "agent") {
        let is_assignee = current_value["assignee_agent_id"].as_str() == Some(agent_id);
        let is_reviewer = current_value["reviewer_agent_id"].as_str() == Some(agent_id);
        if !is_assignee && !is_reviewer {
            return Err(http(403, "Agent is not the current assignee or reviewer"));
        }
        if current_status == "in_progress"
            && is_assignee
            && current_value["checkout_run_id"].as_str().is_some()
        {
            let run_id = run_id.ok_or_else(|| http(401, "Agent run id required"))?;
            if Uuid::parse_str(run_id).is_err()
                || current_value["checkout_run_id"].as_str() != Some(run_id)
            {
                return Err(http(409, "Issue run ownership conflict"));
            }
        }
    }
    let mut next_status = if input.get("status").is_some() {
        Some(required_text(input, "status")?)
    } else {
        None
    };
    let mut comment_body = match input.get("comment") {
        None => None,
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        Some(_) => return Err(http(422, "comment must be a non-empty string")),
    };
    let reopen = match input.get("reopen") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(http(422, "reopen must be a boolean")),
    };
    let hidden_at = input
        .get("hiddenAt")
        .map(parse_optional_timestamp)
        .transpose()?;
    let review_decision = match input.get("reviewDecision") {
        None => None,
        Some(Value::String(value)) => {
            validate_choice(
                value,
                &["approve", "request_changes", "needs_followup", "blocked"],
                "Invalid reviewer decision",
            )?;
            Some(value.as_str())
        }
        Some(_) => return Err(http(422, "Invalid reviewer decision")),
    };
    let is_closed = matches!(current_status, "done" | "cancelled");
    let reopened = comment_body.is_some()
        && reopen
        && is_closed
        && input.get("status").is_none()
        && review_decision.is_none();
    if reopened {
        next_status = Some("todo".to_owned());
    }
    if let Some(decision) = review_decision {
        if comment_body.is_none() {
            return Err(http(422, "Reviewer decisions require a comment"));
        }
        if !matches!(current_status, "in_review" | "blocked") {
            return Err(http(
                422,
                "Reviewer decisions can only be recorded while the issue is in_review or blocked",
            ));
        }
        if actor_kind == "agent" && current_value["reviewer_agent_id"].as_str() != actor_agent_id {
            return Err(http(
                403,
                "Only the reviewer agent can record a reviewer decision",
            ));
        }
        next_status = Some(
            match decision {
                "approve" => "done",
                "request_changes" => "in_progress",
                "needs_followup" => "todo",
                "blocked" => "blocked",
                _ => unreachable!("review decision was validated"),
            }
            .to_owned(),
        );
    }
    let next_title = if input.get("title").is_some() {
        Some(required_text(input, "title")?)
    } else {
        None
    };
    if next_title
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(http(422, "Issue title is required"));
    }
    let next_priority = if input.get("priority").is_some() {
        Some(required_text(input, "priority")?)
    } else {
        None
    };
    if let Some(priority) = next_priority.as_deref() {
        validate_choice(priority, &PRIORITIES, "Invalid Issue priority")?;
    }
    let assignee_agent = resolve_optional_entity_ref_field(
        tx,
        org,
        input,
        "assigneeAgentId",
        "agents",
        "agt",
        "Assignee agent ID",
    )
    .await?;
    let assignee_user =
        resolve_optional_user_ref_field(tx, org, input, "assigneeUserId", "Assignee user ID")
            .await?;
    let reviewer_agent = resolve_optional_entity_ref_field(
        tx,
        org,
        input,
        "reviewerAgentId",
        "agents",
        "agt",
        "Reviewer agent ID",
    )
    .await?;
    let reviewer_user =
        resolve_optional_user_ref_field(tx, org, input, "reviewerUserId", "Reviewer user ID")
            .await?;
    let next_assignee_agent = assignee_agent.clone().unwrap_or_else(|| {
        current_value["assignee_agent_id"]
            .as_str()
            .map(ToOwned::to_owned)
    });
    let next_assignee_user = assignee_user.clone().unwrap_or_else(|| {
        current_value["assignee_user_id"]
            .as_str()
            .map(ToOwned::to_owned)
    });
    let next_reviewer_agent = reviewer_agent.clone().unwrap_or_else(|| {
        current_value["reviewer_agent_id"]
            .as_str()
            .map(ToOwned::to_owned)
    });
    let next_reviewer_user = reviewer_user.clone().unwrap_or_else(|| {
        current_value["reviewer_user_id"]
            .as_str()
            .map(ToOwned::to_owned)
    });
    let is_reviewer_agent = actor_agent_id
        .is_some_and(|agent_id| current_value["reviewer_agent_id"].as_str() == Some(agent_id));
    let mut reviewed_completion_normalized = false;
    if actor_kind == "agent" && next_status.as_deref() == Some("done") {
        let can_complete = ((current_status == "in_review" || current_status == "blocked")
            && is_reviewer_agent)
            || (current_status == "in_progress"
                && current_value["assignee_agent_id"].as_str() == actor_agent_id);
        if !can_complete {
            return Err(http(
                403,
                "Only the checked-out assignee or reviewer can complete issue",
            ));
        }
        let has_reviewer = current_value["reviewer_agent_id"].as_str().is_some()
            || current_value["reviewer_user_id"].as_str().is_some();
        if has_reviewer
            && !((current_status == "in_review" || current_status == "blocked")
                && is_reviewer_agent)
        {
            next_status = Some("in_review".to_owned());
            reviewed_completion_normalized = true;
        }
    }
    if let Some(status) = next_status.as_deref() {
        validate_choice(status, &STATUSES, "Invalid Issue status")?;
    }
    let status_for_validation = next_status.as_deref().unwrap_or(current_status);
    if next_assignee_agent.is_some() && next_assignee_user.is_some() {
        return Err(http(422, "Issue can only have one assignee"));
    }
    if next_reviewer_agent.is_some() && next_reviewer_user.is_some() {
        return Err(http(422, "Issue can only have one reviewer"));
    }
    if status_for_validation == "in_progress"
        && next_assignee_agent.is_none()
        && next_assignee_user.is_none()
    {
        return Err(http(422, "in_progress issues require an assignee"));
    }
    if status_for_validation == "in_review"
        && next_reviewer_agent.is_none()
        && next_reviewer_user.is_none()
    {
        return Err(http(
            422,
            "An in_review Issue requires a reviewer agent or user",
        ));
    }
    let current_has_reviewer = current_value["reviewer_agent_id"].as_str().is_some()
        || current_value["reviewer_user_id"].as_str().is_some();
    let next_has_reviewer = next_reviewer_agent.is_some() || next_reviewer_user.is_some();
    if matches!(current_status, "in_review" | "blocked")
        && current_has_reviewer
        && !next_has_reviewer
        && !matches!(status_for_validation, "done" | "todo" | "in_progress")
    {
        return Err(http(
            422,
            "Cannot clear the last reviewer while an Issue is in_review or blocked; change the status to done, todo, or in_progress first",
        ));
    }
    if let Some(Some(agent)) = assignee_agent.as_ref() {
        validate_agent(tx, org, Some(agent), "Assignee").await?;
    }
    if let Some(Some(user)) = assignee_user.as_ref() {
        validate_user(tx, org, Some(user), "Assignee").await?;
    }
    if let Some(Some(agent)) = reviewer_agent.as_ref() {
        validate_agent(tx, org, Some(agent), "Reviewer").await?;
    }
    if let Some(Some(user)) = reviewer_user.as_ref() {
        validate_user(tx, org, Some(user), "Reviewer").await?;
    }
    if actor_kind == "agent"
        && input.get("assigneeAgentId").is_some()
        && assignee_agent.as_ref().and_then(Option::as_deref) != actor_agent_id
    {
        return Err(http(403, "Agent can only assign work to itself"));
    }

    let project_id = resolve_optional_entity_ref_field(
        tx,
        org,
        input,
        "projectId",
        "projects",
        "prj",
        "Project ID",
    )
    .await?;
    let project_changed = project_id
        .as_ref()
        .is_some_and(|value| value.as_deref() != current_value["project_id"].as_str());
    let mut project_workspace_id = optional_field_uuid(input, "projectWorkspaceId")?;
    let goal_id =
        resolve_optional_entity_ref_field(tx, org, input, "goalId", "goals", "gol", "Goal ID")
            .await?;
    let parent_id = resolve_optional_entity_ref_field(
        tx,
        org,
        input,
        "parentId",
        "issues",
        "iss",
        "Parent issue ID",
    )
    .await?;
    let mut execution_workspace_id =
        alias_field_uuid(input, "runWorkspaceId", "executionWorkspaceId")?;
    let execution_workspace_preference = alias_field_text(
        input,
        "runWorkspacePreference",
        "executionWorkspacePreference",
    )?;
    let execution_workspace_settings =
        alias_field_json(input, "runWorkspaceSettings", "executionWorkspaceSettings")?;
    let label_ids = if input.get("labelIds").is_some() {
        Some(optional_uuid_array(input, "labelIds")?)
    } else {
        None
    };
    if project_changed && input.get("projectWorkspaceId").is_none() {
        project_workspace_id = Some(None);
    }
    if project_changed
        && input.get("runWorkspaceId").is_none()
        && input.get("executionWorkspaceId").is_none()
    {
        execution_workspace_id = Some(None);
    }
    let next_project = match &project_id {
        Some(value) => value.as_deref(),
        None => current_value["project_id"].as_str(),
    };
    let next_project_workspace = match &project_workspace_id {
        Some(value) => value.as_deref(),
        None => current_value["project_workspace_id"].as_str(),
    };
    let next_execution_workspace = match &execution_workspace_id {
        Some(value) => value.as_deref(),
        None => current_value["execution_workspace_id"].as_str(),
    };
    validate_reference(
        tx,
        "projects",
        org,
        project_id
            .as_ref()
            .and_then(|v| v.as_deref())
            .or(next_project),
        "Project not found",
    )
    .await?;
    validate_reference(
        tx,
        "goals",
        org,
        goal_id.as_ref().and_then(|v| v.as_deref()),
        "Goal not found",
    )
    .await?;
    validate_workspace_project(
        tx,
        org,
        next_project,
        next_project_workspace,
        next_execution_workspace,
    )
    .await?;
    if let Some(parent) = parent_id.as_ref().and_then(|v| v.as_deref()) {
        let parent_row = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT org_id::text,parent_id::text FROM issues WHERE id=$1::uuid",
        )
        .bind(parent)
        .fetch_optional(&mut **tx)
        .await?;
        let Some((parent_org, parent_parent_id)) = parent_row else {
            return Err(http(
                422,
                "Parent issue must belong to the same organization",
            ));
        };
        if parent_org != org {
            return Err(http(
                422,
                "Parent issue must belong to the same organization",
            ));
        }
        if parent == id {
            return Err(http(422, "Issue cannot be its own parent"));
        }
        let mut visited = Vec::new();
        let mut ancestor = parent_parent_id;
        while let Some(ancestor_id) = ancestor {
            if ancestor_id == id {
                return Err(http(422, "Issue parent cannot be one of its descendants"));
            }
            if visited.contains(&ancestor_id) {
                return Err(http(422, "Issue parent chain contains a cycle"));
            }
            visited.push(ancestor_id.clone());
            ancestor = sqlx::query_scalar::<_, Option<String>>(
                "SELECT parent_id::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid",
            )
            .bind(org)
            .bind(ancestor_id)
            .fetch_optional(&mut **tx)
            .await?
            .flatten();
        }
    }
    if let Some(labels) = label_ids.as_ref() {
        validate_labels(tx, org, labels).await?;
    }

    let block_audit = if is_assignee_agent_block_claim(
        actor_kind,
        actor_agent_id,
        current_value["assignee_agent_id"].as_str(),
        review_decision,
        input,
    ) {
        let agent_id = actor_agent_id.ok_or_else(|| http(401, "Agent authentication required"))?;
        let run_id = run_id.ok_or_else(|| http(422, "Block Audit requires an Agent Run id"))?;
        let body = comment_body
            .as_deref()
            .filter(|body| !body.trim().is_empty())
            .ok_or_else(|| {
                http(
                    422,
                    "A blocked claim must explain the blocker and exact human input or action required",
                )
            })?;
        let safe_body = redact_sensitive_text(body);
        comment_body = Some(safe_body.clone());
        let audit =
            claim_issue_block(tx, org, id, run_id, agent_id, &safe_body, &current_issue).await?;
        if audit["applied"] == false {
            let mut response = current_issue.clone();
            response["comment"] = Value::Null;
            response["blockAudit"] = audit;
            return Ok((response, None));
        }
        if audit["blocked"] != true {
            next_status = Some(current_status.to_owned());
        }
        Some(audit)
    } else {
        None
    };

    let assignee_changed = assignee_agent
        .as_ref()
        .is_some_and(|value| value.as_deref() != current_value["assignee_agent_id"].as_str())
        || assignee_user
            .as_ref()
            .is_some_and(|value| value.as_deref() != current_value["assignee_user_id"].as_str());
    let reviewer_changed = reviewer_agent
        .as_ref()
        .is_some_and(|value| value.as_deref() != current_value["reviewer_agent_id"].as_str())
        || reviewer_user
            .as_ref()
            .is_some_and(|value| value.as_deref() != current_value["reviewer_user_id"].as_str());
    let is_returning_to_creator = actor_kind == "agent"
        && actor_agent_id.is_some()
        && current_value["assignee_agent_id"].as_str() == actor_agent_id
        && assignee_agent.as_ref().is_some_and(Option::is_none)
        && assignee_user
            .as_ref()
            .and_then(|value| value.as_deref())
            .is_some_and(|user_id| current_value["created_by_user_id"].as_str() == Some(user_id));
    if actor_kind == "agent" && ((assignee_changed && !is_returning_to_creator) || reviewer_changed)
    {
        require_task_assign(
            tx,
            org,
            actor_agent_id.ok_or_else(|| http(401, "Agent authentication required"))?,
        )
        .await?;
    }
    let assignment_changed = assignee_changed;
    let supersede_assistance = block_audit.is_none()
        && (assignment_changed || has_material_issue_update_input(input) || comment_body.is_some());
    let mut set = Vec::<(&str, FieldValue)>::new();
    if let Some(value) = next_title {
        set.push(("title", FieldValue::Text(Some(value))));
    }
    if let Some(value) = optional_field_text(input, "description")? {
        set.push(("description", FieldValue::Text(value)));
    }
    if let Some(value) = next_status.clone() {
        set.push(("status", FieldValue::Text(Some(value))));
    }
    if let Some(value) = next_priority {
        set.push(("priority", FieldValue::Text(Some(value))));
    }
    if let Some(value) = project_id {
        set.push(("project_id", FieldValue::Uuid(value)));
    }
    if let Some(value) = project_workspace_id {
        set.push(("project_workspace_id", FieldValue::Uuid(value)));
    }
    if let Some(value) = goal_id {
        set.push(("goal_id", FieldValue::Uuid(value)));
    }
    if let Some(value) = parent_id {
        set.push(("parent_id", FieldValue::Uuid(value)));
    }
    if let Some(value) = assignee_agent {
        set.push(("assignee_agent_id", FieldValue::Uuid(value)));
    }
    if let Some(value) = assignee_user {
        set.push(("assignee_user_id", FieldValue::Text(value)));
    }
    if let Some(value) = reviewer_agent {
        set.push(("reviewer_agent_id", FieldValue::Uuid(value)));
    }
    if let Some(value) = reviewer_user {
        set.push(("reviewer_user_id", FieldValue::Text(value)));
    }
    if let Some(value) = optional_field_text(input, "billingCode")? {
        set.push(("billing_code", FieldValue::Text(value)));
    }
    if let Some(value) = optional_field_json(input, "assigneeAgentRuntimeOverrides")? {
        set.push(("assignee_agent_runtime_overrides", FieldValue::Json(value)));
    }
    if let Some(value) = execution_workspace_id {
        set.push(("execution_workspace_id", FieldValue::Uuid(value)));
    }
    if let Some(value) = execution_workspace_preference {
        set.push(("execution_workspace_preference", FieldValue::Text(value)));
    }
    if let Some(value) = execution_workspace_settings {
        set.push(("execution_workspace_settings", FieldValue::Json(value)));
    }
    if let Some(value) = hidden_at {
        set.push(("hidden_at", FieldValue::Timestamp(value)));
    }
    if let Some(value) = input.get("requestDepth") {
        let depth = value
            .as_i64()
            .filter(|value| (0..=i32::MAX as i64).contains(value))
            .ok_or_else(|| http(422, "requestDepth must be a nonnegative integer"))?;
        set.push(("request_depth", FieldValue::Integer(Some(depth as i32))));
    }
    set.retain(|(column, value)| !field_value_matches_current(&current_value, column, value));
    let labels_changed = label_ids.as_ref().is_some_and(|labels| {
        let mut current_labels = current_issue["labelIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        let mut next_labels = labels.clone();
        current_labels.sort_unstable();
        current_labels.dedup();
        next_labels.sort_unstable();
        next_labels.dedup();
        current_labels != next_labels
    });
    let updated_raw = if set.is_empty() && !labels_changed {
        current.clone()
    } else {
        let mut query = QueryBuilder::<Postgres>::new("UPDATE issues SET ");
        {
            let mut separated = query.separated(", ");
            for (column, value) in set {
                separated.push(column).push_unseparated("=");
                match value {
                    FieldValue::Text(value) => {
                        separated.push_bind_unseparated(value);
                    }
                    FieldValue::Uuid(value) => {
                        separated
                            .push_bind_unseparated(value)
                            .push_unseparated("::uuid");
                    }
                    FieldValue::Json(value) => {
                        separated
                            .push_bind_unseparated(value.map(|v| v.to_string()))
                            .push_unseparated("::jsonb");
                    }
                    FieldValue::Timestamp(value) => {
                        separated
                            .push_bind_unseparated(value)
                            .push_unseparated("::timestamptz");
                    }
                    FieldValue::Integer(value) => {
                        separated.push_bind_unseparated(value);
                    }
                }
            }
            if let Some(status) = next_status.as_deref() {
                if status == "in_progress" {
                    separated.push("started_at=COALESCE(started_at,clock_timestamp())");
                }
                if status == "done" {
                    separated.push("completed_at=clock_timestamp()");
                } else {
                    separated.push("completed_at=NULL");
                }
                if status == "cancelled" {
                    separated.push("cancelled_at=clock_timestamp()").push("execution_cancellation_at=CASE WHEN status='cancelled' THEN execution_cancellation_at ELSE clock_timestamp() END");
                } else {
                    separated.push("cancelled_at=NULL");
                }
                if status != "in_progress" {
                    separated
                        .push("checkout_run_id=NULL")
                        .push("execution_run_id=NULL")
                        .push("execution_agent_name_key=NULL")
                        .push("execution_locked_at=NULL");
                }
            }
            if assignment_changed {
                separated.push("assignee_agent_runtime_overrides=CASE WHEN ");
                if current_value["execution_run_id"].as_str().is_some() {
                    separated.push_unseparated("EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.id=issues.execution_run_id AND (r.status IN ('queued','running') OR r.terminal_effects_pending)) THEN assignee_agent_runtime_overrides ELSE NULL END");
                } else {
                    separated.push_unseparated(
                        "false THEN assignee_agent_runtime_overrides ELSE NULL END",
                    );
                }
                separated.push("checkout_run_id=CASE WHEN ");
                if current_value["execution_run_id"].as_str().is_some() {
                    separated.push_unseparated("EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.id=issues.execution_run_id AND (r.status IN ('queued','running') OR r.terminal_effects_pending)) THEN checkout_run_id ELSE NULL END");
                    separated.push("execution_run_id=CASE WHEN EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.id=issues.execution_run_id AND (r.status IN ('queued','running') OR r.terminal_effects_pending)) THEN execution_run_id ELSE NULL END");
                } else {
                    separated
                        .push_unseparated("false THEN checkout_run_id ELSE NULL END")
                        .push("execution_run_id=NULL");
                }
                separated.push("execution_agent_name_key=CASE WHEN execution_run_id IS NULL THEN NULL ELSE execution_agent_name_key END")
                    .push("execution_locked_at=CASE WHEN execution_run_id IS NULL THEN NULL ELSE execution_locked_at END");
            }
            separated.push("updated_at=clock_timestamp()");
        }
        query
            .push(" WHERE org_id=")
            .push_bind(org)
            .push("::uuid AND id=")
            .push_bind(id)
            .push("::uuid RETURNING to_jsonb(issues)::text");
        query
            .build_query_scalar::<String>()
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| http(404, "Issue not found"))?
    };
    let next_status_value = next_status.as_deref().unwrap_or(current_status);
    if next_status_value == "cancelled" && current_status != "cancelled" {
        let linked_run_ids = [
            current_value["checkout_run_id"].as_str(),
            current_value["execution_run_id"].as_str(),
        ]
        .into_iter()
        .flatten()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
        request_issue_run_cancellation(tx, org, id, &linked_run_ids).await?;
    }
    if labels_changed && let Some(labels) = label_ids {
        sqlx::query("DELETE FROM issue_labels WHERE org_id=$1::uuid AND issue_id=$2::uuid")
            .bind(org)
            .bind(id)
            .execute(&mut **tx)
            .await?;
        if !labels.is_empty() {
            let mut query = QueryBuilder::<Postgres>::new(
                "INSERT INTO issue_labels (org_id,issue_id,label_id) ",
            );
            query.push_values(labels.iter(), |mut row, label| {
                row.push_bind(org)
                    .push("::uuid,")
                    .push_bind(id)
                    .push("::uuid,")
                    .push_bind(label)
                    .push("::uuid");
            });
            query.build().execute(&mut **tx).await?;
        }
    }
    let issue = project_issue(tx, &updated_raw)
        .await
        .map_err(project_error)?;
    crate::automation_issue_finalization::sync_issue_status(tx, org, &issue).await?;
    crate::issue_lifecycle_analytics::record_issue_update_work_started(
        tx,
        org,
        actor_kind,
        &current_issue,
        &issue,
    )
    .await?;
    if supersede_assistance {
        supersede_open_assistance(
            tx,
            org,
            id,
            if assignment_changed {
                "reassigned"
            } else {
                "material_progress"
            },
        )
        .await?;
    }
    let comment = if let Some(body) = comment_body.as_deref() {
        let raw = sqlx::query_scalar::<_, String>(
            "INSERT INTO issue_comments (org_id,issue_id,author_agent_id,author_user_id,body) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5) RETURNING jsonb_build_object('id',id,'issueId',issue_id,'body',body,'authorAgentId',author_agent_id,'authorUserId',author_user_id,'createdAt',created_at)::text",
        )
        .bind(org)
        .bind(id)
        .bind(actor_agent_id)
        .bind((actor_kind == "user").then_some(actor_id))
        .bind(body)
        .fetch_one(&mut **tx)
        .await?;
        Some(serde_json::from_str::<Value>(&raw)?)
    } else {
        None
    };
    let mut metadata = Map::new();
    if let Some(identifier) = issue.get("identifier").cloned() {
        metadata.insert("identifier".to_owned(), identifier);
    }
    if comment.is_some() {
        metadata.insert("source".to_owned(), Value::String("comment".to_owned()));
    }
    if reopened {
        metadata.insert("reopened".to_owned(), Value::Bool(true));
        metadata.insert(
            "reopenedFrom".to_owned(),
            Value::String(current_status.to_owned()),
        );
    }
    if reviewed_completion_normalized {
        metadata.insert(
            "normalizedFromStatus".to_owned(),
            Value::String("done".to_owned()),
        );
        metadata.insert(
            "normalizedReason".to_owned(),
            Value::String("reviewed_issue_assignee_completion".to_owned()),
        );
    }
    if let Some(approval) = approved {
        metadata.insert("source".into(), json!("approval.approved"));
        metadata.insert("approvalId".into(), json!(approval.id()));
        metadata.insert("previousStatus".into(), json!(current_status));
    }
    let details = issue_update_activity_details(&current_issue, &issue, metadata);
    let has_material_changes = issue_update_has_material_changes(&details);
    let has_field_changes = details
        .get("_previous")
        .and_then(Value::as_object)
        .is_some_and(|previous| !previous.is_empty());
    let audit = ActivityActor {
        actor_type: activity_actor_type(actor_kind),
        actor_id: actor_id.to_owned(),
        run_id: run_id.map(ToOwned::to_owned),
    };
    if has_material_changes || has_field_changes || reopened || reviewed_completion_normalized {
        write_activity_options(
            tx,
            ActivityWrite {
                org,
                audit: &audit,
                action: "issue.updated",
                entity_type: "issue",
                entity_id: id,
                details: Some(&details),
                options: ActivityOptions {
                    agent_id: actor_agent_id,
                    effects: None,
                    bind_run: true,
                },
            },
        )
        .await?;
    }
    if let (Some(body), Some(comment)) = (comment_body.as_deref(), comment.as_ref()) {
        let mut comment_details = json!({
            "commentId": comment["id"],
            "bodySnippet": body.chars().take(120).collect::<String>(),
            "identifier": issue["identifier"],
            "issueTitle": issue["title"],
        });
        if reopened {
            comment_details["reopened"] = Value::Bool(true);
            comment_details["reopenedFrom"] = Value::String(current_status.to_owned());
            comment_details["source"] = Value::String("comment".to_owned());
        }
        if has_field_changes {
            comment_details["updated"] = Value::Bool(true);
        }
        if let Some(extra) = comment_activity_details.and_then(Value::as_object) {
            for (key, value) in extra {
                comment_details[key] = value.clone();
            }
        }
        write_activity_options(
            tx,
            ActivityWrite {
                org,
                audit: &audit,
                action: "issue.comment_added",
                entity_type: "issue",
                entity_id: id,
                details: Some(&comment_details),
                options: ActivityOptions {
                    agent_id: actor_agent_id,
                    effects: None,
                    bind_run: true,
                },
            },
        )
        .await?;
    }
    let review_activity_id = if let Some(decision) = review_decision {
        let review_details = json!({
            "decision": decision,
            "outcome": "review_closed",
            "status": issue["status"],
            "identifier": issue["identifier"],
            "commentId": comment.as_ref().map(|value| value["id"].clone()).unwrap_or(Value::Null),
        });
        Some(
            write_activity_options(
                tx,
                ActivityWrite {
                    org,
                    audit: &audit,
                    action: "issue.review_decision_recorded",
                    entity_type: "issue",
                    entity_id: id,
                    details: Some(&review_details),
                    options: ActivityOptions {
                        agent_id: actor_agent_id,
                        effects: None,
                        bind_run: true,
                    },
                },
            )
            .await?,
        )
    } else {
        None
    };
    let mut wakeups = Vec::new();
    if let Some(agent_id) = issue["assigneeAgentId"].as_str() {
        if assignment_changed && is_assignment_wakeup_status(issue["status"].as_str()) {
            wakeups.push(IssueWakeupIntent::assignment(
                agent_id,
                "assignment",
                "issue_assigned",
                "update",
                "issue.update",
            ));
        } else if !assignment_changed
            && current_status == "backlog"
            && is_assignment_wakeup_status(issue["status"].as_str())
        {
            wakeups.push(IssueWakeupIntent::assignment(
                agent_id,
                "automation",
                "issue_status_changed",
                "update",
                "issue.status_change",
            ));
        } else if !assignment_changed
            && matches!(current_status, "in_review" | "blocked")
            && matches!(issue["status"].as_str(), Some("todo" | "in_progress"))
        {
            let mut intent = IssueWakeupIntent::assignment(
                agent_id,
                "assignment",
                "issue_changes_requested",
                "review_changes_requested",
                "issue.review_changes_requested",
            );
            intent.comment = comment.as_ref().map(|comment| {
                json!({
                    "id": comment["id"],
                    "body": comment["body"],
                    "authorAgentId": comment["authorAgentId"],
                    "authorUserId": comment["authorUserId"],
                })
            });
            wakeups.push(intent);
        }
    }
    let wake_reviewer = block_audit.is_none()
        && ((current_status != "in_review" && issue["status"] == "in_review")
            || (current_status != "blocked" && issue["status"] == "blocked")
            || (reviewer_changed
                && matches!(issue["status"].as_str(), Some("in_review" | "blocked"))));
    if wake_reviewer && let Some(agent_id) = issue["reviewerAgentId"].as_str() {
        let mutation = if current_status != "in_review" && issue["status"] == "in_review" {
            "status_to_in_review"
        } else if current_status != "blocked" && issue["status"] == "blocked" {
            "status_to_blocked"
        } else if issue["status"] == "blocked" {
            "reviewer_changed_blocked"
        } else {
            "reviewer_changed_in_review"
        };
        let context_source = if mutation.starts_with("status_") {
            "issue.status_change"
        } else {
            "issue.reviewer_change"
        };
        wakeups.push(IssueWakeupIntent {
            agent_id: agent_id.to_owned(),
            source: "review",
            reason: "issue_review_requested",
            mutation: mutation.to_owned(),
            context_source,
            wake_source: "review",
            role: Some("reviewer"),
            comment: None,
            relationship: None,
            expected_issue_execution_run_id: None,
            payload_extra: None,
            context_extra: None,
        });
    }
    if approved.is_none() {
        enqueue_issue_wakeups(tx, org, id, actor_kind, actor_id, wakeups).await?;
    }
    let mut response = issue;
    response["comment"] = comment.unwrap_or(Value::Null);
    if let Some(block_audit) = block_audit {
        response["blockAudit"] = block_audit;
    }
    let post_commit = Some(IssueUpdatePostCommit {
        org_id: org.to_owned(),
        issue_id: id.to_owned(),
        actor_kind: actor_kind.to_owned(),
        actor_id: actor_id.to_owned(),
        actor_run_id: run_id.map(ToOwned::to_owned),
        status: response["status"].as_str().unwrap_or("backlog").to_owned(),
        created_by_user_id: response["createdByUserId"].as_str().map(ToOwned::to_owned),
        has_reviewer: response["reviewerAgentId"].as_str().is_some()
            || response["reviewerUserId"].as_str().is_some(),
        review_decision: review_decision.map(ToOwned::to_owned),
        review_activity_id,
        comment_created_at: response["comment"]["createdAt"]
            .as_str()
            .map(ToOwned::to_owned),
        reopened,
    });
    Ok((response, post_commit))
}

fn is_assignee_agent_block_claim(
    actor_kind: &str,
    actor_agent_id: Option<&str>,
    current_assignee_agent_id: Option<&str>,
    review_decision: Option<&str>,
    input: &Value,
) -> bool {
    actor_kind == "agent"
        && actor_agent_id.is_some()
        && actor_agent_id == current_assignee_agent_id
        && review_decision.is_none()
        && input.get("status").and_then(Value::as_str) == Some("blocked")
}

fn has_material_issue_update_input(input: &Value) -> bool {
    [
        "status",
        "priority",
        "assigneeAgentId",
        "assigneeUserId",
        "reviewerAgentId",
        "reviewerUserId",
        "projectId",
        "projectWorkspaceId",
        "goalId",
        "parentId",
        "labelIds",
        "billingCode",
        "requestDepth",
        "hiddenAt",
        "assigneeAgentRuntimeOverrides",
    ]
    .iter()
    .any(|field| input.get(*field).is_some())
}

async fn claim_issue_block(
    tx: &mut Tx<'_>,
    org: &str,
    issue_id: &str,
    run_id: &str,
    agent_id: &str,
    body: &str,
    issue: &Value,
) -> Result<Value> {
    if issue["assigneeAgentId"].as_str() != Some(agent_id) {
        return Err(http(
            422,
            "Only the current assignee can claim an issue blocker",
        ));
    }
    if issue["status"] != "in_progress"
        || (issue["checkoutRunId"].as_str() != Some(run_id)
            && issue["executionRunId"].as_str() != Some(run_id))
    {
        return Err(http(
            422,
            "Block Audit requires the current checked-out Issue execution Run",
        ));
    }
    let pending_approval = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM issue_approvals ia JOIN approvals a ON a.id=ia.approval_id AND a.org_id=ia.org_id
         WHERE ia.org_id=$1::uuid AND ia.issue_id=$2::uuid AND a.status IN ('pending','revision_requested','rejected'))",
    )
    .bind(org)
    .bind(issue_id)
    .fetch_one(&mut **tx)
    .await?;
    if pending_approval {
        return Err(http(
            422,
            "A pending or denied Approval already owns this governed stop; Assistance must not be nested",
        ));
    }
    let run = sqlx::query_as::<_, (String, Value, Option<String>)>(
        "SELECT status,context_snapshot,invocation_source FROM heartbeat_runs WHERE id=$1::uuid AND org_id=$2::uuid AND agent_id=$3::uuid",
    )
    .bind(run_id)
    .bind(org)
    .bind(agent_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((run_status, context, invocation_source)) = run else {
        return Err(http(
            422,
            "Block Audit requires the current eligible Issue execution Run",
        ));
    };
    let context = if context.is_object() {
        context
    } else {
        Value::Object(Map::new())
    };
    if run_status != "running"
        || context["issueId"].as_str() != Some(issue_id)
        || invocation_source.as_deref() == Some("review")
        || context["role"] == "reviewer"
        || context["wakeSource"] == "review"
    {
        return Err(http(
            422,
            "Block Audit requires a running assignee Issue execution Run",
        ));
    }
    let governed_stop_class = context["governedStopClass"]
        .as_str()
        .unwrap_or_default()
        .trim();
    if !governed_stop_class.is_empty() {
        return Err(http(
            422,
            &format!(
                "The {governed_stop_class} policy already owns this governed stop; Assistance must not be nested"
            ),
        ));
    }

    let failure_class = [
        context["operationClass"].as_str(),
        context["failureKind"].as_str(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|value| !value.is_empty())
    .unwrap_or("issue_execution");
    let fingerprint = blocker_fingerprint(issue_id, failure_class, body, body);
    let duplicate = sqlx::query_as::<_, (String, i32, String, String)>(
        "SELECT request_id::text,attempt_number,status_after,blocker_fingerprint FROM issue_block_audit_attempts
         WHERE org_id=$1::uuid AND issue_id=$2::uuid AND run_id=$3::uuid",
    )
    .bind(org)
    .bind(issue_id)
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?;
    if let Some((request_id, attempt, status_after, previous_fingerprint)) = duplicate {
        if previous_fingerprint != fingerprint {
            return Err(http(
                422,
                "One Agent Run cannot claim two materially different blockers",
            ));
        }
        let request = request_json(tx, org, &request_id)
            .await?
            .ok_or_else(|| http(422, "Block Audit request is no longer available"))?;
        return Ok(json!({
            "request": request,
            "attempt": attempt,
            "requiredAttempts": BLOCK_AUDIT_REQUIRED_ATTEMPTS,
            "blocked": status_after == "blocked",
            "fingerprint": previous_fingerprint,
            "applied": false
        }));
    }

    let stale_open = sqlx::query_scalar::<_, String>(
        "SELECT id::text FROM requests WHERE org_id=$1::uuid AND issue_id=$2::uuid AND kind='assistance' AND status='open'",
    )
    .bind(org)
    .bind(issue_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut request_id = sqlx::query_scalar::<_, String>(
        "SELECT id::text FROM requests WHERE org_id=$1::uuid AND issue_id=$2::uuid AND kind='assistance' AND status='open' AND blocker_fingerprint=$3 LIMIT 1",
    )
    .bind(org)
    .bind(issue_id)
    .bind(&fingerprint)
    .fetch_optional(&mut **tx)
    .await?;
    if request_id.is_none() {
        request_id = sqlx::query_scalar::<_, String>(
            "INSERT INTO requests (org_id,kind,subtype,status,issue_id,requested_by_agent_id,origin_run_id,assignee_agent_id,blocker_fingerprint,title,prompt,metadata)
             VALUES ($1::uuid,'assistance','issue_blocker','open',$2::uuid,$3::uuid,$4::uuid,$3::uuid,$5,$6,$7,$8::jsonb)
             ON CONFLICT DO NOTHING RETURNING id::text",
        )
        .bind(org)
        .bind(issue_id)
        .bind(agent_id)
        .bind(run_id)
        .bind(&fingerprint)
        .bind(format!(
            "Input needed for {}",
            issue["identifier"].as_str().unwrap_or_else(|| issue["title"].as_str().unwrap_or("Issue"))
        ))
        .bind(body)
        .bind(json!({
            "blockerReason":body,
            "requiredAttempts":BLOCK_AUDIT_REQUIRED_ATTEMPTS
        }).to_string())
        .fetch_optional(&mut **tx)
        .await?;
        if request_id.is_none() {
            request_id = sqlx::query_scalar::<_, String>(
                "SELECT id::text FROM requests WHERE org_id=$1::uuid AND issue_id=$2::uuid AND kind='assistance' AND status='open' AND blocker_fingerprint=$3 LIMIT 1",
            )
            .bind(org)
            .bind(issue_id)
            .bind(&fingerprint)
            .fetch_optional(&mut **tx)
            .await?;
        }
    }
    let request_id = request_id.ok_or_else(|| http(500, "Failed to create Block Audit request"))?;

    let mut superseded_requests = 0;
    for stale_id in stale_open {
        if stale_id == request_id {
            continue;
        }
        let superseded = sqlx::query_as::<_, (String, Option<String>)>(
            "UPDATE requests SET status='superseded',superseded_by_request_id=$3::uuid,metadata=metadata || jsonb_build_object('supersededReason','blocker_changed'),updated_at=clock_timestamp()
             WHERE id=$1::uuid AND org_id=$2::uuid AND status='open' RETURNING id::text,blocker_fingerprint",
        )
        .bind(&stale_id)
        .bind(org)
        .bind(&request_id)
        .fetch_optional(&mut **tx)
        .await?;
        let Some((superseded_id, previous_fingerprint)) = superseded else {
            continue;
        };
        superseded_requests += 1;
        let idempotency_key = format!("request-superseded:{superseded_id}:{request_id}");
        let details = json!({
            "issueId":issue_id,
            "reason":"blocker_changed",
            "supersededByRequestId":request_id,
            "previousBlockerFingerprint":previous_fingerprint,
            "blockerFingerprint":fingerprint
        });
        let audit = ActivityActor {
            actor_type: "agent",
            actor_id: agent_id.to_owned(),
            run_id: Some(run_id.to_owned()),
        };
        crate::activity::write_activity_idempotent(
            tx,
            ActivityWrite {
                org,
                audit: &audit,
                action: "request.superseded",
                entity_type: "request",
                entity_id: &superseded_id,
                details: Some(&details),
                options: ActivityOptions {
                    agent_id: Some(agent_id),
                    effects: None,
                    bind_run: true,
                },
            },
            &idempotency_key,
        )
        .await?;
        let payload = json!({
            "requestId":superseded_id,
            "issueId":issue_id,
            "reason":"blocker_changed",
            "supersededByRequestId":request_id,
            "previousBlockerFingerprint":previous_fingerprint,
            "blockerFingerprint":fingerprint
        });
        append_issue_run_event(
            tx,
            org,
            IssueRunEvent {
                run_id,
                agent_id,
                event_type: "request.superseded",
                level: "info",
                message: "Assistance Request superseded after blocker changed",
                idempotency_key: &idempotency_key,
                payload: &payload,
            },
        )
        .await?;
    }

    sqlx::query("SELECT id FROM requests WHERE id=$1::uuid AND org_id=$2::uuid FOR UPDATE")
        .bind(&request_id)
        .bind(org)
        .execute(&mut **tx)
        .await?;
    let open = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM requests WHERE id=$1::uuid AND org_id=$2::uuid AND status='open')",
    )
    .bind(&request_id)
    .bind(org)
    .fetch_one(&mut **tx)
    .await?;
    if !open {
        return Err(http(
            422,
            "The Assistance Request changed before the Block Audit could be recorded",
        ));
    }
    let previous = sqlx::query_as::<_, (i32, String, String, String)>(
        "SELECT attempt_number,run_id::text,root_run_id::text,status_after FROM issue_block_audit_attempts
         WHERE org_id=$1::uuid AND issue_id=$2::uuid AND request_id=$3::uuid AND blocker_fingerprint=$4
         ORDER BY attempt_number ASC",
    )
    .bind(org)
    .bind(issue_id)
    .bind(&request_id)
    .bind(&fingerprint)
    .fetch_all(&mut **tx)
    .await?;
    let latest = previous.last();
    let attempt = i32::try_from(previous.len() + 1).map_err(|_| {
        http(
            422,
            "Block Audit attempt count exceeded its supported range",
        )
    })?;
    let root_run_id = latest.map_or(run_id, |row| row.2.as_str());
    let previous_run_id = latest.map(|row| row.1.as_str());
    let continuation_kind = if latest.is_some() {
        "passive_issue_followup"
    } else {
        "initial"
    };
    let reset_reason = (superseded_requests > 0).then_some("reset_after_blocker_change");
    let passive_followup = context
        .get("passiveFollowup")
        .filter(|value| value.is_object());
    if let Some(latest) = latest {
        let valid_continuation = context["wakeReason"] == "issue_passive_followup"
            && passive_followup.and_then(|value| value["originRunId"].as_str())
                == Some(latest.2.as_str())
            && passive_followup.and_then(|value| value["previousRunId"].as_str())
                == Some(latest.1.as_str())
            && passive_followup.and_then(|value| value["attempt"].as_i64())
                == Some(i64::from(latest.0));
        if !valid_continuation {
            return Err(http(
                422,
                "Block Audit attempts after the first require the next passive Issue follow-up Run",
            ));
        }
    } else if passive_followup.is_some() && reset_reason.is_none() {
        return Err(http(
            422,
            "Block Audit cannot start from a passive follow-up without its originating attempt",
        ));
    }
    let status_before = issue["status"].as_str().unwrap_or("backlog");
    let blocked = attempt >= BLOCK_AUDIT_REQUIRED_ATTEMPTS;
    let status_after = if blocked { "blocked" } else { status_before };
    sqlx::query(
        "INSERT INTO issue_block_audit_attempts (org_id,issue_id,request_id,run_id,root_run_id,previous_run_id,agent_id,continuation_kind,eligible,failure_class,blocker_fingerprint,attempt_number,required_attempts,status_before,status_after,reset_reason,blocker_reason,requested_action)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,true,$9,$10,$11,$12,$13,$14,$15,$16,$16)",
    )
    .bind(org)
    .bind(issue_id)
    .bind(&request_id)
    .bind(run_id)
    .bind(root_run_id)
    .bind(previous_run_id)
    .bind(agent_id)
    .bind(continuation_kind)
    .bind(failure_class)
    .bind(&fingerprint)
    .bind(attempt)
    .bind(BLOCK_AUDIT_REQUIRED_ATTEMPTS)
    .bind(status_before)
    .bind(status_after)
    .bind(reset_reason)
    .bind(body)
    .execute(&mut **tx)
    .await?;
    if blocked {
        sqlx::query(
            "UPDATE issues SET status='blocked',checkout_run_id=NULL,execution_run_id=NULL,execution_agent_name_key=NULL,execution_locked_at=NULL,updated_at=clock_timestamp()
             WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(org)
        .bind(issue_id)
        .execute(&mut **tx)
        .await?;
    }
    sqlx::query(
        "UPDATE requests SET prompt=$3,metadata=jsonb_build_object('blockerReason',$4,'requiredAttempts',$5,'attempt',$6),updated_at=clock_timestamp()
         WHERE id=$1::uuid AND org_id=$2::uuid AND status='open'",
    )
    .bind(&request_id)
    .bind(org)
    .bind(body)
    .bind(body)
    .bind(BLOCK_AUDIT_REQUIRED_ATTEMPTS)
    .bind(attempt)
    .execute(&mut **tx)
    .await?;
    let request = request_json(tx, org, &request_id)
        .await?
        .ok_or_else(|| http(422, "Block Audit request is no longer available"))?;
    let details = json!({
        "requestId":request_id,
        "attempt":attempt,
        "requiredAttempts":BLOCK_AUDIT_REQUIRED_ATTEMPTS,
        "blockerFingerprint":fingerprint,
        "blocked":blocked,
        "rootRunId":root_run_id,
        "previousRunId":previous_run_id,
        "continuationKind":continuation_kind,
        "eligible":true,
        "failureClass":failure_class,
        "statusBefore":status_before,
        "statusAfter":status_after,
        "resetReason":reset_reason
    });
    let audit = ActivityActor {
        actor_type: "agent",
        actor_id: agent_id.to_owned(),
        run_id: Some(run_id.to_owned()),
    };
    let idempotency_key = format!("issue-block-audit:{issue_id}:{run_id}");
    crate::activity::write_activity_idempotent(
        tx,
        ActivityWrite {
            org,
            audit: &audit,
            action: "issue.block_audit_attempted",
            entity_type: "issue",
            entity_id: issue_id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: Some(agent_id),
                effects: None,
                bind_run: true,
            },
        },
        &idempotency_key,
    )
    .await?;
    let run_event_message =
        format!("Block Audit attempt {attempt}/{BLOCK_AUDIT_REQUIRED_ATTEMPTS}");
    let run_event_payload = json!({
        "requestId":request_id,
        "issueId":issue_id,
        "attempt":attempt,
        "requiredAttempts":BLOCK_AUDIT_REQUIRED_ATTEMPTS,
        "blocked":blocked,
        "blockerFingerprint":fingerprint,
        "rootRunId":root_run_id,
        "previousRunId":previous_run_id,
        "continuationKind":continuation_kind,
        "eligible":true,
        "failureClass":failure_class,
        "statusBefore":status_before,
        "statusAfter":status_after,
        "resetReason":reset_reason
    });
    append_issue_run_event(
        tx,
        org,
        IssueRunEvent {
            run_id,
            agent_id,
            event_type: "issue.block_audit_attempted",
            level: "info",
            message: &run_event_message,
            idempotency_key: &idempotency_key,
            payload: &run_event_payload,
        },
    )
    .await?;

    Ok(json!({
        "request":request,
        "attempt":attempt,
        "requiredAttempts":BLOCK_AUDIT_REQUIRED_ATTEMPTS,
        "blocked":blocked,
        "fingerprint":fingerprint,
        "applied":true
    }))
}

async fn request_json(tx: &mut Tx<'_>, org: &str, request_id: &str) -> Result<Option<Value>> {
    let query = format!(
        "SELECT {} FROM requests t WHERE t.org_id=$1::uuid AND t.id=$2::uuid",
        crate::request_reads::projection("requests")
    );
    let raw = sqlx::query_scalar::<_, String>(&query)
        .bind(org)
        .bind(request_id)
        .fetch_optional(&mut **tx)
        .await?;
    raw.map(|raw| {
        let redacted = crate::request_reads::redaction::row(&raw, false)?;
        serde_json::from_str(&redacted).map_err(IssueCoreWriteError::from)
    })
    .transpose()
}

struct IssueRunEvent<'a> {
    run_id: &'a str,
    agent_id: &'a str,
    event_type: &'a str,
    level: &'a str,
    message: &'a str,
    idempotency_key: &'a str,
    payload: &'a Value,
}

async fn append_issue_run_event(
    tx: &mut Tx<'_>,
    org: &str,
    event: IssueRunEvent<'_>,
) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(event.run_id)
        .execute(&mut **tx)
        .await?;
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM heartbeat_run_events WHERE run_id=$1::uuid AND idempotency_key=$2)",
    )
    .bind(event.run_id)
    .bind(event.idempotency_key)
    .fetch_one(&mut **tx)
    .await?;
    if exists {
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO heartbeat_run_events (org_id,run_id,agent_id,seq,event_type,stream,level,message,payload,idempotency_key)
         SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE(MAX(seq),0)+1,$4,'system',$5,$6,$7::jsonb,$8
         FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid
         ON CONFLICT DO NOTHING",
    )
    .bind(org)
    .bind(event.run_id)
    .bind(event.agent_id)
    .bind(event.event_type)
    .bind(event.level)
    .bind(event.message)
    .bind(event.payload.to_string())
    .bind(event.idempotency_key)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn blocker_fingerprint(
    issue_id: &str,
    failure_class: &str,
    reason: &str,
    requested_action: &str,
) -> String {
    let normalized_reason = normalize_blocker_text(reason);
    let normalized_action = normalize_blocker_text(requested_action);
    format!(
        "{:x}",
        Sha256::digest(
            [
                issue_id,
                failure_class,
                "assistance",
                &normalized_reason,
                &normalized_action
            ]
            .join("\n")
            .as_bytes()
        )
    )
}

fn normalize_blocker_text(value: &str) -> String {
    let normalized = value.nfkc().collect::<String>().to_lowercase();
    let uuid = Regex::new(r"[0-9a-f]{8}-[0-9a-f-]{27,}")
        .expect("blocker UUID pattern is valid")
        .replace_all(&normalized, "<uuid>");
    let attempts = Regex::new(r"\b(attempt|retry)\s*#?\d+\b")
        .expect("blocker attempt pattern is valid")
        .replace_all(&uuid, "$1 <counter>");
    let numbers = Regex::new(r"\b\d{10,}\b")
        .expect("blocker number pattern is valid")
        .replace_all(&attempts, "<long-number>");
    Regex::new(r"\s+")
        .expect("blocker whitespace pattern is valid")
        .replace_all(&numbers, " ")
        .trim()
        .to_owned()
}

fn redact_sensitive_text(value: &str) -> String {
    let private_key = Regex::new(
        r"-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----",
    )
    .expect("private key redaction pattern is valid");
    let mut redacted = private_key
        .replace_all(value, "[REDACTED_PRIVATE_KEY]")
        .into_owned();
    let otp = Regex::new(r"\b\d{6}\b").expect("OTP redaction pattern is valid");
    redacted = otp.replace_all(&redacted, "[REDACTED_OTP]").into_owned();
    let bearer = Regex::new(r"(?i)(bearer\s+)[^\s,;]+").expect("bearer redaction pattern is valid");
    redacted = bearer.replace_all(&redacted, "$1[REDACTED]").into_owned();
    let credentials = Regex::new(
        r"(?i)((?:^|[?&\s])(?:api[-_]?key|access[-_]?token|token|code|secret|password|credential)\s*[=:]\s*)[^&\s,;\[]+",
    )
    .expect("credential redaction pattern is valid");
    redacted = credentials
        .replace_all(&redacted, "$1[REDACTED]")
        .into_owned();
    let known_tokens = Regex::new(
        r"\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,})\b",
    )
    .expect("known token redaction pattern is valid");
    redacted = known_tokens
        .replace_all(&redacted, "[REDACTED_SECRET]")
        .into_owned();
    let jwt = Regex::new(r"\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")
        .expect("JWT redaction pattern is valid");
    jwt.replace_all(&redacted, "[REDACTED_JWT]").into_owned()
}

async fn supersede_open_assistance(
    tx: &mut Tx<'_>,
    org: &str,
    issue_id: &str,
    reason: &str,
) -> Result<()> {
    let rows = sqlx::query_as::<_, (String, Value)>(
        "UPDATE requests SET status='superseded',metadata=metadata || jsonb_build_object('supersededReason',$3),updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND issue_id=$2::uuid AND kind='assistance' AND status='open'
         RETURNING id::text, jsonb_build_object('issueId',issue_id,'reason',$3)",
    )
    .bind(org)
    .bind(issue_id)
    .bind(reason)
    .fetch_all(&mut **tx)
    .await?;
    let audit = ActivityActor {
        actor_type: "system",
        actor_id: "request-lifecycle".to_owned(),
        run_id: None,
    };
    for (request_id, details) in rows {
        let idempotency_key = format!("request-superseded:{request_id}:{reason}");
        crate::activity::write_activity_idempotent(
            tx,
            ActivityWrite {
                org,
                audit: &audit,
                action: "request.superseded",
                entity_type: "request",
                entity_id: &request_id,
                details: Some(&details),
                options: ActivityOptions::default(),
            },
            &idempotency_key,
        )
        .await?;
    }
    Ok(())
}

impl IssueWakeupIntent {
    fn assignment(
        agent_id: &str,
        source: &'static str,
        reason: &'static str,
        mutation: &str,
        context_source: &'static str,
    ) -> Self {
        Self {
            agent_id: agent_id.to_owned(),
            source,
            reason,
            mutation: mutation.to_owned(),
            context_source,
            wake_source: source,
            role: None,
            comment: None,
            relationship: None,
            expected_issue_execution_run_id: None,
            payload_extra: None,
            context_extra: None,
        }
    }
}

async fn enqueue_issue_wakeups(
    tx: &mut Tx<'_>,
    org: &str,
    issue_id: &str,
    actor_kind: &str,
    actor_id: &str,
    wakeups: Vec<IssueWakeupIntent>,
) -> Result<()> {
    let mut by_agent = BTreeMap::new();
    for wakeup in wakeups {
        by_agent.insert(wakeup.agent_id.clone(), wakeup);
    }
    for (_, wakeup) in by_agent {
        let requested_by = IssueWakeupActor {
            kind: actor_kind,
            id: actor_id,
        };
        enqueue_issue_core_wakeup(tx, org, issue_id, &wakeup, &requested_by)
            .await
            .map_err(project_error)?;
    }
    Ok(())
}

async fn request_issue_run_cancellation(
    tx: &mut Tx<'_>,
    org: &str,
    issue_id: &str,
    linked_run_ids: &[String],
) -> Result<()> {
    const REASON: &str = "Cancelled because the linked Issue was cancelled";
    sqlx::query(
        "UPDATE agent_wakeup_requests SET status='cancelled',finished_at=clock_timestamp(),error=$3,updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND payload->>'issueId'=$2
           AND execution_authority='legacy_ts'
           AND status IN ('queued','claimed','deferred_issue_execution','deferred_agent_paused','deferred_goal_focus','deferred_goal_blocked')
           AND requested_at <= (SELECT execution_cancellation_at FROM issues WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(org)
    .bind(issue_id)
    .bind(REASON)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE heartbeat_runs SET error=$4,error_code='cancel_requested',updated_at=statement_timestamp()
         WHERE org_id=$1::uuid AND execution_authority='legacy_ts' AND status IN ('queued','running')
           AND (context_snapshot->>'issueId'=$2 OR id::text=ANY($3::text[]))
           AND created_at <= (SELECT execution_cancellation_at FROM issues WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(org)
    .bind(issue_id)
    .bind(linked_run_ids)
    .bind(REASON)
    .execute(&mut **tx)
    .await?;

    // Issue work created by the legacy heartbeat queue is stopped by that
    // process owner observing the durable intent above. If an Issue is linked
    // to a run already owned by the native Goal worker, use its existing
    // cancellation primitive so that worker can stop and finalize the run.
    let native_run_ids = sqlx::query_scalar::<_, String>(
        "SELECT r.id::text FROM heartbeat_runs r
         JOIN issues i ON i.org_id=r.org_id AND i.id=$2::uuid
         WHERE r.org_id=$1::uuid AND r.execution_authority='native_rust'
           AND r.status='running'
           AND (r.context_snapshot->>'issueId'=$2 OR r.id::text=ANY($3::text[]))
           AND r.created_at <= i.execution_cancellation_at
         ORDER BY r.created_at,r.id",
    )
    .bind(org)
    .bind(issue_id)
    .bind(linked_run_ids)
    .fetch_all(&mut **tx)
    .await?;
    for run_id in native_run_ids {
        goal_runs::request_cancel_in_transaction(tx, org, &run_id, REASON)
            .await
            .map_err(|error| match error {
                goal_runs::GoalRunError::Database(error) => IssueCoreWriteError::Database(error),
                _ => http(500, "Failed to request Issue run cancellation"),
            })?;
    }
    Ok(())
}

fn is_assignment_wakeup_status(status: Option<&str>) -> bool {
    matches!(status, Some("todo" | "in_progress" | "blocked"))
}

#[derive(Clone)]
enum FieldValue {
    Text(Option<String>),
    Uuid(Option<String>),
    Json(Option<Value>),
    Timestamp(Option<String>),
    Integer(Option<i32>),
}

fn field_value_matches_current(current: &Value, column: &str, value: &FieldValue) -> bool {
    match value {
        FieldValue::Text(value) | FieldValue::Uuid(value) => {
            current
                .get(column)
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                == *value
                || (value.is_none() && current.get(column).is_some_and(Value::is_null))
        }
        FieldValue::Json(value) => {
            current.get(column).cloned().unwrap_or(Value::Null)
                == value.clone().unwrap_or(Value::Null)
        }
        FieldValue::Timestamp(value) => {
            let current = current.get(column).and_then(Value::as_str);
            match (current, value.as_deref()) {
                (None, None) => true,
                (Some(current), Some(next)) => {
                    let current = OffsetDateTime::parse(current, &Rfc3339).ok();
                    let next = OffsetDateTime::parse(next, &Rfc3339).ok();
                    current.is_some() && current == next
                }
                _ => false,
            }
        }
        FieldValue::Integer(value) => {
            current.get(column).and_then(Value::as_i64) == value.map(i64::from)
        }
    }
}

async fn delete_issue(
    tx: &mut Tx<'_>,
    org: &str,
    actor_kind: &str,
    actor_id: &str,
    actor_agent_id: Option<&str>,
    run_id: Option<&str>,
    id: &str,
) -> Result<(Value, Vec<String>)> {
    let raw=sqlx::query_scalar::<_,String>("SELECT to_jsonb(i)::text FROM issues i WHERE i.org_id=$1::uuid AND i.id=$2::uuid FOR UPDATE").bind(org).bind(id).fetch_optional(&mut **tx).await?.ok_or_else(||http(404,"Issue not found"))?;
    let issue = project_issue(tx, &raw).await.map_err(project_error)?;
    let asset_ids = sqlx::query_scalar::<_, String>(
        "SELECT asset_id::text FROM issue_attachments WHERE org_id=$1::uuid AND issue_id=$2::uuid",
    )
    .bind(org)
    .bind(id)
    .fetch_all(&mut **tx)
    .await?;
    let asset_object_keys = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT assets.object_key FROM issue_attachments JOIN assets ON assets.org_id=issue_attachments.org_id AND assets.id=issue_attachments.asset_id WHERE issue_attachments.org_id=$1::uuid AND issue_attachments.issue_id=$2::uuid",
    )
    .bind(org)
    .bind(id)
    .fetch_all(&mut **tx)
    .await?;
    let document_ids = sqlx::query_scalar::<_, String>(
        "SELECT document_id::text FROM issue_documents WHERE org_id=$1::uuid AND issue_id=$2::uuid",
    )
    .bind(org)
    .bind(id)
    .fetch_all(&mut **tx)
    .await?;
    sqlx::query("DELETE FROM issue_read_states WHERE org_id=$1::uuid AND issue_id=$2::uuid")
        .bind(org)
        .bind(id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid")
        .bind(org)
        .bind(id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM issues WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org)
        .bind(id)
        .execute(&mut **tx)
        .await?;
    crate::issue_messenger_cleanup::remove_issue_group_entries(tx, org, id).await?;
    if !asset_ids.is_empty() {
        sqlx::query("DELETE FROM assets WHERE org_id=$1::uuid AND id=ANY($2::uuid[])")
            .bind(org)
            .bind(&asset_ids)
            .execute(&mut **tx)
            .await?;
    }
    if !document_ids.is_empty() {
        sqlx::query("DELETE FROM documents WHERE id=ANY($1::uuid[])")
            .bind(&document_ids)
            .execute(&mut **tx)
            .await?;
    }
    let audit = ActivityActor {
        actor_type: activity_actor_type(actor_kind),
        actor_id: actor_id.to_owned(),
        run_id: run_id.map(ToOwned::to_owned),
    };
    write_activity_options(
        tx,
        ActivityWrite {
            org,
            audit: &audit,
            action: "issue.deleted",
            entity_type: "issue",
            entity_id: id,
            details: None,
            options: ActivityOptions {
                agent_id: actor_agent_id,
                effects: None,
                bind_run: true,
            },
        },
    )
    .await?;
    Ok((issue, asset_object_keys))
}

async fn reorder_issue(tx: &mut Tx<'_>, org: &str, actor_id: &str, input: &Value) -> Result<Value> {
    let id = required_text(input, "issueId")?;
    let id = resolve_entity_reference(tx, org, &id, "issues", "iss", "Issue ID").await?;
    let target_status = required_text(input, "targetStatus")?;
    validate_choice(&target_status, &STATUSES, "Invalid Issue status")?;
    let previous = resolve_optional_entity_ref(
        tx,
        org,
        input,
        "previousIssueId",
        "issues",
        "iss",
        "Previous issue ID",
    )
    .await?;
    let next = resolve_optional_entity_ref(
        tx,
        org,
        input,
        "nextIssueId",
        "issues",
        "iss",
        "Next issue ID",
    )
    .await?;
    let position = text_or(input, "position", "end")?;
    validate_choice(&position, &["start", "end"], "Invalid issue position")?;
    if previous.is_some() && previous == next {
        return Err(http(
            422,
            "previousIssueId and nextIssueId must be different",
        ));
    }
    let current=sqlx::query_as::<_,(String,String,i32,Option<String>,Option<String>)>("SELECT to_jsonb(i)::text,i.status,i.board_order,i.checkout_run_id::text,i.execution_run_id::text FROM issues i WHERE i.org_id=$1::uuid AND i.id=$2::uuid FOR UPDATE").bind(org).bind(&id).fetch_optional(&mut **tx).await?.ok_or_else(||http(404,"Issue not found"))?;
    let (raw, current_status, current_order, checkout_run, execution_run) = current;
    let current_row: Value = serde_json::from_str(&raw)?;
    if target_status == "in_review"
        && current_row["reviewer_agent_id"].is_null()
        && current_row["reviewer_user_id"].is_null()
    {
        return Err(http(
            422,
            "An in_review Issue requires a reviewer agent or user",
        ));
    }
    let mut rows=sqlx::query_as::<_,(String,i32)>("SELECT id::text,board_order FROM issues WHERE org_id=$1::uuid AND status=$2 AND id<>$3::uuid AND hidden_at IS NULL ORDER BY board_order ASC,updated_at DESC,created_at DESC,id ASC FOR UPDATE").bind(org).bind(&target_status).bind(&id).fetch_all(&mut **tx).await?;
    let find_index = |raw: Option<&str>, rows: &[(String, i32)]| -> Result<Option<usize>> {
        if let Some(raw) = raw {
            let target =
                canonical_uuid(raw).map_err(|_| http(422, "Issue reference must be a UUID"))?;
            Ok(Some(
                rows.iter()
                    .position(|(id, _)| id == &target)
                    .ok_or_else(|| {
                        http(422, "Issue reference must belong to the target status lane")
                    })?,
            ))
        } else {
            Ok(None)
        }
    };
    let pi = find_index(previous.as_deref(), &rows)?;
    let ni = find_index(next.as_deref(), &rows)?;
    let index = match (pi, ni) {
        (Some(p), Some(n)) if n == p + 1 => n,
        (Some(_), Some(_)) => {
            return Err(http(
                422,
                "previousIssueId and nextIssueId must be adjacent in the target lane",
            ));
        }
        (Some(p), None) => p + 1,
        (None, Some(n)) => n,
        (None, None) => {
            if position == "start" {
                0
            } else {
                rows.len()
            }
        }
    };
    rows.insert(index, (id.clone(), 0));
    let mut returned = String::new();
    for (i, (row_id, old_order)) in rows.iter().enumerate() {
        let order = (i as i32 + 1) * BOARD_ORDER_STEP;
        if row_id == &id {
            let updated=sqlx::query_scalar::<_,String>("UPDATE issues SET status=$3,board_order=$4,updated_at=CASE WHEN status IS DISTINCT FROM $3 THEN clock_timestamp() ELSE updated_at END,started_at=CASE WHEN $3='in_progress' THEN COALESCE(started_at,clock_timestamp()) ELSE started_at END,completed_at=CASE WHEN status=$3 THEN completed_at WHEN $3='done' THEN clock_timestamp() ELSE NULL END,cancelled_at=CASE WHEN status=$3 THEN cancelled_at WHEN $3='cancelled' THEN clock_timestamp() ELSE NULL END,execution_cancellation_at=CASE WHEN $3='cancelled' AND status<>'cancelled' THEN clock_timestamp() ELSE execution_cancellation_at END,checkout_run_id=CASE WHEN $3='in_progress' OR status=$3 THEN checkout_run_id ELSE NULL END,execution_run_id=CASE WHEN $3='in_progress' OR status=$3 THEN execution_run_id ELSE NULL END,execution_agent_name_key=CASE WHEN $3='in_progress' OR status=$3 THEN execution_agent_name_key ELSE NULL END,execution_locked_at=CASE WHEN $3='in_progress' OR status=$3 THEN execution_locked_at ELSE NULL END WHERE org_id=$1::uuid AND id=$2::uuid RETURNING to_jsonb(issues)::text").bind(org).bind(&id).bind(&target_status).bind(order).fetch_one(&mut **tx).await?;
            returned = updated;
        } else if *old_order != order {
            sqlx::query("UPDATE issues SET board_order=$3 WHERE org_id=$1::uuid AND id=$2::uuid")
                .bind(org)
                .bind(row_id)
                .bind(order)
                .execute(&mut **tx)
                .await?;
        }
    }
    let issue = project_issue(tx, &returned).await.map_err(project_error)?;
    if target_status == "cancelled" && current_status != "cancelled" {
        let linked_run_ids = [checkout_run.clone(), execution_run.clone()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        request_issue_run_cancellation(tx, org, &id, &linked_run_ids).await?;
    }
    let details = json!({"identifier":issue["identifier"],"status":issue["status"],"boardOrder":issue["boardOrder"],"previousIssueId":previous,"nextIssueId":next,"position":position,"_previous":{"status":current_status,"boardOrder":current_order}});
    let audit = ActivityActor {
        actor_type: "user",
        actor_id: actor_id.to_owned(),
        run_id: None,
    };
    write_activity_options(
        tx,
        ActivityWrite {
            org,
            audit: &audit,
            action: "issue.reordered",
            entity_type: "issue",
            entity_id: &id,
            details: Some(&details),
            options: ActivityOptions::default(),
        },
    )
    .await?;
    Ok(issue)
}

async fn validate_agent(tx: &mut Tx<'_>, org: &str, id: Option<&str>, label: &str) -> Result<()> {
    if let Some(id) = id {
        let row = sqlx::query_as::<_, (String, String)>(
            "SELECT org_id::text,status FROM agents WHERE id=$1::uuid",
        )
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
        let Some((actual, status)) = row else {
            return Err(http(404, &format!("{label} agent not found")));
        };
        if actual != org {
            return Err(http(
                422,
                &format!("{label} must belong to same organization"),
            ));
        }
        if status == "pending_approval" {
            return Err(http(
                409,
                &format!(
                    "Cannot {} pending approval agents",
                    if label == "Assignee" {
                        "assign work to"
                    } else {
                        "select"
                    }
                ),
            ));
        }
        if status == "terminated" {
            return Err(http(
                409,
                &format!(
                    "Cannot {} terminated agents",
                    if label == "Assignee" {
                        "assign work to"
                    } else {
                        "select"
                    }
                ),
            ));
        }
    }
    Ok(())
}
async fn validate_user(tx: &mut Tx<'_>, org: &str, id: Option<&str>, label: &str) -> Result<()> {
    if let Some(id) = id {
        let ok=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM organization_memberships WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2 AND status='active')").bind(org).bind(id).fetch_one(&mut **tx).await?;
        if !ok {
            return Err(http(404, &format!("{label} user not found")));
        }
    }
    Ok(())
}

async fn require_task_assign(tx: &mut Tx<'_>, org: &str, agent_id: &str) -> Result<()> {
    let allowed = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM principal_permission_grants WHERE org_id=$1::uuid AND principal_type='agent' AND principal_id=$2 AND permission_key='tasks:assign') OR EXISTS(SELECT 1 FROM agents WHERE org_id=$1::uuid AND id=$2::uuid AND (role='ceo' OR COALESCE(permissions->>'canCreateAgents','false')='true'))",
    )
    .bind(org)
    .bind(agent_id)
    .fetch_one(&mut **tx)
    .await?;
    if allowed {
        Ok(())
    } else {
        Err(http(403, "Missing permission: tasks:assign"))
    }
}

async fn validate_reference(
    tx: &mut Tx<'_>,
    table: &str,
    org: &str,
    id: Option<&str>,
    message: &str,
) -> Result<()> {
    let Some(id) = id else { return Ok(()) };
    if Uuid::parse_str(id).is_err() {
        return Err(http(422, "Invalid reference ID"));
    }
    let cross_org_message = match table {
        "projects" => "Project must belong to same organization",
        "goals" => "Goal must belong to same organization",
        "project_workspaces" => "Project run directory must belong to same organization",
        "execution_workspaces" => "Run workspace must belong to same organization",
        _ => return Err(http(422, "Invalid reference")),
    };
    let query = format!("SELECT org_id::text FROM {table} WHERE id=$1::uuid");
    let actual_org = sqlx::query_scalar::<_, String>(&query)
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(actual_org) = actual_org else {
        return Err(http(404, message));
    };
    if actual_org != org {
        return Err(http(422, cross_org_message));
    }
    Ok(())
}
async fn validate_workspace_project(
    tx: &mut Tx<'_>,
    org: &str,
    project: Option<&str>,
    project_workspace: Option<&str>,
    execution_workspace: Option<&str>,
) -> Result<()> {
    for (table, id) in [
        ("project_workspaces", project_workspace),
        ("execution_workspaces", execution_workspace),
    ] {
        if let Some(id) = id {
            let query =
                format!("SELECT org_id::text,project_id::text FROM {table} WHERE id=$1::uuid");
            let row = sqlx::query_as::<_, (String, Option<String>)>(&query)
                .bind(id)
                .fetch_optional(&mut **tx)
                .await?
                .ok_or_else(|| {
                    http(
                        404,
                        if table == "project_workspaces" {
                            "Project run directory not found"
                        } else {
                            "Run workspace not found"
                        },
                    )
                })?;
            let (workspace_org, workspace_project) = row;
            if workspace_org != org {
                return Err(http(
                    422,
                    if table == "project_workspaces" {
                        "Project run directory must belong to same organization"
                    } else {
                        "Run workspace must belong to same organization"
                    },
                ));
            }
            if project.is_some_and(|project| workspace_project.as_deref() != Some(project)) {
                return Err(http(
                    422,
                    if table == "project_workspaces" {
                        "Project run directory must belong to the selected project"
                    } else {
                        "Run workspace must belong to the selected project"
                    },
                ));
            }
        }
    }
    Ok(())
}
async fn validate_labels(tx: &mut Tx<'_>, org: &str, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM labels WHERE org_id=$1::uuid AND id=ANY($2::uuid[])",
    )
    .bind(org)
    .bind(ids)
    .fetch_one(&mut **tx)
    .await?;
    if count != ids.len() as i64 {
        return Err(http(
            422,
            "One or more labels are invalid for this organization",
        ));
    }
    Ok(())
}

fn parse_optional_timestamp(value: &Value) -> Result<Option<String>> {
    match value {
        Value::Null => Ok(None),
        Value::String(raw) => {
            let timestamp = OffsetDateTime::parse(raw, &Rfc3339)
                .map_err(|_| http(422, "hiddenAt must be a valid datetime or null"))?;
            timestamp
                .format(&Rfc3339)
                .map(Some)
                .map_err(|_| http(422, "hiddenAt must be a valid datetime or null"))
        }
        _ => Err(http(422, "hiddenAt must be a valid datetime or null")),
    }
}

fn issue_update_activity_details(
    existing: &Value,
    updated: &Value,
    mut metadata: Map<String, Value>,
) -> Value {
    const FIELDS: [&str; 20] = [
        "assigneeAgentId",
        "assigneeUserId",
        "assigneeAgentRuntimeOverrides",
        "billingCode",
        "description",
        "executionWorkspaceId",
        "executionWorkspacePreference",
        "executionWorkspaceSettings",
        "goalId",
        "hiddenAt",
        "labelIds",
        "parentId",
        "priority",
        "projectId",
        "projectWorkspaceId",
        "requestDepth",
        "reviewerAgentId",
        "reviewerUserId",
        "status",
        "title",
    ];
    let mut previous = Map::new();
    for key in FIELDS {
        if existing.get(key) != updated.get(key) {
            if let Some(value) = updated.get(key) {
                metadata.insert(key.to_owned(), value.clone());
            }
            if let Some(value) = existing.get(key) {
                previous.insert(key.to_owned(), value.clone());
            }
        }
    }
    if !previous.is_empty() {
        metadata.insert("_previous".to_owned(), Value::Object(previous));
    }
    Value::Object(metadata)
}

fn issue_update_has_material_changes(details: &Value) -> bool {
    let Some(details) = details.as_object() else {
        return false;
    };
    details.keys().any(|key| {
        !matches!(
            key.as_str(),
            "identifier"
                | "issueIdentifier"
                | "source"
                | "reopened"
                | "reopenedFrom"
                | "normalizedFromStatus"
                | "normalizedReason"
                | "_previous"
                | "_references"
                | "title"
                | "description"
                | "executionWorkspaceId"
                | "executionWorkspacePreference"
                | "executionWorkspaceSettings"
                | "currentExecutionWorkspace"
                | "runWorkspaceId"
                | "runWorkspacePreference"
                | "runWorkspaceSettings"
                | "currentRunWorkspace"
        )
    })
}
fn project_error(error: crate::issue_checkout::IssueCheckoutError) -> IssueCoreWriteError {
    match error {
        crate::issue_checkout::IssueCheckoutError::Database(error) => {
            IssueCoreWriteError::Database(error)
        }
        crate::issue_checkout::IssueCheckoutError::Json(error) => IssueCoreWriteError::Json(error),
        crate::issue_checkout::IssueCheckoutError::Http(status, message, _) => {
            http(status, &message)
        }
    }
}

fn map_agent_issue_creation_error(
    error: crate::agent_issue_creation::AgentIssueCreationError,
) -> IssueCoreWriteError {
    match error {
        crate::agent_issue_creation::AgentIssueCreationError::Forbidden(message) => {
            http(403, message)
        }
        crate::agent_issue_creation::AgentIssueCreationError::Conflict(message) => {
            http(409, message)
        }
        crate::agent_issue_creation::AgentIssueCreationError::Database(error) => {
            IssueCoreWriteError::Database(error)
        }
    }
}

fn map_issue_comment_error(error: crate::issue_comments::IssueCommentError) -> IssueCoreWriteError {
    match error {
        crate::issue_comments::IssueCommentError::Http(status, message)
        | crate::issue_comments::IssueCommentError::OwnershipRejected(status, message, _) => {
            http(status, &message)
        }
        crate::issue_comments::IssueCommentError::HttpDetails(status, message, _) => {
            http(status, &message)
        }
        crate::issue_comments::IssueCommentError::Store(error) => IssueCoreWriteError::Store(error),
        crate::issue_comments::IssueCommentError::Database(error) => {
            IssueCoreWriteError::Database(error)
        }
        crate::issue_comments::IssueCommentError::Json(error) => IssueCoreWriteError::Json(error),
    }
}

fn http(status: u16, message: &str) -> IssueCoreWriteError {
    IssueCoreWriteError::Http(status, message.to_owned())
}

fn activity_actor_type(actor_kind: &str) -> &'static str {
    match actor_kind {
        "user" => "user",
        "agent" => "agent",
        _ => "system",
    }
}

fn canonical_uuid(value: &str) -> std::result::Result<String, IssueCoreWriteError> {
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| http(422, "Invalid UUID"))
}
fn required_issue_id(id: Option<&str>) -> Result<String> {
    canonical_uuid(id.ok_or_else(|| http(404, "Issue not found"))?)
}
fn required_text(input: &Value, key: &str) -> Result<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| http(422, &format!("{key} is required")))
}
fn text_or(input: &Value, key: &str, fallback: &str) -> Result<String> {
    match input.get(key) {
        None => Ok(fallback.to_owned()),
        Some(Value::String(value)) => Ok(value.clone()),
        _ => Err(http(422, &format!("{key} must be a string"))),
    }
}
fn optional_text(input: &Value, key: &str) -> Result<Option<String>> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(http(422, &format!("{key} must be a string or null"))),
    }
}
fn optional_field_text(input: &Value, key: &str) -> Result<Option<Option<String>>> {
    input
        .get(key)
        .map(|_| optional_text(input, key))
        .transpose()
}
fn optional_uuid(input: &Value, key: &str) -> Result<Option<String>> {
    optional_text(input, key)?
        .map(|value| canonical_uuid(&value))
        .transpose()
}

async fn resolve_optional_entity_ref(
    tx: &mut Tx<'_>,
    org: &str,
    input: &Value,
    key: &str,
    table: &str,
    prefix: &str,
    label: &str,
) -> Result<Option<String>> {
    let Some(value) = optional_text(input, key)? else {
        return Ok(None);
    };
    Ok(Some(
        resolve_entity_reference(tx, org, &value, table, prefix, label).await?,
    ))
}

async fn resolve_optional_entity_ref_field(
    tx: &mut Tx<'_>,
    org: &str,
    input: &Value,
    key: &str,
    table: &str,
    prefix: &str,
    label: &str,
) -> Result<Option<Option<String>>> {
    if input.get(key).is_none() {
        return Ok(None);
    }
    Ok(Some(
        resolve_optional_entity_ref(tx, org, input, key, table, prefix, label).await?,
    ))
}

pub(crate) async fn resolve_entity_reference(
    tx: &mut Tx<'_>,
    org: &str,
    raw: &str,
    table: &str,
    expected_prefix: &str,
    label: &str,
) -> std::result::Result<String, IssueCoreWriteError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(http(422, &format!("{label} must not be empty")));
    }
    if let Ok(id) = Uuid::parse_str(value) {
        return Ok(id.to_string());
    }
    let typed_message =
        format!("{label} must be a UUID or typed {expected_prefix}_<prefix> reference");
    let Some((actual_prefix, short_prefix)) = value.split_once('_') else {
        return Err(http(422, &typed_message));
    };
    if actual_prefix.len() != 3 || !actual_prefix.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        return Err(http(422, &typed_message));
    }
    if !actual_prefix.eq_ignore_ascii_case(expected_prefix)
        || !(8..=32).contains(&short_prefix.len())
        || !short_prefix.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(http(422, &typed_message));
    }
    let query = format!(
        "SELECT id::text FROM {table} WHERE org_id=$1::uuid AND replace(lower(id::text),'-','') LIKE $2 || '%' ORDER BY id LIMIT 2"
    );
    let matches = sqlx::query_scalar::<_, String>(&query)
        .bind(org)
        .bind(short_prefix.to_ascii_lowercase())
        .fetch_all(&mut **tx)
        .await?;
    match matches.as_slice() {
        [id] => Ok(id.clone()),
        [] => Err(http(
            404,
            &format!("{label} short reference not found in this organization"),
        )),
        _ => Err(http(
            409,
            &format!(
                "{label} short reference is ambiguous in this organization. Use a longer typed ref."
            ),
        )),
    }
}

pub(crate) async fn resolve_optional_user_ref(
    tx: &mut Tx<'_>,
    org: &str,
    input: &Value,
    key: &str,
    label: &str,
) -> Result<Option<String>> {
    let Some(value) = optional_text(input, key)? else {
        return Ok(None);
    };
    let value = value.trim();
    let Some((prefix, short_prefix)) = value.split_once('_') else {
        return Ok(Some(value.to_owned()));
    };
    if prefix.len() != 3 || !prefix.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        return Ok(Some(value.to_owned()));
    }
    if !prefix.eq_ignore_ascii_case("usr")
        || !(8..=32).contains(&short_prefix.len())
        || !short_prefix.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(http(
            422,
            &format!("{label} must be a UUID or typed usr_<prefix> reference"),
        ));
    }
    let matches = sqlx::query_scalar::<_, String>(
        "SELECT principal_id FROM organization_memberships WHERE org_id=$1::uuid AND principal_type='user' AND status='active' AND replace(lower(principal_id),'-','') LIKE $2 || '%' ORDER BY principal_id LIMIT 2",
    )
    .bind(org)
    .bind(short_prefix.to_ascii_lowercase())
    .fetch_all(&mut **tx)
    .await?;
    match matches.as_slice() {
        [id] => Ok(Some(id.clone())),
        [] => Err(http(
            404,
            &format!("{label} short reference not found in this organization"),
        )),
        _ => Err(http(
            409,
            &format!(
                "{label} short reference is ambiguous in this organization. Use a longer typed ref."
            ),
        )),
    }
}

async fn resolve_optional_user_ref_field(
    tx: &mut Tx<'_>,
    org: &str,
    input: &Value,
    key: &str,
    label: &str,
) -> Result<Option<Option<String>>> {
    if input.get(key).is_none() {
        return Ok(None);
    }
    Ok(Some(
        resolve_optional_user_ref(tx, org, input, key, label).await?,
    ))
}

fn optional_field_uuid(input: &Value, key: &str) -> Result<Option<Option<String>>> {
    input
        .get(key)
        .map(|_| optional_uuid(input, key))
        .transpose()
}
fn optional_uuid_array(input: &Value, key: &str) -> Result<Vec<String>> {
    let Some(value) = input.get(key) else {
        return Ok(Vec::new());
    };
    let Some(values) = value.as_array() else {
        return Err(http(422, &format!("{key} must be an array")));
    };
    let mut ids = Vec::new();
    for value in values {
        let Some(value) = value.as_str() else {
            return Err(http(422, &format!("{key} must contain UUID strings")));
        };
        let id = canonical_uuid(value)?;
        if !ids.contains(&id) {
            ids.push(id)
        }
    }
    Ok(ids)
}
fn optional_field_json(input: &Value, key: &str) -> Result<Option<Option<Value>>> {
    input
        .get(key)
        .map(|value| {
            if value.is_null() {
                Ok(None)
            } else if value.is_object() {
                Ok(Some(value.clone()))
            } else {
                Err(http(422, &format!("{key} must be an object or null")))
            }
        })
        .transpose()
}
fn json_field(input: &Value, key: &str) -> Result<Option<Value>> {
    optional_field_json(input, key).map(|v| v.flatten())
}
fn validate_choice(value: &str, choices: &[&str], message: &str) -> Result<()> {
    if choices.contains(&value) {
        Ok(())
    } else {
        Err(http(422, message))
    }
}
fn alias_uuid(input: &Value, canonical: &str, legacy: &str) -> Result<Option<String>> {
    let a = optional_uuid(input, canonical)?;
    let b = optional_uuid(input, legacy)?;
    if input.get(canonical).is_some() && input.get(legacy).is_some() && a != b {
        return Err(http(
            422,
            &format!("{canonical} conflicts with deprecated {legacy}"),
        ));
    }
    Ok(a.or(b))
}
fn alias_text(input: &Value, canonical: &str, legacy: &str) -> Result<Option<String>> {
    let a = optional_text(input, canonical)?;
    let b = optional_text(input, legacy)?;
    if input.get(canonical).is_some() && input.get(legacy).is_some() && a != b {
        return Err(http(
            422,
            &format!("{canonical} conflicts with deprecated {legacy}"),
        ));
    }
    Ok(a.or(b))
}
fn alias_json(input: &Value, canonical: &str, legacy: &str) -> Result<Option<Value>> {
    let a = input.get(canonical).filter(|v| !v.is_null()).cloned();
    let b = input.get(legacy).filter(|v| !v.is_null()).cloned();
    if input.get(canonical).is_some() && input.get(legacy).is_some() && a != b {
        return Err(http(
            422,
            &format!("{canonical} conflicts with deprecated {legacy}"),
        ));
    }
    Ok(a.or(b))
}
fn alias_field_uuid(
    input: &Value,
    canonical: &str,
    legacy: &str,
) -> Result<Option<Option<String>>> {
    if input.get(canonical).is_none() && input.get(legacy).is_none() {
        return Ok(None);
    }
    alias_uuid(input, canonical, legacy).map(Some)
}
fn alias_field_text(
    input: &Value,
    canonical: &str,
    legacy: &str,
) -> Result<Option<Option<String>>> {
    if input.get(canonical).is_none() && input.get(legacy).is_none() {
        return Ok(None);
    }
    alias_text(input, canonical, legacy).map(Some)
}
fn alias_field_json(input: &Value, canonical: &str, legacy: &str) -> Result<Option<Option<Value>>> {
    if input.get(canonical).is_none() && input.get(legacy).is_none() {
        return Ok(None);
    }
    alias_json(input, canonical, legacy).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_update_activity_contains_only_changed_values_and_previous_snapshot() {
        let previous = json!({
            "title": "Old title",
            "description": "same",
            "status": "todo",
            "labelIds": ["label-a"],
        });
        let updated = json!({
            "title": "New title",
            "description": "same",
            "status": "in_progress",
            "labelIds": ["label-a"],
        });
        let details = issue_update_activity_details(
            &previous,
            &updated,
            Map::from_iter([("identifier".to_owned(), json!("RUD-1"))]),
        );

        assert_eq!(details["title"], "New title");
        assert_eq!(details["status"], "in_progress");
        assert!(details.get("description").is_none());
        assert!(details.get("labelIds").is_none());
        assert_eq!(details["_previous"]["title"], "Old title");
        assert_eq!(details["_previous"]["status"], "todo");
        assert_eq!(details["identifier"], "RUD-1");
        assert!(issue_update_has_material_changes(&details));
    }

    #[test]
    fn title_and_description_changes_remain_low_signal() {
        let details = json!({"title":"Changed", "description":"Changed"});
        assert!(!issue_update_has_material_changes(&details));
    }

    #[test]
    fn hidden_at_accepts_rfc3339_or_explicit_null_only() {
        assert_eq!(
            parse_optional_timestamp(&json!("2026-10-26T04:05:06.123Z")).unwrap(),
            Some("2026-10-26T04:05:06.123Z".to_owned())
        );
        assert_eq!(parse_optional_timestamp(&Value::Null).unwrap(), None);
        assert!(parse_optional_timestamp(&json!("not-a-date")).is_err());
        assert!(parse_optional_timestamp(&json!(true)).is_err());
    }

    #[test]
    fn block_audit_fingerprint_normalizes_unicode_counters_and_volatile_ids() {
        let issue_id = "11111111-1111-4111-8111-111111111111";
        let first = blocker_fingerprint(
            issue_id,
            "issue_execution",
            "Ａuth failed on attempt #1, run 123456789012 and 22222222-2222-4222-8222-222222222222",
            "Ask the owner to retry #2",
        );
        let second = blocker_fingerprint(
            issue_id,
            "issue_execution",
            "auth failed on attempt #9, run 987654321098 and 33333333-3333-4333-8333-333333333333",
            "Ask the owner to retry 15",
        );
        assert_eq!(first, second);
        assert_ne!(
            first,
            blocker_fingerprint(
                issue_id,
                "issue_execution",
                "Auth failed",
                "Provide a replacement credential"
            )
        );
    }

    #[test]
    fn block_audit_redacts_secrets_before_persisting_request_text() {
        let redacted = redact_sensitive_text(
            "Bearer abc123 api_key=top-secret code=123456 sk-12345678901234567890",
        );
        assert!(redacted.contains("Bearer [REDACTED]"));
        assert!(redacted.contains("api_key=[REDACTED]"));
        assert!(redacted.contains("[REDACTED_OTP]"));
        assert!(redacted.contains("[REDACTED_SECRET]"));
        assert!(!redacted.contains("top-secret"));
    }
}
