//! Read-only activity selection for every legacy and current row. Authorization
//! stays at the public Node boundary and is authenticated again by the private
//! foundation capability. No mutation-owner flags, write locks, or fallback.
use crate::{StoreError, legacy_read_json::normalize_legacy_read_json, transaction};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sqlx::{PgPool, Row};
use std::collections::BTreeMap;

type Object = BTreeMap<String, Box<RawValue>>;

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivityFilters {
    pub agent_id: Option<String>,
    pub user_id: Option<String>,
    pub actor_type: Option<String>,
    pub actor_id: Option<String>,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCursor {
    pub created_at: String,
    pub id: String,
}

pub enum ActivityRead {
    Organization {
        filters: ActivityFilters,
        page: Option<(i64, Option<ActivityCursor>)>,
    },
    IssueActivity {
        issue_id: String,
    },
    IssueRuns {
        issue_id: String,
    },
    RunIssues {
        run_id: String,
    },
}

// Explicit public columns prevent a future private DB column from becoming part
// of the API through to_jsonb(table). Opaque details never undergo a bounded
// recursive Value parse, so deep/large legacy metadata remains readable.
const EVENT: &str = r#"jsonb_build_object(
 'id', a.id, 'orgId', a.org_id, 'actorType', a.actor_type, 'actorId', a.actor_id,
 'action', a.action, 'entityType', a.entity_type, 'entityId', a.entity_id,
 'agentId', a.agent_id, 'runId', a.run_id, 'details', a.details,
 'idempotencyKey', a.idempotency_key,
 'createdAt', to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text"#;

// Match the former SQL prefilter, not the broader post-projection JS filter.
// The latter also ignores internal workspace keys and runs *after* pagination.
const LOW_SIGNAL_SQL: &str = r#"(
 a.action = 'issue.updated' AND jsonb_typeof(a.details) = 'object'
 AND (a.details ? 'description' OR a.details ? 'title')
 AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(
   CASE WHEN jsonb_typeof(a.details) = 'object' THEN a.details ELSE '{}'::jsonb END
 ) AS k(key) WHERE k.key NOT IN (
  'description','title','identifier','issueIdentifier','_previous','_references',
  'source','reopened','reopenedFrom','normalizedFromStatus','normalizedReason'))
)"#;

fn raw<T: Serialize>(value: &T) -> Result<Box<RawValue>, StoreError> {
    serde_json::value::to_raw_value(value).map_err(|_| StoreError::InvalidReceipt)
}

fn object(value: &str) -> Result<Object, StoreError> {
    serde_json::from_str(value).map_err(|_| StoreError::InvalidReceipt)
}

fn string(value: Option<&RawValue>) -> Option<String> {
    value.and_then(|value| serde_json::from_str::<String>(value.get()).ok())
}

// JS object spread is also defined for historical JSON arrays and primitives.
// Preserve it without recursively decoding or normalizing nested payloads.
fn spread(value: &str) -> Result<Object, StoreError> {
    let value = value.trim();
    match value.as_bytes().first() {
        Some(b'{') => object(value),
        Some(b'[') => {
            let values: Vec<Box<RawValue>> =
                serde_json::from_str(value).map_err(|_| StoreError::InvalidReceipt)?;
            Ok(values
                .into_iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v))
                .collect())
        }
        Some(b'"') => {
            let value: String =
                serde_json::from_str(value).map_err(|_| StoreError::InvalidReceipt)?;
            value
                .encode_utf16()
                .enumerate()
                .map(|(i, unit)| {
                    let value = RawValue::from_string(format!("\"\\u{unit:04x}\""))
                        .map_err(|_| StoreError::InvalidReceipt)?;
                    Ok((i.to_string(), value))
                })
                .collect()
        }
        _ => Ok(Object::new()),
    }
}

fn low_signal(event: &Object) -> Result<bool, StoreError> {
    if string(event.get("action").map(Box::as_ref)).as_deref() != Some("issue.updated") {
        return Ok(false);
    }
    let Some(details) = event.get("details").filter(|v| v.get().starts_with('{')) else {
        return Ok(false);
    };
    let details = object(details.get())?;
    let changed: Vec<_> = details
        .keys()
        .filter(|key| {
            !matches!(
                key.as_str(),
                "identifier"
                    | "issueIdentifier"
                    | "_previous"
                    | "_references"
                    | "source"
                    | "reopened"
                    | "reopenedFrom"
                    | "normalizedFromStatus"
                    | "normalizedReason"
                    | "executionWorkspaceId"
                    | "executionWorkspacePreference"
                    | "executionWorkspaceSettings"
                    | "currentExecutionWorkspace"
                    | "runWorkspaceId"
                    | "runWorkspacePreference"
                    | "runWorkspaceSettings"
                    | "currentRunWorkspace"
            )
        })
        .collect();
    Ok(!changed.is_empty()
        && changed
            .iter()
            .all(|key| matches!(key.as_str(), "title" | "description")))
}

