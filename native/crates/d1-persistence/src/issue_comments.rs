//! Organization-scoped public Issue comment reads and writes.

use crate::{
    StoreError,
    activity::{
        ActivityActor, ActivityOptions, ActivityWrite, redact_current_user_text,
        write_activity_options,
    },
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    goal_writes::lock_organization,
    issue_checkout::{IssueWakeupActor, IssueWakeupIntent, enqueue_issue_core_wakeup},
};
use regex_lite::Regex;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

type Tx<'a> = Transaction<'a, Postgres>;
const MAX_COMMENT_PAGE_LIMIT: i64 = 500;

#[derive(Debug, thiserror::Error)]
pub enum IssueCommentError {
    #[error("{1}")]
    Http(u16, String),
    #[error("{1}")]
    HttpDetails(u16, String, Value),
    #[error("{1}")]
    OwnershipRejected(u16, String, String),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

type Result<T> = std::result::Result<T, IssueCommentError>;

#[derive(Clone, Copy)]
pub struct IssueCommentActor<'a> {
    pub kind: &'a str,
    pub id: &'a str,
    pub agent_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IssueCommentWrite {
    Create,
    Update,
    Delete,
}

#[derive(Clone, Debug, Default)]
struct CommentControl {
    interrupt: bool,
    steer_expected_run_id: Option<String>,
}

#[derive(Clone, Debug)]
struct ActiveCommentRun {
    id: String,
    agent_id: String,
}

/// Resolve the organization before public identity revalidation. The caller
/// uses the returned scope to construct the same native authorizer used by the
/// other Issue handlers; a missing Issue remains a 404 as in the Node route.
pub async fn organization_for_issue(pool: &PgPool, issue_id: &str) -> Result<Option<String>> {
    let Ok(issue_id) = Uuid::parse_str(issue_id) else {
        return Ok(None);
    };
    Ok(
        sqlx::query_scalar::<_, String>("SELECT org_id::text FROM issues WHERE id=$1::uuid")
            .bind(issue_id.to_string())
            .fetch_optional(pool)
            .await?,
    )
}

pub async fn read_issue_comments_with_native_auth(
    pool: &PgPool,
    org_id: &str,
    issue_id: &str,
    after_comment_id: Option<&str>,
    order: &str,
    limit: Option<i64>,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<Value> {
    let org = canonical_uuid(org_id)?;
    let issue = canonical_uuid(issue_id)?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    revalidate(&mut tx, &org, authorizer).await?;
    ensure_issue(&mut tx, &org, &issue).await?;

    let order = if order.trim().eq_ignore_ascii_case("asc") {
        "asc"
    } else {
        "desc"
    };
    let cursor = if let Some(cursor) = after_comment_id.map(str::trim).filter(|s| !s.is_empty()) {
        let resolved = if Uuid::parse_str(cursor).is_ok() {
            Some(cursor.to_owned())
        } else {
            resolve_comment_reference(&mut tx, &org, &issue, cursor).await?
        };
        if let Some(resolved) = resolved {
            sqlx::query_as::<_, (String, String)>(
                "SELECT id::text, created_at::text FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid AND id=$3::uuid AND deleted_at IS NULL",
            )
            .bind(&org)
            .bind(&issue)
            .bind(resolved)
            .fetch_optional(&mut *tx)
            .await?
        } else {
            return Err(http(404, "Comment not found"));
        }
    } else {
        None
    };
    if after_comment_id.is_some_and(|value| !value.trim().is_empty()) && cursor.is_none() {
        return Err(http(404, "Comment not found"));
    }
    let censor_username = censor_username(&mut tx).await?;
    let rows = if let Some((cursor_id, cursor_created_at)) = cursor {
        let direction = if order == "asc" { ">" } else { "<" };
        let query = format!(
            "SELECT {COMMENT_JSON} FROM issue_comments c WHERE c.org_id=$1::uuid AND c.issue_id=$2::uuid AND c.deleted_at IS NULL AND (c.created_at,c.id) {direction} ($3::timestamptz,$4::uuid) ORDER BY c.created_at {order},c.id {order}"
        );
        if let Some(limit) = valid_limit(limit) {
            sqlx::query_scalar::<_, String>(&format!("{query} LIMIT $5"))
                .bind(&org)
                .bind(&issue)
                .bind(cursor_created_at)
                .bind(cursor_id)
                .bind(limit)
                .fetch_all(&mut *tx)
                .await?
        } else {
            sqlx::query_scalar::<_, String>(&query)
                .bind(&org)
                .bind(&issue)
                .bind(cursor_created_at)
                .bind(cursor_id)
                .fetch_all(&mut *tx)
                .await?
        }
    } else {
        let query = format!(
            "SELECT {COMMENT_JSON} FROM issue_comments c WHERE c.org_id=$1::uuid AND c.issue_id=$2::uuid AND c.deleted_at IS NULL ORDER BY c.created_at {order},c.id {order}"
        );
        if let Some(limit) = valid_limit(limit) {
            sqlx::query_scalar::<_, String>(&format!("{query} LIMIT $3"))
                .bind(&org)
                .bind(&issue)
                .bind(limit)
                .fetch_all(&mut *tx)
                .await?
        } else {
            sqlx::query_scalar::<_, String>(&query)
                .bind(&org)
                .bind(&issue)
                .fetch_all(&mut *tx)
                .await?
        }
    };
    tx.commit().await?;
    rows.into_iter()
        .map(|raw| serialize_comment(&raw, censor_username))
        .collect::<Result<Vec<_>>>()
        .map(Value::Array)
}

pub async fn read_issue_comment_with_native_auth(
    pool: &PgPool,
    org_id: &str,
    issue_id: &str,
    comment_ref: &str,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<Value> {
    let org = canonical_uuid(org_id)?;
    let issue = canonical_uuid(issue_id)?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    revalidate(&mut tx, &org, authorizer).await?;
    ensure_issue(&mut tx, &org, &issue).await?;
    let id = resolve_comment_reference(&mut tx, &org, &issue, comment_ref)
        .await?
        .ok_or_else(|| http(404, "Issue comment not found"))?;
    let raw = sqlx::query_scalar::<_, String>(
        &format!("SELECT {COMMENT_JSON} FROM issue_comments c WHERE c.org_id=$1::uuid AND c.issue_id=$2::uuid AND c.id=$3::uuid"),
    )
    .bind(&org)
    .bind(&issue)
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| http(404, "Comment not found"))?;
    let censor_username = censor_username(&mut tx).await?;
    tx.commit().await?;
    serialize_comment(&raw, censor_username)
}

pub async fn apply_issue_comment_write_with_native_auth(
    pool: &PgPool,
    org_id: &str,
    issue_id: &str,
    comment_ref: Option<&str>,
    operation: IssueCommentWrite,
    actor: IssueCommentActor<'_>,
    input: &Value,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<Value> {
    let org = canonical_uuid(org_id)?;
    let issue = canonical_uuid(issue_id)?;
    let control = if operation == IssueCommentWrite::Create {
        parse_comment_control(input)?
    } else {
        CommentControl::default()
    };
    if operation == IssueCommentWrite::Create
        && input.get("reopen").and_then(Value::as_bool) == Some(true)
        && let Some(comment) =
            reopen_with_comment(pool, &org, &issue, actor, input, &control, authorizer).await?
    {
        return Ok(comment);
    }
    if !matches!(actor.kind, "user" | "agent") || actor.id.trim().is_empty() {
        return Err(http(401, "Unauthorized"));
    }
    if actor.kind == "agent" && actor.agent_id != Some(actor.id) {
        return Err(http(401, "Unauthorized"));
    }
    let mut tx = pool.begin().await?;
    let mut pending_mention_ids = Vec::new();
    let mut pending_mention_mutation = None;
    let mut pending_steer = None;
    let mut interrupted_run_id = None;
    let result = async {
        lock_organization(&mut tx, &org).await?;
        revalidate(&mut tx, &org, authorizer).await?;
        let issue_row = sqlx::query(
            "SELECT id::text,org_id::text,title,description,status,priority,assignee_agent_id::text,reviewer_agent_id::text,checkout_run_id::text,execution_run_id::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
        )
        .bind(&org)
        .bind(&issue)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| http(404, "Issue not found"))?;
        let resolved_ref = match comment_ref {
            Some(value) => Some(
                resolve_comment_reference(&mut tx, &org, &issue, value)
                    .await?
                    .ok_or_else(|| http(404, "Issue comment not found"))?,
            ),
            None => None,
        };
        let censor_username = censor_username(&mut tx).await?;
        let now = sqlx::query_scalar::<_, String>("SELECT clock_timestamp()::text")
            .fetch_one(&mut *tx)
            .await?;
        let comment = match operation {
            IssueCommentWrite::Create => {
                let body = input
                    .get("body")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| http(422, "Invalid comment body"))?;
                validate_agent_comment_access(&mut tx, &org, &issue, &issue_row, actor).await?;
                if control.interrupt || control.steer_expected_run_id.is_some() {
                    if actor.kind != "user" {
                        return Err(http(
                            403,
                            "Only board users can interrupt active runs from issue comments",
                        ));
                    }
                    let active = active_issue_run_for_comment(
                        &mut tx,
                        &org,
                        &issue,
                        &issue_row,
                        control.steer_expected_run_id.as_deref(),
                    )
                    .await?;
                    if let Some(steer_run_id) = control.steer_expected_run_id.as_deref() {
                        let Some(active) = active else {
                            return Err(http(409, "The active issue run changed before Steer was accepted"));
                        };
                        if active.id != steer_run_id {
                            return Err(http(409, "The active issue run changed before Steer was accepted"));
                        }
                        pending_steer = Some(active);
                    } else if control.interrupt
                        && let Some(active) = active
                        && request_comment_run_cancellation(
                            &mut tx,
                            &org,
                            &issue,
                            &active,
                            actor,
                            "issue_comment_interrupt",
                            None,
                        )
                        .await?
                    {
                        interrupted_run_id = Some(active.id);
                    }
                }
                let body = canonicalize_agent_wake_mentions(&mut tx, &org, body).await?;
                let body = if censor_username {
                    redact_current_user_text(&body)
                } else {
                    body
                };
                let raw = sqlx::query_scalar::<_, String>(
                    "INSERT INTO issue_comments (org_id,issue_id,author_agent_id,author_user_id,body) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5) RETURNING jsonb_build_object('id',id::text,'orgId',org_id::text,'issueId',issue_id::text,'authorAgentId',author_agent_id::text,'authorUserId',author_user_id,'body',body,'deletedAt',deleted_at,'deletedByUserId',deleted_by_user_id,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))::text",
                )
                .bind(&org)
                .bind(&issue)
                .bind(actor.agent_id)
                .bind((actor.kind == "user").then_some(actor.id))
                .bind(body)
                .fetch_one(&mut *tx)
                .await?;
                sqlx::query("UPDATE issues SET updated_at=$3::timestamptz WHERE org_id=$1::uuid AND id=$2::uuid")
                    .bind(&org)
                    .bind(&issue)
                    .bind(&now)
                    .execute(&mut *tx)
                    .await?;
                let comment = serialize_comment(&raw, censor_username)?;
                let audit = activity_actor(actor);
                let details = json!({
                    "commentId": comment["id"],
                    "bodySnippet": body_snippet(comment["body"].as_str().unwrap_or_default()),
                    "identifier": sqlx::query_scalar::<_, Option<String>>("SELECT identifier FROM issues WHERE org_id=$1::uuid AND id=$2::uuid")
                        .bind(&org).bind(&issue).fetch_one(&mut *tx).await?,
                    "issueTitle": issue_row.try_get::<String,_>("title")?,
                });
                let mut details = details;
                if let Some(run_id) = interrupted_run_id.as_deref() {
                    details["interruptedRunId"] = Value::String(run_id.to_owned());
                }
                if let Some(run) = pending_steer.as_ref() {
                    details["steerRunId"] = Value::String(run.id.clone());
                    details["steerDisposition"] = Value::String("interrupt_continue".to_owned());
                }
                write_activity_options(
                    &mut tx,
                    ActivityWrite {
                        org: &org,
                        audit: &audit,
                        action: "issue.comment_added",
                        entity_type: "issue",
                        entity_id: &issue,
                        details: Some(&details),
                        options: ActivityOptions {
                            agent_id: actor.agent_id,
                            effects: None,
                            bind_run: true,
                        },
                    },
                )
                .await?;
                pending_mention_ids = mentioned_agent_ids(
                    &mut tx,
                    &org,
                    comment["body"].as_str().unwrap_or_default(),
                )
                .await?;
                pending_mention_mutation = Some("comment");
                comment
            }
            IssueCommentWrite::Update => {
                if actor.kind != "user" {
                    return Err(http(403, "Board access required"));
                }
                let body = input
                    .get("body")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| http(422, "Invalid comment body"))?;
                let current = sqlx::query(
                    "SELECT author_agent_id::text,author_user_id,body,deleted_at FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid AND id=$3::uuid FOR UPDATE",
                )
                .bind(&org)
                .bind(&issue)
                .bind(resolved_ref.as_deref().unwrap_or_default())
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| http(404, "Comment not found"))?;
                if current.try_get::<Option<String>, _>("deleted_at")?.is_some() {
                    return Err(http(403, "Deleted comments cannot be modified"));
                }
                if current.try_get::<Option<String>, _>("author_agent_id")?.is_some()
                    || current.try_get::<Option<String>, _>("author_user_id")?.as_deref()
                        != Some(actor.id)
                {
                    return Err(http(403, "Only the comment author can modify this comment"));
                }
                let canonical_body = canonicalize_agent_wake_mentions(&mut tx, &org, body).await?;
                let previous_body: String = current.try_get("body")?;
                let previous_mentions = mentioned_agent_ids(&previous_body)?;
                let updated_mentions = mentioned_agent_ids(&canonical_body)?;
                let newly_mentioned = updated_mentions
                    .into_iter()
                    .filter(|agent_id| !previous_mentions.contains(agent_id))
                    .collect::<Vec<_>>();
                let body = if censor_username {
                    redact_current_user_text(&canonical_body)
                } else {
                    canonical_body
                };
                let raw = sqlx::query_scalar::<_, String>(
                    "UPDATE issue_comments SET body=$4,updated_at=$5::timestamptz WHERE org_id=$1::uuid AND issue_id=$2::uuid AND id=$3::uuid AND deleted_at IS NULL RETURNING jsonb_build_object('id',id::text,'orgId',org_id::text,'issueId',issue_id::text,'authorAgentId',author_agent_id::text,'authorUserId',author_user_id,'body',body,'deletedAt',deleted_at,'deletedByUserId',deleted_by_user_id,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))::text",
                )
                .bind(&org)
                .bind(&issue)
                .bind(resolved_ref.as_deref().unwrap_or_default())
                .bind(body)
                .bind(&now)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| http(404, "Comment not found"))?;
                sqlx::query("UPDATE issues SET updated_at=$3::timestamptz WHERE org_id=$1::uuid AND id=$2::uuid")
                    .bind(&org).bind(&issue).bind(&now).execute(&mut *tx).await?;
                let comment = serialize_comment(&raw, censor_username)?;
                let details = json!({
                    "commentId": comment["id"],
                    "identifier": sqlx::query_scalar::<_, Option<String>>("SELECT identifier FROM issues WHERE org_id=$1::uuid AND id=$2::uuid")
                        .bind(&org).bind(&issue).fetch_one(&mut *tx).await?,
                    "issueTitle": issue_row.try_get::<String,_>("title")?,
                });
                let audit = activity_actor(actor);
                write_activity_options(
                    &mut tx,
                    ActivityWrite {
                        org: &org,
                        audit: &audit,
                        action: "issue.comment_updated",
                        entity_type: "issue",
                        entity_id: &issue,
                        details: Some(&details),
                        options: ActivityOptions { agent_id: None, effects: None, bind_run: true },
                    },
                )
                .await?;
                pending_mention_ids = newly_mentioned;
                pending_mention_mutation = Some("comment_edit");
                comment
            }
            IssueCommentWrite::Delete => {
                if actor.kind != "user" {
                    return Err(http(403, "Board access required"));
                }
                let current = sqlx::query(
                    "SELECT author_agent_id::text,author_user_id,deleted_at FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid AND id=$3::uuid FOR UPDATE",
                )
                .bind(&org)
                .bind(&issue)
                .bind(resolved_ref.as_deref().unwrap_or_default())
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| http(404, "Comment not found"))?;
                if current.try_get::<Option<String>, _>("deleted_at")?.is_some() {
                    return Err(http(404, "Comment not found"));
                }
                if current.try_get::<Option<String>, _>("author_agent_id")?.is_none()
                    && current.try_get::<Option<String>, _>("author_user_id")?.as_deref()
                        != Some(actor.id)
                {
                    return Err(http(403, "Only the comment author can delete this comment"));
                }
                let raw = sqlx::query_scalar::<_, String>(
                    "UPDATE issue_comments SET deleted_at=$4::timestamptz,deleted_by_user_id=$5,updated_at=$4::timestamptz WHERE org_id=$1::uuid AND issue_id=$2::uuid AND id=$3::uuid AND deleted_at IS NULL RETURNING jsonb_build_object('id',id::text,'orgId',org_id::text,'issueId',issue_id::text,'authorAgentId',author_agent_id::text,'authorUserId',author_user_id,'body',body,'deletedAt',deleted_at,'deletedByUserId',deleted_by_user_id,'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))::text",
                )
                .bind(&org)
                .bind(&issue)
                .bind(resolved_ref.as_deref().unwrap_or_default())
                .bind(&now)
                .bind(actor.id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| http(404, "Comment not found"))?;
                sqlx::query("UPDATE issues SET updated_at=$3::timestamptz WHERE org_id=$1::uuid AND id=$2::uuid")
                    .bind(&org).bind(&issue).bind(&now).execute(&mut *tx).await?;
                let comment = serialize_comment(&raw, censor_username)?;
                let details = json!({
                    "commentId": comment["id"],
                    "identifier": sqlx::query_scalar::<_, Option<String>>("SELECT identifier FROM issues WHERE org_id=$1::uuid AND id=$2::uuid")
                        .bind(&org).bind(&issue).fetch_one(&mut *tx).await?,
                    "issueTitle": issue_row.try_get::<String,_>("title")?,
                });
                let audit = activity_actor(actor);
                write_activity_options(
                    &mut tx,
                    ActivityWrite {
                        org: &org,
                        audit: &audit,
                        action: "issue.comment_deleted",
                        entity_type: "issue",
                        entity_id: &issue,
                        details: Some(&details),
                        options: ActivityOptions { agent_id: None, effects: None, bind_run: true },
                    },
                )
                .await?;
                comment
            }
        };
        Ok(comment)
    }
    .await;

    match result {
        Ok(comment) => {
            tx.commit().await?;
            if operation == IssueCommentWrite::Create
                && let Some(run_id) = actor.run_id
                && let Err(error) =
                    crate::issue_lifecycle_analytics::clear_comment_run_detached_warning(
                        pool, run_id,
                    )
                    .await
            {
                tracing::warn!(%error, run_id, issue_id = issue, "failed to clear detached warning after Issue comment");
            }
            if let Some(mutation) = pending_mention_mutation
                && !pending_mention_ids.is_empty()
                && pending_steer.is_none()
                && let Err(error) = enqueue_comment_mentions_after_commit(
                    pool,
                    &org,
                    &issue,
                    actor,
                    &comment,
                    mutation,
                    &pending_mention_ids,
                    authorizer,
                )
                .await
            {
                tracing::warn!(%error, org_id = org, issue_id = issue, "failed to enqueue Issue comment mention wakeups");
            }
            if let Some(steer) = pending_steer
                && let Err(error) = enqueue_comment_steer_after_commit(
                    pool,
                    &org,
                    &issue,
                    actor,
                    &comment,
                    &steer,
                    &pending_mention_ids,
                    authorizer,
                )
                .await
            {
                return Err(match error {
                    IssueCommentError::Http(status, message) if status == 409 => {
                        IssueCommentError::HttpDetails(status, message, comment)
                    }
                    IssueCommentError::HttpDetails(status, message, _) if status == 409 => {
                        IssueCommentError::HttpDetails(status, message, comment)
                    }
                    other => other,
                });
            }
            Ok(comment)
        }
        Err(error) => {
            if let IssueCommentError::OwnershipRejected(status, message, reason) = &error {
                record_comment_ownership_rejection(&mut tx, &org, &issue, actor, reason).await?;
                tx.commit().await?;
                return Err(http(*status, message));
            }
            if let Err(rollback_error) = tx.rollback().await {
                tracing::warn!(%rollback_error, org_id = org, "failed to roll back Issue comment mutation");
            }
            Err(error)
        }
    }
}

