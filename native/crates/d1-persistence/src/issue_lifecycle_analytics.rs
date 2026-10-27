//! Product-analytics lifecycle effects for public Issue mutations.
//!
//! The local analytics ledger and work-cycle state are written by Rust in the
//! same transactions that own Issue creation or the follow-up lifecycle. The
//! derived review and detached-run events retain their legacy best-effort
//! behavior after the Issue transaction has committed.

use crate::{
    StoreError,
    product_analytics::{ProductAnalyticsEvent, write_product_analytics_event},
};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};

const ISSUE_WORK_CYCLE_PREFIX: &str = "issue:";
const DETACHED_PROCESS_ERROR_CODE: &str = "process_detached";

/// Record the creation event and its initial human-work cycle, if the Issue
/// starts in progress or already has an execution run.
pub async fn record_issue_created(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    issue: &Value,
) -> Result<(), StoreError> {
    let issue_id = string_field(issue, "id", "id").ok_or(StoreError::InvalidInput)?;
    let created_by_user_id = string_field(issue, "createdByUserId", "created_by_user_id");
    let created_by_agent_id = string_field(issue, "createdByAgentId", "created_by_agent_id");
    let origin_kind = string_field(issue, "originKind", "origin_kind");
    let (actor_type, origin) = if created_by_user_id.is_some() {
        ("human", "human")
    } else if origin_kind == Some("automation_execution") {
        ("automation", "automation")
    } else if created_by_agent_id.is_some() {
        ("agent", "system")
    } else {
        ("system", "system")
    };
    let actor_id = created_by_user_id.or(created_by_agent_id);
    let occurred_at = string_field(issue, "createdAt", "created_at");
    let properties = json!({
        "creation_path": issue.get("originKind").or_else(|| issue.get("origin_kind")).cloned().unwrap_or(Value::Null),
        "has_goal_link": has_non_null_field(issue, "goalId", "goal_id"),
        "has_project_link": has_non_null_field(issue, "projectId", "project_id"),
        "is_sub_issue": has_non_null_field(issue, "parentId", "parent_id"),
    });
    let dedupe_key = format!("issue_created:{issue_id}");
    write_product_analytics_event(
        tx,
        ProductAnalyticsEvent {
            org_id: Some(org_id),
            event_name: "issue_created",
            occurred_at,
            source_transition: "issue.create",
            confidence: "exact",
            actor_type,
            actor_id,
            entity_type: Some("issue"),
            entity_id: Some(issue_id),
            work_surface: Some("issue"),
            work_id: Some(issue_id),
            work_cycle_id: None,
            root_run_id: None,
            run_id: None,
            completion_revision: None,
            origin,
            dedupe_key: &dedupe_key,
            properties: &properties,
        },
    )
    .await?;

    if let Some(user_id) = created_by_user_id
        && (string_field(issue, "status", "status") == Some("in_progress")
            || has_non_null_field(issue, "executionRunId", "execution_run_id"))
    {
        record_human_work_started(tx, org_id, issue_id, user_id, occurred_at, "issue.create")
            .await?;
    }
    Ok(())
}

/// Record the first human work-start event for a status/run transition during
/// an Issue update. Call after projecting the updated Issue inside its write
/// transaction.
pub async fn record_issue_update_work_started(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    actor_kind: &str,
    previous: &Value,
    updated: &Value,
) -> Result<(), StoreError> {
    if actor_kind == "agent" {
        return Ok(());
    }
    let Some(user_id) = string_field(updated, "createdByUserId", "created_by_user_id") else {
        return Ok(());
    };
    let status_started = string_field(previous, "status", "status") != Some("in_progress")
        && string_field(updated, "status", "status") == Some("in_progress");
    let run_started = !has_non_null_field(previous, "executionRunId", "execution_run_id")
        && has_non_null_field(updated, "executionRunId", "execution_run_id");
    if !status_started && !run_started {
        return Ok(());
    }
    let issue_id = string_field(updated, "id", "id").ok_or(StoreError::InvalidInput)?;
    let occurred_at = string_field(updated, "updatedAt", "updated_at");
    record_human_work_started(tx, org_id, issue_id, user_id, occurred_at, "issue.update").await
}

