//! Public organization list/detail projections shared by native ingress.
//!
//! The selected fields and derived values mirror the existing organization
//! service response. Authorization remains at the public ingress boundary;
//! callers pass the already-authorized organization scope for collection
//! reads and use a repeatable-read connection for both authorization and data.

use serde_json::{Value, json};
use sqlx::{PgConnection, Row};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Debug, Error)]
pub enum OrganizationReadError {
    #[error("organization read query failed")]
    Sql(#[from] sqlx::Error),
    #[error("organization read timestamp could not be formatted")]
    Timestamp(#[from] time::error::Format),
}

const ORGANIZATION_PROJECTION: &str = r#"
SELECT
  o.id::text AS id,
  o.url_key AS url_key,
  o.name AS name,
  o.description AS description,
  o.status AS status,
  o.pause_reason AS pause_reason,
  to_char(o.paused_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS paused_at,
  o.issue_prefix AS issue_prefix,
  o.issue_counter AS issue_counter,
  o.budget_monthly_cents AS budget_monthly_cents,
  COALESCE((
    SELECT sum(c.cost_cents)::integer
    FROM cost_events c
    WHERE c.org_id = o.id
      AND c.occurred_at >= (
        date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      )
      AND c.occurred_at < (
        (date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC') + interval '1 month')
          AT TIME ZONE 'UTC'
      )
  ), 0)::integer AS spent_monthly_cents,
  o.require_board_approval_for_new_agents AS require_board_approval_for_new_agents,
  o.default_chat_issue_creation_mode AS default_chat_issue_creation_mode,
  o.brand_color AS brand_color,
  ol.asset_id::text AS logo_asset_id,
  to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(o.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at,
  COALESCE((
    SELECT jsonb_agg(a.prefix)
    FROM organization_issue_prefix_aliases a
    WHERE a.org_id = o.id
  ), '[]'::jsonb) AS issue_prefix_aliases
FROM organizations o
LEFT JOIN organization_logos ol ON ol.org_id = o.id
"#;

/// Read the same unpaginated organization projection returned by the legacy
/// list route. `allowed_organization_ids == None` means unrestricted Board
/// context (local implicit or instance administrator).
pub async fn read_organizations(
    connection: &mut PgConnection,
    allowed_organization_ids: Option<&[String]>,
    now: OffsetDateTime,
) -> Result<Vec<Value>, OrganizationReadError> {
    let timestamp = now.format(&Rfc3339)?;
    let allowed_organization_ids = allowed_organization_ids.map(<[String]>::to_vec);
    let rows = sqlx::query(&format!(
        "{ORGANIZATION_PROJECTION} WHERE ($2::text[] IS NULL OR o.id::text = ANY($2))"
    ))
    .bind(timestamp)
    .bind(allowed_organization_ids)
    .fetch_all(&mut *connection)
    .await?;

    rows.into_iter().map(project_row).collect()
}

/// Read one organization after the caller has checked current access in the
/// same database snapshot. Invalid UUID-shaped input remains a database error,
/// matching the legacy route's query behavior.
pub async fn read_organization(
    connection: &mut PgConnection,
    organization_id: &str,
    now: OffsetDateTime,
) -> Result<Option<Value>, OrganizationReadError> {
    let timestamp = now.format(&Rfc3339)?;
    let row = sqlx::query(&format!("{ORGANIZATION_PROJECTION} WHERE o.id = $2::uuid"))
        .bind(timestamp)
        .bind(organization_id)
        .fetch_optional(&mut *connection)
        .await?;
    row.map(project_row).transpose()
}

fn project_row(row: sqlx::postgres::PgRow) -> Result<Value, OrganizationReadError> {
    let logo_asset_id: Option<String> = row.try_get("logo_asset_id")?;
    let logo_url = logo_asset_id
        .as_ref()
        .map(|asset_id| format!("/api/assets/{asset_id}/content"));

    Ok(json!({
        "id": row.try_get::<String, _>("id")?,
        "urlKey": row.try_get::<String, _>("url_key")?,
        "name": row.try_get::<String, _>("name")?,
        "description": row.try_get::<Option<String>, _>("description")?,
        "status": row.try_get::<String, _>("status")?,
        "pauseReason": row.try_get::<Option<String>, _>("pause_reason")?,
        "pausedAt": row.try_get::<Option<String>, _>("paused_at")?,
        "issuePrefix": row.try_get::<String, _>("issue_prefix")?,
        "issueCounter": row.try_get::<i32, _>("issue_counter")?,
        "budgetMonthlyCents": row.try_get::<i32, _>("budget_monthly_cents")?,
        "spentMonthlyCents": row.try_get::<i32, _>("spent_monthly_cents")?,
        "requireBoardApprovalForNewAgents": row.try_get::<bool, _>("require_board_approval_for_new_agents")?,
        "defaultChatIssueCreationMode": row.try_get::<String, _>("default_chat_issue_creation_mode")?,
        "brandColor": row.try_get::<Option<String>, _>("brand_color")?,
        "logoAssetId": logo_asset_id,
        "createdAt": row.try_get::<String, _>("created_at")?,
        "updatedAt": row.try_get::<String, _>("updated_at")?,
        "issuePrefixAliases": row.try_get::<Value, _>("issue_prefix_aliases")?,
        "workspace": Value::Null,
        "logoUrl": logo_url,
    }))
}