const COMMENT_JSON: &str = "jsonb_build_object('id',c.id::text,'orgId',c.org_id::text,'issueId',c.issue_id::text,'authorAgentId',c.author_agent_id::text,'authorUserId',c.author_user_id,'body',CASE WHEN c.deleted_at IS NULL THEN c.body ELSE '' END,'deletedAt',c.deleted_at,'deletedByUserId',c.deleted_by_user_id,'createdAt',to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'updatedAt',to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),'shortRef','cmt_'||substr(replace(c.id::text,'-',''),1,8))::text";

fn parse_comment_control(input: &Value) -> Result<CommentControl> {
    if input.get("reopen").is_some_and(|value| !value.is_boolean()) {
        return Err(http(422, "reopen must be a boolean"));
    }
    let interrupt = match input.get("interrupt") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(http(422, "interrupt must be a boolean")),
    };
    let steer_expected_run_id = match input.get("steer") {
        None => None,
        Some(Value::Object(steer)) => {
            let Some(run_id) = steer.get("expectedRunId").and_then(Value::as_str) else {
                return Err(http(422, "Invalid steer request"));
            };
            Some(
                Uuid::parse_str(run_id)
                    .map_err(|_| http(422, "Invalid steer request"))?
                    .to_string(),
            )
        }
        Some(_) => return Err(http(422, "Invalid steer request")),
    };
    Ok(CommentControl {
        interrupt,
        steer_expected_run_id,
    })
}

