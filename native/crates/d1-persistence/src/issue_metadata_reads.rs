//! Read-only issue metadata. Authorization is bound to the existing public actor
//! decision; issue identity and every disclosed linked row are rechecked here.
use crate::{
    StoreError,
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    legacy_read_json::normalize_legacy_read_json,
};
use serde::Deserialize;
use sqlx::{PgPool, Row};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IssueMetadataReadOperation {
    Attachments,
    WorkProducts,
    Follows,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IssueMetadataReadInput {
    pub operation: IssueMetadataReadOperation,
    pub issue_id: Option<String>,
    pub board_user_context: Option<bool>,
    pub legacy_date_timezone: Option<String>,
}
impl IssueMetadataReadInput {
    pub fn validate(&self) -> Result<(), StoreError> {
        if self.legacy_date_timezone.as_ref().is_some_and(|zone| {
            zone.is_empty() || zone.len() > 256 || zone.chars().any(char::is_control)
        }) {
            return Err(StoreError::InvalidInput);
        }
        match self.operation {
            IssueMetadataReadOperation::Follows if self.issue_id.is_some() => {
                Err(StoreError::InvalidInput)
            }
            IssueMetadataReadOperation::Attachments | IssueMetadataReadOperation::WorkProducts
                if self.issue_id.as_ref().is_none_or(String::is_empty)
                    || self.board_user_context.is_some() =>
            {
                Err(StoreError::InvalidInput)
            }
            _ => Ok(()),
        }
    }
}
#[derive(Debug, thiserror::Error)]
pub enum IssueMetadataReadError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub(crate) fn timestamp_value(column: &str) -> String {
    format!(
        r#"(CASE WHEN NOT isfinite({column}) THEN NULL
 WHEN extract(year FROM {column})<1 OR extract(year FROM {column}) BETWEEN 13 AND 31
   OR mod(extract(timezone FROM {column}),60)<>0 THEN NULL
 WHEN extract(year FROM {column}) BETWEEN 1 AND 12 THEN
   make_timestamp(2000+extract(day FROM {column})::int,extract(year FROM {column})::int,
     extract(month FROM {column})::int,extract(hour FROM {column})::int,
     extract(minute FROM {column})::int,extract(second FROM {column})::double precision)
     - extract(timezone FROM {column})::double precision * INTERVAL '1 second'
 WHEN extract(year FROM {column}) BETWEEN 32 AND 99 THEN
   make_timestamp((CASE WHEN extract(year FROM {column})<50 THEN 2000 ELSE 1900 END)+extract(year FROM {column})::int,
     extract(month FROM {column})::int,extract(day FROM {column})::int,extract(hour FROM {column})::int,
     extract(minute FROM {column})::int,extract(second FROM {column})::double precision)
     - extract(timezone FROM {column})::double precision * INTERVAL '1 second'
 ELSE {column} AT TIME ZONE 'UTC' END)"#
    )
}
pub(crate) fn timestamp(column: &str) -> String {
    let stamp = timestamp_value(column);
    // Node Date parsing discards sub-millisecond digits before TimeClip checks
    // the upper boundary, so max Date plus 1 microsecond is still representable.
    format!(
        r#"(SELECT CASE WHEN stamp IS NULL OR extract(epoch FROM date_trunc('milliseconds',stamp))>8640000000000 THEN NULL
 ELSE CASE WHEN extract(year FROM stamp)>=10000 THEN '+' || to_char(extract(year FROM stamp),'FM000000')
 ELSE to_char(stamp,'YYYY') END || to_char(stamp,'-MM-DD"T"HH24:MI:SS.MS"Z"') END
 FROM (SELECT {stamp} AS stamp) legacy_date)"#
    )
}