fn visible(event: &Object, issue: bool) -> Result<bool, StoreError> {
    let action = string(event.get("action").map(Box::as_ref));
    Ok(action.as_deref() != Some("issue.execution_released")
        && !(issue && action.as_deref() == Some("issue.document_updated"))
        && !low_signal(event)?)
}

fn enrich_issue(
    event: &mut Object,
    identifier: Option<String>,
    title: Option<String>,
) -> Result<(), StoreError> {
    let identifier = identifier.filter(|s| !s.is_empty());
    let title = title.filter(|s| !s.is_empty());
    if string(event.get("entityType").map(Box::as_ref)).as_deref() != Some("issue")
        || (identifier.is_none() && title.is_none())
    {
        return Ok(());
    }
    let mut details = spread(event.get("details").map(|v| v.get()).unwrap_or("null"))?;
    for (value, enriched, fallback) in [
        (identifier, "issueIdentifier", "identifier"),
        (title, "issueTitle", "title"),
    ] {
        if let Some(value) = value {
            details.insert(enriched.to_owned(), raw(&value)?);
            if string(details.get(fallback).map(Box::as_ref)).is_none() {
                details.insert(fallback.to_owned(), raw(&value)?);
            }
        }
    }
    event.insert("details".to_owned(), raw(&details)?);
    Ok(())
}

fn serialize<T: Serialize>(value: &T) -> Result<String, StoreError> {
    let value = serde_json::to_string(value).map_err(|_| StoreError::InvalidReceipt)?;
    normalize_legacy_read_json(&value).map_err(|_| StoreError::InvalidReceipt)
}

/// The caller supplies validated page limits/cursors. All business selection,
/// joins, enrichment, low-signal filtering, and response shaping occur here.
pub async fn read_activity(
    pool: &PgPool,
    organization_id: &str,
    input: ActivityRead,
) -> Result<String, StoreError> {
    let org = organization_id.to_ascii_lowercase();
    transaction::uuid(&org)?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let response = match input {
        ActivityRead::Organization { filters, page } => {
            organization(&mut tx, &org, filters, page).await?
        }
        ActivityRead::IssueActivity { issue_id } => {
            issue_activity(&mut tx, &org, &issue_id).await?
        }
        ActivityRead::IssueRuns { issue_id } => issue_runs(&mut tx, &org, &issue_id).await?,
        ActivityRead::RunIssues { run_id } => run_issues(&mut tx, &org, &run_id).await?,
    };
    tx.commit().await?;
    Ok(response)
}