async fn active_issue_run_for_comment(
    tx: &mut Tx<'_>,
    org: &str,
    issue: &str,
    issue_row: &sqlx::postgres::PgRow,
    expected_run_id: Option<&str>,
) -> Result<Option<ActiveCommentRun>> {
    if let Some(expected_run_id) = expected_run_id {
        let active = sqlx::query_as::<_, (String, String)>(
            "SELECT r.id::text,r.agent_id::text FROM heartbeat_runs r
             WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.status='running'
               AND (r.id::text=(SELECT i.execution_run_id::text FROM issues i WHERE i.org_id=$1::uuid AND i.id=$3::uuid)
                    OR r.context_snapshot->>'issueId'=$3)",
        )
        .bind(org)
        .bind(expected_run_id)
        .bind(issue)
        .fetch_optional(&mut **tx)
        .await?;
        return active
            .map(|(id, agent_id)| Some(ActiveCommentRun { id, agent_id }))
            .ok_or_else(|| {
                http(
                    409,
                    "The active issue run changed before Steer was accepted",
                )
            });
    }
    let execution_run_id = issue_row.try_get::<Option<String>, _>("execution_run_id")?;
    if let Some(run_id) = execution_run_id {
        if let Some((id, agent_id)) = sqlx::query_as::<_, (String, String)>(
            "SELECT id::text,agent_id::text FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid AND status='running'",
        )
        .bind(org)
        .bind(run_id)
        .fetch_optional(&mut **tx)
        .await?
        {
            return Ok(Some(ActiveCommentRun { id, agent_id }));
        }
    }
    let assignee = issue_row.try_get::<Option<String>, _>("assignee_agent_id")?;
    let Some(assignee) = assignee else {
        return Ok(None);
    };
    Ok(sqlx::query_as::<_, (String, String)>(
        "SELECT id::text,agent_id::text FROM heartbeat_runs
         WHERE org_id=$1::uuid AND agent_id=$2::uuid AND status='running'
           AND context_snapshot->>'issueId'=$3
         ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .bind(org)
    .bind(assignee)
    .bind(issue)
    .fetch_optional(&mut **tx)
    .await?
    .map(|(id, agent_id)| ActiveCommentRun { id, agent_id }))
}

async fn request_comment_run_cancellation(
    tx: &mut Tx<'_>,
    org: &str,
    issue: &str,
    run: &ActiveCommentRun,
    actor: IssueCommentActor<'_>,
    source: &str,
    comment_id: Option<&str>,
) -> Result<bool> {
    let authority = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT execution_authority,goal_id::text FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid AND status='running' FOR UPDATE",
    )
    .bind(org)
    .bind(&run.id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((execution_authority, goal_id)) = authority else {
        return Ok(false);
    };
    let requested = if execution_authority == "native_rust" && goal_id.is_some() {
        crate::goal_runs::request_cancel_in_transaction(
            tx,
            org,
            &run.id,
            "Cancelled by Issue comment interrupt",
        )
        .await
        .map_err(|error| match error {
            crate::goal_runs::GoalRunError::Database(error) => IssueCommentError::Database(error),
            _ => http(
                409,
                "The active issue run changed before interruption was accepted",
            ),
        })?
    } else {
        sqlx::query(
            "UPDATE heartbeat_runs SET error=CASE WHEN error_code='cancel_requested' THEN error ELSE $3 END,
               error_code='cancel_requested',updated_at=clock_timestamp()
             WHERE org_id=$1::uuid AND id=$2::uuid AND status='running'
             RETURNING id::text",
        )
        .bind(org)
        .bind(&run.id)
        .bind("Cancelled by Issue comment interrupt")
        .fetch_optional(&mut **tx)
        .await?
        .is_some()
    };
    if !requested {
        return Ok(false);
    }
    sqlx::query(
        "UPDATE agent_wakeup_requests SET status='cancelled',finished_at=clock_timestamp(),
           error='Cancelled by Issue comment interrupt',updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND run_id=$2::uuid AND execution_authority='legacy_ts'
           AND status IN ('queued','claimed')",
    )
    .bind(org)
    .bind(&run.id)
    .execute(&mut **tx)
    .await?;
    let mut details = json!({
        "agentId":run.agent_id,
        "source":source,
        "issueId":issue,
    });
    if let Some(comment_id) = comment_id {
        details["commentId"] = Value::String(comment_id.to_owned());
    }
    let audit = activity_actor(actor);
    write_activity_options(
        tx,
        ActivityWrite {
            org,
            audit: &audit,
            action: "heartbeat.cancelled",
            entity_type: "heartbeat_run",
            entity_id: &run.id,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: actor.agent_id,
                effects: None,
                bind_run: true,
            },
        },
    )
    .await?;
    Ok(true)
}

