//! Dashboard and Budget overview selection/aggregation. Node supplies only a
//! signed clock and its trusted host-local month constructor.
use crate::{
    StoreError,
    activity_reads::{utc_date_text, utc_stamp},
    cost_reads::fixed_two,
    legacy_read_json::normalize_legacy_read_json,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::{Date, Month, OffsetDateTime};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OverviewReadOperation {
    DashboardSummary,
    BudgetOverview,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OverviewReadInput {
    pub operation: OverviewReadOperation,
    pub now_ms: i64,
    pub host_local_month_start_ms: i64,
    pub legacy_date_timezone: Option<String>,
}
fn month_start(year: i32, month: Month) -> Result<i64, StoreError> {
    let date = Date::from_calendar_date(year, month, 1).map_err(|_| StoreError::InvalidInput)?;
    Ok(date.midnight().assume_utc().unix_timestamp() * 1000)
}
fn utc_months(now_ms: i64) -> Result<[i64; 3], StoreError> {
    let now = OffsetDateTime::from_unix_timestamp(now_ms.div_euclid(1000))
        .map_err(|_| StoreError::InvalidInput)?;
    let (year, month) = (now.year(), now.month());
    Ok([
        month_start(year - i32::from(month == Month::January), month.previous())?,
        month_start(year, month)?,
        month_start(year + i32::from(month == Month::December), month.next())?,
    ])
}
impl OverviewReadInput {
    pub fn validate(&self) -> Result<(), StoreError> {
        let age = self
            .now_ms
            .checked_sub(self.host_local_month_start_ms)
            .ok_or(StoreError::InvalidInput)?;
        if [self.now_ms, self.host_local_month_start_ms]
            .iter()
            .any(|ms| ms.unsigned_abs() > 8_640_000_000_000_000)
            || !(0..32 * 86_400_000).contains(&age)
            || self.legacy_date_timezone.as_ref().is_some_and(|zone| {
                zone.is_empty() || zone.len() > 256 || zone.chars().any(char::is_control)
            })
        {
            return Err(StoreError::InvalidInput);
        }
        // Plausibility only: without the host zone, Rust cannot independently
        // reconstruct Node's local constructor. The signed adapter owns it.
        if !utc_months(self.now_ms)?
            .iter()
            .any(|boundary| self.host_local_month_start_ms.abs_diff(*boundary) <= 26 * 3_600_000)
        {
            return Err(StoreError::InvalidInput);
        }
        Ok(())
    }
    pub fn matches_issuance(&self, issued_at: u64) -> bool {
        self.now_ms >= 0 && issued_at == (self.now_ms as u64 / 1000).saturating_sub(1).max(1)
    }
}
#[derive(Debug, thiserror::Error)]
pub enum OverviewReadError {
    #[error("{0} not found")]
    MissingScope(&'static str),
    #[error(transparent)]
    Store(#[from] StoreError),
}
impl From<sqlx::Error> for OverviewReadError {
    fn from(error: sqlx::Error) -> Self {
        Self::Store(error.into())
    }
}
fn decode(raw: &str) -> Result<Value, OverviewReadError> {
    serde_json::from_str(raw).map_err(|_| StoreError::InvalidReceipt.into())
}
fn json_stamp(ms: i64) -> Result<String, StoreError> {
    let date =
        OffsetDateTime::from_unix_timestamp(ms / 1000).map_err(|_| StoreError::InvalidInput)?;
    Ok(format!(
        "{:04}-{:02}-01T00:00:00.000Z",
        date.year(),
        u8::from(date.month())
    ))
}
fn js_blank(value: &str) -> bool {
    value.chars().all(|ch| matches!(ch, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
const SCOPE_JOINS: &str = "LEFT JOIN organizations o ON r.scope_type='organization' AND o.id=r.scope_id AND o.id=r.org_id LEFT JOIN agents a ON r.scope_type='agent' AND a.id=r.scope_id AND a.org_id=r.org_id";
const SCOPE_COLUMNS: &str = "CASE WHEN r.scope_type='organization' THEN o.id ELSE a.id END::text scope_found,CASE WHEN r.scope_type='organization' THEN o.name ELSE a.name END scope_name,CASE WHEN r.scope_type='organization' THEN o.status='paused' OR o.paused_at IS NOT NULL ELSE a.status='paused' END scope_paused,CASE WHEN r.scope_type='organization' THEN o.pause_reason ELSE a.pause_reason END scope_pause_reason";
fn scope(
    row: &sqlx::postgres::PgRow,
    kind: &str,
) -> Result<(String, bool, Option<String>), OverviewReadError> {
    if row.try_get::<Option<String>, _>("scope_found")?.is_none() {
        return Err(OverviewReadError::MissingScope(if kind == "organization" {
            "Organization"
        } else {
            "Agent"
        }));
    }
    let name: String = row.try_get("scope_name")?;
    Ok((
        if kind == "agent" && js_blank(&name) {
            "agent".to_owned()
        } else {
            name
        },
        row.try_get("scope_paused")?,
        row.try_get("scope_pause_reason")?,
    ))
}
pub(crate) async fn budget_overview(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    start: i64,
    end: i64,
) -> Result<Value, OverviewReadError> {
    // Legacy scope resolution precedes observed-spend evaluation. In particular,
    // an unresolved scope must remain404 even when its org's SUM would overflow.
    // Overview uses raw PostgreSQL timestamps, then UUID for exact ties, in both
    // its policy and incident arrays. Date projection does not determine order.
    let rows = sqlx::query(&format!(r#"SELECT jsonb_build_object('policyId',r.id,'orgId',r.org_id,'scopeType',r.scope_type,'scopeId',r.scope_id,
      'metric',r.metric,'windowKind',r.window_kind,'amount',r.amount,'warnPercent',r.warn_percent,'hardStopEnabled',r.hard_stop_enabled,
      'notifyEnabled',r.notify_enabled,'isActive',r.is_active)::text payload,{SCOPE_COLUMNS},
      CASE WHEN (r.scope_type='organization' AND o.id IS NULL) OR (r.scope_type='agent' AND a.id IS NULL) THEN 0
      WHEN r.metric<>'billed_cents' THEN 0 ELSE (SELECT coalesce(sum(c.cost_cents),0)::int FROM cost_events c
      WHERE c.org_id=r.org_id AND (r.scope_type<>'agent' OR c.agent_id=r.scope_id)
      AND (r.window_kind<>'calendar_month_utc' OR (c.occurred_at>=to_timestamp($2::bigint::double precision/1000)
      AND c.occurred_at<to_timestamp($3::bigint::double precision/1000)))) END observed
      FROM budget_policies r {SCOPE_JOINS} WHERE r.org_id=$1::uuid AND r.is_active AND r.scope_type IN ('organization','agent') ORDER BY r.updated_at DESC,r.id DESC"#))
      .bind(org_id).bind(start).bind(end).fetch_all(&mut **tx).await?;
    let mut policies = Vec::with_capacity(rows.len());
    let mut paused_agents = 0;
    for row in rows {
        let mut value = decode(&row.try_get::<String, _>("payload")?)?;
        let kind = value["scopeType"]
            .as_str()
            .ok_or(StoreError::InvalidReceipt)?
            .to_owned();
        let (name, paused, pause_reason) = scope(&row, &kind)?;
        let observed = i64::from(row.try_get::<i32, _>("observed")?);
        let amount = value["amount"].as_i64().ok_or(StoreError::InvalidReceipt)?;
        let warn = value["warnPercent"]
            .as_i64()
            .ok_or(StoreError::InvalidReceipt)?;
        let status = if amount <= 0 {
            "ok"
        } else if observed >= amount {
            "hard_stop"
        } else if observed as f64 >= (amount as f64 * warn as f64 / 100.0).ceil() {
            "warning"
        } else {
            "ok"
        };
        let lifetime = value["windowKind"] == "lifetime";
        value["scopeName"] = json!(name);
        value["paused"] = json!(paused);
        value["pauseReason"] = json!(pause_reason);
        value["observedAmount"] = json!(observed);
        value["remainingAmount"] = json!(if amount > 0 {
            (amount - observed).max(0)
        } else {
            0
        });
        value["utilizationPercent"] = json!(if amount > 0 {
            fixed_two(observed as f64 / amount as f64 * 100.0)
        } else {
            0.0
        });
        value["status"] = json!(status);
        value["windowStart"] = json!(if lifetime {
            "1970-01-01T00:00:00.000Z".into()
        } else {
            json_stamp(start)?
        });
        value["windowEnd"] = json!(if lifetime {
            "9999-01-01T00:00:00.000Z".into()
        } else {
            json_stamp(end)?
        });
        if kind == "agent" && paused {
            paused_agents += 1;
        }
        policies.push(value);
    }
    let fields = [
        ("windowStart", "window_start"),
        ("windowEnd", "window_end"),
        ("resolvedAt", "resolved_at"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
    ];
    let parsed = fields
        .iter()
        .map(|(_, column)| format!("{} AS {column}", utc_stamp(&format!("r.{column}"))))
        .collect::<Vec<_>>()
        .join(",");
    let dates = fields
        .iter()
        .map(|(key, column)| format!("'{key}',{}", utc_date_text(&format!("d.{column}"))))
        .collect::<Vec<_>>()
        .join(",");
    let rows=sqlx::query(&format!(r#"SELECT jsonb_build_object('id',r.id,'orgId',r.org_id,'policyId',r.policy_id,
      'scopeType',r.scope_type,'scopeId',r.scope_id,'metric',r.metric,'windowKind',r.window_kind,'thresholdType',r.threshold_type,
      'amountLimit',r.amount_limit,'amountObserved',r.amount_observed,'status',r.status,'approvalId',r.approval_id,
      'approvalStatus',p.status,{dates})::text payload,{SCOPE_COLUMNS}
      FROM budget_incidents r {SCOPE_JOINS} LEFT JOIN approvals p ON p.id=r.approval_id AND p.org_id=r.org_id
      CROSS JOIN LATERAL (SELECT {parsed}) d WHERE r.org_id=$1::uuid AND r.status='open' AND r.scope_type IN ('organization','agent') ORDER BY r.created_at DESC,r.id DESC"#))
      .bind(org_id).fetch_all(&mut **tx).await?;
    let mut incidents = Vec::with_capacity(rows.len());
    let mut pending = 0;
    for row in rows {
        let mut value = decode(&row.try_get::<String, _>("payload")?)?;
        let kind = value["scopeType"]
            .as_str()
            .ok_or(StoreError::InvalidReceipt)?;
        let (name, _, _) = scope(&row, kind)?;
        value["scopeName"] = json!(name);
        if value["approvalStatus"] == "pending" {
            pending += 1;
        }
        incidents.push(value);
    }
    Ok(
        json!({"orgId":org_id,"policies":policies,"activeIncidents":incidents,"pausedAgentCount":paused_agents,"pendingApprovalCount":pending}),
    )
}
async fn dashboard(
    tx: &mut Transaction<'_, Postgres>,
    org_id: &str,
    input: &OverviewReadInput,
    start: i64,
    end: i64,
) -> Result<Value, OverviewReadError> {
    let budget = sqlx::query_scalar::<_, i32>(
        "SELECT budget_monthly_cents FROM organizations WHERE id=$1::uuid",
    )
    .bind(org_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(OverviewReadError::MissingScope("Organization"))?;
    let rows = sqlx::query(
        "SELECT status,count(*) count FROM agents WHERE org_id=$1::uuid GROUP BY status",
    )
    .bind(org_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut agents = json!({"active":0,"running":0,"paused":0,"error":0});
    for row in rows {
        let status: String = row.try_get("status")?;
        let key = if status == "idle" {
            "active"
        } else {
            status.as_str()
        };
        if ["active", "running", "paused", "error"].contains(&key) {
            agents[key] =
                json!(agents[key].as_i64().unwrap_or(0) + row.try_get::<i64, _>("count")?);
        }
    }
    let rows = sqlx::query(
        "SELECT status,count(*) count FROM issues WHERE org_id=$1::uuid GROUP BY status",
    )
    .bind(org_id)
    .fetch_all(&mut **tx)
    .await?;
    let mut tasks = json!({"open":0,"inProgress":0,"blocked":0,"done":0});
    for row in rows {
        let status: String = row.try_get("status")?;
        let count: i64 = row.try_get("count")?;
        if status != "done" && status != "cancelled" {
            tasks["open"] = json!(tasks["open"].as_i64().unwrap_or(0) + count);
        }
        let key = match status.as_str() {
            "in_progress" => Some("inProgress"),
            "blocked" => Some("blocked"),
            "done" => Some("done"),
            _ => None,
        };
        if let Some(key) = key {
            tasks[key] = json!(count);
        }
    }
    let pending = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM approvals WHERE org_id=$1::uuid AND status='pending'",
    )
    .bind(org_id)
    .fetch_one(&mut **tx)
    .await?;
    // The legacy Dashboard intentionally includes all future events after its
    // local lower boundary. Budget uses the independent UTC closed/open window.
    let spend=sqlx::query_scalar::<_,i32>("SELECT coalesce(sum(cost_cents),0)::int FROM cost_events WHERE org_id=$1::uuid AND occurred_at>=to_timestamp($2::bigint::double precision/1000)")
        .bind(org_id).bind(input.host_local_month_start_ms).fetch_one(&mut **tx).await?;
    let overview = budget_overview(tx, org_id, start, end).await?;
    Ok(
        json!({"orgId":org_id,"agents":agents,"tasks":tasks,"costs":{"monthSpendCents":spend,"monthBudgetCents":budget,
      "monthUtilizationPercent":if budget>0 {fixed_two(spend as f64/budget as f64*100.0)}else{0.0}},"pendingApprovals":pending,
      "budgets":{"activeIncidents":overview["activeIncidents"].as_array().map_or(0,Vec::len),"pendingApprovals":overview["pendingApprovalCount"],"pausedAgents":overview["pausedAgentCount"]}}),
    )
}
pub async fn read_overview(
    pool: &PgPool,
    org_id: &str,
    input: &OverviewReadInput,
) -> Result<String, OverviewReadError> {
    input.validate()?;
    let [_, start, end] = utc_months(input.now_ms)?;
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
    let value = match input.operation {
        OverviewReadOperation::BudgetOverview => {
            budget_overview(&mut tx, org_id, start, end).await?
        }
        OverviewReadOperation::DashboardSummary => {
            dashboard(&mut tx, org_id, input, start, end).await?
        }
    };
    tx.commit().await?;
    normalize_legacy_read_json(&value.to_string()).map_err(|_| StoreError::InvalidReceipt.into())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn ms(value: &str) -> i64 {
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
            .unwrap()
            .unix_timestamp()
            * 1000
    }
    #[test]
    fn trusted_local_constructor_handles_east_west_dst_and_utc_rollover() {
        for (now, start) in [
            ("2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z"),
            ("2026-03-01T00:00:00Z", "2026-02-28T10:00:00Z"),
            ("2026-03-01T00:00:00Z", "2026-02-01T10:00:00Z"),
            ("2017-10-15T12:00:00Z", "2017-10-01T04:00:00Z"),
            ("2026-12-31T20:00:00Z", "2026-12-31T10:00:00Z"),
        ] {
            let input = OverviewReadInput {
                operation: OverviewReadOperation::DashboardSummary,
                now_ms: ms(now),
                host_local_month_start_ms: ms(start),
                legacy_date_timezone: None,
            };
            assert!(input.validate().is_ok(), "{now} {start}");
        }
        assert_eq!(
            utc_months(ms("2026-12-31T23:59:59Z")).unwrap()[2],
            ms("2027-01-01T00:00:00Z")
        );
        assert_eq!(
            utc_months(ms("2028-02-29T23:59:59Z")).unwrap()[2],
            ms("2028-03-01T00:00:00Z")
        );
    }
    #[test]
    fn scope_name_uses_javascript_whitespace() {
        assert!(js_blank("\u{feff}\u{3000}"));
        assert!(!js_blank("\u{0085}"));
    }
}