async fn organization(
    tx: &mut transaction::Tx<'_>,
    org: &str,
    filters: ActivityFilters,
    page: Option<(i64, Option<ActivityCursor>)>,
) -> Result<String, StoreError> {
    let (limit, cursor) = page
        .as_ref()
        .map(|(limit, cursor)| (Some(*limit + 1), cursor.as_ref()))
        .unwrap_or((None, None));
    let query = format!(
        r#"SELECT {EVENT} AS event, i.identifier, i.title,
 to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
 FROM activity_log a LEFT JOIN issues i ON a.entity_type='issue' AND i.org_id=a.org_id AND a.entity_id=i.id::text
 WHERE a.org_id=$1::uuid AND a.action NOT IN ('issue.read_marked','issue.execution_released')
 AND NOT {LOW_SIGNAL_SQL} AND (a.entity_type!='issue' OR i.hidden_at IS NULL)
 AND ($2::text IS NULL OR a.agent_id=$2::uuid OR (a.actor_type='agent' AND a.actor_id=$2))
 AND ($3::text IS NULL OR (a.actor_type='user' AND a.actor_id=$3))
 AND ($4::text IS NULL OR a.actor_type=$4) AND ($5::text IS NULL OR a.actor_id=$5)
 AND ($6::text IS NULL OR a.entity_type=$6) AND ($7::text IS NULL OR a.entity_id=$7)
 AND ($8::text IS NULL OR a.created_at<$8::timestamptz OR (a.created_at=$8::timestamptz AND a.id<$9::uuid))
 ORDER BY a.created_at DESC, a.id DESC LIMIT $10"#
    );
    let rows = sqlx::query(&query)
        .bind(org)
        .bind(&filters.agent_id)
        .bind(&filters.user_id)
        .bind(&filters.actor_type)
        .bind(&filters.actor_id)
        .bind(&filters.entity_type)
        .bind(&filters.entity_id)
        .bind(cursor.map(|c| c.created_at.as_str()))
        .bind(cursor.map(|c| c.id.as_str()))
        .bind(limit)
        .fetch_all(&mut **tx)
        .await?;
    let count = page
        .as_ref()
        .map(|(limit, _)| *limit as usize)
        .unwrap_or(rows.len());
    let more = rows.len() > count;
    let mut items = Vec::new();
    let mut last_cursor = None;
    for row in rows.iter().take(count) {
        let mut event = object(&row.try_get::<String, _>("event")?)?;
        last_cursor = Some(ActivityCursor {
            created_at: row.try_get("cursor_created_at")?,
            id: string(event.get("id").map(Box::as_ref)).ok_or(StoreError::InvalidReceipt)?,
        });
        enrich_issue(
            &mut event,
            row.try_get("identifier")?,
            row.try_get("title")?,
        )?;
        if visible(&event, false)? {
            items.push(event);
        }
    }
    if page.is_some() {
        // The transport supplies base64url encoding to keep cursor format in one
        // place; this private result is unwrapped before crossing the public API.
        let next = if more { last_cursor } else { None };
        #[derive(Serialize)]
        struct Page {
            items: Vec<Object>,
            cursor: Option<ActivityCursor>,
        }
        serialize(&Page {
            items,
            cursor: next,
        })
    } else {
        serialize(&items)
    }
}

async fn issue_activity(
    tx: &mut transaction::Tx<'_>,
    org: &str,
    issue_id: &str,
) -> Result<String, StoreError> {
    transaction::uuid(&issue_id.to_ascii_lowercase())?;
    let query = format!(
        "SELECT {EVENT} AS event FROM activity_log a WHERE a.org_id=$1::uuid AND a.entity_type='issue' AND a.entity_id=$2 AND a.action!='issue.read_marked' ORDER BY a.created_at DESC"
    );
    let mut events = Vec::new();
    for row in sqlx::query(&query)
        .bind(org)
        .bind(issue_id)
        .fetch_all(&mut **tx)
        .await?
    {
        let event = object(&row.try_get::<String, _>("event")?)?;
        if visible(&event, true)? {
            events.push(event);
        }
    }
    let query = format!(
        r#"SELECT {EVENT} AS event, c.title FROM activity_log a
 JOIN chat_conversations c ON a.entity_type='chat' AND a.entity_id=c.id::text AND c.org_id=a.org_id
 LEFT JOIN chat_context_links l ON l.conversation_id=c.id AND l.org_id=a.org_id AND l.entity_type='issue' AND l.entity_id=$2
 WHERE a.org_id=$1::uuid AND (
  (a.action='chat.issue_converted' AND a.details->>'issueId'=$2)
  OR (a.action='chat.context_linked' AND a.details->>'entityType'='issue' AND a.details->>'entityId'=$2)
  OR (a.action='chat.created' AND l.id IS NOT NULL AND coalesce((a.details->>'contextLinkCount')::int,0)>0))
 ORDER BY a.created_at DESC"#
    );
    for row in sqlx::query(&query)
        .bind(org)
        .bind(issue_id)
        .fetch_all(&mut **tx)
        .await?
    {
        let mut event = object(&row.try_get::<String, _>("event")?)?;
        let mut details = spread(event.get("details").map(|v| v.get()).unwrap_or("null"))?;
        details.insert(
            "conversationTitle".to_owned(),
            raw(&row.try_get::<Option<String>, _>("title")?)?,
        );
        event.insert("details".to_owned(), raw(&details)?);
        events.push(event);
    }
    // Stable millisecond ordering matches the old merge: issue rows precede chat
    // rows at equal JS timestamps, preserving each SQL source's microsecond order.
    events.sort_by_cached_key(|event| {
        std::cmp::Reverse(string(event.get("createdAt").map(Box::as_ref)).unwrap_or_default())
    });
    serialize(&events)
}