async fn validate_agent_comment_access(
    tx: &mut Tx<'_>,
    org: &str,
    issue: &str,
    issue_row: &sqlx::postgres::PgRow,
    actor: IssueCommentActor<'_>,
) -> Result<()> {
    if actor.kind != "agent" {
        return Ok(());
    }
    let agent_id = actor
        .agent_id
        .ok_or_else(|| http(403, "Agent authentication required"))?;
    let assignee = issue_row.try_get::<Option<String>, _>("assignee_agent_id")?;
    let reviewer = issue_row.try_get::<Option<String>, _>("reviewer_agent_id")?;
    let status: String = issue_row.try_get("status")?;
    let checkout_run: Option<String> = issue_row.try_get("checkout_run_id")?;
    let execution_run: Option<String> = issue_row.try_get("execution_run_id")?;
    let relationship =
        assignee.as_deref() == Some(agent_id) || reviewer.as_deref() == Some(agent_id);
    if !relationship && actor.run_id.is_none() {
        return Err(IssueCommentError::OwnershipRejected(
            401,
            "Agent run id required".to_owned(),
            "missing_agent_run_id".to_owned(),
        ));
    }
    let checkout_requires_run = status == "in_progress"
        && assignee.as_deref() == Some(agent_id)
        && checkout_run.is_some()
        && checkout_run.as_deref() != actor.run_id;
    if let Some(run_id) = actor.run_id {
        let Ok(run_uuid) = Uuid::parse_str(run_id) else {
            if checkout_requires_run {
                return Err(IssueCommentError::OwnershipRejected(
                    403,
                    "Run context is not valid for this issue".to_owned(),
                    "invalid_agent_run_id".to_owned(),
                ));
            }
            return Err(http(403, "Run context is not valid for this issue"));
        };
        let valid = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND r.agent_id=$3::uuid AND (r.context_snapshot->>'issueId'=$4 OR $5=$2 OR $6=$2))",
        )
        .bind(org)
        .bind(run_uuid.to_string())
        .bind(agent_id)
        .bind(issue)
        .bind(checkout_run.as_deref().unwrap_or_default())
        .bind(execution_run.as_deref().unwrap_or_default())
        .fetch_one(&mut **tx)
        .await?;
        if !valid {
            return Err(http(403, "Run context is not valid for this issue"));
        }
    }
    if status == "in_progress"
        && assignee.as_deref() == Some(agent_id)
        && let Some(checkout_run_id) = checkout_run.as_deref()
        && checkout_run_id != actor.run_id.unwrap_or_default()
    {
        let Some(run_id) = actor.run_id else {
            return Err(IssueCommentError::OwnershipRejected(
                401,
                "Agent run id required".to_owned(),
                "missing_agent_run_id".to_owned(),
            ));
        };
        if Uuid::parse_str(run_id).is_err() {
            return Err(IssueCommentError::OwnershipRejected(
                403,
                "Run context is not valid for this issue".to_owned(),
                "invalid_agent_run_id".to_owned(),
            ));
        }
        let stale = crate::issue_checkout::stale_run(tx, checkout_run_id)
            .await
            .map_err(map_issue_checkout_error)?;
        if !stale {
            return Err(IssueCommentError::OwnershipRejected(
                409,
                "Issue run ownership conflict".to_owned(),
                "checkout_owner_conflict".to_owned(),
            ));
        }
        let adopted = sqlx::query_scalar::<_, String>(
            "UPDATE issues SET checkout_run_id=$4::uuid,execution_run_id=$4::uuid,
               execution_locked_at=clock_timestamp(),updated_at=clock_timestamp()
             WHERE org_id=$1::uuid AND id=$2::uuid AND status='in_progress'
               AND assignee_agent_id=$3::uuid AND checkout_run_id=$5::uuid
             RETURNING id::text",
        )
        .bind(org)
        .bind(issue)
        .bind(agent_id)
        .bind(run_id)
        .bind(checkout_run_id)
        .fetch_optional(&mut **tx)
        .await?;
        if adopted.is_none() {
            return Err(IssueCommentError::OwnershipRejected(
                409,
                "Issue run ownership conflict".to_owned(),
                "checkout_owner_conflict".to_owned(),
            ));
        }
        let audit = activity_actor(actor);
        let details = json!({
            "previousCheckoutRunId":checkout_run_id,
            "checkoutRunId":run_id,
            "reason":"stale_checkout_run",
        });
        write_activity_options(
            tx,
            ActivityWrite {
                org,
                audit: &audit,
                action: "issue.checkout_lock_adopted",
                entity_type: "issue",
                entity_id: issue,
                details: Some(&details),
                options: ActivityOptions {
                    agent_id: Some(agent_id),
                    effects: None,
                    bind_run: true,
                },
            },
        )
        .await?;
    }
    Ok(())
}

