//! Generic Run transition events using the existing local analytics/outbox.
use crate::{
    StoreError,
    product_analytics::{ProductAnalyticsEvent, write_product_analytics_event},
};
use serde_json::json;
use sqlx::{Postgres, Row, Transaction};

pub(crate) async fn started(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    run_id: &str,
) -> Result<(), sqlx::Error> {
    record(tx, org, run_id, true).await
}
pub(crate) async fn terminal(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    run_id: &str,
) -> Result<(), sqlx::Error> {
    record(tx, org, run_id, false).await
}

async fn record(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    run_id: &str,
    started: bool,
) -> Result<(), sqlx::Error> {
    let run=sqlx::query("SELECT agent_id::text AS agent_id,status,invocation_source,retry_of_run_id::text AS retry_of_run_id,COALESCE(started_at,created_at)::text AS started_at,COALESCE(finished_at,statement_timestamp())::text AS finished_at,result_summary_json IS NOT NULL AS has_result FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org).bind(run_id).fetch_one(&mut **tx).await?;
    let agent_id: String = run.try_get("agent_id")?;
    let status: String = run.try_get("status")?;
    let source: String = run.try_get("invocation_source")?;
    let retry: Option<String> = run.try_get("retry_of_run_id")?;
    let root = retry.as_deref().unwrap_or(run_id);
    let occurred: String = run.try_get(if started { "started_at" } else { "finished_at" })?;
    let issue:Option<String>=sqlx::query_scalar("SELECT id::text FROM issues WHERE org_id=$1::uuid AND (execution_run_id=$2::uuid OR checkout_run_id=$2::uuid) ORDER BY id LIMIT 1")
        .bind(org).bind(run_id).fetch_optional(&mut **tx).await?;
    let cycle = issue.as_ref().map(|id| format!("issue:{id}"));
    let automation = source.contains("automation");
    let actor_type = if automation { "automation" } else { "agent" };
    let origin = if automation {
        "automation"
    } else if retry.is_some() {
        "retry"
    } else {
        "human"
    };
    let name = if started {
        "run_started"
    } else if status == "succeeded" {
        "run_succeeded"
    } else {
        "run_failed"
    };
    let key = if started || status == "succeeded" {
        format!("{name}:{run_id}")
    } else {
        format!("run_failed:{run_id}:{status}")
    };
    let mut properties =
        json!({"run_kind":source,"attempt_kind":if retry.is_some(){"retry"}else{"root"}});
    if !started && status != "succeeded" {
        properties["terminal_status"] = json!(status);
    }
    write_product_analytics_event(
        tx,
        ProductAnalyticsEvent {
            org_id: Some(org),
            event_name: name,
            occurred_at: Some(&occurred),
            source_transition: if started {
                "heartbeat.run.claim"
            } else {
                "heartbeat.run.terminal"
            },
            confidence: "exact",
            actor_type,
            actor_id: Some(&agent_id),
            entity_type: Some("run"),
            entity_id: Some(run_id),
            work_surface: issue.as_ref().map(|_| "issue"),
            work_id: issue.as_deref(),
            work_cycle_id: cycle.as_deref(),
            root_run_id: Some(root),
            run_id: Some(run_id),
            completion_revision: None,
            origin,
            dedupe_key: &key,
            properties: &properties,
        },
    )
    .await
    .map_err(database_error)?;
    if !started && status == "succeeded" && run.try_get::<bool, _>("has_result")? {
        write_product_analytics_event(
            tx,
            ProductAnalyticsEvent {
                org_id: Some(org),
                event_name: "output_ready",
                occurred_at: Some(&occurred),
                source_transition: "heartbeat.run.terminal",
                confidence: "exact",
                actor_type,
                actor_id: Some(&agent_id),
                entity_type: Some("run"),
                entity_id: Some(run_id),
                work_surface: issue.as_ref().map(|_| "issue"),
                work_id: issue.as_deref(),
                work_cycle_id: cycle.as_deref(),
                root_run_id: Some(root),
                run_id: Some(run_id),
                completion_revision: None,
                origin: "system",
                dedupe_key: &format!("output_ready:run:{run_id}:structured_result:{run_id}"),
                properties: &json!({"output_kind":"structured_result"}),
            },
        )
        .await
        .map_err(database_error)?;
    }
    Ok(())
}

fn database_error(error: StoreError) -> sqlx::Error {
    match error {
        StoreError::Database(error) => error,
        _ => sqlx::Error::Protocol("Native Run analytics rejected persisted values".into()),
    }
}