const ISSUE_RUNS_SQL: &str = r#"SELECT jsonb_build_object(
 'runId', r.id, 'status', r.status, 'agentId', r.agent_id,
 'startedAt', to_char(r.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'finishedAt', to_char(r.finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'createdAt', to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'invocationSource', r.invocation_source, 'triggerDetail', r.trigger_detail,
 'contextSnapshot', nullif(jsonb_strip_nulls(jsonb_build_object(
  'issueId', r.context_snapshot->'issueId', 'resumeFromRunId', r.context_snapshot->'resumeFromRunId',
  'passiveFollowup', CASE WHEN jsonb_typeof(r.context_snapshot->'passiveFollowup')='object' THEN jsonb_strip_nulls(jsonb_build_object(
   'attempt', r.context_snapshot->'passiveFollowup'->'attempt', 'maxAttempts', r.context_snapshot->'passiveFollowup'->'maxAttempts')) ELSE NULL END)), '{}'::jsonb),
 'usageJson', r.usage_json, 'resultJson', r.result_summary_json,
 'resultFallbackJson', CASE WHEN r.result_summary_json IS NULL THEN jsonb_strip_nulls(jsonb_build_object(
  'summary', left(r.result_json->>'summary',500), 'result', left(r.result_json->>'result',500),
  'message', left(r.result_json->>'message',500), 'error', left(r.result_json->>'error',500),
  'userMessage', left(r.result_json->>'userMessage',500), 'body', left(r.result_json->>'body',500),
  'stdout', left(r.result_json->>'stdout',32768), 'provider', left(r.result_json->>'provider',500),
  'biller', left(r.result_json->>'biller',500), 'model', left(r.result_json->>'model',500),
  'billingType', left(r.result_json->>'billingType',100), 'total_cost_usd', r.result_json->'total_cost_usd',
  'cost_usd', r.result_json->'cost_usd', 'costUsd', r.result_json->'costUsd')) ELSE NULL END
 )::text AS run
 FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND (
  r.context_snapshot->>'issueId'=$2 OR EXISTS (SELECT 1 FROM activity_log a
   WHERE a.org_id=$1::uuid AND a.entity_type='issue' AND a.entity_id=$2 AND a.run_id=r.id))
 ORDER BY r.created_at DESC, r.id DESC"#;

fn slice_utf16(value: &str, length: usize) -> Result<Box<RawValue>, StoreError> {
    let units: Vec<_> = value.encode_utf16().take(length).collect();
    let escaped = units
        .iter()
        .map(|unit| format!("\\u{unit:04x}"))
        .collect::<String>();
    RawValue::from_string(format!("\"{escaped}\"")).map_err(|_| StoreError::InvalidReceipt)
}

fn project_run(mut run: Object) -> Result<Object, StoreError> {
    let mut result = spread(
        run.remove("resultFallbackJson")
            .as_ref()
            .map(|v| v.get())
            .unwrap_or("null"),
    )?;
    if let Some(usage) = run.get("usageJson").filter(|v| v.get().starts_with('{')) {
        let usage = object(usage.get())?;
        for key in ["provider", "biller", "model", "billingType"] {
            if let Some(value) = string(usage.get(key).map(Box::as_ref)).filter(|v| !v.is_empty()) {
                result.insert(
                    key.to_owned(),
                    slice_utf16(&value, if key == "billingType" { 100 } else { 500 })?,
                );
            }
        }
    }
    result.extend(spread(
        run.get("resultJson").map(|v| v.get()).unwrap_or("null"),
    )?);
    run.insert(
        "resultJson".to_owned(),
        if result.is_empty() {
            raw(&Option::<()>::None)?
        } else {
            raw(&result)?
        },
    );
    Ok(run)
}

async fn issue_runs(
    tx: &mut transaction::Tx<'_>,
    org: &str,
    issue_id: &str,
) -> Result<String, StoreError> {
    transaction::uuid(&issue_id.to_ascii_lowercase())?;
    let mut runs = Vec::new();
    for row in sqlx::query(ISSUE_RUNS_SQL)
        .bind(org)
        .bind(issue_id)
        .fetch_all(&mut **tx)
        .await?
    {
        runs.push(project_run(object(&row.try_get::<String, _>("run")?)?)?);
    }
    serialize(&runs)
}

async fn run_issues(
    tx: &mut transaction::Tx<'_>,
    org: &str,
    run_id: &str,
) -> Result<String, StoreError> {
    transaction::uuid(&run_id.to_ascii_lowercase())?;
    // Querying the run again within the snapshot binds the context lookup to the
    // authorized org even if callers hold a valid ID from another organization.
    let context: Option<Option<String>> = sqlx::query_scalar("SELECT CASE WHEN jsonb_typeof(context_snapshot->'issueId')='string' THEN context_snapshot->>'issueId' ELSE NULL END FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(org).bind(run_id).fetch_optional(&mut **tx).await?;
    let Some(context) = context else {
        return Ok("[]".to_owned());
    };
    const PROJECTION: &str = "jsonb_build_object('issueId', i.id, 'identifier', i.identifier, 'title', i.title, 'status', i.status, 'priority', i.priority)::text";
    let query = format!(
        "SELECT {PROJECTION} AS issue, i.id::text AS issue_id FROM issues i WHERE i.org_id=$1::uuid AND i.hidden_at IS NULL AND EXISTS (SELECT 1 FROM activity_log a WHERE a.org_id=$1::uuid AND a.run_id=$2::uuid AND a.entity_type='issue' AND a.entity_id=i.id::text) ORDER BY i.id::text"
    );
    let rows = sqlx::query(&query)
        .bind(org)
        .bind(run_id)
        .fetch_all(&mut **tx)
        .await?;
    let mut issues = Vec::new();
    let mut context_present = false;
    for row in rows {
        context_present |= Some(row.try_get::<String, _>("issue_id")?).as_ref() == context.as_ref();
        issues.push(
            RawValue::from_string(row.try_get("issue")?).map_err(|_| StoreError::InvalidReceipt)?,
        );
    }
    if let Some(context) = context.filter(|value| !value.is_empty() && !context_present) {
        let query = format!(
            "SELECT {PROJECTION} FROM issues i WHERE i.org_id=$1::uuid AND i.id=$2::uuid AND i.hidden_at IS NULL"
        );
        let from_context: Option<String> = sqlx::query_scalar(&query)
            .bind(org)
            .bind(context)
            .fetch_optional(&mut **tx)
            .await?;
        if let Some(from_context) = from_context {
            issues.insert(
                0,
                RawValue::from_string(from_context).map_err(|_| StoreError::InvalidReceipt)?,
            );
        }
    }
    serialize(&issues)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn projection_preserves_deep_json_and_javascript_numbers() {
        let deep = format!("{}9007199254740993{}", "[".repeat(600), "]".repeat(600));
        let mut event = object(&format!(
            r#"{{"entityType":"issue","details":{{"payload":{deep},"title":9}}}}"#
        ))
        .unwrap();
        enrich_issue(
            &mut event,
            Some("RUD-1".into()),
            Some("Actual title".into()),
        )
        .unwrap();
        let output = serialize(&event).unwrap();
        assert!(output.contains("9007199254740992"));
        assert!(output.contains(r#""title":"Actual title""#));
        assert!(output.contains(&"[".repeat(600)));
    }
    #[test]
    fn filters_keep_internal_workspace_metadata_out_of_changed_keys() {
        assert!(low_signal(&object(r#"{"action":"issue.updated","details":{"title":"x","runWorkspaceId":"w","_previous":{}}}"#).unwrap()).unwrap());
        assert!(
            !low_signal(
                &object(r#"{"action":"issue.updated","details":{"title":"x","status":"done"}}"#)
                    .unwrap()
            )
            .unwrap()
        );
        assert!(
            !visible(
                &object(r#"{"action":"issue.execution_released"}"#).unwrap(),
                false
            )
            .unwrap()
        );
        assert!(
            !visible(
                &object(r#"{"action":"issue.document_updated"}"#).unwrap(),
                true
            )
            .unwrap()
        );
        assert!(
            visible(
                &object(r#"{"action":"issue.document_updated"}"#).unwrap(),
                false
            )
            .unwrap()
        );
    }
    #[test]
    fn result_precedence_and_utf16_lengths_match_node() {
        let value = project_run(object(r#"{"resultJson":{"model":"summary"},"usageJson":{"provider":"usage","model":"usage","other":3},"resultFallbackJson":{"provider":"fallback","body":"fallback"}}"#).unwrap()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&serialize(&value).unwrap()).unwrap();
        assert_eq!(
            parsed["resultJson"],
            json!({"provider":"usage","model":"summary","body":"fallback"})
        );
        assert!(
            !parsed
                .as_object()
                .unwrap()
                .contains_key("resultFallbackJson")
        );
        assert_eq!(slice_utf16("😀a", 1).unwrap().get(), r#""\ud83d""#);
        assert_eq!(spread(r#"[true,{"deep":2}]"#).unwrap().len(), 2);
        assert_eq!(spread(r#""😀""#).unwrap().len(), 2);
    }
}