async fn resolve_comment_reference(
    tx: &mut Tx<'_>,
    org: &str,
    issue: &str,
    reference: &str,
) -> Result<Option<String>> {
    let reference = reference.trim();
    if let Ok(id) = Uuid::parse_str(reference) {
        return Ok(sqlx::query_scalar::<_, String>(
            "SELECT id::text FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid AND id=$3::uuid AND deleted_at IS NULL",
        )
        .bind(org)
        .bind(issue)
        .bind(id.to_string())
        .fetch_optional(&mut **tx)
        .await?);
    }
    let Some(prefix) = short_comment_prefix(reference) else {
        return Ok(Some(reference.to_owned()));
    };
    let pattern = format!("{prefix}%");
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT id::text FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid AND deleted_at IS NULL AND replace(id::text,'-','') LIKE $3 ORDER BY id LIMIT 2",
    )
    .bind(org)
    .bind(issue)
    .bind(pattern)
    .fetch_all(&mut **tx)
    .await?;
    match rows.as_slice() {
        [] => Ok(None),
        [id] => Ok(Some(id.clone())),
        _ => Err(http(
            409,
            "Issue comment short ref is ambiguous for this issue. Use the comment ID.",
        )),
    }
}

fn short_comment_prefix(reference: &str) -> Option<String> {
    let (kind, prefix) = reference.trim().split_once('_')?;
    if !kind.eq_ignore_ascii_case("cmt")
        || !(8..=32).contains(&prefix.len())
        || !prefix.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some(prefix.to_ascii_lowercase())
}

async fn ensure_issue(tx: &mut Tx<'_>, org: &str, issue: &str) -> Result<()> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM issues WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(org)
    .bind(issue)
    .fetch_one(&mut **tx)
    .await?;
    if exists {
        Ok(())
    } else {
        Err(http(404, "Issue not found"))
    }
}

async fn revalidate(
    tx: &mut Tx<'_>,
    org: &str,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<()> {
    match authorizer.revalidate(tx, org).await? {
        NativeAgentAccess::Authorized => Ok(()),
        NativeAgentAccess::Unauthorized => Err(StoreError::PublicIdentityUnauthorized.into()),
        NativeAgentAccess::Forbidden => Err(StoreError::PublicIdentityForbidden.into()),
    }
}

async fn censor_username(tx: &mut Tx<'_>) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE((SELECT CASE WHEN general->>'censorUsernameInLogs'='true' THEN true ELSE false END FROM instance_settings WHERE singleton_key='default'),false)",
    )
    .fetch_one(&mut **tx)
    .await?)
}

async fn query_censor_username(pool: &PgPool) -> Result<bool> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let value = censor_username(&mut tx).await?;
    tx.commit().await?;
    Ok(value)
}

fn serialize_comment(raw: &str, censor_username: bool) -> Result<Value> {
    let mut comment = serde_json::from_str::<Value>(raw)?;
    if !comment.get("deletedAt").is_none_or(Value::is_null) {
        comment["body"] = Value::String(String::new());
    }
    if censor_username && let Some(body) = comment.get("body").and_then(Value::as_str) {
        comment["body"] = Value::String(redact_current_user_text(body));
    }
    if let Some(id) = comment.get("id").and_then(Value::as_str) {
        comment["shortRef"] = Value::String(format!(
            "cmt_{}",
            id.replace('-', "").chars().take(8).collect::<String>()
        ));
    }
    Ok(comment)
}

async fn canonicalize_agent_wake_mentions(
    tx: &mut Tx<'_>,
    org: &str,
    body: &str,
) -> Result<String> {
    let short_refs = agent_wake_references(body)
        .into_iter()
        .filter_map(|reference| short_agent_prefix(&reference).map(|prefix| (reference, prefix)))
        .collect::<Vec<_>>();
    if short_refs.is_empty() {
        return Ok(body.to_owned());
    }
    let agent_ids = sqlx::query_scalar::<_, String>(
        "SELECT id::text FROM agents WHERE org_id=$1::uuid ORDER BY id",
    )
    .bind(org)
    .fetch_all(&mut **tx)
    .await?;
    let mut resolved = BTreeMap::new();
    for (reference, prefix) in short_refs {
        let matches = agent_ids
            .iter()
            .filter(|id| {
                id.replace('-', "")
                    .to_ascii_lowercase()
                    .starts_with(&prefix)
            })
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [id] => {
                resolved.insert(reference, (*id).clone());
            }
            [] => return Err(http(404, "Agent short ref not found in this organization")),
            _ => {
                return Err(http(
                    409,
                    "Agent short ref is ambiguous in this organization. Use the agent ID.",
                ));
            }
        }
    }
    Ok(replace_outside_markdown_code(body, |segment| {
        let links = Regex::new(r"(?i)\[[^\]]*\]\((agent://[^)\s]+)\)")
            .expect("valid agent mention link pattern");
        links
            .replace_all(segment, |captures: &regex_lite::Captures<'_>| {
                let link = captures.get(0).expect("full match").as_str();
                let href = captures.get(1).expect("agent href").as_str();
                let Some(reference) = parse_wake_agent_reference(href) else {
                    return link.to_owned();
                };
                let Some(id) = resolved.get(&reference) else {
                    return link.to_owned();
                };
                link.replace(href, &format!("agent://{id}?intent=wake"))
            })
            .into_owned()
    }))
}

async fn mentioned_agent_ids(tx: &mut Tx<'_>, org: &str, body: &str) -> Result<Vec<String>> {
    let references = agent_wake_references(body);
    if references.is_empty() {
        return Ok(Vec::new());
    }
    let agent_ids = sqlx::query_scalar::<_, String>(
        "SELECT id::text FROM agents WHERE org_id=$1::uuid ORDER BY id",
    )
    .bind(org)
    .fetch_all(&mut **tx)
    .await?;
    let mut ids = BTreeSet::new();
    for reference in references {
        if let Ok(id) = Uuid::parse_str(&reference) {
            let id = id.to_string();
            if agent_ids.iter().any(|candidate| candidate == &id) {
                ids.insert(id);
            }
            continue;
        }
        let Some(prefix) = short_agent_prefix(&reference) else {
            continue;
        };
        let matches = agent_ids
            .iter()
            .filter(|id| {
                id.replace('-', "")
                    .to_ascii_lowercase()
                    .starts_with(&prefix)
            })
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [id] => {
                ids.insert((*id).clone());
            }
            [] => {}
            _ => {
                return Err(http(
                    409,
                    "Agent short ref is ambiguous in this organization. Use the agent ID.",
                ));
            }
        }
    }
    Ok(ids.into_iter().collect())
}