async fn record_human_work_started(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    issue_id: &str,
    user_id: &str,
    occurred_at: Option<&str>,
    source_transition: &str,
) -> Result<(), StoreError> {
    let work_cycle_id = format!("{ISSUE_WORK_CYCLE_PREFIX}{issue_id}");
    sqlx::query(
        "INSERT INTO product_analytics_work_cycles
           (org_id,work_surface,work_id,work_cycle_id,actor_id,started_at)
         VALUES ($1::uuid,'issue',$2,$3,$4,COALESCE($5::timestamptz,clock_timestamp()))
         ON CONFLICT (org_id,work_cycle_id) DO NOTHING",
    )
    .bind(org_id)
    .bind(issue_id)
    .bind(&work_cycle_id)
    .bind(user_id)
    .bind(occurred_at)
    .execute(&mut **tx)
    .await?;

    let properties = json!({"work_surface":"issue","origin":"human"});
    let dedupe_key = format!("human_work_started:{work_cycle_id}");
    write_product_analytics_event(
        tx,
        ProductAnalyticsEvent {
            org_id: Some(org_id),
            event_name: "human_work_started",
            occurred_at,
            source_transition,
            confidence: "exact",
            actor_type: "human",
            actor_id: Some(user_id),
            entity_type: Some("issue"),
            entity_id: Some(issue_id),
            work_surface: Some("issue"),
            work_id: Some(issue_id),
            work_cycle_id: Some(&work_cycle_id),
            root_run_id: None,
            run_id: None,
            completion_revision: None,
            origin: "human",
            dedupe_key: &dedupe_key,
            properties: &properties,
        },
    )
    .await?;
    Ok(())
}

/// Record an Issue review event using the legacy derived-event boundary.
/// Failures are logged and do not change the committed Issue response.
pub struct IssueReviewAnalytics<'a> {
    pub org_id: &'a str,
    pub issue_id: &'a str,
    pub actor_kind: &'a str,
    pub actor_id: &'a str,
    pub review_activity_id: &'a str,
    pub decision: &'a str,
    pub comment_created_at: &'a str,
}

pub async fn record_issue_review_best_effort(pool: &PgPool, review: IssueReviewAnalytics<'_>) {
    let result = async {
        let mut tx = pool.begin().await?;
        let work_cycle_id = format!("{ISSUE_WORK_CYCLE_PREFIX}{}", review.issue_id);
        let properties = json!({"decision":review.decision,"review_surface":"issue"});
        let dedupe_key = format!("review_decision_recorded:{}", review.review_activity_id);
        write_product_analytics_event(
            &mut tx,
            ProductAnalyticsEvent {
                org_id: Some(review.org_id),
                event_name: "review_decision_recorded",
                occurred_at: Some(review.comment_created_at),
                source_transition: "issue.review_decision_recorded",
                confidence: "derived",
                actor_type: if review.actor_kind == "user" {
                    "human"
                } else {
                    "agent"
                },
                actor_id: Some(review.actor_id),
                entity_type: Some("issue"),
                entity_id: Some(review.issue_id),
                work_surface: Some("issue"),
                work_id: Some(review.issue_id),
                work_cycle_id: Some(&work_cycle_id),
                root_run_id: None,
                run_id: None,
                completion_revision: None,
                origin: if review.actor_kind == "user" {
                    "human"
                } else {
                    "system"
                },
                dedupe_key: &dedupe_key,
                properties: &properties,
            },
        )
        .await?;
        tx.commit().await?;
        Ok::<(), StoreError>(())
    }
    .await;
    if let Err(error) = result {
        tracing::warn!(%error, issue_id = review.issue_id, "failed to record derived product analytics review event");
    }
}

