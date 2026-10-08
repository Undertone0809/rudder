//! Organization-scoped cost/finance read authority. All filtering, aggregation,
//! project attribution and response projection execute here, never in Node.
use crate::{
    StoreError,
    legacy_read_json::{normalize_legacy_read_json, parse_legacy_read_json},
    transaction,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CostReadOperation {
    Summary,
    ByAgent,
    Trend,
    ByAgentModel,
    ByProvider,
    ByBiller,
    ByProject,
    WindowSpend,
    FinanceSummary,
    FinanceByBiller,
    FinanceByKind,
    FinanceEvents,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Granularity {
    Hour,
    #[default]
    Day,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CostReadInput {
    pub operation: CostReadOperation,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    #[serde(default)]
    pub granularity: Granularity,
    pub agent_id: Option<String>,
    pub project_id: Option<String>,
    pub limit: Option<i64>,
    pub legacy_date_timezone: Option<String>,
}

impl CostReadInput {
    pub fn validate(&self) -> Result<(), StoreError> {
        if self
            .from_ms
            .zip(self.to_ms)
            .is_some_and(|(from, to)| from > to)
            || self.limit.is_some_and(|limit| !(1..=500).contains(&limit))
            || [self.from_ms, self.to_ms]
                .into_iter()
                .flatten()
                .any(|ms| ms.unsigned_abs() > 8_640_000_000_000_000)
        {
            return Err(StoreError::InvalidInput);
        }
        if self.legacy_date_timezone.as_ref().is_some_and(|zone| {
            zone.is_empty() || zone.len() > 256 || zone.chars().any(char::is_control)
        }) {
            return Err(StoreError::InvalidInput);
        }
        Ok(())
    }
}

// Every query takes the same six bound parameters. Timestamps originate in the
// authenticated adapter's existing Date parser. Database time owns rolling windows.
const INPUT: &str = r#"WITH input AS (
 SELECT $1::uuid org, (TIMESTAMP 'epoch' + ($2::bigint / 86400000) * INTERVAL '1 day' + ($2::bigint % 86400000) * INTERVAL '1 millisecond') AT TIME ZONE 'UTC' since,
 (TIMESTAMP 'epoch' + ($3::bigint / 86400000) * INTERVAL '1 day' + ($3::bigint % 86400000) * INTERVAL '1 millisecond') AT TIME ZONE 'UTC' until, $4::text agent,
 $5::text project, $6::bigint max_rows, date_trunc('milliseconds', CURRENT_TIMESTAMP) clock
)"#;
const COSTS: &str = r#", costs AS (
 SELECT c.*, CASE WHEN lower(c.provider) IN ('anthropic','claude')
 THEN c.input_tokens::bigint + c.cached_input_tokens::bigint
 ELSE c.input_tokens::bigint END prompt_tokens
 FROM cost_events c CROSS JOIN input i WHERE c.org_id=i.org
 AND (i.since IS NULL OR c.occurred_at >= i.since)
 AND (i.until IS NULL OR c.occurred_at <= i.until)
)"#;
const PROJECT_LINKS: &str = r#", run_project_links AS (
 SELECT DISTINCT ON (a.run_id) a.run_id, issues.project_id
 FROM activity_log a JOIN issues ON a.entity_type='issue' AND a.entity_id=issues.id::text
 CROSS JOIN input i WHERE a.org_id=i.org AND issues.org_id=i.org
 AND a.run_id IS NOT NULL AND issues.project_id IS NOT NULL
 ORDER BY a.run_id, a.created_at DESC, a.id DESC
)"#;
const TOTALS: &str = r#"coalesce(sum(c.cost_cents),0)::double precision AS "costCents",
 coalesce(sum(c.prompt_tokens),0)::double precision AS "inputTokens",
 coalesce(sum(c.cached_input_tokens),0)::double precision AS "cachedInputTokens",
 coalesce(sum(c.output_tokens),0)::double precision AS "outputTokens""#;