fn agent_wake_references(body: &str) -> Vec<String> {
    let code = Regex::new(r"(?s)```.*?```|`[^`\n]*`").expect("valid Markdown code pattern");
    let body = code.replace_all(body, "");
    let links = Regex::new(r"(?i)\[[^\]]*\]\((agent://[^)\s]+)\)")
        .expect("valid agent mention link pattern");
    let mut references = BTreeSet::new();
    for captures in links.captures_iter(&body) {
        if let Some(href) = captures
            .get(1)
            .and_then(|value| value.as_str().parse::<url::Url>().ok())
            && href.scheme() == "agent"
            && href
                .query_pairs()
                .any(|(key, value)| key == "intent" && value == "wake")
        {
            let reference = format!(
                "{}{}",
                href.host_str().unwrap_or_default(),
                href.path().trim_start_matches('/')
            )
            .trim()
            .to_owned();
            if !reference.is_empty() {
                references.insert(reference);
            }
        }
    }
    references.into_iter().collect()
}

fn parse_wake_agent_reference(href: &str) -> Option<String> {
    let url = href.parse::<url::Url>().ok()?;
    if url.scheme() != "agent"
        || !url
            .query_pairs()
            .any(|(key, value)| key == "intent" && value == "wake")
    {
        return None;
    }
    let reference = format!(
        "{}{}",
        url.host_str().unwrap_or_default(),
        url.path().trim_start_matches('/')
    );
    (!reference.is_empty()).then_some(reference)
}

fn short_agent_prefix(reference: &str) -> Option<String> {
    let (kind, prefix) = reference.trim().split_once('_')?;
    if !kind.eq_ignore_ascii_case("agt")
        || !(8..=32).contains(&prefix.len())
        || !prefix.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some(prefix.to_ascii_lowercase())
}

fn replace_outside_markdown_code(markdown: &str, replace: impl Fn(&str) -> String) -> String {
    let protected = Regex::new(r"(?s)```.*?```|`[^`\n]*`").expect("valid Markdown code pattern");
    let mut output = String::with_capacity(markdown.len());
    let mut cursor = 0;
    for found in protected.find_iter(markdown) {
        output.push_str(&replace(&markdown[cursor..found.start()]));
        output.push_str(found.as_str());
        cursor = found.end();
    }
    output.push_str(&replace(&markdown[cursor..]));
    output
}

async fn enqueue_comment_mentions(
    tx: &mut Tx<'_>,
    org: &str,
    issue: &str,
    actor: IssueCommentActor<'_>,
    issue_row: &sqlx::postgres::PgRow,
    comment: &Value,
    mutation: &str,
    selected_agent_ids: Option<&[String]>,
) -> Result<()> {
    let agent_ids = if let Some(selected) = selected_agent_ids {
        selected.to_vec()
    } else {
        mentioned_agent_ids(tx, org, comment["body"].as_str().unwrap_or_default()).await?
    };
    let assignee = issue_row.try_get::<Option<String>, _>("assignee_agent_id")?;
    let reviewer = issue_row.try_get::<Option<String>, _>("reviewer_agent_id")?;
    let requested_by = IssueWakeupActor {
        kind: actor.kind,
        id: actor.id,
    };
    for agent_id in agent_ids {
        if actor.kind == "agent" && actor.agent_id == Some(agent_id.as_str()) {
            continue;
        }
        let relationship = if assignee.as_deref() == Some(agent_id.as_str()) {
            "assignee"
        } else if reviewer.as_deref() == Some(agent_id.as_str()) {
            "reviewer"
        } else {
            // Node's comment wake path records the relationship in its
            // context, then the heartbeat admission returns `bypass` for a
            // collaborator unless this is an explicitly fenced Steer.
            continue;
        };
        let comment_context = json!({
            "id": comment["id"],
            "body": comment["body"],
            "authorAgentId": comment["authorAgentId"],
            "authorUserId": comment["authorUserId"],
        });
        let wakeup = IssueWakeupIntent {
            agent_id,
            source: "automation",
            reason: "issue_comment_mentioned",
            mutation: mutation.to_owned(),
            context_source: "comment.mention",
            wake_source: "comment.mention",
            role: None,
            comment: Some(comment_context),
            relationship: Some(relationship),
            expected_issue_execution_run_id: None,
            payload_extra: None,
            context_extra: None,
        };
        enqueue_issue_core_wakeup(tx, org, issue, &wakeup, &requested_by)
            .await
            .map_err(map_issue_checkout_error)?;
    }
    Ok(())
}

async fn enqueue_comment_mentions_after_commit(
    pool: &PgPool,
    org: &str,
    issue: &str,
    actor: IssueCommentActor<'_>,
    comment: &Value,
    mutation: &str,
    selected_agent_ids: &[String],
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let result = async {
        lock_organization(&mut tx, org).await?;
        revalidate(&mut tx, org, authorizer).await?;
        let issue_row = sqlx::query(
            "SELECT assignee_agent_id::text,reviewer_agent_id::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
        )
        .bind(org)
        .bind(issue)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| http(404, "Issue not found"))?;
        enqueue_comment_mentions(
            &mut tx,
            org,
            issue,
            actor,
            &issue_row,
            comment,
            mutation,
            Some(selected_agent_ids),
        )
        .await?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            tx.commit().await?;
            Ok(())
        }
        Err(error) => {
            if let IssueCommentError::OwnershipRejected(status, message, reason) = &error {
                record_comment_ownership_rejection(&mut tx, org, issue, actor, reason).await?;
                tx.commit().await?;
                return Err(http(*status, message));
            }
            if let Err(rollback_error) = tx.rollback().await {
                tracing::warn!(%rollback_error, org_id = org, "failed to roll back Issue comment mention admission");
            }
            Err(error)
        }
    }
}

async fn enqueue_comment_steer_after_commit(
    pool: &PgPool,
    org: &str,
    issue: &str,
    actor: IssueCommentActor<'_>,
    comment: &Value,
    steer: &ActiveCommentRun,
    mentioned: &[String],
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let result = async {
        lock_organization(&mut tx, org).await?;
        revalidate(&mut tx, org, authorizer).await?;
        let issue_row = sqlx::query(
            "SELECT assignee_agent_id::text,reviewer_agent_id::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
        )
        .bind(org)
        .bind(issue)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| http(404, "Issue not found"))?;
        let relationship = if issue_row
            .try_get::<Option<String>, _>("assignee_agent_id")?
            .as_deref()
            == Some(steer.agent_id.as_str())
        {
            "assignee"
        } else if issue_row
            .try_get::<Option<String>, _>("reviewer_agent_id")?
            .as_deref()
            == Some(steer.agent_id.as_str())
        {
            "reviewer"
        } else {
            return Err(http(
                409,
                "The active issue relationship changed before Steer was accepted",
            ));
        };
        let requested_by = IssueWakeupActor {
            kind: actor.kind,
            id: actor.id,
        };
        let wakeup = IssueWakeupIntent {
            agent_id: steer.agent_id.clone(),
            source: "automation",
            reason: "issue_comment_steer",
            mutation: "steer".to_owned(),
            context_source: "issue.comment.steer",
            wake_source: "issue.comment.steer",
            role: None,
            comment: Some(comment_context(comment)),
            relationship: Some(relationship),
            expected_issue_execution_run_id: Some(steer.id.clone()),
            payload_extra: Some(json!({"steerRunId":steer.id,"mutation":"steer"})),
            context_extra: Some(json!({
                "wakeReason":"issue_comment_steer",
                "wakeSource":"issue.comment.steer",
                "source":"issue.comment.steer",
                "steerRunId":steer.id,
                "steerDisposition":"interrupt_continue",
            })),
        };
        let admitted = enqueue_issue_core_wakeup(&mut tx, org, issue, &wakeup, &requested_by)
            .await
            .map_err(map_issue_checkout_error)?;
        if admitted.as_deref() != Some(steer.id.as_str()) {
            return Err(http(
                409,
                "Steer could not reserve a continuation; feedback was saved as a comment",
            ));
        }
        request_comment_run_cancellation(
            &mut tx,
            org,
            issue,
            steer,
            actor,
            "issue_comment_steer",
            comment.get("id").and_then(Value::as_str),
        )
        .await?;
        let others = mentioned
            .iter()
            .filter(|agent_id| agent_id.as_str() != steer.agent_id)
            .cloned()
            .collect::<Vec<_>>();
        enqueue_comment_mentions(
            &mut tx,
            org,
            issue,
            actor,
            &issue_row,
            comment,
            "comment",
            Some(&others),
        )
        .await?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            tx.commit().await?;
            Ok(())
        }
        Err(error) => {
            if let Err(rollback_error) = tx.rollback().await {
                tracing::warn!(%rollback_error, org_id = org, "failed to roll back Issue comment steer admission");
            }
            Err(error)
        }
    }
}

