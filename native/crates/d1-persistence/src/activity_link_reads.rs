//! User Activity and Run/Issue link GET authority, with current target and Run visibility checks.
mod ledger;
mod ledger_query;
use crate::{
    StoreError,
    activity_reads::{JsString, details, encode_object, legacy_date_text, legacy_stamp, object},
    legacy_read_json::normalize_legacy_read_json,
    run_visibility,
};
use serde::Deserialize;
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityLinkReadOperation {
    UserLedger,
    IssueRuns,
    RunIssues,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivityLinkReadInput {
    pub operation: ActivityLinkReadOperation,
    pub user_id: Option<String>,
    pub issue_id: Option<String>,
    pub run_id: Option<String>,
    pub run_alias: Option<String>,
    pub since: Option<String>,
    pub until: Option<String>,
    pub include: Option<Vec<String>>,
    pub agent_id: Option<String>,
    pub project_id: Option<String>,
    pub limit: Option<f64>,
    pub cursor: Option<String>,
    pub legacy_date_timezone: Option<String>,
    pub canonical_locale: Option<String>,
}
impl ActivityLinkReadInput {
    pub fn validate(&self) -> Result<(), StoreError> {
        if match self.operation {
            ActivityLinkReadOperation::UserLedger => {
                self.user_id.is_none()
                    || self.canonical_locale.as_ref().is_none_or(|locale| {
                        locale.is_empty()
                            || locale.len() > 256
                            || locale.parse::<icu_locale_core::Locale>().is_err()
                    })
            }
            ActivityLinkReadOperation::IssueRuns => self.issue_id.is_none(),
            ActivityLinkReadOperation::RunIssues => {
                self.run_id.is_none()
                    || !matches!(self.run_alias.as_deref(), Some("heartbeat" | "agent"))
            }
        } || self.legacy_date_timezone.as_ref().is_some_and(|zone| {
            zone.is_empty() || zone.len() > 256 || zone.chars().any(char::is_control)
        }) {
            return Err(StoreError::InvalidInput);
        }
        Ok(())
    }
}
#[derive(Debug, thiserror::Error)]
pub enum ActivityLinkReadError {
    #[error("{0}")]
    BadRequest(String),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
type Object = BTreeMap<JsString, String>;
fn array(rows: Vec<String>) -> String {
    format!("[{}]", rows.join(","))
}
fn value<'a>(row: &'a Object, key: &str) -> Option<&'a str> {
    row.get(&JsString::from(key)).map(String::as_str)
}
fn text(row: &Object, key: &str) -> Result<Option<String>, StoreError> {
    match value(row, key) {
        None | Some("null") => Ok(None),
        Some(raw) => serde_json::from_str(raw)
            .map(Some)
            .map_err(|_| StoreError::InvalidReceipt),
    }
}
fn json_text(value: &str) -> String {
    serde_json::to_string(value).expect("string")
}
fn date(column: &str) -> String {
    legacy_date_text(&legacy_stamp(column))
}
fn js_string(raw: &str) -> Result<JsString, StoreError> {
    serde_json::from_str(raw).map_err(|_| StoreError::InvalidReceipt)
}
fn merge_run(raw: &str) -> Result<String, StoreError> {
    let mut row = object(raw)?;
    let usage = details(value(&row, "usageJson"))?;
    let summary = details(value(&row, "resultJson"))?;
    let mut result = object(value(&row, "resultFallbackJson").unwrap_or("null"))?;
    if usage.starts_with('{') {
        let fields = object(&usage)?;
        for key in ["provider", "biller", "model", "billingType"] {
            if let Some(raw) = value(&fields, key).filter(|v| v.starts_with('"')) {
                let mut text = js_string(raw)?;
                if !text.0.is_empty() {
                    text.0
                        .truncate(if key == "billingType" { 100 } else { 500 });
                    result.insert(key.into(), text.json());
                }
            }
        }
    }
    result.extend(object(&summary)?);
    row.remove(&JsString::from("resultFallbackJson"));
    row.insert("usageJson".into(), usage);
    row.insert(
        "resultJson".into(),
        if result.is_empty() {
            "null".into()
        } else {
            encode_object(result)
        },
    );
    Ok(encode_object(row))
}
async fn issue_runs(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    issue: &str,
    owner: Option<&str>,
) -> Result<String, ActivityLinkReadError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM issues WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(org)
    .bind(issue)
    .fetch_one(&mut **tx)
    .await?;
    if !exists {
        return Err(StoreError::NotFound.into());
    }
    let visibility = run_visibility::predicate("r", 3);
    let fallback = [
        ("summary", 500),
        ("result", 500),
        ("message", 500),
        ("error", 500),
        ("userMessage", 500),
        ("body", 500),
        ("stdout", 32768),
        ("provider", 500),
        ("biller", 500),
        ("model", 500),
        ("billingType", 100),
    ]
    .iter()
    .map(|(key, len)| format!("'{key}',left(r.result_json->>'{key}',{len})"))
    .chain([
        "'total_cost_usd',r.result_json->'total_cost_usd'".into(),
        "'cost_usd',r.result_json->'cost_usd'".into(),
        "'costUsd',r.result_json->'costUsd'".into(),
    ])
    .collect::<Vec<_>>()
    .join(",");
    let started = date("r.started_at");
    let finished = date("r.finished_at");
    let created = date("r.created_at");
    let query = format!(
        r#"SELECT jsonb_build_object('runId',r.id,'status',r.status,'agentId',r.agent_id,
      'startedAt',{started},'finishedAt',{finished},'createdAt',{created},'invocationSource',r.invocation_source,'triggerDetail',r.trigger_detail,
      'contextSnapshot',nullif(jsonb_strip_nulls(jsonb_build_object('issueId',r.context_snapshot->'issueId','resumeFromRunId',r.context_snapshot->'resumeFromRunId',
        'passiveFollowup',CASE WHEN jsonb_typeof(r.context_snapshot->'passiveFollowup')='object' THEN jsonb_strip_nulls(jsonb_build_object(
          'attempt',r.context_snapshot->'passiveFollowup'->'attempt','maxAttempts',r.context_snapshot->'passiveFollowup'->'maxAttempts')) ELSE NULL END)), '{{}}'::jsonb),
      'usageJson',r.usage_json,'resultJson',r.result_summary_json,
      'resultFallbackJson',CASE WHEN r.result_summary_json IS NULL THEN jsonb_strip_nulls(jsonb_build_object({fallback})) ELSE NULL END)::text
      FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND {visibility} AND (r.context_snapshot->>'issueId'=$2 OR EXISTS(
        SELECT 1 FROM activity_log a WHERE a.org_id=$1::uuid AND a.entity_type='issue' AND a.entity_id=$2 AND a.run_id=r.id)) ORDER BY r.created_at DESC,r.id DESC"#
    );
    let rows = sqlx::query_scalar::<_, String>(&query)
        .bind(org)
        .bind(issue)
        .bind(owner)
        .fetch_all(&mut **tx)
        .await?;
    Ok(array(
        rows.iter()
            .map(|raw| merge_run(raw))
            .collect::<Result<_, _>>()?,
    ))
}
async fn run_issues(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    run: &str,
    owner: Option<&str>,
) -> Result<String, ActivityLinkReadError> {
    let visibility = run_visibility::predicate("r", 3);
    let selected=sqlx::query(&format!("SELECT r.context_snapshot::text context FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND r.id=$2::uuid AND {visibility}"))
        .bind(org).bind(run).bind(owner).fetch_optional(&mut **tx).await?.ok_or(StoreError::NotFound)?;
    let context = details(selected.try_get::<Option<&str>, _>("context")?)?;
    let projection = "jsonb_build_object('issueId',i.id,'identifier',i.identifier,'title',i.title,'status',i.status,'priority',i.priority)::text";
    let rows=sqlx::query_scalar::<_,String>(&format!("SELECT DISTINCT ON (i.id::text) {projection} FROM activity_log a INNER JOIN issues i ON a.entity_id=i.id::text WHERE a.org_id=$1::uuid AND a.run_id=$2::uuid AND a.entity_type='issue' AND i.org_id=$1::uuid AND i.hidden_at IS NULL ORDER BY i.id::text"))
        .bind(org).bind(run).fetch_all(&mut **tx).await?;
    let context_id = if context.starts_with('{') {
        let map = object(&context)?;
        match value(&map, "issueId") {
            Some(raw) if raw.starts_with('"') => Some(serde_json::from_str::<String>(raw)?),
            _ => None,
        }
    } else {
        None
    };
    let Some(context_id) = context_id.filter(|id| !id.is_empty()) else {
        return Ok(array(rows));
    };
    for row in &rows {
        if text(&object(row)?, "issueId")?.as_deref() == Some(context_id.as_str()) {
            return Ok(array(rows));
        }
    }
    let from_context=sqlx::query_scalar::<_,String>(&format!("SELECT {projection} FROM issues i WHERE i.org_id=$1::uuid AND i.id=$2::uuid AND i.hidden_at IS NULL"))
        .bind(org).bind(&context_id).fetch_optional(&mut **tx).await?;
    let mut result = Vec::with_capacity(rows.len() + 1);
    if let Some(row) = from_context {
        result.push(row);
    }
    result.extend(rows);
    Ok(array(result))
}
pub async fn read_activity_links(
    pool: &PgPool,
    org: &str,
    owner: Option<&str>,
    input: &ActivityLinkReadInput,
) -> Result<String, ActivityLinkReadError> {
    input.validate()?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    if let Some(zone) = &input.legacy_date_timezone {
        sqlx::query("SELECT set_config('TimeZone',$1,true)")
            .bind(zone)
            .execute(&mut *tx)
            .await?;
    }
    let result = match input.operation {
        ActivityLinkReadOperation::UserLedger => ledger::read(&mut tx, org, owner, input).await?,
        ActivityLinkReadOperation::IssueRuns => {
            issue_runs(
                &mut tx,
                org,
                input.issue_id.as_deref().ok_or(StoreError::InvalidInput)?,
                owner,
            )
            .await?
        }
        ActivityLinkReadOperation::RunIssues => {
            run_issues(
                &mut tx,
                org,
                input.run_id.as_deref().ok_or(StoreError::InvalidInput)?,
                owner,
            )
            .await?
        }
    };
    tx.commit().await?;
    Ok(normalize_legacy_read_json(&result)?)
}