pub struct IssueUpdateAnalytics<'a> {
    pub org_id: &'a str,
    pub issue_id: &'a str,
    pub actor_kind: &'a str,
    pub actor_id: &'a str,
    pub actor_run_id: Option<&'a str>,
    pub status: &'a str,
    pub created_by_user_id: Option<&'a str>,
    pub has_reviewer: bool,
    pub review_decision: Option<&'a str>,
    pub review_activity_id: Option<&'a str>,
    pub comment_created_at: Option<&'a str>,
    pub reopened: bool,
}

/// Apply post-commit Issue lifecycle analytics and activity side effects.
/// Review and detached-run evidence is best effort; database failures in
/// completion or invalidation preserve the existing visible error behavior.
pub async fn after_issue_update(
    pool: &PgPool,
    update: IssueUpdateAnalytics<'_>,
) -> Result<(), StoreError> {
    if let Some(run_id) = update.actor_run_id
        && let Err(error) = clear_detached_run_warning(pool, run_id).await
    {
        tracing::warn!(%error, run_id, "failed to clear detached run warning after issue activity");
    }

    if let (Some(decision), Some(activity_id), Some(comment_created_at)) = (
        update.review_decision,
        update.review_activity_id,
        update.comment_created_at,
    ) {
        record_issue_review_best_effort(
            pool,
            IssueReviewAnalytics {
                org_id: update.org_id,
                issue_id: update.issue_id,
                actor_kind: update.actor_kind,
                actor_id: update.actor_id,
                review_activity_id: activity_id,
                decision,
                comment_created_at,
            },
        )
        .await;
    }

    if update.status == "done"
        && update.actor_kind == "user"
        && let Some(created_by_user_id) = update.created_by_user_id
    {
        complete_issue_work_cycle(pool, &update, created_by_user_id).await?;
    }

    if update.reopened {
        invalidate_reopened_issue_work_cycle(pool, update.org_id, update.issue_id).await?;
    }
    Ok(())
}