async fn reopen_with_comment(
    pool: &PgPool,
    org: &str,
    issue: &str,
    actor: IssueCommentActor<'_>,
    input: &Value,
    control: &CommentControl,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<Option<Value>> {
    let body = input
        .get("body")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| http(422, "Invalid comment body"))?;
    let mut tx = pool.begin().await?;
    let prepared = async {
        lock_organization(&mut tx, org).await?;
        revalidate(&mut tx, org, authorizer).await?;
        let issue_row = sqlx::query(
            "SELECT status,assignee_agent_id::text,reviewer_agent_id::text,checkout_run_id::text,execution_run_id::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
        )
        .bind(org)
        .bind(issue)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| http(404, "Issue not found"))?;
        let status: String = issue_row.try_get("status")?;
        if !matches!(status.as_str(), "done" | "cancelled") {
            return Ok(None);
        }
        let assignee: Option<String> = issue_row.try_get("assignee_agent_id")?;
        let reviewer: Option<String> = issue_row.try_get("reviewer_agent_id")?;
        validate_agent_comment_access(&mut tx, org, issue, &issue_row, actor).await?;
        if actor.kind == "agent"
            && actor.agent_id.is_none_or(|agent_id| {
                assignee.as_deref() != Some(agent_id) && reviewer.as_deref() != Some(agent_id)
            })
        {
            return Err(http(403, "Only the current assignee or reviewer can reopen an issue"));
        }
        let mut interrupted_run_id = None;
        let mut steer = None;
        if control.interrupt || control.steer_expected_run_id.is_some() {
            if actor.kind != "user" {
                return Err(http(
                    403,
                    "Only board users can interrupt active runs from issue comments",
                ));
            }
            let active = active_issue_run_for_comment(
                &mut tx,
                org,
                issue,
                &issue_row,
                control.steer_expected_run_id.as_deref(),
            )
            .await?;
            if control.steer_expected_run_id.is_some() {
                steer = active;
            } else if control.interrupt
                && let Some(active) = active
                && request_comment_run_cancellation(
                    &mut tx,
                    org,
                    issue,
                    &active,
                    actor,
                    "issue_comment_interrupt",
                    None,
                )
                .await?
            {
                interrupted_run_id = Some(active.id);
            }
        }
        let mut body = canonicalize_agent_wake_mentions(&mut tx, org, body).await?;
        let mut mentioned = mentioned_agent_ids(&mut tx, org, &body).await?;
        let self_comment = actor.kind == "agent" && actor.agent_id == assignee.as_deref();
        if let Some(assignee_id) = assignee.as_deref()
            && !self_comment
            && !mentioned.iter().any(|id| id == assignee_id)
        {
            body = format!(
                "{}\n\n[Assigned Agent](agent://{assignee_id}?intent=wake)",
                body.trim_end()
            );
            mentioned = mentioned_agent_ids(&mut tx, org, &body).await?;
        }
        let censor_username = censor_username(&mut tx).await?;
        if censor_username {
            body = redact_current_user_text(&body);
        }
        Ok(Some((
            body,
            status,
            assignee,
            self_comment,
            mentioned,
            steer,
            interrupted_run_id,
        )))
    }
    .await;
    let prepared = match prepared {
        Ok(Some(prepared)) => {
            tx.commit().await?;
            prepared
        }
        Ok(None) => {
            tx.commit().await?;
            return Ok(None);
        }
        Err(IssueCommentError::OwnershipRejected(status, message, reason)) => {
            record_comment_ownership_rejection(&mut tx, org, issue, actor, &reason).await?;
            tx.commit().await?;
            return Err(http(status, &message));
        }
        Err(error) => {
            if let Err(rollback_error) = tx.rollback().await {
                tracing::warn!(%rollback_error, org_id = org, "failed to roll back Issue reopen comment preflight");
            }
            return Err(error);
        }
    };
    let (body, reopened_from, assignee_id, self_comment, mentioned, steer, interrupted_run_id) =
        prepared;
    let mut comment_activity_details = json!({});
    if let Some(run_id) = interrupted_run_id.as_deref() {
        comment_activity_details["interruptedRunId"] = Value::String(run_id.to_owned());
    }
    if let Some(run) = steer.as_ref() {
        comment_activity_details["steerRunId"] = Value::String(run.id.clone());
        comment_activity_details["steerDisposition"] =
            Value::String("interrupt_continue".to_owned());
    }
    let update = json!({
        "comment":body,
        "reopen":true,
    });
    let write_actor = crate::issue_core_writes::IssueCoreWriteActor {
        kind: actor.kind,
        id: actor.id,
        agent_id: actor.agent_id,
        run_id: actor.run_id,
        authorizer,
    };
    let write_request = crate::issue_core_writes::IssueCoreWriteRequest {
        org_id: org,
        operation: crate::issue_core_writes::IssueCoreWriteOperation::Update,
        issue_id: Some(issue),
        input: &update,
        comment_activity_details: Some(&comment_activity_details),
    };
    let (_, response) =
        crate::issue_core_writes::apply_issue_core_write(pool, &write_actor, &write_request, None)
            .await
            .map_err(map_issue_core_write_error)?;
    let Some(comment_id) = response["comment"]["id"].as_str() else {
        return Err(http(500, "Failed to persist reopened Issue comment"));
    };
    let censor_username = query_censor_username(pool).await?;
    let raw = sqlx::query_scalar::<_, String>(
        &format!("SELECT {COMMENT_JSON} FROM issue_comments c WHERE c.org_id=$1::uuid AND c.issue_id=$2::uuid AND c.id=$3::uuid"),
    )
    .bind(org)
    .bind(issue)
    .bind(comment_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| http(404, "Comment not found"))?;
    let comment = serialize_comment(&raw, censor_username)?;
    if let Err(error) = enqueue_reopened_comment_effects(
        pool,
        org,
        issue,
        actor,
        &comment,
        &reopened_from,
        assignee_id.as_deref(),
        self_comment,
        &mentioned,
        steer.as_ref(),
        interrupted_run_id.as_deref(),
        authorizer,
    )
    .await
    {
        if steer.is_some() {
            return Err(match error {
                IssueCommentError::Http(status, message) if status == 409 => {
                    IssueCommentError::HttpDetails(status, message, comment)
                }
                other => other,
            });
        }
        tracing::warn!(%error, org_id = org, issue_id = issue, "failed to enqueue reopened Issue comment wakeups");
    }
    Ok(Some(comment))
}