const RUN_TOTALS: &str = r#"count(DISTINCT CASE WHEN c.billing_type='metered_api' THEN c.heartbeat_run_id END) AS "apiRunCount",
 count(DISTINCT CASE WHEN c.billing_type IN ('subscription_included','subscription_overage') THEN c.heartbeat_run_id END) AS "subscriptionRunCount",
 coalesce(sum(CASE WHEN c.billing_type IN ('subscription_included','subscription_overage') THEN c.cached_input_tokens ELSE 0 END),0)::double precision AS "subscriptionCachedInputTokens",
 coalesce(sum(CASE WHEN c.billing_type IN ('subscription_included','subscription_overage') THEN c.prompt_tokens ELSE 0 END),0)::double precision AS "subscriptionInputTokens",
 coalesce(sum(CASE WHEN c.billing_type IN ('subscription_included','subscription_overage') THEN c.output_tokens ELSE 0 END),0)::double precision AS "subscriptionOutputTokens""#;
const FINANCE: &str = r#", finance AS (
 SELECT f.* FROM finance_events f CROSS JOIN input i WHERE f.org_id=i.org
 AND (i.since IS NULL OR f.occurred_at>=i.since) AND (i.until IS NULL OR f.occurred_at<=i.until)
)"#;
const FINANCE_TOTALS: &str = r#"coalesce(sum(CASE WHEN direction='debit' THEN amount_cents ELSE 0 END),0)::double precision AS "debitCents",
 coalesce(sum(CASE WHEN direction='credit' THEN amount_cents ELSE 0 END),0)::double precision AS "creditCents",
 coalesce(sum(CASE WHEN direction='debit' AND estimated THEN amount_cents ELSE 0 END),0)::double precision AS "estimatedDebitCents",
 count(*) AS "eventCount",
 coalesce(sum(CASE WHEN direction='debit' THEN amount_cents WHEN direction='credit' THEN -amount_cents::bigint ELSE 0 END),0)::double precision AS "netCents""#;

// postgres-js/Drizzle parsed the PostgreSQL text with JavaScript Date. Preserve
// its legacy small-year interpretation as well as extended ISO years, invalid
// BC/nonfinite dates and historical offsets containing unsupported seconds.
fn finance_timestamp(column: &str) -> String {
    format!(
        r#"(SELECT CASE WHEN stamp IS NULL OR extract(epoch FROM stamp)>8640000000000 THEN NULL
 ELSE CASE WHEN extract(year FROM stamp)>=10000 THEN '+' || to_char(extract(year FROM stamp),'FM000000')
 ELSE to_char(stamp,'YYYY') END || to_char(stamp,'-MM-DD"T"HH24:MI:SS.MS"Z"') END
 FROM (SELECT CASE WHEN NOT isfinite({column}) THEN NULL
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
 ELSE {column} AT TIME ZONE 'UTC' END AS stamp) legacy_date)"#
    )
}

