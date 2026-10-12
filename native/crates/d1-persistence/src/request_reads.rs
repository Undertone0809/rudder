//! Requests GET authority: legacy table selection, combined projection and
//! payload redaction. Mutation handlers keep their existing owners.
pub(crate) mod redaction;
use crate::StoreError;
use serde::Deserialize;
use sqlx::{PgPool, Row};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RequestReadOperation {
    List,
    Detail,
    BlockAuditAttempts,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RequestReadInput {
    pub operation: RequestReadOperation,
    pub request_id: Option<String>,
    pub status: Option<String>,
    pub kind: Option<String>,
    pub legacy_date_timezone: Option<String>,
}
impl RequestReadInput {
    pub fn validate(&self) -> Result<(), StoreError> {
        if self.legacy_date_timezone.as_ref().is_some_and(|zone| {
            zone.is_empty() || zone.len() > 256 || zone.chars().any(char::is_control)
        }) {
            return Err(StoreError::InvalidInput);
        }
        if self.operation == RequestReadOperation::List {
            if self.request_id.is_some()
                || self
                    .status
                    .as_deref()
                    .is_some_and(|v| !matches!(v, "open" | "resolved" | "cancelled" | "superseded"))
                || self
                    .kind
                    .as_deref()
                    .is_some_and(|v| !matches!(v, "assistance" | "approval"))
            {
                return Err(StoreError::InvalidInput);
            }
        } else if self.request_id.is_none() || self.status.is_some() || self.kind.is_some() {
            return Err(StoreError::InvalidInput);
        }
        Ok(())
    }
}
#[derive(Debug, thiserror::Error)]
pub enum RequestReadError {
    #[error("Only Assistance Requests have Block Audit attempts")]
    NotAssistance,
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Sql(#[from] sqlx::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
fn timestamp_value(column: &str) -> String {
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

fn projection(table: &str) -> String {
    let fields: &[(&str, &str)] = match table {
        "requests" => &[
            ("id", "id"),
            ("orgId", "org_id"),
            ("kind", "kind"),
            ("subtype", "subtype"),
            ("status", "status"),
            ("issueId", "issue_id"),
            ("requestedByAgentId", "requested_by_agent_id"),
            ("requestedByUserId", "requested_by_user_id"),
            ("originRunId", "origin_run_id"),
            ("assigneeAgentId", "assignee_agent_id"),
            ("blockerFingerprint", "blocker_fingerprint"),
            ("supersededByRequestId", "superseded_by_request_id"),
            ("title", "title"),
            ("prompt", "prompt"),
            ("resolution", "resolution"),
            ("response", "response"),
            ("resolvedByUserId", "resolved_by_user_id"),
            ("metadata", "metadata"),
        ],
        "approvals" => &[
            ("id", "id"),
            ("orgId", "org_id"),
            ("type", "type"),
            ("requestedByAgentId", "requested_by_agent_id"),
            ("requestedByUserId", "requested_by_user_id"),
            ("status", "status"),
            ("payload", "payload"),
            ("decisionNote", "decision_note"),
            ("decidedByUserId", "decided_by_user_id"),
        ],
        _ => &[
            ("id", "id"),
            ("orgId", "org_id"),
            ("issueId", "issue_id"),
            ("requestId", "request_id"),
            ("runId", "run_id"),
            ("rootRunId", "root_run_id"),
            ("previousRunId", "previous_run_id"),
            ("agentId", "agent_id"),
            ("continuationKind", "continuation_kind"),
            ("eligible", "eligible"),
            ("failureClass", "failure_class"),
            ("blockerFingerprint", "blocker_fingerprint"),
            ("attemptNumber", "attempt_number"),
            ("requiredAttempts", "required_attempts"),
            ("statusBefore", "status_before"),
            ("statusAfter", "status_after"),
            ("resetReason", "reset_reason"),
            ("blockerReason", "blocker_reason"),
            ("requestedAction", "requested_action"),
        ],
    };
    let mut parts: Vec<String> = fields
        .iter()
        .map(|(key, col)| format!("'{key}',t.{col}"))
        .collect();
    let dates: &[(&str, &str)] = match table {
        "requests" => &[
            ("resolvedAt", "resolved_at"),
            ("createdAt", "created_at"),
            ("updatedAt", "updated_at"),
        ],
        "approvals" => &[
            ("decidedAt", "decided_at"),
            ("createdAt", "created_at"),
            ("updatedAt", "updated_at"),
        ],
        _ => &[("createdAt", "created_at")],
    };
    for (key, col) in dates {
        parts.push(format!("'{key}',{}", timestamp(&format!("t.{col}"))));
    }
    if table == "approvals" {
        parts.push(format!(
            "'kind','approval','subtype',t.type,'requestStatus',{}",
            approval_status()
        ));
    }
    format!("jsonb_build_object({})::text", parts.join(","))
}
fn approval_status() -> &'static str {
    "CASE WHEN t.status='cancelled' THEN 'cancelled' WHEN t.status IN ('approved','rejected') THEN 'resolved' ELSE 'open' END"
}
fn array(rows: Vec<String>) -> String {
    format!("[{}]", rows.join(","))
}

// Explicit total order: preserve the legacy parsed Date instant, floor to a
// whole UTC second, then UUID and table. Invalid dates follow all finite rows.
// This intentionally removes the old host-local Date string roundtrip.
fn list_time(column: &str) -> String {
    let stamp = timestamp_value(column);
    format!(
        "(SELECT CASE WHEN stamp IS NULL OR extract(epoch FROM date_trunc('milliseconds',stamp))>8640000000000 THEN NULL ELSE floor(extract(epoch FROM date_trunc('milliseconds',stamp))) END FROM (SELECT {stamp} AS stamp) list_date)"
    )
}

async fn list_requests(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
    input: &RequestReadInput,
) -> Result<String, RequestReadError> {
    let query = format!(
        "SELECT value,kind FROM (SELECT {} value,t.kind,{} sort_time,t.id,0 source FROM requests t WHERE t.org_id=$1::uuid AND ($2::text IS NULL OR t.status=$2) AND ($3::text IS NULL OR $3='assistance') UNION ALL SELECT {} value,'approval' kind,{} sort_time,t.id,1 source FROM approvals t WHERE t.org_id=$1::uuid AND ($2::text IS NULL OR ({})=$2) AND ($3::text IS NULL OR $3='approval')) combined ORDER BY sort_time DESC NULLS LAST,id DESC,source ASC",
        projection("requests"),
        list_time("t.updated_at"),
        projection("approvals"),
        list_time("t.updated_at"),
        approval_status()
    );
    let rows = sqlx::query(&query)
        .bind(org)
        .bind(input.status.as_deref())
        .bind(input.kind.as_deref())
        .fetch_all(&mut **tx)
        .await?;
    let mut output = Vec::with_capacity(rows.len());
    for row in rows {
        output.push(redaction::row(
            &row.try_get::<String, _>("value")?,
            row.try_get::<String, _>("kind")? == "approval",
        )?);
    }
    Ok(array(output))
}

pub async fn read_requests(
    pool: &PgPool,
    org: &str,
    input: &RequestReadInput,
) -> Result<String, RequestReadError> {
    input.validate()?;
    // A transaction keeps the global winner and its scoped projection coherent.
    // Repeatable-read prevents an intervening same-ID assistance insertion from
    // changing which row was authorized inside this native read.
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    if let Some(zone) = &input.legacy_date_timezone {
        sqlx::query("SELECT set_config('TimeZone', $1, true)")
            .bind(zone)
            .execute(&mut *tx)
            .await?;
    }
    if input.operation == RequestReadOperation::List {
        let output = list_requests(&mut tx, org, input).await?;
        tx.commit().await?;
        return Ok(output);
    }
    let output = {
        let id = input
            .request_id
            .as_deref()
            .ok_or(StoreError::InvalidInput)?;
        // Resolve before filtering by org: an unauthorized requests row must
        // mask an approval with the same ID, including a post-Node lookup race.
        let winner = sqlx::query("SELECT org_id::text,kind,source FROM (SELECT org_id,kind,0 source FROM requests WHERE id=$1::uuid UNION ALL SELECT org_id,'approval',1 FROM approvals WHERE id=$1::uuid) candidate ORDER BY source LIMIT 1")
            .bind(id).fetch_optional(&mut *tx).await?.ok_or(StoreError::NotFound)?;
        let winner_org: String = winner.try_get("org_id")?;
        if winner_org != org {
            return Err(StoreError::NotFound.into());
        }
        let kind: String = winner.try_get("kind")?;
        if input.operation == RequestReadOperation::BlockAuditAttempts {
            if kind != "assistance" {
                return Err(RequestReadError::NotAssistance);
            }
            let query = format!(
                "SELECT {} value FROM issue_block_audit_attempts t WHERE t.org_id=$1::uuid AND t.request_id=$2::uuid ORDER BY t.attempt_number ASC",
                projection("attempts")
            );
            let rows = sqlx::query_scalar::<_, String>(&query)
                .bind(org)
                .bind(id)
                .fetch_all(&mut *tx)
                .await?;
            array(
                rows.iter()
                    .map(|raw| redaction::row(raw, false))
                    .collect::<Result<_, _>>()?,
            )
        } else {
            let table = if winner.try_get::<i32, _>("source")? == 0 {
                "requests"
            } else {
                "approvals"
            };
            let query = format!(
                "SELECT {} FROM {table} t WHERE t.org_id=$1::uuid AND t.id=$2::uuid",
                projection(table)
            );
            let raw = sqlx::query_scalar::<_, String>(&query)
                .bind(org)
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or(StoreError::NotFound)?;
            redaction::row(&raw, kind == "approval")?
        }
    };
    tx.commit().await?;
    Ok(output)
}
