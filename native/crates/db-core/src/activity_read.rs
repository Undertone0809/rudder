//! Private, read-only SQLx adapter for bounded activity and run evidence.
//!
//! The host must construct [`TrustedOrganizationScope`] from authenticated
//! organization state. The adapter never accepts an organization id from a
//! row, request payload, or cursor as its scope. Every request value is a bind
//! parameter; SQL fragments are fixed allowlisted projections only.
//!
//! This slice deliberately returns run-log metadata, not `log_ref`. A log
//! reference can be a local capability, so opening or reading it remains
//! outside this database adapter and is not reachable through these methods.

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rudder_read_surfaces_core::{OrganizationScope, Page, ReadError};
use rudder_run_evidence_core::RunLogMetadata;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{
    FromRow, PgPool, Postgres,
    postgres::{PgArguments, PgRow},
    query::QueryAs,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{ProjectionError, ReadAdapterError};

pub const MAX_ACTIVITY_PAGE_SIZE: usize = 100;
pub const MAX_RUN_PAGE_SIZE: usize = 100;
const PAGE_LOOKAHEAD: usize = 1;
const MAX_CURSOR_BYTES: usize = 4_096;
const MAX_JSON_BYTES: usize = 32 * 1024;
const MAX_ACTIVITY_TEXT: usize = 512;
const MAX_RUN_TEXT: usize = 512;
const MAX_EVENT_TEXT: usize = 4_096;
const REDACTED_VALUE: &str = "***REDACTED***";

/// An organization set captured from authenticated host state.
///
/// `from_host` is intentionally the only constructor. The database adapter
/// cannot turn a request-provided string into authorization context by itself.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedOrganizationScope {
    scope: OrganizationScope,
}

impl TrustedOrganizationScope {
    pub fn from_host(scope: OrganizationScope) -> Self {
        Self { scope }
    }

    pub fn as_scope(&self) -> &OrganizationScope {
        &self.scope
    }

    fn ids(&self) -> impl Iterator<Item = &str> {
        self.scope.ids()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CreatedCursor {
    created_at: String,
    id: String,
}

/// A bounded keyset page request for activity and run lists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivityPageRequest {
    limit: usize,
    cursor: Option<CreatedCursor>,
}

impl ActivityPageRequest {
    pub fn new(limit: usize) -> Result<Self, ReadError> {
        validate_limit(limit, MAX_ACTIVITY_PAGE_SIZE)?;
        Ok(Self {
            limit,
            cursor: None,
        })
    }

    pub fn with_cursor(limit: usize, cursor: impl Into<String>) -> Result<Self, ReadError> {
        validate_limit(limit, MAX_ACTIVITY_PAGE_SIZE)?;
        Ok(Self {
            limit,
            cursor: Some(decode_created_cursor(&cursor.into())?),
        })
    }

    pub fn limit(&self) -> usize {
        self.limit
    }