fn query(input: &CostReadInput) -> String {
    use CostReadOperation::*;
    let (ctes, projection) = match input.operation {
        Summary => (
            COSTS.to_owned(),
            format!(
                r#"SELECT {TOTALS},
 coalesce(sum(c.prompt_tokens+c.output_tokens::bigint),0)::double precision AS "totalTokens",
 count(*) AS "eventCount", count(*) FILTER (WHERE c.prompt_tokens+c.output_tokens::bigint>0) AS "tokenEventCount"
 FROM costs c"#
            ),
        ),
        ByAgent => (
            COSTS.to_owned(),
            format!(
                r#"SELECT c.agent_id AS "agentId", a.name AS "agentName",
 a.icon AS "agentIcon", a.role AS "agentRole", a.status AS "agentStatus", {TOTALS}, {RUN_TOTALS},
 'included_in_input' AS "cachedInputTokenSemantics" FROM costs c
 LEFT JOIN agents a ON a.id=c.agent_id AND a.org_id=c.org_id
 GROUP BY c.agent_id,a.name,a.icon,a.role,a.status ORDER BY "costCents" DESC"#
            ),
        ),
        ByProvider => (
            COSTS.to_owned(),
            format!(
                r#"SELECT c.provider,c.biller,c.billing_type AS "billingType",c.model,
 {TOTALS}, {RUN_TOTALS}, 'included_in_input' AS "cachedInputTokenSemantics" FROM costs c
 GROUP BY c.provider,c.biller,c.billing_type,c.model ORDER BY "costCents" DESC"#
            ),
        ),
        ByBiller => (
            COSTS.to_owned(),
            format!(
                r#"SELECT c.biller,{TOTALS},{RUN_TOTALS},
 count(DISTINCT c.provider) AS "providerCount",count(DISTINCT c.model) AS "modelCount"
 FROM costs c GROUP BY c.biller ORDER BY "costCents" DESC"#
            ),
        ),
        ByAgentModel => (
            COSTS.to_owned(),
            format!(
                r#"SELECT c.agent_id AS "agentId",a.name AS "agentName",
 c.provider,c.biller,c.billing_type AS "billingType",c.model,{TOTALS},
 'included_in_input' AS "cachedInputTokenSemantics" FROM costs c
 LEFT JOIN agents a ON a.id=c.agent_id AND a.org_id=c.org_id
 GROUP BY c.agent_id,a.name,c.provider,c.biller,c.billing_type,c.model
 ORDER BY c.provider,c.biller,c.billing_type,c.model"#
            ),
        ),
        ByProject => (
            format!("{COSTS}{PROJECT_LINKS}"),
            format!(
                r#"SELECT p.id AS "projectId",p.name AS "projectName",{TOTALS}
 FROM costs c LEFT JOIN run_project_links r ON r.run_id=c.heartbeat_run_id
 LEFT JOIN projects p ON p.id=coalesce(c.project_id,r.project_id) AND p.org_id=c.org_id
 GROUP BY p.id,p.name ORDER BY "costCents" DESC"#
            ),
        ),
        Trend => {
            let bucket = match input.granularity {
                Granularity::Hour => {
                    r#"to_char(date_trunc('hour',c.occurred_at AT TIME ZONE 'UTC'),'YYYY-MM-DD"T"HH24:00:00.000"Z"')"#
                }
                Granularity::Day => {
                    "to_char(date_trunc('day',c.occurred_at AT TIME ZONE 'UTC'),'YYYY-MM-DD')"
                }
            };
            (
                format!("{COSTS}{PROJECT_LINKS}"),
                format!(
                    r#"SELECT {bucket} AS date,{TOTALS},
 coalesce(sum(c.prompt_tokens+c.output_tokens::bigint),0)::double precision AS "totalTokens",count(*) AS "eventCount"
 FROM costs c CROSS JOIN input i LEFT JOIN run_project_links r ON r.run_id=c.heartbeat_run_id
 WHERE (i.agent IS NULL OR c.agent_id=i.agent::uuid)
 AND (i.project IS NULL OR coalesce(c.project_id,r.project_id)=i.project::uuid)
 GROUP BY {bucket} ORDER BY date"#
                ),
            )
        }
        WindowSpend => (
            format!(
                "{COSTS}, windows(label,hours,position) AS (VALUES ('5h',5,1),('24h',24,2),('7d',168,3))"
            ),
            format!(
                r#"SELECT c.provider,CASE WHEN count(DISTINCT c.biller)=1 THEN min(c.biller) ELSE 'mixed' END biller,
 w.label AS "window", w.hours AS "windowHours",{TOTALS},'included_in_input' AS "cachedInputTokenSemantics"
 FROM costs c CROSS JOIN input i CROSS JOIN windows w
 WHERE c.occurred_at >= i.clock - w.hours * INTERVAL '1 hour'
 GROUP BY c.provider,w.label,w.hours,w.position ORDER BY w.position,"costCents" DESC"#
            ),
        ),
        FinanceSummary => (
            FINANCE.to_owned(),
            format!("SELECT {FINANCE_TOTALS} FROM finance"),
        ),
        FinanceByBiller => (
            FINANCE.to_owned(),
            format!(
                r#"SELECT biller,{FINANCE_TOTALS},count(DISTINCT event_kind) AS "kindCount"
 FROM finance GROUP BY biller ORDER BY "netCents" DESC,biller"#
            ),
        ),
        FinanceByKind => (
            FINANCE.to_owned(),
            format!(
                r#"SELECT event_kind AS "eventKind",{FINANCE_TOTALS},count(DISTINCT biller) AS "billerCount"
 FROM finance GROUP BY event_kind ORDER BY "netCents" DESC,event_kind"#
            ),
        ),
        FinanceEvents => {
            return format!(
                r#"{INPUT}{FINANCE} SELECT jsonb_build_object(
 'id',f.id,
 'orgId',f.org_id,
 'agentId',f.agent_id,
 'issueId',f.issue_id,
 'projectId',f.project_id,
 'goalId',f.goal_id,
 'heartbeatRunId',f.heartbeat_run_id,
 'costEventId',f.cost_event_id,
 'billingCode',f.billing_code,
 'description',f.description,
 'eventKind',f.event_kind,
 'direction',f.direction,
 'biller',f.biller,
 'provider',f.provider,
 'executionAgentRuntimeType',f.execution_agent_runtime_type,
 'pricingTier',f.pricing_tier,
 'region',f.region,
 'model',f.model,
 'quantity',f.quantity,
 'unit',f.unit,
 'amountCents',f.amount_cents,
 'currency',f.currency,
 'estimated',f.estimated,
 'externalInvoiceId',f.external_invoice_id,
 'metadataJson',f.metadata_json,
 'occurredAt',{occurred_at},
 'createdAt',{created_at})::text FROM finance f
 ORDER BY f.occurred_at DESC,f.created_at DESC LIMIT (SELECT max_rows FROM input)"#,
                occurred_at = finance_timestamp("f.occurred_at"),
                created_at = finance_timestamp("f.created_at"),
            );
        }
    };
    format!("{INPUT}{ctes} SELECT to_jsonb(result)::text FROM ({projection}) result")
}

