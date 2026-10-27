//! Public Issue list/detail projections over the durable Issue row.

use crate::{
    StoreError,
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    goal_reads::{GoalReadRequest, GoalReadView, read_goals_for_actor_in_transaction},
    issue_checkout::project_issue,
    project_reads::read_projects_in_snapshot,
};
use regex_lite::Regex;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, QueryBuilder, Row, Transaction};
use std::{collections::HashSet, sync::OnceLock};
use url::Url;
use uuid::Uuid;

type Tx<'a> = Transaction<'a, Postgres>;

#[derive(Debug, thiserror::Error)]
pub enum IssueCoreReadError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("Issue reference is invalid")]
    InvalidReference,
    #[error("{1}")]
    Http(u16, String),
}

/// Read an Issue detail or collection after revalidating the public identity
/// on the same repeatable-read snapshot used for the projection.
pub async fn read_issue_core_with_native_auth(
    pool: &PgPool,
    organization_id: &str,
    issue_id: Option<&str>,
    filters: &Value,
    user_id: Option<&str>,
    organization_workspace_root: &str,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<Value, IssueCoreReadError> {
    let org = Uuid::parse_str(organization_id)
        .map(|id| id.to_string())
        .map_err(|_| IssueCoreReadError::InvalidReference)?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    match authorizer.revalidate(&mut tx, &org).await? {
        NativeAgentAccess::Authorized => {}
        NativeAgentAccess::Unauthorized => {
            return Err(StoreError::PublicIdentityUnauthorized.into());
        }
        NativeAgentAccess::Forbidden => {
            return Err(StoreError::PublicIdentityForbidden.into());
        }
    }

    let response = if let Some(issue_id) = issue_id {
        let id = Uuid::parse_str(issue_id)
            .map(|id| id.to_string())
            .map_err(|_| IssueCoreReadError::InvalidReference)?;
        let raw = sqlx::query_scalar::<_, String>(
            "SELECT to_jsonb(i)::text FROM issues i WHERE i.org_id=$1::uuid AND i.id=$2::uuid",
        )
        .bind(&org)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::NotFound)?;
        let mut issue = project_issue(&mut tx, &raw).await.map_err(project_error)?;
        issue["ancestors"] = read_ancestors(&mut tx, &org, &raw).await?;
        let stored: Value = serde_json::from_str(&raw)?;
        issue["project"] = if let Some(project_id) = stored["project_id"].as_str() {
            read_projects_in_snapshot(
                &mut tx,
                &org,
                Some(project_id),
                false,
                organization_workspace_root,
            )
            .await?
        } else {
            Value::Null
        };
        issue["goal"] = if let Some(goal_id) = stored["goal_id"].as_str() {
            let request = GoalReadRequest {
                view: GoalReadView::Detail,
                goal_id: Some(goal_id.to_owned()),
                cursor: None,
                limit: None,
                agent_id: None,
                lifecycle: None,
                focus: None,
                facet: None,
            };
            let value = read_goals_for_actor_in_transaction(&mut tx, &org, &request, None)
                .await
                .map_err(|error| match error {
                    crate::goal_reads::GoalReadError::Store(error) => {
                        IssueCoreReadError::Store(error)
                    }
                    crate::goal_reads::GoalReadError::Cursor
                    | crate::goal_reads::GoalReadError::Limit
                    | crate::goal_reads::GoalReadError::TimelineLimit => {
                        IssueCoreReadError::Store(StoreError::InvalidInput)
                    }
                })?;
            serde_json::from_str(&value)?
        } else {
            Value::Null
        };
        issue["mentionedProjects"] =
            read_mentioned_projects(&mut tx, &org, &stored, organization_workspace_root).await?;
        let workspace = if let Some(workspace_id) = stored["execution_workspace_id"].as_str() {
            let raw = sqlx::query_scalar::<_, String>("SELECT to_jsonb(w)::text FROM execution_workspaces w WHERE w.org_id=$1::uuid AND w.id=$2::uuid")
                .bind(&org).bind(workspace_id).fetch_optional(&mut *tx).await?;
            raw.map(|raw| {
                let mut value: Value = serde_json::from_str(&raw)?;
                camelize_keys(&mut value);
                Ok::<Value, IssueCoreReadError>(value)
            })
            .transpose()?
            .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        issue["currentRunWorkspace"] = workspace.clone();
        issue["currentExecutionWorkspace"] = workspace;
        issue["workProducts"] = read_work_products(&mut tx, &org, issue_id).await?;
        issue
    } else {
        read_issue_collection(&mut tx, &org, filters, user_id).await?
    };
    tx.commit().await?;
    Ok(response)
}

pub(crate) async fn read_issue_collection(
    tx: &mut Tx<'_>,
    org: &str,
    filters: &Value,
    user_id: Option<&str>,
) -> Result<Value, IssueCoreReadError> {
    let status_values = split_csv(filters.get("status").and_then(value_as_query_string));
    let mut query =
        QueryBuilder::<Postgres>::new("SELECT to_jsonb(i)::text FROM issues i WHERE i.org_id=");
    query.push_bind(org).push("::uuid AND i.hidden_at IS NULL");
    if !status_values.is_empty() {
        query
            .push(" AND i.status=ANY(")
            .push_bind(status_values)
            .push("::text[])");
    }

    for (key, column) in [
        ("assigneeAgentId", "assignee_agent_id"),
        ("reviewerAgentId", "reviewer_agent_id"),
        ("projectId", "project_id"),
        ("parentId", "parent_id"),
    ] {
        if let Some(value) = filters.get(key).and_then(value_as_query_string) {
            let (table, prefix, label) = match key {
                "assigneeAgentId" => ("agents", "agt", "Assignee agent ID"),
                "reviewerAgentId" => ("agents", "agt", "Reviewer agent ID"),
                "projectId" => ("projects", "prj", "Project ID"),
                "parentId" => ("issues", "iss", "Parent issue ID"),
                _ => unreachable!("filter reference mapping is exhaustive"),
            };
            let value = crate::issue_core_writes::resolve_entity_reference(
                tx, org, value, table, prefix, label,
            )
            .await
            .map_err(map_reference_error)?;
            query
                .push(" AND i.")
                .push(column)
                .push("=")
                .push_bind(value)
                .push("::uuid");
        }
    }
    if filters
        .get("excludeReviewerRecordedBlockedDecision")
        .and_then(Value::as_bool)
        == Some(true)
        && let Some(value) = filters
            .get("reviewerAgentId")
            .and_then(value_as_query_string)
    {
        let reviewer_id = crate::issue_core_writes::resolve_entity_reference(
            tx,
            org,
            value,
            "agents",
            "agt",
            "Reviewer agent ID",
        )
        .await
        .map_err(map_reference_error)?;
        query.push(
                " AND NOT (i.status='blocked' AND EXISTS(SELECT 1 FROM activity_log confirmed_blocked_review
                 WHERE confirmed_blocked_review.org_id=",
            )
            .push_bind(org)
            .push("::uuid AND confirmed_blocked_review.entity_type='issue' AND confirmed_blocked_review.entity_id=i.id::text
                   AND confirmed_blocked_review.action='issue.review_decision_recorded' AND confirmed_blocked_review.actor_type='agent'
                   AND confirmed_blocked_review.actor_id=")
            .push_bind(reviewer_id.clone())
            .push("::text AND confirmed_blocked_review.details->>'decision'='blocked'
                   AND confirmed_blocked_review.created_at >= COALESCE((SELECT MAX(material_activity.created_at)
                     FROM activity_log material_activity WHERE material_activity.org_id=")
            .push_bind(org)
            .push("::uuid AND material_activity.entity_type='issue' AND material_activity.entity_id=i.id::text AND (
                       (material_activity.action='issue.updated' AND jsonb_typeof(material_activity.details)='object'
                         AND EXISTS(SELECT 1 FROM jsonb_object_keys(material_activity.details) AS detail_key(key)
                           WHERE detail_key.key NOT IN ('title','description','identifier','issueIdentifier','_previous','_references','source','reopened','reopenedFrom','normalizedFromStatus','normalizedReason')))
                       OR (material_activity.action='issue.comment_added' AND NOT (material_activity.actor_type='agent' AND material_activity.actor_id=")
            .push_bind(reviewer_id)
            .push("::text))
                     )),to_timestamp(0))))");
    }

    for (key, column) in [
        ("assigneeUserId", "assignee_user_id"),
        ("reviewerUserId", "reviewer_user_id"),
        ("originKind", "origin_kind"),
        ("originId", "origin_id"),
    ] {
        if let Some(value) = query_user_value(tx, org, filters, key, user_id).await? {
            query
                .push(" AND i.")
                .push(column)
                .push("=")
                .push_bind(value);
        }
    }
    let touched_by_user_id = query_user_value(tx, org, filters, "touchedByUserId", user_id).await?;
    let unread_for_user_id = query_user_value(tx, org, filters, "unreadForUserId", user_id).await?;
    let followed_by_user_id =
        query_user_value(tx, org, filters, "followedByUserId", user_id).await?;
    let involved_user_id = query_user_value(tx, org, filters, "involvedUserId", user_id).await?;
    if let Some(value) = filters
        .get("participantAgentId")
        .and_then(value_as_query_string)
    {
        let agent_id = crate::issue_core_writes::resolve_entity_reference(
            tx,
            org,
            value,
            "agents",
            "agt",
            "Participant agent ID",
        )
        .await
        .map_err(map_reference_error)?;
        query.push(" AND (i.created_by_agent_id=").push_bind(agent_id.clone()).push("::uuid OR i.assignee_agent_id=").push_bind(agent_id.clone()).push("::uuid OR i.reviewer_agent_id=").push_bind(agent_id.clone()).push("::uuid OR EXISTS(SELECT 1 FROM issue_comments c WHERE c.org_id=i.org_id AND c.issue_id=i.id AND c.author_agent_id=").push_bind(agent_id.clone()).push("::uuid) OR EXISTS(SELECT 1 FROM activity_log a WHERE a.org_id=i.org_id AND a.entity_type='issue' AND a.entity_id=i.id::text AND a.agent_id=").push_bind(agent_id).push("::uuid))");
    }
    if let Some(label_id) = filters.get("labelId").and_then(value_as_query_string) {
        let label_id = crate::issue_core_writes::resolve_entity_reference(
            tx, org, label_id, "labels", "lbl", "Label ID",
        )
        .await
        .map_err(map_reference_error)?;
        query.push(" AND EXISTS(SELECT 1 FROM issue_labels il WHERE il.org_id=i.org_id AND il.issue_id=i.id AND il.label_id=").push_bind(label_id).push("::uuid)");
    }
    if let Some(user_id) = touched_by_user_id.as_deref() {
        push_touched_by_filter(&mut query, user_id);
    }
    if let Some(user_id) = followed_by_user_id.as_deref() {
        query.push(" AND EXISTS(SELECT 1 FROM issue_follows f WHERE f.org_id=i.org_id AND f.issue_id=i.id AND f.user_id=")
            .push_bind(user_id)
            .push(")");
    }
    if let Some(user_id) = involved_user_id.as_deref() {
        query
            .push(" AND (i.created_by_user_id=")
            .push_bind(user_id)
            .push(" OR i.assignee_user_id=")
            .push_bind(user_id)
            .push(" OR i.reviewer_user_id=")
            .push_bind(user_id)
            .push(")");
    }
    if let Some(user_id) = unread_for_user_id.as_deref() {
        push_unread_filter(&mut query, user_id);
    }
    if filters
        .get("includeAutomationExecutions")
        .and_then(Value::as_bool)
        != Some(true)
        && filters.get("originKind").is_none()
        && filters.get("originId").is_none()
    {
        if let Some(user_id) = unread_for_user_id
            .as_deref()
            .or(touched_by_user_id.as_deref())
        {
            query.push(" AND (i.origin_kind<>'automation_execution' OR EXISTS(SELECT 1 FROM issue_follows f WHERE f.org_id=i.org_id AND f.issue_id=i.id AND f.user_id=")
                .push_bind(user_id)
                .push(") OR EXISTS(SELECT 1 FROM activity_log a WHERE a.org_id=i.org_id AND a.entity_type='issue' AND a.entity_id=i.id::text AND a.action IN ('automation.issue_created_notification','agent.issue_created_notification') AND a.details->>'userId'=")
                .push_bind(user_id)
                .push("))");
        } else {
            query.push(" AND i.origin_kind<>'automation_execution'");
        }
    }

    let search = filters
        .get("q")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let mut search_fields = split_csv(filters.get("searchFields").and_then(value_as_query_string));
    search_fields.retain(|field| matches!(field.as_str(), "title" | "description" | "comment"));
    if search_fields.is_empty() {
        search_fields.push("title".to_owned());
    }
    let has_search = !search.is_empty();
    let contains = format!("%{}%", escape_like(&search));
    let starts_with = format!("{}%", escape_like(&search));
    if has_search {
        query
            .push(" AND (i.identifier ILIKE ")
            .push_bind(&contains)
            .push(" ESCAPE '\\'");
        for field in &search_fields {
            match field.as_str() {
                "title" => query.push(" OR i.title ILIKE ").push_bind(&contains).push(" ESCAPE '\\'"),
                "description" => query.push(" OR i.description ILIKE ").push_bind(&contains).push(" ESCAPE '\\'"),
                "comment" => query.push(" OR EXISTS(SELECT 1 FROM issue_comments c WHERE c.org_id=i.org_id AND c.issue_id=i.id AND c.deleted_at IS NULL AND c.body ILIKE ").push_bind(&contains).push(" ESCAPE '\\')"),
                _ => unreachable!("search field was filtered above"),
            };
        }
        query.push(")");
    }

    let sort_field = filters
        .get("sortField")
        .and_then(Value::as_str)
        .unwrap_or("priority");
    let sort_dir = if filters.get("sortDir").and_then(Value::as_str) == Some("desc") {
        "DESC"
    } else {
        "ASC"
    };
    let order = match sort_field {
        "manual" => "i.board_order",
        "status" => {
            "CASE i.status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 WHEN 'backlog' THEN 2 WHEN 'in_review' THEN 3 WHEN 'blocked' THEN 4 WHEN 'done' THEN 5 WHEN 'cancelled' THEN 6 ELSE 7 END"
        }
        "title" => "i.title COLLATE \"C\"",
        "created" => "i.created_at",
        "updated" => "i.updated_at",
        "priority" => {
            "CASE i.priority WHEN 'urgent' THEN 0 WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END"
        }
        _ => {
            "CASE i.priority WHEN 'urgent' THEN 0 WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END"
        }
    };
    query.push(" ORDER BY ");
    if has_search {
        query.push("CASE ");
        if search_fields.iter().any(|field| field == "title") {
            query
                .push("WHEN i.title ILIKE ")
                .push_bind(&starts_with)
                .push(" ESCAPE '\\' THEN 0 ");
        }
        query
            .push("WHEN i.identifier ILIKE ")
            .push_bind(&starts_with)
            .push(" ESCAPE '\\' THEN 1 WHEN i.identifier ILIKE ")
            .push_bind(&contains)
            .push(" ESCAPE '\\' THEN 2 ");
        if search_fields.iter().any(|field| field == "title") {
            query
                .push("WHEN i.title ILIKE ")
                .push_bind(&contains)
                .push(" ESCAPE '\\' THEN 3 ");
        }
        if search_fields.iter().any(|field| field == "description") {
            query
                .push("WHEN i.description ILIKE ")
                .push_bind(&contains)
                .push(" ESCAPE '\\' THEN 4 ");
        }
        if search_fields.iter().any(|field| field == "comment") {
            query
                .push("WHEN EXISTS(SELECT 1 FROM issue_comments c WHERE c.org_id=i.org_id AND c.issue_id=i.id AND c.deleted_at IS NULL AND c.body ILIKE ")
                .push_bind(&contains)
                .push(" ESCAPE '\\') THEN 5 ");
        }
        query
            .push("ELSE 6 END ASC, ")
            .push(order)
            .push(" ASC, i.updated_at DESC, i.created_at DESC, COALESCE(i.identifier,i.id::text) COLLATE \"C\" ASC");
    } else {
        query
            .push(order)
            .push(" ")
            .push(sort_dir)
            .push(", i.updated_at DESC, i.created_at DESC, COALESCE(i.identifier,i.id::text) COLLATE \"C\" ASC");
    }
    if let Some(limit) = filters
        .get("limit")
        .and_then(Value::as_u64)
        .filter(|limit| *limit > 0)
    {
        query.push(" LIMIT ").push_bind(limit.min(500) as i64);
    }
    if let Some(offset) = filters
        .get("offset")
        .and_then(Value::as_u64)
        .filter(|offset| *offset > 0)
    {
        query
            .push(" OFFSET ")
            .push_bind(offset.min(i64::MAX as u64) as i64);
    }
    let rows = query
        .build_query_scalar::<String>()
        .fetch_all(&mut **tx)
        .await?;
    let mut issues = Vec::with_capacity(rows.len());
    let mut execution_ids = Vec::new();
    for raw in &rows {
        let mut issue = project_issue(tx, raw).await.map_err(project_error)?;
        if let Some(id) = issue.get("executionRunId").and_then(Value::as_str) {
            execution_ids.push(id.to_owned());
        }
        issue["activeRun"] = Value::Null;
        issues.push(issue);
    }
    if !execution_ids.is_empty() {
        let runs = sqlx::query_as::<_, (String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)>(
            "SELECT id::text,status,agent_id::text,invocation_source,trigger_detail,to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),to_char(finished_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM heartbeat_runs WHERE id=ANY($1::uuid[]) AND (status IN ('queued','running') OR terminal_effects_pending)",
        )
        .bind(&execution_ids)
        .fetch_all(&mut **tx)
        .await?;
        for issue in &mut issues {
            if let Some(run_id) = issue.get("executionRunId").and_then(Value::as_str)
                && let Some((
                    id,
                    status,
                    agent_id,
                    invocation_source,
                    trigger_detail,
                    started_at,
                    finished_at,
                    created_at,
                )) = runs.iter().find(|row| row.0 == run_id)
            {
                issue["activeRun"] = json!({"id":id,"status":status,"agentId":agent_id,"invocationSource":invocation_source,"triggerDetail":trigger_detail,"startedAt":started_at,"finishedAt":finished_at,"createdAt":created_at});
            }
        }
    }
    if has_search {
        attach_search_matches(tx, org, &mut issues, &search, &search_fields).await?;
    }
    if let Some(user_id) = unread_for_user_id
        .as_deref()
        .or(touched_by_user_id.as_deref())
    {
        attach_user_context(tx, org, &mut issues, user_id).await?;
    }
    Ok(Value::Array(issues))
}

async fn attach_search_matches(
    tx: &mut Tx<'_>,
    org: &str,
    issues: &mut [Value],
    query: &str,
    fields: &[String],
) -> Result<(), IssueCoreReadError> {
    if issues.is_empty() {
        return Ok(());
    }
    let issue_ids = issues
        .iter()
        .filter_map(|issue| {
            issue
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect::<Vec<_>>();
    let comments = if fields.iter().any(|field| field == "comment") {
        sqlx::query_as::<_, (String, String, String)>(
            "SELECT issue_id::text,id::text,body FROM issue_comments WHERE org_id=$1::uuid AND issue_id=ANY($2::uuid[]) AND deleted_at IS NULL ORDER BY created_at ASC,id ASC",
        )
        .bind(org)
        .bind(&issue_ids)
        .fetch_all(&mut **tx)
        .await?
    } else {
        Vec::new()
    };
    let needle = query.to_lowercase();
    for issue in issues {
        let id = issue.get("id").and_then(Value::as_str).unwrap_or_default();
        let identifier = issue
            .get("identifier")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let title = issue
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let description = issue
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let matched = if identifier.to_lowercase().contains(&needle) {
            Some(json!({"field":"identifier","snippet":identifier}))
        } else if fields.iter().any(|field| field == "title")
            && title.to_lowercase().contains(&needle)
        {
            Some(json!({"field":"title","snippet":search_snippet(title, query)}))
        } else if fields.iter().any(|field| field == "description")
            && description.to_lowercase().contains(&needle)
        {
            Some(json!({"field":"description","snippet":search_snippet(description, query)}))
        } else {
            comments
                .iter()
                .find(|(issue_id, _, body)| {
                    issue_id == id && body.to_lowercase().contains(&needle)
                })
                .map(|(_, comment_id, body)| {
                    json!({"field":"comment","snippet":search_snippet(body, query),"commentId":comment_id})
                })
        };
        issue["searchMatch"] = matched.unwrap_or(Value::Null);
    }
    Ok(())
}

fn search_snippet(value: &str, query: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let characters = compact.char_indices().collect::<Vec<_>>();
    if characters.len() <= 160 {
        return compact;
    }
    // Lowercasing can change the UTF-8 byte length (for example, U+0130
    // expands to `i` plus a combining dot). Map the match offset back to the
    // original string before calculating a character-based excerpt.
    let mut lowered = String::new();
    let mut lowered_byte_to_original = Vec::new();
    for (original_byte, character) in compact.char_indices() {
        for lowered_character in character.to_lowercase() {
            lowered.push(lowered_character);
            lowered_byte_to_original.resize(lowered.len(), original_byte);
        }
    }
    let lowered_index = lowered.find(&query.to_lowercase()).unwrap_or_default();
    let index = lowered_byte_to_original
        .get(lowered_index)
        .copied()
        .unwrap_or_default();
    let index_char = compact[..index].chars().count();
    let context = 20.max(160usize.saturating_sub(query.chars().count()) / 2);
    let start_char = index_char.saturating_sub(context);
    let end_char = characters.len().min(start_char.saturating_add(160));
    let start = characters
        .get(start_char)
        .map_or(compact.len(), |(byte, _)| *byte);
    let end = characters
        .get(end_char)
        .map_or(compact.len(), |(byte, _)| *byte);
    format!(
        "{}{}{}",
        if start_char > 0 { "…" } else { "" },
        compact[start..end].trim(),
        if end_char < characters.len() {
            "…"
        } else {
            ""
        }
    )
}

async fn attach_user_context(
    tx: &mut Tx<'_>,
    org: &str,
    issues: &mut [Value],
    user_id: &str,
) -> Result<(), IssueCoreReadError> {
    if issues.is_empty() {
        return Ok(());
    }
    let issue_ids = issues
        .iter()
        .filter_map(|issue| {
            issue
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect::<Vec<_>>();
    let comment_stats = sqlx::query_as::<_, (String, Option<String>, Option<String>)>(
        "SELECT issue_id::text,to_char(max(created_at) FILTER (WHERE author_user_id=$3) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),to_char(max(created_at) FILTER (WHERE author_user_id IS NULL OR author_user_id<>$3) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM issue_comments WHERE org_id=$1::uuid AND issue_id=ANY($2::uuid[]) AND deleted_at IS NULL GROUP BY issue_id",
    )
    .bind(org)
    .bind(&issue_ids)
    .bind(user_id)
    .fetch_all(&mut **tx)
    .await?;
    let reads = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT issue_id::text,to_char(max(last_read_at) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM issue_read_states WHERE org_id=$1::uuid AND issue_id=ANY($2::uuid[]) AND user_id=$3 GROUP BY issue_id",
    )
    .bind(org)
    .bind(&issue_ids)
    .bind(user_id)
    .fetch_all(&mut **tx)
    .await?;
    let notifications = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT entity_id,to_char(max(created_at) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM activity_log WHERE org_id=$1::uuid AND entity_type='issue' AND entity_id=ANY($2::text[]) AND action IN ('automation.issue_created_notification','agent.issue_created_notification') AND details->>'userId'=$3 GROUP BY entity_id",
    )
    .bind(org)
    .bind(&issue_ids)
    .bind(user_id)
    .fetch_all(&mut **tx)
    .await?;
    let issue_timestamps = sqlx::query_as::<_, (String, Option<String>, Option<String>, Option<String>, Option<String>)>(
        "SELECT id::text,created_by_user_id,assignee_user_id,reviewer_user_id,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')||'|'||to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM issues WHERE org_id=$1::uuid AND id=ANY($2::uuid[])",
    )
    .bind(org)
    .bind(&issue_ids)
    .fetch_all(&mut **tx)
    .await?;
    for issue in issues {
        let id = issue.get("id").and_then(Value::as_str).unwrap_or_default();
        let comments = comment_stats.iter().find(|row| row.0 == id);
        let my_comment = comments.and_then(|row| row.1.as_deref());
        let external_comment = comments.and_then(|row| row.2.as_deref());
        let my_read = reads
            .iter()
            .find(|row| row.0 == id)
            .and_then(|row| row.1.as_deref());
        let external_activity = notifications
            .iter()
            .find(|row| row.0 == id)
            .and_then(|row| row.1.as_deref());
        let timestamps = issue_timestamps.iter().find(|row| row.0 == id);
        let created_at = timestamps.and_then(|row| {
            (row.1.as_deref() == Some(user_id))
                .then_some(row.4.as_deref())
                .flatten()
                .and_then(|value| value.split_once('|').map(|(created, _)| created))
        });
        let updated_at = timestamps.and_then(|row| {
            (row.2.as_deref() == Some(user_id) || row.3.as_deref() == Some(user_id))
                .then_some(row.4.as_deref())
                .flatten()
                .and_then(|value| value.split_once('|').map(|(_, updated)| updated))
        });
        let my_last_touch = [my_comment, my_read, created_at, updated_at]
            .into_iter()
            .flatten()
            .max()
            .map(ToOwned::to_owned);
        let latest_external = [external_comment, external_activity]
            .into_iter()
            .flatten()
            .max();
        let unread = latest_external.is_some_and(|latest| {
            (external_activity.is_some() && my_last_touch.is_none())
                || my_last_touch.as_deref().is_some_and(|touch| latest > touch)
        });
        issue["myLastTouchAt"] = my_last_touch.map_or(Value::Null, Value::String);
        issue["lastExternalCommentAt"] = external_comment.map_or(Value::Null, |value| json!(value));
        issue["lastExternalActivityAt"] =
            external_activity.map_or(Value::Null, |value| json!(value));
        issue["isUnreadForMe"] = json!(unread);
    }
    Ok(())
}

async fn query_user_value(
    tx: &mut Tx<'_>,
    org: &str,
    filters: &Value,
    key: &str,
    user_id: Option<&str>,
) -> Result<Option<String>, IssueCoreReadError> {
    let Some(value) = filters.get(key).and_then(value_as_query_string) else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value == "me" {
        return user_id
            .map(|user_id| Some(user_id.to_owned()))
            .ok_or_else(|| StoreError::PublicIdentityForbidden.into());
    }
    crate::issue_core_writes::resolve_optional_user_ref(tx, org, &json!(value), key, key)
        .await
        .map_err(map_reference_error)
}

fn value_as_query_string(value: &Value) -> Option<&str> {
    match value {
        Value::String(value) => Some(value),
        Value::Array(values) => values.first().and_then(Value::as_str),
        _ => None,
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn push_touched_by_filter(query: &mut QueryBuilder<'_, Postgres>, user_id: &str) {
    query
        .push(" AND (i.created_by_user_id=")
        .push_bind(user_id.to_owned())
        .push(" OR i.assignee_user_id=")
        .push_bind(user_id.to_owned())
        .push(" OR i.reviewer_user_id=")
        .push_bind(user_id.to_owned())
        .push(" OR EXISTS(SELECT 1 FROM issue_follows f WHERE f.org_id=i.org_id AND f.issue_id=i.id AND f.user_id=")
        .push_bind(user_id.to_owned())
        .push(") OR EXISTS(SELECT 1 FROM activity_log a WHERE a.org_id=i.org_id AND a.entity_type='issue' AND a.entity_id=i.id::text AND a.action IN ('automation.issue_created_notification','agent.issue_created_notification') AND a.details->>'userId'=")
        .push_bind(user_id.to_owned())
        .push(") OR EXISTS(SELECT 1 FROM issue_read_states s WHERE s.org_id=i.org_id AND s.issue_id=i.id AND s.user_id=")
        .push_bind(user_id.to_owned())
        .push(") OR EXISTS(SELECT 1 FROM issue_comments c WHERE c.org_id=i.org_id AND c.issue_id=i.id AND c.deleted_at IS NULL AND c.author_user_id=")
        .push_bind(user_id.to_owned())
        .push("))");
}

fn push_my_last_touch(query: &mut QueryBuilder<'_, Postgres>, user_id: &str) {
    query
        .push("GREATEST(COALESCE((SELECT max(c.created_at) FROM issue_comments c WHERE c.org_id=i.org_id AND c.issue_id=i.id AND c.deleted_at IS NULL AND c.author_user_id=")
        .push_bind(user_id.to_owned())
        .push("),to_timestamp(0)),COALESCE((SELECT max(s.last_read_at) FROM issue_read_states s WHERE s.org_id=i.org_id AND s.issue_id=i.id AND s.user_id=")
        .push_bind(user_id.to_owned())
        .push("),to_timestamp(0)),COALESCE(CASE WHEN i.created_by_user_id=")
        .push_bind(user_id.to_owned())
        .push(" THEN i.created_at END,to_timestamp(0)),COALESCE(CASE WHEN i.assignee_user_id=")
        .push_bind(user_id.to_owned())
        .push(" OR i.reviewer_user_id=")
        .push_bind(user_id.to_owned())
        .push(" THEN i.updated_at END,to_timestamp(0)))");
}

fn push_unread_filter(query: &mut QueryBuilder<'_, Postgres>, user_id: &str) {
    query.push(" AND ((");
    query.push("(");
    query
        .push("i.created_by_user_id=")
        .push_bind(user_id.to_owned())
        .push(" OR i.assignee_user_id=")
        .push_bind(user_id.to_owned())
        .push(" OR i.reviewer_user_id=")
        .push_bind(user_id.to_owned())
        .push(" OR EXISTS(SELECT 1 FROM issue_follows f WHERE f.org_id=i.org_id AND f.issue_id=i.id AND f.user_id=")
        .push_bind(user_id.to_owned())
        .push(") OR EXISTS(SELECT 1 FROM activity_log a WHERE a.org_id=i.org_id AND a.entity_type='issue' AND a.entity_id=i.id::text AND a.action IN ('automation.issue_created_notification','agent.issue_created_notification') AND a.details->>'userId'=")
        .push_bind(user_id.to_owned())
        .push(") OR EXISTS(SELECT 1 FROM issue_read_states s WHERE s.org_id=i.org_id AND s.issue_id=i.id AND s.user_id=")
        .push_bind(user_id.to_owned())
        .push(") OR EXISTS(SELECT 1 FROM issue_comments c WHERE c.org_id=i.org_id AND c.issue_id=i.id AND c.deleted_at IS NULL AND c.author_user_id=")
        .push_bind(user_id.to_owned())
        .push(")");
    query
        .push(" AND EXISTS(SELECT 1 FROM issue_comments c WHERE c.org_id=i.org_id AND c.issue_id=i.id AND c.deleted_at IS NULL AND (c.author_user_id IS NULL OR c.author_user_id<>")
        .push_bind(user_id.to_owned())
        .push(") AND c.created_at>");
    push_my_last_touch(query, user_id);
    query.push(")) OR EXISTS(SELECT 1 FROM activity_log n WHERE n.org_id=i.org_id AND n.entity_type='issue' AND n.entity_id=i.id::text AND n.action IN ('automation.issue_created_notification','agent.issue_created_notification') AND n.details->>'userId'=")
        .push_bind(user_id.to_owned())
        .push(" AND n.created_at>");
    push_my_last_touch(query, user_id);
    query.push("))");
}

async fn read_ancestors(
    tx: &mut Tx<'_>,
    org: &str,
    issue_raw: &str,
) -> Result<Value, IssueCoreReadError> {
    let issue: Value = serde_json::from_str(issue_raw)?;
    let mut parent = issue
        .get("parent_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let mut visited = vec![
        issue
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    ];
    let mut rows = Vec::new();
    while let Some(parent_id) = parent {
        if visited.len() > 50 || visited.iter().any(|id| id == &parent_id) {
            break;
        }
        visited.push(parent_id.clone());
        let raw = sqlx::query_scalar::<_, String>(
            "SELECT to_jsonb(i)::text FROM issues i WHERE i.org_id=$1::uuid AND i.id=$2::uuid",
        )
        .bind(org)
        .bind(&parent_id)
        .fetch_optional(&mut **tx)
        .await?;
        let Some(raw) = raw else { break };
        let value: Value = serde_json::from_str(&raw)?;
        parent = value
            .get("parent_id")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let issue = project_issue(tx, &raw).await.map_err(project_error)?;
        rows.push(json!({"id":issue["id"],"identifier":issue["identifier"],"title":issue["title"],"description":issue["description"],"status":issue["status"],"priority":issue["priority"],"assigneeAgentId":issue["assigneeAgentId"],"assigneeUserId":issue["assigneeUserId"],"reviewerAgentId":issue["reviewerAgentId"],"reviewerUserId":issue["reviewerUserId"],"projectId":issue["projectId"],"goalId":issue["goalId"]}));
    }
    Ok(Value::Array(rows))
}

async fn read_work_products(
    tx: &mut Tx<'_>,
    org: &str,
    issue_id: &str,
) -> Result<Value, IssueCoreReadError> {
    let rows = sqlx::query("SELECT to_jsonb(w)::text FROM issue_work_products w WHERE w.org_id=$1::uuid AND w.issue_id=$2::uuid ORDER BY w.is_primary DESC,w.updated_at DESC")
        .bind(org).bind(issue_id).fetch_all(&mut **tx).await?;
    let mut output = Vec::with_capacity(rows.len());
    for row in rows {
        let raw: String = row.try_get(0)?;
        let mut value: Value = serde_json::from_str(&raw)?;
        camelize_keys(&mut value);
        output.push(value);
    }
    Ok(Value::Array(output))
}

async fn read_mentioned_projects(
    tx: &mut Tx<'_>,
    org: &str,
    issue: &Value,
    organization_workspace_root: &str,
) -> Result<Value, IssueCoreReadError> {
    let comments = sqlx::query_scalar::<_, String>(
        "SELECT body FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid AND deleted_at IS NULL",
    )
    .bind(org)
    .bind(issue["id"].as_str().unwrap_or_default())
    .fetch_all(&mut **tx)
    .await?;

    let mut mentioned_ids = Vec::new();
    let mut seen = HashSet::new();
    for source in std::iter::once(issue["title"].as_str().unwrap_or_default())
        .chain(std::iter::once(
            issue["description"].as_str().unwrap_or_default(),
        ))
        .chain(comments.iter().map(String::as_str))
    {
        for id in extract_project_mention_ids(source) {
            if crate::project_reads::is_project_uuid_like(&id) && seen.insert(id.clone()) {
                mentioned_ids.push(id);
            }
        }
    }
    if mentioned_ids.is_empty() {
        return Ok(json!([]));
    }

    let same_org_ids: HashSet<String> = sqlx::query_scalar(
        "SELECT id::text FROM projects WHERE org_id=$1::uuid AND id::text=ANY($2::text[])",
    )
    .bind(org)
    .bind(&mentioned_ids)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .collect();

    let mut projects = Vec::new();
    for project_id in mentioned_ids {
        if !same_org_ids.contains(&project_id) {
            continue;
        }
        let values = read_projects_in_snapshot(
            tx,
            org,
            Some(&project_id),
            false,
            organization_workspace_root,
        )
        .await?;
        projects.push(values);
    }
    Ok(Value::Array(projects))
}

fn extract_project_mention_ids(markdown: &str) -> Vec<String> {
    let source = strip_markdown_code(markdown);
    let mut seen = HashSet::new();
    project_mention_link_regex()
        .captures_iter(&source)
        .filter_map(|capture| {
            let url = Url::parse(capture.get(1)?.as_str()).ok()?;
            if url.scheme() != "project" {
                return None;
            }
            let mut id = url.host_str().unwrap_or_default().to_owned();
            id.push_str(url.path());
            let id = id.trim_start_matches('/').trim().to_owned();
            (!id.is_empty() && seen.insert(id.clone())).then_some(id)
        })
        .collect()
}

fn strip_markdown_code(markdown: &str) -> String {
    static FENCED_CODE: OnceLock<Regex> = OnceLock::new();
    static INLINE_CODE: OnceLock<Regex> = OnceLock::new();
    let fenced = FENCED_CODE
        .get_or_init(|| Regex::new(r"(?s)```.*?```").expect("valid fenced Markdown code pattern"));
    let inline = INLINE_CODE
        .get_or_init(|| Regex::new(r"`[^`\n]*`").expect("valid inline Markdown code pattern"));
    inline
        .replace_all(&fenced.replace_all(markdown, ""), "")
        .into_owned()
}

fn project_mention_link_regex() -> &'static Regex {
    static PROJECT_MENTION_LINK: OnceLock<Regex> = OnceLock::new();
    PROJECT_MENTION_LINK.get_or_init(|| {
        Regex::new(r"(?i)\[[^\]]*]\((project://[^)\s]+)\)")
            .expect("valid project mention link pattern")
    })
}

fn camelize_keys(value: &mut Value) {
    match value {
        Value::Object(object) => {
            let old = std::mem::take(object);
            for (key, mut value) in old {
                camelize_keys(&mut value);
                let mut next = String::new();
                let mut upper = false;
                for character in key.chars() {
                    if character == '_' {
                        upper = true;
                    } else if upper {
                        next.extend(character.to_uppercase());
                        upper = false;
                    } else {
                        next.push(character);
                    }
                }
                object.insert(next, value);
            }
        }
        Value::Array(values) => values.iter_mut().for_each(camelize_keys),
        _ => {}
    }
}

fn map_reference_error(error: crate::issue_core_writes::IssueCoreWriteError) -> IssueCoreReadError {
    match error {
        crate::issue_core_writes::IssueCoreWriteError::Http(status, message) => {
            IssueCoreReadError::Http(status, message)
        }
        crate::issue_core_writes::IssueCoreWriteError::Database(error) => {
            IssueCoreReadError::Database(error)
        }
        crate::issue_core_writes::IssueCoreWriteError::Json(error) => {
            IssueCoreReadError::Json(error)
        }
        crate::issue_core_writes::IssueCoreWriteError::Store(error) => {
            IssueCoreReadError::Store(error)
        }
    }
}

fn split_csv(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn project_error(error: crate::issue_checkout::IssueCheckoutError) -> IssueCoreReadError {
    match error {
        crate::issue_checkout::IssueCheckoutError::Database(error) => {
            IssueCoreReadError::Database(error)
        }
        crate::issue_checkout::IssueCheckoutError::Json(error) => IssueCoreReadError::Json(error),
        crate::issue_checkout::IssueCheckoutError::Http(_, _, _) => StoreError::InvalidInput.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{extract_project_mention_ids, search_snippet};

    #[test]
    fn unicode_case_mapping_keeps_search_snippet_anchored_to_match() {
        let text = format!("{} target {}", "İ".repeat(100), "z".repeat(100));

        let snippet = search_snippet(&text, "target");

        assert!(snippet.contains("target"));
        assert!(snippet.starts_with('…'));
    }

    #[test]
    fn project_mentions_keep_unique_links_outside_markdown_code() {
        let first = "018f2ac0-6a3b-4c4d-8e9f-0123456789ab";
        let second = "018f2ac0-6a3b-4c4d-8e9f-1123456789ab";
        let markdown = format!(
            "[@First](project://{first}) `[@Hidden](project://{second})`\n```md\n[@Also Hidden](project://{second})\n```\n[@Again](project://{first})"
        );

        assert_eq!(extract_project_mention_ids(&markdown), vec![first]);
    }
}