    pub fn cursor(&self) -> Option<String> {
        self.cursor.as_ref().map(encode_created_cursor)
    }
}

fn validate_limit(limit: usize, maximum: usize) -> Result<(), ReadError> {
    if !(1..=maximum).contains(&limit) {
        return Err(ReadError::InvalidPage { limit });
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ActivityListFilter {
    pub agent_id: Option<String>,
    pub actor_type: Option<String>,
    pub actor_id: Option<String>,
    pub action: Option<String>,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub run_id: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RunListFilter {
    pub agent_id: Option<String>,
    pub status: Option<String>,
    pub invocation_source: Option<String>,
    pub issue_id: Option<String>,
    pub goal_id: Option<String>,
}

/// Values carried by an activity/run query plan.
///
/// Keeping the values beside the SQL makes it possible to contract-test that
/// organization ids, filters, cursors, and limits never become SQL text.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ActivityReadBind {
    Text(String),
    Limit(usize),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivityReadQueryPlan {
    pub sql: String,
    pub binds: Vec<ActivityReadBind>,
}

pub type ActivityQueryPlan = ActivityReadQueryPlan;

#[derive(Clone, Debug, Default, FromRow, PartialEq)]
pub struct ActivityDbRow {
    pub id: String,
    pub org_id: String,
    pub actor_type: String,
    pub actor_id: String,
    pub action: String,
    pub entity_type: String,
    pub entity_id: String,
    pub agent_id: Option<String>,
    pub run_id: Option<String>,
    pub details: Option<Value>,
    pub issue_id: Option<String>,
    pub issue_identifier: Option<String>,
    pub issue_title: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, FromRow, PartialEq)]
pub struct RunDbRow {
    pub id: String,
    pub org_id: String,
    pub agent_id: String,
    pub agent_name: Option<String>,
    pub runtime: String,
    pub org_name: Option<String>,
    pub invocation_source: String,
    pub trigger_detail: Option<String>,
    pub status: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub error_summary: Option<String>,
    pub outcome_summary: Option<String>,
    pub source_run_id: Option<String>,
    pub goal_id: Option<String>,
    pub chat_conversation_id: Option<String>,
    pub issue_id: Option<String>,
    pub issue_identifier: Option<String>,
    pub issue_title: Option<String>,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub usage_input_tokens: Option<String>,
    pub usage_cached_input_tokens: Option<String>,
    pub usage_output_tokens: Option<String>,
    pub usage_cost_usd: Option<String>,
    pub usage_provider: Option<String>,
    pub usage_model: Option<String>,
    pub log_store: Option<String>,
    pub log_ref_present: bool,
    pub log_bytes: Option<i64>,
    pub log_sha256: Option<String>,
    pub log_compressed: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueEvidenceRef {
    pub id: String,
    pub identifier: Option<String>,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityProjection {
    pub id: String,
    pub org_id: String,
    pub actor_type: String,
    pub actor_id: String,
    pub action: String,
    pub entity_type: String,
    pub entity_id: String,
    pub agent_id: Option<String>,
    pub run_id: Option<String>,
    pub details: Option<Value>,
    pub issue: Option<IssueEvidenceRef>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTargetProjection {
    pub r#type: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunUsageProjection {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: Option<f64>,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummaryProjection {
    pub id: String,
    pub org_id: String,
    pub org_name: Option<String>,
    pub agent_id: String,
    pub agent_name: Option<String>,
    pub runtime: String,
    pub invocation_source: String,
    pub trigger_detail: Option<String>,
    pub status: String,
    pub source_run_id: Option<String>,
    pub goal_id: Option<String>,
    pub chat_conversation_id: Option<String>,
    pub issue: Option<IssueEvidenceRef>,
    pub target: Option<RunTargetProjection>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub outcome: Option<String>,
    pub error: Option<String>,
    pub usage: Option<RunUsageProjection>,
    pub log: RunLogMetadata,
}

const ACTIVITY_SELECT: &str = r#"SELECT
    al.id::text AS id,
    al.org_id::text AS org_id,
    left(al.actor_type, 64) AS actor_type,
    left(al.actor_id, 512) AS actor_id,
    left(al.action, 256) AS action,
    left(al.entity_type, 256) AS entity_type,
    left(al.entity_id, 512) AS entity_id,
    activity_agent.id::text AS agent_id,
    activity_run.id::text AS run_id,
    CASE
      WHEN al.details IS NULL THEN NULL::jsonb
      WHEN octet_length(al.details::text) <= 32768 THEN al.details
      ELSE jsonb_build_object('_truncated', true)
    END AS details,
    activity_issue.id::text AS issue_id,
    left(activity_issue.identifier, 256) AS issue_identifier,
    left(activity_issue.title, 500) AS issue_title,
    to_char(al.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
  FROM activity_log al
  LEFT JOIN issues activity_issue
    ON activity_issue.id::text = al.entity_id
   AND al.entity_type = 'issue'
   AND activity_issue.org_id = al.org_id
   AND activity_issue.hidden_at IS NULL
  LEFT JOIN agents activity_agent
    ON activity_agent.id = al.agent_id
   AND activity_agent.org_id = al.org_id
  LEFT JOIN heartbeat_runs activity_run
    ON activity_run.id = al.run_id
   AND activity_run.org_id = al.org_id"#;

const RUN_SELECT: &str = r#"SELECT
    r.id::text AS id,
    r.org_id::text AS org_id,
    r.agent_id::text AS agent_id,
    left(a.name, 256) AS agent_name,
    left(a.agent_runtime_type, 128) AS runtime,
    left(o.name, 256) AS org_name,
    left(r.invocation_source, 128) AS invocation_source,
    left(r.trigger_detail, 512) AS trigger_detail,
    left(r.status, 128) AS status,
    to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
    to_char(r.finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS finished_at,
    left(coalesce(r.error_code, r.error), 501) AS error_summary,
    left(coalesce(
      r.result_summary_json ->> 'summary',
      r.result_summary_json ->> 'result',
      r.result_summary_json ->> 'message',
      r.result_summary_json ->> 'userMessage'
    ), 501) AS outcome_summary,
    source_run.id::text AS source_run_id,
    run_goal.id::text AS goal_id,
    run_chat.id::text AS chat_conversation_id,
    run_issue.id::text AS issue_id,
    left(run_issue.identifier, 256) AS issue_identifier,
    left(run_issue.title, 500) AS issue_title,
    left(r.context_snapshot ->> 'targetType', 128) AS target_type,
    left(r.context_snapshot ->> 'targetId', 512) AS target_id,
    left(r.usage_json ->> 'inputTokens', 128) AS usage_input_tokens,
    left(coalesce(
      r.usage_json ->> 'cachedInputTokens',
      r.usage_json ->> 'cacheReadTokens'
    ), 128) AS usage_cached_input_tokens,
    left(r.usage_json ->> 'outputTokens', 128) AS usage_output_tokens,
    left(coalesce(
      r.usage_json ->> 'costUsd',
      r.usage_json ->> 'totalCostUsd'
    ), 128) AS usage_cost_usd,
    left(r.usage_json ->> 'provider', 256) AS usage_provider,
    left(r.usage_json ->> 'model', 256) AS usage_model,
    left(r.log_store, 128) AS log_store,
    (r.log_ref IS NOT NULL) AS log_ref_present,
    r.log_bytes,
    left(r.log_sha256, 128) AS log_sha256,
    r.log_compressed,
    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
  FROM heartbeat_runs r
  INNER JOIN agents a
    ON a.id = r.agent_id
   AND a.org_id = r.org_id
  INNER JOIN organizations o
    ON o.id = r.org_id
  LEFT JOIN issues run_issue
    ON run_issue.id::text = r.context_snapshot ->> 'issueId'
   AND run_issue.org_id = r.org_id
   AND run_issue.hidden_at IS NULL
  LEFT JOIN goals run_goal
    ON run_goal.id = r.goal_id
   AND run_goal.org_id = r.org_id
  LEFT JOIN heartbeat_runs source_run
    ON source_run.id = r.source_run_id
   AND source_run.org_id = r.org_id
  LEFT JOIN chat_conversations run_chat
    ON run_chat.id = r.chat_conversation_id
   AND run_chat.org_id = r.org_id"#;

const ACTIVITY_VISIBILITY: &str = r#"(
    al.action <> 'issue.read_marked'
    AND al.action <> 'issue.execution_released'
    AND NOT (
      al.action = 'issue.updated'
      AND COALESCE(jsonb_typeof(al.details) = 'object', FALSE)
      AND (
        COALESCE(al.details ? 'description', FALSE)
        OR COALESCE(al.details ? 'title', FALSE)
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_object_keys(
          CASE
            WHEN jsonb_typeof(al.details) = 'object' THEN al.details
            ELSE '{}'::jsonb
          END
        ) AS detail_key(key)
        WHERE detail_key.key NOT IN (
          'identifier', 'issueIdentifier', '_previous', '_references',
          'source', 'reopened', 'reopenedFrom', 'normalizedFromStatus',
          'normalizedReason'
        )
      )
    )
    AND (al.entity_type <> 'issue' OR activity_issue.id IS NOT NULL)
  )"#;

fn decode_created_cursor(encoded: &str) -> Result<CreatedCursor, ReadError> {
    if encoded.len() > MAX_CURSOR_BYTES {
        return Err(ReadError::InvalidCursor);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(|_| ReadError::InvalidCursor)?;
    let cursor: CreatedCursorWire =
        serde_json::from_slice(&bytes).map_err(|_| ReadError::InvalidCursor)?;
    if cursor.created_at.is_empty()
        || cursor.id.is_empty()
        || OffsetDateTime::parse(&cursor.created_at, &Rfc3339).is_err()
        || !is_canonical_uuid(&cursor.id)
    {
        return Err(ReadError::InvalidCursor);
    }
    Ok(CreatedCursor {
        created_at: cursor.created_at,
        id: cursor.id,
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedCursorWire {
    created_at: String,
    id: String,
}

fn encode_created_cursor(cursor: &CreatedCursor) -> String {
    URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&CreatedCursorWire {
            created_at: cursor.created_at.clone(),
            id: cursor.id.clone(),
        })
        .expect("cursor wire is serializable"),
    )
}

fn is_canonical_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn scoped_predicate(column: &str, bind_count: usize) -> String {
    if bind_count == 0 {
        return "FALSE".into();
    }
    if bind_count == 1 {
        return format!("{column} = $1::uuid");
    }
    let placeholders = (1..=bind_count)
        .map(|index| format!("${index}::uuid"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{column} IN ({placeholders})")
}

fn add_scope_binds(scope: &TrustedOrganizationScope, binds: &mut Vec<ActivityReadBind>) {
    binds.extend(scope.ids().map(|id| ActivityReadBind::Text(id.to_owned())));
}

fn append_created_cursor(
    alias: &str,
    cursor: Option<&CreatedCursor>,
    binds: &mut Vec<ActivityReadBind>,
    predicates: &mut Vec<String>,
) {
    let Some(cursor) = cursor else {
        return;
    };
    let created_bind = binds.len() + 1;
    let id_bind = created_bind + 1;
    predicates.push(format!(
        "({alias}.created_at < ${created_bind}::timestamptz OR ({alias}.created_at = ${created_bind}::timestamptz AND {alias}.id < ${id_bind}::uuid))"
    ));
    binds.push(ActivityReadBind::Text(cursor.created_at.clone()));
    binds.push(ActivityReadBind::Text(cursor.id.clone()));
}

fn append_activity_filters(
    filter: &ActivityListFilter,
    binds: &mut Vec<ActivityReadBind>,
    predicates: &mut Vec<String>,
) {
    if let Some(agent_id) = &filter.agent_id {
        let bind = binds.len() + 1;
        predicates.push(format!(
            "(al.agent_id = ${bind}::uuid OR (al.actor_type = 'agent' AND al.actor_id = ${bind}::text))"
        ));
        binds.push(ActivityReadBind::Text(agent_id.clone()));
    }
    for (column, value) in [
        ("al.actor_type", filter.actor_type.as_ref()),
        ("al.actor_id", filter.actor_id.as_ref()),
        ("al.action", filter.action.as_ref()),
        ("al.entity_type", filter.entity_type.as_ref()),
        ("al.entity_id", filter.entity_id.as_ref()),
    ] {
        if let Some(value) = value {
            let bind = binds.len() + 1;
            predicates.push(format!("{column} = ${bind}::text"));
            binds.push(ActivityReadBind::Text(value.clone()));
        }
    }
    if let Some(run_id) = &filter.run_id {
        let bind = binds.len() + 1;
        predicates.push(format!("al.run_id = ${bind}::uuid"));
        binds.push(ActivityReadBind::Text(run_id.clone()));
    }
}

fn append_run_filters(
    filter: &RunListFilter,
    binds: &mut Vec<ActivityReadBind>,
    predicates: &mut Vec<String>,
) {
    if let Some(agent_id) = &filter.agent_id {
        let bind = binds.len() + 1;
        predicates.push(format!("r.agent_id = ${bind}::uuid"));
        binds.push(ActivityReadBind::Text(agent_id.clone()));
    }
    for (column, value) in [
        ("r.status", filter.status.as_ref()),
        ("r.invocation_source", filter.invocation_source.as_ref()),
    ] {
        if let Some(value) = value {
            let bind = binds.len() + 1;
            predicates.push(format!("{column} = ${bind}::text"));
            binds.push(ActivityReadBind::Text(value.clone()));
        }
    }
    if let Some(issue_id) = &filter.issue_id {
        let bind = binds.len() + 1;
        predicates.push(format!(
            "run_issue.id = ${bind}::uuid AND r.context_snapshot ->> 'issueId' = ${bind}::text"
        ));
        binds.push(ActivityReadBind::Text(issue_id.clone()));
    }
    if let Some(goal_id) = &filter.goal_id {
        let bind = binds.len() + 1;
        predicates.push(format!("run_goal.id = ${bind}::uuid"));
        binds.push(ActivityReadBind::Text(goal_id.clone()));
    }
}

/// Build a bounded, organization-fenced activity list query.
pub fn list_activity_query_plan(
    scope: &TrustedOrganizationScope,
    filter: &ActivityListFilter,
    page: &ActivityPageRequest,
) -> Result<ActivityReadQueryPlan, ReadAdapterError> {
    let cursor = page.cursor.as_ref();
    let mut binds = Vec::new();
    add_scope_binds(scope, &mut binds);
    let mut predicates = vec![scoped_predicate("al.org_id", binds.len())];
    predicates.push(ACTIVITY_VISIBILITY.into());
    append_activity_filters(filter, &mut binds, &mut predicates);
    append_created_cursor("al", cursor, &mut binds, &mut predicates);
    let limit_bind = binds.len() + 1;
    binds.push(ActivityReadBind::Limit(page.limit() + PAGE_LOOKAHEAD));
    Ok(ActivityReadQueryPlan {
        sql: format!(
            "{ACTIVITY_SELECT} WHERE {} ORDER BY al.created_at DESC, al.id DESC LIMIT ${limit_bind}::int4",
            predicates.join(" AND ")
        ),
        binds,
    })
}

/// Build a bounded, organization-fenced run-summary list query.
pub fn list_run_query_plan(
    scope: &TrustedOrganizationScope,
    filter: &RunListFilter,
    page: &ActivityPageRequest,
) -> Result<ActivityReadQueryPlan, ReadAdapterError> {
    let cursor = page.cursor.as_ref();
    let mut binds = Vec::new();
    add_scope_binds(scope, &mut binds);
    let mut predicates = vec![scoped_predicate("r.org_id", binds.len())];
    append_run_filters(filter, &mut binds, &mut predicates);
    append_created_cursor("r", cursor, &mut binds, &mut predicates);
    let limit_bind = binds.len() + 1;
    binds.push(ActivityReadBind::Limit(page.limit() + PAGE_LOOKAHEAD));
    Ok(ActivityReadQueryPlan {
        sql: format!(
            "{RUN_SELECT} WHERE {} ORDER BY r.created_at DESC, r.id DESC LIMIT ${limit_bind}::int4",
            predicates.join(" AND ")
        ),
        binds,
    })
}

trait QueryPlanBindings {
    fn bind_query_as<'q, O>(&'q self) -> QueryAs<'q, Postgres, O, PgArguments>
    where
        O: for<'r> FromRow<'r, PgRow>;
}

impl QueryPlanBindings for ActivityReadQueryPlan {
    fn bind_query_as<'q, O>(&'q self) -> QueryAs<'q, Postgres, O, PgArguments>
    where
        O: for<'r> FromRow<'r, PgRow>,
    {
        let mut query = sqlx::query_as::<_, O>(&self.sql);
        for bind in &self.binds {
            query = match bind {
                ActivityReadBind::Text(value) => query.bind(value.clone()),
                ActivityReadBind::Limit(value) => query.bind(*value as i32),
            };
        }
        query
    }
}

trait CreatedCursorRow {
    fn id(&self) -> &str;
    fn created_at(&self) -> &str;
}

impl CreatedCursorRow for ActivityDbRow {
    fn id(&self) -> &str {
        &self.id
    }

    fn created_at(&self) -> &str {
        &self.created_at
    }
}

impl CreatedCursorRow for RunDbRow {
    fn id(&self) -> &str {
        &self.id
    }

    fn created_at(&self) -> &str {
        &self.created_at
    }
}

fn page_created_rows<T, U>(
    mut rows: Vec<T>,
    page: &ActivityPageRequest,
    mut project: impl FnMut(T) -> Result<U, ProjectionError>,
) -> Result<Page<U>, ReadAdapterError>
where
    T: CreatedCursorRow,
{
    let has_more = rows.len() > page.limit();
    rows.truncate(page.limit());
    let next_cursor = has_more
        .then(|| {
            rows.last().map(|row| {
                encode_created_cursor(&CreatedCursor {
                    created_at: row.created_at().to_owned(),
                    id: row.id().to_owned(),
                })
            })
        })
        .flatten();
    let items = rows
        .into_iter()
        .map(&mut project)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Page {
        items,
        next_cursor,
        has_more,
    })
}

/// SQLx repository for the bounded activity/run read slice.
#[derive(Clone)]
pub struct ActivityRunReadRepository {
    pool: PgPool,
}

pub type ActivityReadRepository = ActivityRunReadRepository;

impl ActivityRunReadRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self::new(pool)
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn list_activity(
        &self,
        scope: &TrustedOrganizationScope,
        filter: ActivityListFilter,
        page: ActivityPageRequest,
    ) -> Result<Page<ActivityProjection>, ReadAdapterError> {
        let plan = list_activity_query_plan(scope, &filter, &page)?;
        let rows = plan
            .bind_query_as::<ActivityDbRow>()
            .fetch_all(&self.pool)
            .await?;
        page_created_rows(rows, &page, ActivityDbRow::into_projection)
    }

    pub async fn list_runs(
        &self,
        scope: &TrustedOrganizationScope,
        filter: RunListFilter,
        page: ActivityPageRequest,
    ) -> Result<Page<RunSummaryProjection>, ReadAdapterError> {
        let plan = list_run_query_plan(scope, &filter, &page)?;
        let rows = plan
            .bind_query_as::<RunDbRow>()
            .fetch_all(&self.pool)
            .await?;
        page_created_rows(rows, &page, RunDbRow::into_projection)
    }
}

impl ActivityDbRow {
    pub fn into_projection(self) -> Result<ActivityProjection, ProjectionError> {
        let issue_identifier = self
            .issue_identifier
            .clone()
            .map(|value| safe_text(value, MAX_ACTIVITY_TEXT));
        let issue_title = self
            .issue_title
            .clone()
            .map(|value| safe_text(value, MAX_ACTIVITY_TEXT));
        let issue = self.issue_id.clone().map(|id| IssueEvidenceRef {
            id,
            identifier: issue_identifier,
            title: issue_title,
        });
        let mut details = redact_bounded_json(self.details);
        if let Some(issue) = &issue {
            if let Some(Value::Object(mut object)) = details.take() {
                add_issue_detail_fields(&mut object, issue);
                details = Some(Value::Object(object));
            } else if issue.identifier.is_some() || issue.title.is_some() {
                let mut object = Map::new();
                add_issue_detail_fields(&mut object, issue);
                details = Some(Value::Object(object));
            }
        }
        Ok(ActivityProjection {
            id: self.id,
            org_id: self.org_id,
            actor_type: safe_text(self.actor_type, MAX_ACTIVITY_TEXT),
            actor_id: safe_text(self.actor_id, MAX_ACTIVITY_TEXT),
            action: safe_text(self.action, MAX_ACTIVITY_TEXT),
            entity_type: safe_text(self.entity_type, MAX_ACTIVITY_TEXT),
            entity_id: safe_text(self.entity_id, MAX_ACTIVITY_TEXT),
            agent_id: self.agent_id,
            run_id: self.run_id,
            details,
            issue,
            created_at: self.created_at,
        })
    }
}

fn add_issue_detail_fields(object: &mut Map<String, Value>, issue: &IssueEvidenceRef) {
    if let Some(identifier) = &issue.identifier {
        object
            .entry("issueIdentifier")
            .or_insert_with(|| Value::String(identifier.clone()));
        object
            .entry("identifier")
            .or_insert_with(|| Value::String(identifier.clone()));
    }
    if let Some(title) = &issue.title {
        object
            .entry("issueTitle")
            .or_insert_with(|| Value::String(title.clone()));
        object
            .entry("title")
            .or_insert_with(|| Value::String(title.clone()));
    }
}

impl RunDbRow {
    pub fn into_projection(self) -> Result<RunSummaryProjection, ProjectionError> {
        let bytes = match self.log_bytes {
            Some(value) => u64::try_from(value).map_err(|_| ProjectionError::InvalidObject {
                entity: "run",
                field: "log_bytes",
            })?,
            None => 0,
        };
        let log_available = self.log_ref_present && self.log_store.is_some();
        let issue_identifier = self
            .issue_identifier
            .map(|value| safe_text(value, MAX_RUN_TEXT));
        let issue_title = self.issue_title.map(|value| safe_text(value, MAX_RUN_TEXT));
        let issue = self.issue_id.map(|id| IssueEvidenceRef {
            id,
            identifier: issue_identifier,
            title: issue_title,
        });
        let target = match (self.target_type, self.target_id) {
            (Some(r#type), Some(id)) => Some(RunTargetProjection {
                r#type: safe_text(r#type, MAX_RUN_TEXT),
                id: safe_text(id, MAX_RUN_TEXT),
            }),
            _ => None,
        };
        let usage = usage_projection(
            self.usage_input_tokens.as_deref(),
            self.usage_cached_input_tokens.as_deref(),
            self.usage_output_tokens.as_deref(),
            self.usage_cost_usd.as_deref(),
            self.usage_provider.as_deref(),
            self.usage_model.as_deref(),
        );
        let started_at = self.started_at;
        let finished_at = self.finished_at;
        let duration_ms = duration_millis(started_at.as_deref(), finished_at.as_deref());
        Ok(RunSummaryProjection {
            id: self.id,
            org_id: self.org_id,
            org_name: self.org_name.map(|value| safe_text(value, MAX_RUN_TEXT)),
            agent_id: self.agent_id,
            agent_name: self.agent_name.map(|value| safe_text(value, MAX_RUN_TEXT)),
            runtime: safe_text(self.runtime, MAX_RUN_TEXT),
            invocation_source: safe_text(self.invocation_source, MAX_RUN_TEXT),
            trigger_detail: self
                .trigger_detail
                .map(|value| safe_text(value, MAX_RUN_TEXT)),
            status: safe_text(self.status, MAX_RUN_TEXT),
            source_run_id: self.source_run_id,
            goal_id: self.goal_id,
            chat_conversation_id: self.chat_conversation_id,
            issue,
            target,
            started_at,
            finished_at,
            duration_ms,
            created_at: self.created_at,
            updated_at: self.updated_at,
            outcome: self
                .outcome_summary
                .map(|value| safe_text(value, MAX_EVENT_TEXT)),
            error: self
                .error_summary
                .map(|value| safe_text(value, MAX_EVENT_TEXT)),
            usage,
            log: RunLogMetadata {
                available: log_available,
                bytes,
                sha256: log_available.then_some(self.log_sha256).flatten(),
                compressed: self.log_compressed,
                store: log_available
                    .then_some(self.log_store)
                    .flatten()
                    .map(|value| safe_text(value, MAX_RUN_TEXT)),
            },
        })
    }
}

fn duration_millis(started_at: Option<&str>, finished_at: Option<&str>) -> Option<i64> {
    let started_at = OffsetDateTime::parse(started_at?, &Rfc3339).ok()?;
    let finished_at = OffsetDateTime::parse(finished_at?, &Rfc3339).ok()?;
    i64::try_from((finished_at - started_at).whole_milliseconds().max(0)).ok()
}

fn parse_u64(value: Option<&str>) -> Option<u64> {
    value?.parse::<u64>().ok()
}

fn parse_cost(value: Option<&str>) -> Option<f64> {
    let value = value?.parse::<f64>().ok()?;
    value
        .is_finite()
        .then_some(value)
        .filter(|value| *value >= 0.0)
}

fn usage_projection(
    input_tokens: Option<&str>,
    cached_input_tokens: Option<&str>,
    output_tokens: Option<&str>,
    cost_usd: Option<&str>,
    provider: Option<&str>,
    model: Option<&str>,
) -> Option<RunUsageProjection> {
    let input_tokens = parse_u64(input_tokens).unwrap_or(0);
    let cached_input_tokens = parse_u64(cached_input_tokens).unwrap_or(0);
    let output_tokens = parse_u64(output_tokens).unwrap_or(0);
    let cost_usd = parse_cost(cost_usd);
    let provider = provider
        .filter(|value| !value.is_empty())
        .map(|value| safe_text(value.to_owned(), MAX_RUN_TEXT));
    let model = model
        .filter(|value| !value.is_empty())
        .map(|value| safe_text(value.to_owned(), MAX_RUN_TEXT));
    let has_usage = input_tokens > 0
        || cached_input_tokens > 0
        || output_tokens > 0
        || cost_usd.is_some()
        || provider.is_some()
        || model.is_some();
    has_usage.then(|| RunUsageProjection {
        input_tokens,
        cached_input_tokens,
        output_tokens,
        total_tokens: input_tokens
            .saturating_add(cached_input_tokens)
            .saturating_add(output_tokens),
        cost_usd,
        provider,
        model,
    })
}

fn clip_text(value: String, maximum: usize) -> String {
    let mut characters = value.chars();
    let clipped = characters.by_ref().take(maximum).collect::<String>();
    if characters.next().is_some() {
        let mut output = clipped
            .chars()
            .take(maximum.saturating_sub(1))
            .collect::<String>();
        output.push('…');
        output
    } else {
        clipped
    }
}

fn safe_text(value: String, maximum: usize) -> String {
    clip_text(redact_text(value), maximum)
}

fn redact_bounded_json(value: Option<Value>) -> Option<Value> {
    value.map(|value| {
        let redacted = redact_json_value(value);
        let size = serde_json::to_vec(&redacted)
            .map(|bytes| bytes.len())
            .unwrap_or(MAX_JSON_BYTES + 1);
        if size > MAX_JSON_BYTES {
            json!({"_truncated": true})
        } else {
            redacted
        }
    })
}

fn redact_json_value(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(redact_json_value).collect()),
        Value::Object(object) => {
            let mut redacted = Map::new();
            for (key, value) in object {
                let value = if is_secret_key(&key) {
                    redact_secret_value(value)
                } else {
                    redact_json_value(value)
                };
                redacted.insert(key, value);
            }
            Value::Object(redacted)
        }
        Value::String(value) => Value::String(redact_text(value)),
        other => other,
    }
}

fn is_secret_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| !matches!(character, '-' | '_'))
        .collect::<String>()
        .to_ascii_lowercase();
    normalized == "token"
        || normalized.contains("apikey")
        || normalized.contains("accesstoken")
        || normalized.contains("authtoken")
        || normalized.contains("authorization")
        || normalized.contains("bearer")
        || normalized.contains("secret")
        || normalized.contains("passwd")
        || normalized.contains("password")
        || normalized.contains("credential")
        || normalized.contains("jwt")
        || normalized.contains("privatekey")
        || normalized.contains("cookie")
        || normalized.contains("connectionstring")
}

fn redact_secret_value(value: Value) -> Value {
    if let Value::Object(object) = &value {
        if object.get("type").and_then(Value::as_str) == Some("secret_ref")
            && object.get("secretId").and_then(Value::as_str).is_some()
        {
            return value;
        }
        if object.get("type").and_then(Value::as_str) == Some("plain")
            && object.contains_key("value")
        {
            return json!({"type": "plain", "value": REDACTED_VALUE});
        }
    }
    Value::String(REDACTED_VALUE.into())
}

fn redact_text(value: String) -> String {
    if value.contains("-----BEGIN") && value.contains("PRIVATE KEY-----") {
        return "[REDACTED_PRIVATE_KEY]".into();
    }
    let words = value.split_whitespace().collect::<Vec<_>>();
    if words.is_empty() {
        return value;
    }
    let mut redacted = Vec::with_capacity(words.len());
    let mut redact_next = false;
    for word in words {
        if redact_next {
            redacted.push("[REDACTED]");
            redact_next = false;
        } else if word.eq_ignore_ascii_case("bearer") {
            redacted.push(word);
            redact_next = true;
        } else if looks_like_secret_token(word) {
            redacted.push("[REDACTED_SECRET]");
        } else {
            redacted.push(word);
        }
    }
    redacted.join(" ")
}

fn looks_like_secret_token(value: &str) -> bool {
    if value.starts_with("ghp_")
        || value.starts_with("gho_")
        || value.starts_with("ghu_")
        || value.starts_with("ghs_")
        || value.starts_with("ghr_")
        || value.starts_with("github_pat_")
        || value.starts_with("sk-")
    {
        return value.len() >= 20;
    }
    let parts = value.split('.').collect::<Vec<_>>();
    (parts.len() == 3 || parts.len() == 4)
        && parts.iter().all(|part| {
            part.len() >= 8
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
}

#[cfg(test)]
#[path = "activity_read_contract_tests.rs"]
mod activity_read_contract_tests;