/// A repeatable-read, read-only snapshot covers summary budget, spend and run
/// duration together. No mutation fencing, rollup backfill or provider calls.
pub async fn read_costs(
    pool: &PgPool,
    organization_id: &str,
    input: &CostReadInput,
) -> Result<String, StoreError> {
    let org = organization_id.to_ascii_lowercase();
    transaction::uuid(&org)?;
    input.validate()?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    if input.operation == CostReadOperation::FinanceEvents
        && let Some(zone) = &input.legacy_date_timezone
    {
        // SQLx starts sessions in UTC; postgres-js used the host connection's
        // timezone when parsing historical timestamp text. The signed host
        // context preserves that parsing behavior. Parameter binding prevents
        // SQL interpolation, and LOCAL configuration ends with this read-only tx.
        sqlx::query("SELECT set_config('TimeZone', $1, true)")
            .bind(zone)
            .execute(&mut *tx)
            .await?;
    }
    let rows: Vec<String> = sqlx::query_scalar(&query(input))
        .bind(&org)
        .bind(input.from_ms)
        .bind(input.to_ms)
        .bind(&input.agent_id)
        .bind(&input.project_id)
        .bind(input.limit.unwrap_or(100))
        .fetch_all(&mut *tx)
        .await?;
    if input.operation == CostReadOperation::FinanceEvents {
        let normalized = rows
            .iter()
            .map(|raw| normalize_legacy_read_json(raw).map_err(|_| StoreError::InvalidReceipt))
            .collect::<Result<Vec<_>, _>>()?;
        tx.commit().await?;
        return Ok(format!("[{}]", normalized.join(",")));
    }
    let mut values = rows
        .iter()
        .map(|raw| parse_legacy_read_json(raw).map_err(|_| StoreError::InvalidReceipt))
        .collect::<Result<Vec<_>, _>>()?;
    use CostReadOperation::*;
    let result = match input.operation {
        Summary => {
            let budget: Option<i32> = sqlx::query_scalar(
                "SELECT budget_monthly_cents FROM organizations WHERE id=$1::uuid",
            )
            .bind(&org)
            .fetch_optional(&mut *tx)
            .await?;
            let budget = budget.ok_or(StoreError::NotFound)?;
            let duration_sql = format!(
                r#"{INPUT} SELECT coalesce(sum(greatest(extract(epoch FROM (
 least(coalesce(h.finished_at,i.clock),coalesce(i.until,i.clock),i.clock)
 - greatest(h.started_at,coalesce(i.since,h.started_at))))*1000,0)),0)::double precision
 FROM heartbeat_runs h CROSS JOIN input i WHERE h.org_id=i.org AND h.started_at IS NOT NULL
 AND h.started_at<=least(coalesce(i.until,i.clock),i.clock)
 AND (i.since IS NULL OR h.finished_at IS NULL OR h.finished_at>=i.since)"#
            );
            let duration: f64 = sqlx::query_scalar(&duration_sql)
                .bind(&org)
                .bind(input.from_ms)
                .bind(input.to_ms)
                .bind(&input.agent_id)
                .bind(&input.project_id)
                .bind(input.limit.unwrap_or(100))
                .fetch_one(&mut *tx)
                .await?;
            let mut row = values.remove(0);
            let spend = row["costCents"]
                .as_f64()
                .ok_or(StoreError::InvalidReceipt)?;
            row.as_object_mut()
                .ok_or(StoreError::InvalidReceipt)?
                .remove("costCents");
            row["orgId"] = json!(organization_id);
            row["spendCents"] = json!(spend);
            row["budgetCents"] = json!(budget);
            row["utilizationPercent"] = json!(if budget > 0 {
                fixed_two(spend / f64::from(budget) * 100.0)
            } else {
                0.0
            });
            row["activeDurationMs"] = json!(duration);
            row
        }
        FinanceSummary => {
            let mut row = values.remove(0);
            row["orgId"] = json!(organization_id);
            row
        }
        FinanceEvents => unreachable!("opaque finance rows returned above"),
        _ => Value::Array(values),
    };
    tx.commit().await?;
    normalize_legacy_read_json(&result.to_string()).map_err(|_| StoreError::InvalidReceipt)
}

