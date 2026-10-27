//! Scoped read authority for the run/execution workspace GET aliases.
use crate::{
    StoreError,
    activity_reads::{details, utc_date_text, utc_stamp},
    legacy_read_json::normalize_legacy_read_json,
};
use serde::Deserialize;
use serde_json::Value;
use sqlx::{PgPool, Row};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RunWorkspaceReadOperation {
    List,
    Detail,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RunWorkspaceReadInput {
    pub operation: RunWorkspaceReadOperation,
    pub workspace_id: Option<String>,
    pub project_id: Option<Value>,
    pub project_workspace_id: Option<Value>,
    pub issue_id: Option<Value>,
    pub statuses: Option<Vec<String>>,
    #[serde(default)]
    pub reuse_eligible: bool,
    pub legacy_date_timezone: Option<String>,
}
impl RunWorkspaceReadInput {
    pub fn validate(&self) -> Result<(), StoreError> {
        if (self.operation == RunWorkspaceReadOperation::Detail) != self.workspace_id.is_some()
            || (self.operation == RunWorkspaceReadOperation::Detail
                && (self.project_id.is_some()
                    || self.project_workspace_id.is_some()
                    || self.issue_id.is_some()
                    || self.statuses.is_some()
                    || self.reuse_eligible))
            || self.legacy_date_timezone.as_ref().is_some_and(|zone| {
                zone.is_empty() || zone.len() > 256 || zone.chars().any(char::is_control)
            })
        {
            return Err(StoreError::InvalidInput);
        }
        if let Some(id) = &self.workspace_id {
            crate::transaction::uuid(id)?;
        }
        Ok(())
    }
}
// Public Express query arrays/objects remain invalid UUID inputs (database500),
// rather than silently becoming a different filter or a validation422.
fn uuid_filter(value: &Option<Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.is_empty() => None,
        Some(Value::String(value)) => Some(value.clone()),
        Some(value) => Some(value.to_string()),
    }
}
fn read_sql() -> String {
    let columns = [
        "last_used_at",
        "opened_at",
        "closed_at",
        "cleanup_eligible_at",
        "created_at",
        "updated_at",
    ];
    let dates = columns
        .iter()
        .map(|column| format!("{} AS {column}", utc_stamp(&format!("w.{column}"))))
        .collect::<Vec<_>>()
        .join(",");
    let date = |column: &str| utc_date_text(&format!("d.{column}"));
    format!(
        r#"SELECT jsonb_build_object('id',w.id,'orgId',w.org_id,'projectId',w.project_id,
      'projectWorkspaceId',w.project_workspace_id,'sourceIssueId',w.source_issue_id,'mode',w.mode,
      'strategyType',w.strategy_type,'name',w.name,'status',w.status,'cwd',w.cwd,'repoUrl',w.repo_url,
      'baseRef',w.base_ref,'branchName',w.branch_name,'providerType',w.provider_type,'providerRef',w.provider_ref,
      'derivedFromRunWorkspaceId',w.derived_from_execution_workspace_id,
      'derivedFromExecutionWorkspaceId',w.derived_from_execution_workspace_id,
      'lastUsedAt',{},'openedAt',{},'closedAt',{},'cleanupEligibleAt',{},'cleanupReason',w.cleanup_reason,
      'createdAt',{},'updatedAt',{})::text payload,w.metadata::text metadata
      FROM execution_workspaces w CROSS JOIN LATERAL (SELECT {dates}) d
      WHERE w.org_id=$1::uuid AND ($2::text IS NULL OR w.id=$2::uuid)
      AND ($3::text IS NULL OR w.project_id=$3::uuid) AND ($4::text IS NULL OR w.project_workspace_id=$4::uuid)
      AND ($5::text IS NULL OR w.source_issue_id=$5::uuid)
      AND (cardinality($6::text[])=0 OR w.status=ANY($6::text[]))
      AND (NOT $7::bool OR w.status IN ('active','idle','in_review'))
      ORDER BY w.last_used_at DESC,w.created_at DESC"#,
        date(columns[0]),
        date(columns[1]),
        date(columns[2]),
        date(columns[3]),
        date(columns[4]),
        date(columns[5])
    )
}
pub async fn read_run_workspaces(
    pool: &PgPool,
    org_id: &str,
    input: &RunWorkspaceReadInput,
) -> Result<String, StoreError> {
    input.validate()?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    if let Some(zone) = &input.legacy_date_timezone {
        sqlx::query("SELECT set_config('TimeZone',$1,true)")
            .bind(zone)
            .execute(&mut *tx)
            .await?;
    }
    let rows = sqlx::query(&read_sql())
        .bind(org_id)
        .bind(&input.workspace_id)
        .bind(uuid_filter(&input.project_id))
        .bind(uuid_filter(&input.project_workspace_id))
        .bind(uuid_filter(&input.issue_id))
        .bind(input.statuses.clone().unwrap_or_default())
        .bind(input.reuse_eligible)
        .fetch_all(&mut *tx)
        .await?;
    if rows.is_empty() && input.operation == RunWorkspaceReadOperation::Detail {
        return Err(StoreError::NotFound);
    }
    let mut projected = Vec::with_capacity(rows.len());
    for row in rows {
        let mut payload: String = row.try_get("payload")?;
        let metadata: Option<String> = row.try_get("metadata")?;
        payload.pop();
        payload.push_str(",\"metadata\":");
        payload.push_str(&details(metadata.as_deref())?);
        payload.push('}');
        projected
            .push(normalize_legacy_read_json(&payload).map_err(|_| StoreError::InvalidReceipt)?);
    }
    tx.commit().await?;
    if input.operation == RunWorkspaceReadOperation::Detail {
        Ok(projected.remove(0))
    } else {
        Ok(format!("[{}]", projected.join(",")))
    }
}