// Metadata is opaque. Decode only a string-valued JSONB column once more, as
// Drizzle does, and keep deep objects and serde-private keys out of Value.
pub(crate) fn decoded_json_column(raw: &str) -> String {
    match serde_json::from_str::<String>(raw) {
        Ok(value) if serde_json::from_str::<serde::de::IgnoredAny>(&value).is_ok() => value,
        _ => raw.to_owned(),
    }
}
pub(crate) fn json_column(raw: &str) -> Result<String, serde_json::Error> {
    normalize_legacy_read_json(&decoded_json_column(raw))
}
pub(crate) fn append_field(mut row: String, name: &str, value: &str) -> String {
    row.pop();
    if row.len() > 1 {
        row.push(',');
    }
    row.push_str(&serde_json::to_string(name).expect("field name"));
    row.push(':');
    row.push_str(value);
    row.push('}');
    row
}
pub(crate) fn projection(fields: &[(&str, &str)], dates: &[(&str, &str)]) -> String {
    let mut items: Vec<String> = fields
        .iter()
        .map(|(key, value)| format!("'{key}',{value}"))
        .collect();
    items.extend(
        dates
            .iter()
            .map(|(key, value)| format!("'{key}',{}", timestamp(value))),
    );
    format!("jsonb_build_object({})::text", items.join(","))
}
fn attachment_projection() -> String {
    projection(
        &[
            ("id", "t.id"),
            ("orgId", "t.org_id"),
            ("issueId", "t.issue_id"),
            ("issueCommentId", "t.issue_comment_id"),
            ("assetId", "t.asset_id"),
            ("usage", "t.usage"),
            ("provider", "a.provider"),
            ("objectKey", "a.object_key"),
            ("contentType", "a.content_type"),
            ("byteSize", "a.byte_size"),
            ("sha256", "a.sha256"),
            ("originalFilename", "a.original_filename"),
            ("createdByAgentId", "a.created_by_agent_id"),
            ("createdByUserId", "a.created_by_user_id"),
            ("contentPath", "'/api/attachments/'||t.id::text||'/content'"),
        ],
        &[("createdAt", "t.created_at"), ("updatedAt", "t.updated_at")],
    )
}
fn work_product_projection() -> String {
    projection(
        &[
            ("id", "t.id"),
            ("orgId", "t.org_id"),
            ("projectId", "t.project_id"),
            ("issueId", "t.issue_id"),
            ("runWorkspaceId", "t.execution_workspace_id"),
            ("executionWorkspaceId", "t.execution_workspace_id"),
            ("runtimeServiceId", "t.runtime_service_id"),
            ("type", "t.type"),
            ("provider", "t.provider"),
            ("externalId", "t.external_id"),
            ("title", "t.title"),
            ("url", "t.url"),
            ("status", "t.status"),
            ("reviewState", "t.review_state"),
            ("isPrimary", "t.is_primary"),
            ("healthStatus", "t.health_status"),
            ("summary", "t.summary"),
            ("createdByRunId", "t.created_by_run_id"),
        ],
        &[("createdAt", "t.created_at"), ("updatedAt", "t.updated_at")],
    )
}
fn follows_projection() -> String {
    let issue = projection(
        &[
            ("id", "i.id"),
            ("identifier", "i.identifier"),
            ("title", "i.title"),
            ("status", "i.status"),
            ("priority", "i.priority"),
            ("assigneeAgentId", "i.assignee_agent_id"),
            ("assigneeUserId", "i.assignee_user_id"),
            ("reviewerUserId", "i.reviewer_user_id"),
            ("createdByUserId", "i.created_by_user_id"),
        ],
        &[("updatedAt", "i.updated_at")],
    );
    projection(
        &[
            ("id", "t.id"),
            ("orgId", "t.org_id"),
            ("issueId", "t.issue_id"),
            ("userId", "t.user_id"),
            ("issue", &format!("({issue})::jsonb")),
        ],
        &[("createdAt", "t.created_at")],
    )
}

pub async fn read_issue_metadata(
    pool: &PgPool,
    org: &str,
    input: &IssueMetadataReadInput,
    user_id: Option<&str>,
) -> Result<String, IssueMetadataReadError> {
    read_issue_metadata_inner(pool, org, input, user_id, None).await
}