// Number(value.toFixed(2)) rounds the exact IEEE-754 value, with midpoint ties
// away from zero. Multiplying a float by 100 first introduces a second rounding.
fn fixed_two(value: f64) -> f64 {
    if !value.is_finite() || value.abs() >= 1e21 {
        return value;
    }
    let bits = value.abs().to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = if exponent == 0 {
        bits & ((1u64 << 52) - 1)
    } else {
        (bits & ((1u64 << 52) - 1)) | (1u64 << 52)
    };
    let power = if exponent == 0 {
        -1074
    } else {
        exponent - 1023 - 52
    };
    let scaled = u128::from(mantissa) * 100;
    let rounded = if power >= 0 {
        scaled << power
    } else {
        let shift = (-power) as u32;
        if shift >= 128 {
            0
        } else {
            (scaled >> shift)
                + u128::from((scaled & ((1u128 << shift) - 1)) >= (1u128 << (shift - 1)))
        }
    };
    // Parse the decimal representation, matching Number's decimal conversion.
    let text = format!(
        "{}{}.{:02}",
        if value.is_sign_negative() { "-" } else { "" },
        rounded / 100,
        rounded % 100
    );
    text.parse().unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utilization_matches_js_fixed_rounding() {
        for (input, expected) in [
            (2.675, 2.67),
            (2.625, 2.63),
            (-2.625, -2.63),
            (1.005, 1.0),
            (0.0, 0.0),
            (1e-100, 0.0),
            (125.125, 125.13),
        ] {
            assert_eq!(fixed_two(input), expected);
        }
    }
    #[test]
    fn rejects_unknown_operation_fields_and_invalid_ranges() {
        assert!(serde_json::from_str::<CostReadInput>(r#"{"operation":"proxy"}"#).is_err());
        assert!(
            serde_json::from_str::<CostReadInput>(r#"{"operation":"summary","sql":"select"}"#)
                .is_err()
        );
        for raw in [
            r#"{"operation":"summary","fromMs":2,"toMs":1}"#,
            r#"{"operation":"finance-events","limit":501}"#,
        ] {
            assert!(
                serde_json::from_str::<CostReadInput>(raw)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
    }
}