async fn complete_issue_work_cycle(
    pool: &PgPool,
    update: &IssueUpdateAnalytics<'_>,
    created_by_user_id: &str,
) -> Result<(), StoreError> {
    let work_cycle_id = format!("{ISSUE_WORK_CYCLE_PREFIX}{}", update.issue_id);
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO product_analytics_work_cycles
           (org_id,work_surface,work_id,work_cycle_id,actor_id)
         VALUES ($1::uuid,'issue',$2,$3,$4)
         ON CONFLICT (org_id,work_cycle_id) DO NOTHING",
    )
    .bind(update.org_id)
    .bind(update.issue_id)
    .bind(&work_cycle_id)
    .bind(created_by_user_id)
    .execute(&mut *tx)
    .await?;
    let cycle = sqlx::query(
        "SELECT state,completion_revision,(invalidated_at IS NOT NULL) AS invalidated,root_run_ids
         FROM product_analytics_work_cycles
         WHERE org_id=$1::uuid AND work_cycle_id=$2 FOR UPDATE",
    )
    .bind(update.org_id)
    .bind(&work_cycle_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(cycle) = cycle else {
        tx.commit().await?;
        return Ok(());
    };
    let successful_runs =
        count_cycle_events(&mut tx, update.org_id, &work_cycle_id, "run_succeeded").await?;
    let ready_outputs =
        count_cycle_events(&mut tx, update.org_id, &work_cycle_id, "output_ready").await?;
    let approved_reviews = if update.has_reviewer {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*)::bigint FROM product_analytics_events
             WHERE org_id=$1::uuid AND work_cycle_id=$2
               AND event_name='review_decision_recorded'
               AND properties->>'decision'='approve'",
        )
        .bind(update.org_id)
        .bind(&work_cycle_id)
        .fetch_one(&mut *tx)
        .await?
    } else {
        1
    };
    if successful_runs < 1 || ready_outputs < 1 || approved_reviews < 1 {
        // The legacy route treats its work-cycle 422 as an ineligible derived
        // completion, while the Issue status update itself remains committed.
        tx.commit().await?;
        return Ok(());
    }

    let state: String = cycle.try_get("state")?;
    let invalidated: bool = cycle.try_get("invalidated")?;
    let previous_revision: i32 = cycle.try_get("completion_revision")?;
    if state == "completed" && !invalidated {
        tx.commit().await?;
        return Ok(());
    }
    let root_run_ids: Value = cycle.try_get("root_run_ids")?;
    let event_run_ids = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT root_run_id::text FROM product_analytics_events
         WHERE org_id=$1::uuid AND work_cycle_id=$2 AND root_run_id IS NOT NULL",
    )
    .bind(update.org_id)
    .bind(&work_cycle_id)
    .fetch_all(&mut *tx)
    .await?;
    let mut root_ids = root_run_ids
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    for run_id in event_run_ids {
        if !root_ids.contains(&run_id) {
            root_ids.push(run_id);
        }
    }
    let revision = previous_revision + 1;
    let properties = json!({
        "work_surface":"issue",
        "origin":"human",
        "review_required":update.has_reviewer,
    });
    let dedupe_key = format!("work_loop_completed:{work_cycle_id}:{revision}");
    let event_id = write_product_analytics_event(
        &mut tx,
        ProductAnalyticsEvent {
            org_id: Some(update.org_id),
            event_name: "work_loop_completed",
            occurred_at: None,
            source_transition: "issue.complete",
            confidence: "exact",
            actor_type: "human",
            actor_id: Some(update.actor_id),
            entity_type: Some("issue"),
            entity_id: Some(update.issue_id),
            work_surface: Some("issue"),
            work_id: Some(update.issue_id),
            work_cycle_id: Some(&work_cycle_id),
            root_run_id: None,
            run_id: None,
            completion_revision: Some(revision),
            origin: "human",
            dedupe_key: &dedupe_key,
            properties: &properties,
        },
    )
    .await?;
    let event_id = match event_id {
        Some(event_id) => event_id,
        None => {
            sqlx::query_scalar::<_, String>(
                "SELECT id::text FROM product_analytics_events WHERE dedupe_key=$1",
            )
            .bind(&dedupe_key)
            .fetch_one(&mut *tx)
            .await?
        }
    };
    sqlx::query(
        "UPDATE product_analytics_work_cycles
         SET state='completed',completion_revision=$3,completed_at=clock_timestamp(),
             invalidated_at=NULL,root_run_ids=$4::jsonb,updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND work_cycle_id=$2",
    )
    .bind(update.org_id)
    .bind(&work_cycle_id)
    .bind(revision)
    .bind(Value::Array(root_ids.into_iter().map(Value::String).collect()).to_string())
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO product_analytics_work_cycle_revisions
           (org_id,work_cycle_id,completion_revision,completion_event_id,completed_at)
         VALUES ($1::uuid,$2,$3,$4::uuid,clock_timestamp()) ON CONFLICT DO NOTHING",
    )
    .bind(update.org_id)
    .bind(&work_cycle_id)
    .bind(revision)
    .bind(event_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn invalidate_reopened_issue_work_cycle(
    pool: &PgPool,
    org_id: &str,
    issue_id: &str,
) -> Result<(), StoreError> {
    let work_cycle_id = format!("{ISSUE_WORK_CYCLE_PREFIX}{issue_id}");
    let mut tx = pool.begin().await?;
    let cycle = sqlx::query(
        "SELECT completion_revision FROM product_analytics_work_cycles
         WHERE org_id=$1::uuid AND work_cycle_id=$2 FOR UPDATE",
    )
    .bind(org_id)
    .bind(&work_cycle_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(cycle) = cycle else {
        tx.commit().await?;
        return Ok(());
    };
    let revision: i32 = cycle.try_get("completion_revision")?;
    if revision < 1 {
        tx.commit().await?;
        return Ok(());
    }
    let properties = json!({"reason_code":"reopened"});
    let dedupe_key = format!("work_loop_invalidated:{work_cycle_id}:{revision}:reopened");
    let event_id = write_product_analytics_event(
        &mut tx,
        ProductAnalyticsEvent {
            org_id: Some(org_id),
            event_name: "work_loop_invalidated",
            occurred_at: None,
            source_transition: "work_loop.invalidate",
            confidence: "exact",
            actor_type: "system",
            actor_id: None,
            entity_type: Some("issue"),
            entity_id: Some(issue_id),
            work_surface: Some("issue"),
            work_id: Some(issue_id),
            work_cycle_id: Some(&work_cycle_id),
            root_run_id: None,
            run_id: None,
            completion_revision: Some(revision),
            origin: "system",
            dedupe_key: &dedupe_key,
            properties: &properties,
        },
    )
    .await?;
    let event_id = match event_id {
        Some(event_id) => event_id,
        None => {
            sqlx::query_scalar::<_, String>(
                "SELECT id::text FROM product_analytics_events WHERE dedupe_key=$1",
            )
            .bind(&dedupe_key)
            .fetch_one(&mut *tx)
            .await?
        }
    };
    update_cycle_invalidation(&mut tx, org_id, &work_cycle_id, revision, &event_id).await?;
    tx.commit().await?;
    Ok(())
}

async fn update_cycle_invalidation(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    work_cycle_id: &str,
    revision: i32,
    event_id: &str,
) -> Result<(), StoreError> {
    sqlx::query(
        "UPDATE product_analytics_work_cycle_revisions
         SET invalidated_at=clock_timestamp(),invalidation_reason_code='reopened',
             invalidation_event_id=$4::uuid,updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND work_cycle_id=$2 AND completion_revision=$3",
    )
    .bind(org_id)
    .bind(work_cycle_id)
    .bind(revision)
    .bind(event_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "UPDATE product_analytics_work_cycles
         SET state='invalidated',invalidated_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND work_cycle_id=$2",
    )
    .bind(org_id)
    .bind(work_cycle_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn count_cycle_events(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    work_cycle_id: &str,
    event_name: &str,
) -> Result<i64, StoreError> {
    Ok(sqlx::query_scalar(
        "SELECT count(*)::bigint FROM product_analytics_events
         WHERE org_id=$1::uuid AND work_cycle_id=$2 AND event_name=$3",
    )
    .bind(org_id)
    .bind(work_cycle_id)
    .bind(event_name)
    .fetch_one(&mut **tx)
    .await?)
}

pub(crate) async fn clear_comment_run_detached_warning(
    pool: &PgPool,
    run_id: &str,
) -> Result<(), StoreError> {
    clear_detached_run_warning(pool, run_id).await
}

async fn clear_detached_run_warning(pool: &PgPool, run_id: &str) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    let cleared = sqlx::query(
        "UPDATE heartbeat_runs SET error=NULL,error_code=NULL,updated_at=clock_timestamp()
         WHERE id=$1::uuid AND status='running' AND error_code=$2
         RETURNING id::text AS id,org_id::text AS org_id,agent_id::text AS agent_id",
    )
    .bind(run_id)
    .bind(DETACHED_PROCESS_ERROR_CODE)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(cleared) = cleared else {
        tx.commit().await?;
        return Ok(());
    };
    let run_id: String = cleared.try_get("id")?;
    let org_id: String = cleared.try_get("org_id")?;
    let agent_id: String = cleared.try_get("agent_id")?;
    tx.commit().await?;

    let mut event_tx = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(&run_id)
        .execute(&mut *event_tx)
        .await?;
    sqlx::query(
        "INSERT INTO heartbeat_run_events
           (org_id,run_id,agent_id,seq,event_type,stream,level,message)
         SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE(MAX(seq),0)+1,
                'lifecycle','system','info',
                'Detached child process reported activity; cleared detached warning'
         FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid",
    )
    .bind(org_id)
    .bind(run_id)
    .bind(agent_id)
    .execute(&mut *event_tx)
    .await?;
    event_tx.commit().await?;
    Ok(())
}

fn string_field<'a>(value: &'a Value, camel: &str, snake: &str) -> Option<&'a str> {
    value
        .get(camel)
        .or_else(|| value.get(snake))
        .and_then(Value::as_str)
}

fn has_non_null_field(value: &Value, camel: &str, snake: &str) -> bool {
    value
        .get(camel)
        .or_else(|| value.get(snake))
        .is_some_and(|value| !value.is_null())
}