/// Public ingress variant. It revalidates the established native credential
/// on the same read-only snapshot used to resolve and project Issue metadata.
pub async fn read_issue_metadata_with_native_auth(
    pool: &PgPool,
    org: &str,
    input: &IssueMetadataReadInput,
    user_id: Option<&str>,
    authorizer: &dyn NativeAgentAuthorizer,
) -> Result<String, IssueMetadataReadError> {
    read_issue_metadata_inner(pool, org, input, user_id, Some(authorizer)).await
}

async fn read_issue_metadata_inner(
    pool: &PgPool,
    org: &str,
    input: &IssueMetadataReadInput,
    user_id: Option<&str>,
    authorizer: Option<&dyn NativeAgentAuthorizer>,
) -> Result<String, IssueMetadataReadError> {
    input.validate()?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    if let Some(authorizer) = authorizer {
        match authorizer.revalidate(&mut tx, org).await? {
            NativeAgentAccess::Authorized => (),
            NativeAgentAccess::Unauthorized => {
                return Err(StoreError::PublicIdentityUnauthorized.into());
            }
            NativeAgentAccess::Forbidden => {
                return Err(StoreError::PublicIdentityForbidden.into());
            }
        }
    }
    if let Some(zone) = &input.legacy_date_timezone {
        sqlx::query("SELECT set_config('TimeZone',$1,true)")
            .bind(zone)
            .execute(&mut *tx)
            .await?;
    }
    let values = match input.operation {
        IssueMetadataReadOperation::Follows => {
            let user = user_id.ok_or(StoreError::InvalidInput)?;
            let query = format!(
                "SELECT {} FROM issue_follows t JOIN issues i ON i.id=t.issue_id AND i.org_id=t.org_id WHERE t.org_id=$1::uuid AND t.user_id=$2 AND i.hidden_at IS NULL ORDER BY t.created_at DESC",
                follows_projection()
            );
            sqlx::query_scalar::<_, String>(&query)
                .bind(org)
                .bind(user)
                .fetch_all(&mut *tx)
                .await?
                .into_iter()
                .map(|raw| normalize_legacy_read_json(&raw))
                .collect::<Result<Vec<_>, _>>()?
        }
        operation => {
            let id = input.issue_id.as_deref().ok_or(StoreError::InvalidInput)?;
            let actual = sqlx::query_scalar::<_, String>(
                "SELECT org_id::text FROM issues WHERE id=$1::uuid",
            )
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(StoreError::NotFound)?;
            if actual != org {
                return Err(StoreError::NotFound.into());
            }
            if operation == IssueMetadataReadOperation::Attachments {
                let query = format!(
                    "SELECT {} FROM issue_attachments t JOIN assets a ON a.id=t.asset_id AND a.org_id=t.org_id WHERE t.org_id=$1::uuid AND t.issue_id=$2::uuid AND t.usage='issue' ORDER BY t.created_at DESC",
                    attachment_projection()
                );
                sqlx::query_scalar::<_, String>(&query)
                    .bind(org)
                    .bind(id)
                    .fetch_all(&mut *tx)
                    .await?
                    .into_iter()
                    .map(|raw| normalize_legacy_read_json(&raw))
                    .collect::<Result<Vec<_>, _>>()?
            } else {
                let query = format!(
                    "SELECT {} AS value,t.metadata::text AS metadata FROM issue_work_products t WHERE t.org_id=$1::uuid AND t.issue_id=$2::uuid ORDER BY t.is_primary DESC,t.updated_at DESC",
                    work_product_projection()
                );
                let mut values = Vec::new();
                for row in sqlx::query(&query)
                    .bind(org)
                    .bind(id)
                    .fetch_all(&mut *tx)
                    .await?
                {
                    let metadata: Option<String> = row.try_get("metadata")?;
                    let raw: String = row.try_get("value")?;
                    values.push(append_field(
                        normalize_legacy_read_json(&raw)?,
                        "metadata",
                        &json_column(metadata.as_deref().unwrap_or("null"))?,
                    ));
                }
                values
            }
        }
    };
    tx.commit().await?;
    Ok(format!("[{}]", values.join(",")))
}