async fn enqueue_reopened_comment_effects(
    pool: &PgPool,
    org: &str,
    issue: &str,
    actor: IssueCommentActor<'_>,
    comment: &Value,
    reopened_from: &str,
    assignee_id: Option<&str>,
    self_comment: bool,
    mentioned: &[String],
    steer: Option<&ActiveCommentRun>,
    interrupted_run_id: Option<&str>,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    let result = async {
        lock_organization(&mut tx, org).await?;
        revalidate(&mut tx, org, authorizer).await?;
        let issue_row = sqlx::query(
            "SELECT assignee_agent_id::text,reviewer_agent_id::text,execution_run_id::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid FOR UPDATE",
        )
        .bind(org)
        .bind(issue)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| http(404, "Issue not found"))?;
        let steer_relationship = if let Some(steer) = steer {
            Some(if issue_row
                .try_get::<Option<String>, _>("assignee_agent_id")?
                .as_deref()
                == Some(steer.agent_id.as_str())
            {
                "assignee"
            } else if issue_row
                .try_get::<Option<String>, _>("reviewer_agent_id")?
                .as_deref()
                == Some(steer.agent_id.as_str())
            {
                "reviewer"
            } else {
                return Err(http(
                    409,
                    "The active issue relationship changed before Steer was accepted",
                ));
            })
        } else {
            None
        };
        let reopen_wakeup = assignee_id
            .filter(|id| !self_comment && mentioned.iter().any(|mentioned| mentioned == id));
        if let Some(agent_id) = reopen_wakeup {
            let requested_by = IssueWakeupActor {
                kind: actor.kind,
                id: actor.id,
            };
            let mut reopen_payload_extra = json!({"reopenedFrom":reopened_from});
            let mut reopen_context_extra = json!({"reopenedFrom":reopened_from});
            if let Some(interrupted_run_id) = interrupted_run_id {
                reopen_payload_extra["interruptedRunId"] = Value::String(interrupted_run_id.to_owned());
                reopen_context_extra["interruptedRunId"] = Value::String(interrupted_run_id.to_owned());
            }
            let wakeup = IssueWakeupIntent {
                agent_id: agent_id.to_owned(),
                source: "automation",
                reason: "issue_reopened_via_comment",
                mutation: "comment".to_owned(),
                context_source: "issue.comment.reopen",
                wake_source: "automation",
                role: None,
                comment: Some(comment_context(comment)),
                relationship: None,
                expected_issue_execution_run_id: None,
                payload_extra: Some(reopen_payload_extra),
                context_extra: Some(reopen_context_extra),
            };
            enqueue_issue_core_wakeup(&mut tx, org, issue, &wakeup, &requested_by)
                .await
                .map_err(map_issue_checkout_error)?;
        }
        if let Some(steer) = steer {
            let requested_by = IssueWakeupActor {
                kind: actor.kind,
                id: actor.id,
            };
            let wakeup = IssueWakeupIntent {
                agent_id: steer.agent_id.clone(),
                source: "automation",
                reason: "issue_comment_steer",
                mutation: "steer".to_owned(),
                context_source: "issue.comment.steer",
                wake_source: "issue.comment.steer",
                role: None,
                comment: Some(comment_context(comment)),
                relationship: steer_relationship,
                expected_issue_execution_run_id: Some(steer.id.clone()),
                payload_extra: Some(json!({"steerRunId":steer.id,"mutation":"steer"})),
                context_extra: Some(json!({
                    "wakeReason":"issue_comment_steer",
                    "wakeSource":"issue.comment.steer",
                    "source":"issue.comment.steer",
                    "steerRunId":steer.id,
                    "steerDisposition":"interrupt_continue",
                })),
            };
            let admitted = enqueue_issue_core_wakeup(&mut tx, org, issue, &wakeup, &requested_by)
                .await
                .map_err(map_issue_checkout_error)?;
            if admitted.as_deref() != Some(steer.id.as_str()) {
                return Err(http(
                    409,
                    "Steer could not reserve a continuation; feedback was saved as a comment",
                ));
            }
            request_comment_run_cancellation(
                &mut tx,
                org,
                issue,
                steer,
                actor,
                "issue_comment_steer",
                comment.get("id").and_then(Value::as_str),
            )
            .await?;
        }
        let other_mentions = mentioned
            .iter()
            .filter(|id| {
                reopen_wakeup != Some(id.as_str())
                    && steer.is_none_or(|steer| steer.agent_id != **id)
            })
            .cloned()
            .collect::<Vec<_>>();
        enqueue_comment_mentions(
            &mut tx,
            org,
            issue,
            actor,
            &issue_row,
            comment,
            "comment",
            Some(&other_mentions),
        )
        .await?;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => {
            tx.commit().await?;
            Ok(())
        }
        Err(error) => {
            if let Err(rollback_error) = tx.rollback().await {
                tracing::warn!(%rollback_error, org_id = org, "failed to roll back reopened comment wake admission");
            }
            Err(error)
        }
    }
}

fn comment_context(comment: &Value) -> Value {
    json!({
        "id": comment["id"],
        "body": comment["body"],
        "authorAgentId": comment["authorAgentId"],
        "authorUserId": comment["authorUserId"],
    })
}

fn activity_actor(actor: IssueCommentActor<'_>) -> ActivityActor {
    ActivityActor {
        actor_type: if actor.kind == "agent" {
            "agent"
        } else {
            "user"
        },
        actor_id: actor.id.to_owned(),
        run_id: actor.run_id.map(ToOwned::to_owned),
    }
}

async fn record_comment_ownership_rejection(
    tx: &mut Tx<'_>,
    org: &str,
    issue: &str,
    actor: IssueCommentActor<'_>,
    reason: &str,
) -> Result<()> {
    let issue_state = sqlx::query(
        "SELECT status,assignee_agent_id::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(org)
    .bind(issue)
    .fetch_optional(&mut **tx)
    .await?;
    let status = issue_state
        .as_ref()
        .and_then(|row| row.try_get::<String, _>("status").ok())
        .unwrap_or_default();
    let assignee = issue_state
        .as_ref()
        .and_then(|row| row.try_get::<Option<String>, _>("assignee_agent_id").ok())
        .flatten();
    let details = json!({
        "reason":reason,
        "status":status,
        "assigneeAgentId":assignee,
        "actorAgentId":actor.agent_id,
        "actorRunId":actor.run_id,
    });
    let audit = activity_actor(actor);
    write_activity_options(
        tx,
        ActivityWrite {
            org,
            audit: &audit,
            action: "issue.run_ownership_rejected",
            entity_type: "issue",
            entity_id: issue,
            details: Some(&details),
            options: ActivityOptions {
                agent_id: actor.agent_id,
                effects: None,
                bind_run: true,
            },
        },
    )
    .await?;
    Ok(())
}

fn body_snippet(body: &str) -> String {
    body.chars().take(120).collect()
}

fn valid_limit(limit: Option<i64>) -> Option<i64> {
    limit
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_COMMENT_PAGE_LIMIT))
}

fn canonical_uuid(value: &str) -> Result<String> {
    Uuid::parse_str(value)
        .map(|id| id.to_string())
        .map_err(|_| http(422, "Invalid Issue comment reference"))
}

fn http(status: u16, message: &str) -> IssueCommentError {
    IssueCommentError::Http(status, message.to_owned())
}

fn map_issue_checkout_error(error: crate::issue_checkout::IssueCheckoutError) -> IssueCommentError {
    match error {
        crate::issue_checkout::IssueCheckoutError::Http(status, message, _) => {
            http(status, &message)
        }
        crate::issue_checkout::IssueCheckoutError::Database(error) => error.into(),
        crate::issue_checkout::IssueCheckoutError::Json(error) => error.into(),
    }
}

fn map_issue_core_write_error(
    error: crate::issue_core_writes::IssueCoreWriteError,
) -> IssueCommentError {
    match error {
        crate::issue_core_writes::IssueCoreWriteError::Http(status, message) => {
            http(status, &message)
        }
        crate::issue_core_writes::IssueCoreWriteError::Store(error) => error.into(),
        crate::issue_core_writes::IssueCoreWriteError::Database(error) => error.into(),
        crate::issue_core_writes::IssueCoreWriteError::Json(error) => error.into(),
    }
}
