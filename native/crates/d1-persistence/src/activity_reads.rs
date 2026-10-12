//! Activity reads preserve org cursors and define a total Issue/Chat order.
use crate::{StoreError, legacy_read_json::normalize_legacy_read_json};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sqlx::{PgPool, Row, postgres::PgRow};
use std::{cmp::Reverse, collections::BTreeMap};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityReadOperation {
    List,
    ListPage,
    Issue,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivityCursor {
    pub created_at: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ActivityReadInput {
    pub operation: ActivityReadOperation,
    pub issue_id: Option<String>,
    pub agent_id: Option<String>,
    pub user_id: Option<String>,
    pub actor_type: Option<String>,
    pub actor_id: Option<String>,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub limit: Option<i64>,
    pub cursor: Option<ActivityCursor>,
    pub legacy_date_timezone: Option<String>,
}

impl ActivityReadInput {
    pub fn validate(&self) -> Result<(), StoreError> {
        if self
            .actor_type
            .as_ref()
            .is_some_and(|v| !["agent", "user", "system"].contains(&v.as_str()))
            || self.limit.is_some_and(|v| !(1..=100).contains(&v))
            || self
                .legacy_date_timezone
                .as_ref()
                .is_some_and(|v| v.is_empty() || v.len() > 256 || v.chars().any(char::is_control))
            || (self.operation != ActivityReadOperation::ListPage
                && (self.limit.is_some() || self.cursor.is_some()))
            || (self.operation == ActivityReadOperation::Issue) != self.issue_id.is_some()
            || (self.operation == ActivityReadOperation::Issue
                && [
                    &self.agent_id,
                    &self.user_id,
                    &self.actor_type,
                    &self.actor_id,
                    &self.entity_type,
                    &self.entity_id,
                ]
                .iter()
                .any(|value| value.is_some()))
        {
            return Err(StoreError::InvalidInput);
        }
        if let Some(id) = &self.issue_id {
            crate::transaction::uuid(id)?;
        }
        if let Some(cursor) = &self.cursor {
            crate::transaction::uuid(&cursor.id)?;
            if !regex_lite::Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$")
                .unwrap()
                .is_match(&cursor.created_at)
            {
                return Err(StoreError::InvalidInput);
            }
        }
        Ok(())
    }
}

const METADATA: &[&str] = &[
    "identifier",
    "issueIdentifier",
    "_previous",
    "_references",
    "source",
    "reopened",
    "reopenedFrom",
    "normalizedFromStatus",
    "normalizedReason",
];
const INTERNAL: &[&str] = &[
    "executionWorkspaceId",
    "executionWorkspacePreference",
    "executionWorkspaceSettings",
    "currentExecutionWorkspace",
    "runWorkspaceId",
    "runWorkspacePreference",
    "runWorkspaceSettings",
    "currentRunWorkspace",
];

/// JSON reparsed from a JSONB string can contain lone UTF-16 surrogates. Serde's
/// byte-string visitor preserves those as WTF-8; ordinary String would reject
/// values which JavaScript JSON.parse and object spread accept.
#[derive(Eq, PartialEq, Ord, PartialOrd)]
struct JsString(Vec<u16>);

impl From<&str> for JsString {
    fn from(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }
}

impl JsString {
    fn equals(&self, value: &str) -> bool {
        self.0.iter().copied().eq(value.encode_utf16())
    }
    fn json(&self) -> String {
        match String::from_utf16(&self.0) {
            Ok(value) => serde_json::to_string(&value).unwrap(),
            Err(_) => format!(
                "\"{}\"",
                self.0
                    .iter()
                    .map(|c| format!("\\u{c:04x}"))
                    .collect::<String>()
            ),
        }
    }
}

impl<'de> Deserialize<'de> for JsString {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl serde::de::Visitor<'_> for Visitor {
            type Value = JsString;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JavaScript string")
            }
            fn visit_bytes<E: serde::de::Error>(self, bytes: &[u8]) -> Result<JsString, E> {
                let mut units = Vec::new();
                let mut index = 0;
                while index < bytes.len() {
                    let first = bytes[index];
                    let (width, mask) = if first < 128 {
                        (1, 0x7f)
                    } else if first < 224 {
                        (2, 0x1f)
                    } else if first < 240 {
                        (3, 0x0f)
                    } else {
                        (4, 0x07)
                    };
                    let mut point = u32::from(first & mask);
                    for offset in 1..width {
                        let byte = bytes
                            .get(index + offset)
                            .ok_or_else(|| E::custom("truncated string"))?;
                        point = (point << 6) | u32::from(byte & 0x3f);
                    }
                    if point <= 0xffff {
                        units.push(point as u16);
                    } else {
                        units.push(0xd800 + ((point - 0x10000) >> 10) as u16);
                        units.push(0xdc00 + ((point - 0x10000) & 0x3ff) as u16);
                    }
                    index += width;
                }
                Ok(JsString(units))
            }
        }
        deserializer.deserialize_bytes(Visitor)
    }
}

// SQLx's PostgreSQL dependency already enables raw_value. Decode only the top
// level: arbitrary legacy details can exceed serde Value's structural limit.
fn object(raw: &str) -> Result<BTreeMap<JsString, String>, StoreError> {
    let fail = |_| StoreError::InvalidReceipt;
    match raw.as_bytes().first() {
        Some(b'{') => serde_json::from_str::<BTreeMap<JsString, Box<RawValue>>>(raw)
            .map(|v| {
                v.into_iter()
                    .map(|(k, v)| (k, v.get().to_owned()))
                    .collect()
            })
            .map_err(fail),
        Some(b'[') => serde_json::from_str::<Vec<Box<RawValue>>>(raw)
            .map(|v| {
                v.into_iter()
                    .enumerate()
                    .map(|(i, v)| (JsString::from(i.to_string().as_str()), v.get().to_owned()))
                    .collect()
            })
            .map_err(fail),
        Some(b'"') => {
            let value: JsString = serde_json::from_str(raw).map_err(fail)?;
            // Object spread enumerates UTF-16 code units, including surrogate
            // halves. Keep them as JSON escapes rather than lossy Rust chars.
            Ok(value
                .0
                .into_iter()
                .enumerate()
                .map(|(i, c)| {
                    (
                        JsString::from(i.to_string().as_str()),
                        format!("\"\\u{c:04x}\""),
                    )
                })
                .collect())
        }
        _ => Ok(BTreeMap::new()),
    }
}

fn encode_object(value: BTreeMap<JsString, String>) -> String {
    format!(
        "{{{}}}",
        value
            .into_iter()
            .map(|(k, v)| format!("{}:{v}", k.json()))
            .collect::<Vec<_>>()
            .join(",")
    )
}

pub(crate) fn details(raw: Option<&str>) -> Result<String, StoreError> {
    let raw = raw.unwrap_or("null");
    // postgres-js parses JSONB once; Drizzle reparses a resulting string if it
    // is valid JSON. Preserve that one extra parse, never recursively reparse.
    if raw.starts_with('"') {
        let inner: String = serde_json::from_str(raw).map_err(|_| StoreError::InvalidReceipt)?;
        if let Ok(value) = normalize_legacy_read_json(&inner) {
            return Ok(value.trim().to_owned());
        }
    }
    normalize_legacy_read_json(raw).map_err(|_| StoreError::InvalidReceipt)
}

fn visible(action: &str, details: &str) -> Result<bool, StoreError> {
    if action == "issue.execution_released" {
        return Ok(false);
    }
    if action != "issue.updated" || !details.starts_with('{') {
        return Ok(true);
    }
    let keys = object(details)?;
    let changed: Vec<_> = keys
        .keys()
        .filter(|k| !METADATA.iter().any(|v| k.equals(v)) && !INTERNAL.iter().any(|v| k.equals(v)))
        .collect();
    Ok(changed.is_empty()
        || changed
            .iter()
            .any(|k| !k.equals("title") && !k.equals("description")))
}

fn hydrate(raw: &str, identifier: Option<&str>, title: Option<&str>) -> Result<String, StoreError> {
    if identifier.is_none_or(str::is_empty) && title.is_none_or(str::is_empty) {
        return Ok(raw.to_owned());
    }
    let mut value = object(raw)?;
    for (canonical, original, text) in [
        ("issueIdentifier", "identifier", identifier),
        ("issueTitle", "title", title),
    ] {
        if let Some(text) = text.filter(|v| !v.is_empty()) {
            let encoded = serde_json::to_string(text).unwrap();
            if value
                .get(&JsString::from(original))
                .is_none_or(|v| !v.starts_with('"'))
            {
                value.insert(original.into(), encoded.clone());
            }
            value.insert(canonical.into(), encoded);
        }
    }
    Ok(encode_object(value))
}

// The legacy driver parsed PG's connection-local timestamp text with JS Date.
// Match Cost reads' established small-year/BC/offset behavior and millisecond
// truncation, while retaining untouched PG timestamps for org cursor ordering.
pub(crate) fn legacy_stamp(column: &str) -> String {
    format!(
        r#"CASE WHEN NOT isfinite({column}) OR extract(epoch FROM date_trunc('milliseconds',{column}))>8640000000000 THEN NULL
 WHEN extract(year FROM {column})<1 OR extract(year FROM {column}) BETWEEN 13 AND 31 OR mod(extract(timezone FROM {column}),60)<>0 THEN NULL
 WHEN extract(year FROM {column}) BETWEEN 1 AND 12 THEN make_timestamp(2000+extract(day FROM {column})::int,extract(year FROM {column})::int,extract(month FROM {column})::int,extract(hour FROM {column})::int,extract(minute FROM {column})::int,extract(second FROM {column})::double precision)-extract(timezone FROM {column})::double precision*INTERVAL '1 second'
 WHEN extract(year FROM {column}) BETWEEN 32 AND 99 THEN make_timestamp((CASE WHEN extract(year FROM {column})<50 THEN 2000 ELSE 1900 END)+extract(year FROM {column})::int,extract(month FROM {column})::int,extract(day FROM {column})::int,extract(hour FROM {column})::int,extract(minute FROM {column})::int,extract(second FROM {column})::double precision)-extract(timezone FROM {column})::double precision*INTERVAL '1 second'
 ELSE {column} AT TIME ZONE 'UTC' END"#
    )
}

pub(crate) fn legacy_date_text(stamp: &str) -> String {
    format!(
        r#"CASE WHEN {stamp} IS NULL THEN NULL ELSE (CASE WHEN extract(year FROM {stamp})>=10000 THEN '+'||to_char(extract(year FROM {stamp}),'FM000000') ELSE to_char({stamp},'YYYY') END)||to_char({stamp},'-MM-DD"T"HH24:MI:SS.MS"Z"') END"#
    )
}

fn projection() -> String {
    r#"jsonb_build_object('id',a.id,'orgId',a.org_id,'actorType',a.actor_type,'actorId',a.actor_id,
 'action',a.action,'entityType',a.entity_type,'entityId',a.entity_id,'agentId',a.agent_id,'runId',a.run_id,
 'idempotencyKey',a.idempotency_key,'createdAt',CASE WHEN stamp IS NULL THEN NULL ELSE
 (CASE WHEN extract(year FROM stamp)>=10000 THEN '+'||to_char(extract(year FROM stamp),'FM000000') ELSE to_char(stamp,'YYYY') END)||to_char(stamp,'-MM-DD"T"HH24:MI:SS.MS"Z"') END)::text AS payload,
 a.details::text AS details,a.action,a.entity_type,a.id::text AS id,
 to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at"#.to_owned()
}

fn low_signal_sql() -> String {
    let keys = [METADATA, &["title", "description"]]
        .concat()
        .iter()
        .map(|v| format!("'{v}'"))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "(a.action='issue.updated' AND jsonb_typeof(a.details)='object' AND (a.details ? 'title' OR a.details ? 'description') AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(a.details) AS k(key) WHERE k.key NOT IN ({keys})))"
    )
}

fn organization_sql(page: bool) -> String {
    let limit = if page { "LIMIT $10" } else { "" };
    format!(
        r#"SELECT {},i.identifier AS issue_identifier,i.title AS issue_title
 FROM activity_log a LEFT JOIN issues i ON a.entity_type='issue' AND i.org_id=a.org_id AND a.entity_id=i.id::text
 CROSS JOIN LATERAL (SELECT {} AS stamp) parsed
 WHERE a.org_id=$1::uuid AND a.action NOT IN ('issue.read_marked','issue.execution_released') AND NOT ({})
 AND (a.entity_type<>'issue' OR i.hidden_at IS NULL)
 AND ($2::text IS NULL OR a.agent_id=$2::uuid OR (a.actor_type='agent' AND a.actor_id=$2))
 AND ($3::text IS NULL OR (a.actor_type='user' AND a.actor_id=$3))
 AND ($4::text IS NULL OR a.actor_type=$4) AND ($5::text IS NULL OR a.actor_id=$5)
 AND ($6::text IS NULL OR a.entity_type=$6) AND ($7::text IS NULL OR a.entity_id=$7)
 AND ($8::text IS NULL OR a.created_at<$8::timestamptz OR (a.created_at=$8::timestamptz AND a.id<$9::uuid))
 ORDER BY a.created_at DESC,a.id DESC {limit}"#,
        projection(),
        legacy_stamp("a.created_at"),
        low_signal_sql()
    )
}

fn project(row: &PgRow) -> Result<Option<String>, StoreError> {
    let raw: Option<String> = row.try_get("details")?;
    let mut value = details(raw.as_deref())?;
    let action: String = row.try_get("action")?;
    if row.try_get::<String, _>("entity_type")? == "issue" {
        let identifier: Option<String> = row.try_get("issue_identifier")?;
        let title: Option<String> = row.try_get("issue_title")?;
        value = hydrate(&value, identifier.as_deref(), title.as_deref())?;
    }
    if !visible(&action, &value)? {
        return Ok(None);
    }
    let mut payload: String = row.try_get("payload")?;
    payload.pop();
    Ok(Some(format!("{payload},\"details\":{value}}}")))
}

fn issue_sql(chat: bool) -> String {
    let (join, filter, title) = if chat {
        ("JOIN chat_conversations c ON a.entity_type='chat' AND a.entity_id=c.id::text AND c.org_id=i.org_id
 LEFT JOIN chat_context_links l ON l.conversation_id=c.id AND l.org_id=i.org_id AND l.entity_type='issue' AND l.entity_id=i.id::text",
         "(a.action='chat.issue_converted' AND a.details->>'issueId'=i.id::text) OR (a.action='chat.context_linked' AND a.details->>'entityType'='issue' AND a.details->>'entityId'=i.id::text) OR (a.action='chat.created' AND l.id IS NOT NULL AND coalesce((a.details->>'contextLinkCount')::int,0)>0)", "c.title")
    } else {
        (
            "",
            "a.entity_type='issue' AND a.entity_id=i.id::text AND a.action<>'issue.read_marked'",
            "NULL::text",
        )
    };
    format!(
        r#"SELECT {},{title} AS conversation_title,
 floor(extract(epoch FROM stamp)*1000)::bigint AS millis
 FROM issues i JOIN activity_log a ON a.org_id=i.org_id {join}
 CROSS JOIN LATERAL (SELECT {} AS stamp) parsed
 WHERE i.id=$2::uuid AND i.org_id=$1::uuid AND ({filter})
 ORDER BY a.created_at DESC,a.id DESC"#,
        projection(),
        legacy_stamp("a.created_at")
    )
}

async fn read_issue(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org_id: &str,
    issue_id: &str,
) -> Result<String, StoreError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM issues WHERE id=$2::uuid AND org_id=$1::uuid)",
    )
    .bind(org_id)
    .bind(issue_id)
    .fetch_one(&mut **tx)
    .await?;
    if !exists {
        return Ok("[]".to_owned());
    }
    let mut merged = Vec::new();
    for (source, chat) in [false, true].into_iter().enumerate() {
        let rows = sqlx::query(&issue_sql(chat))
            .bind(org_id)
            .bind(issue_id)
            .fetch_all(&mut **tx)
            .await?;
        for (raw_order, row) in rows.into_iter().enumerate() {
            let raw: Option<String> = row.try_get("details")?;
            let mut value = details(raw.as_deref())?;
            if chat {
                let title: Option<String> = row.try_get("conversation_title")?;
                let mut properties = object(&value)?;
                properties.insert(
                    "conversationTitle".into(),
                    serde_json::to_string(&title).unwrap(),
                );
                value = encode_object(properties);
            } else {
                let action: String = row.try_get("action")?;
                if action == "issue.document_updated" || !visible(&action, &value)? {
                    continue;
                }
            }
            let mut payload: String = row.try_get("payload")?;
            payload.pop();
            let millis: Option<i64> = row.try_get("millis")?;
            merged.push((
                (
                    millis.is_none(),
                    Reverse(millis.unwrap_or(0)),
                    source,
                    raw_order,
                ),
                format!("{payload},\"details\":{value}}}"),
            ));
        }
    }
    Ok(ordered_issue_json(merged))
}

type IssueOrderKey = (bool, Reverse<i64>, usize, usize);

fn ordered_issue_json(mut merged: Vec<(IssueOrderKey, String)>) -> String {
    // Finite Dates precede invalid Dates. Within each source, raw_order retains
    // the entire original PG timestamp DESC plus UUID DESC, including ancient
    // years that the legacy Date parser maps onto modern millisecond ties.
    // Invalid rows use that same source/raw order. No row is deduplicated.
    merged.sort_by_key(|(key, _)| *key);
    format!(
        "[{}]",
        merged
            .into_iter()
            .map(|(_, payload)| payload)
            .collect::<Vec<_>>()
            .join(",")
    )
}

#[cfg(test)]
mod issue_order_tests {
    use super::{Reverse, ordered_issue_json};

    #[test]
    fn preserves_identical_synthetic_input_rows() {
        // Current PK/unique joins cannot yield this duplicate within one valid
        // snapshot. This synthetic merge check only locks the no-dedup rule.
        let row = ((true, Reverse(0), 0, 0), r#"{"id":"same"}"#.to_owned());
        assert_eq!(
            ordered_issue_json(vec![row.clone(), row]),
            r#"[{"id":"same"},{"id":"same"}]"#
        );
    }
}

pub async fn read_activity(
    pool: &PgPool,
    org_id: &str,
    input: &ActivityReadInput,
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
    if input.operation == ActivityReadOperation::Issue {
        let result = read_issue(
            &mut tx,
            org_id,
            input.issue_id.as_deref().ok_or(StoreError::InvalidInput)?,
        )
        .await?;
        tx.commit().await?;
        return Ok(result);
    }
    let result = {
        let page = input.operation == ActivityReadOperation::ListPage;
        let limit = input.limit.unwrap_or(30) as usize;
        let sql = organization_sql(page);
        let mut query = sqlx::query(&sql)
            .bind(org_id)
            .bind(&input.agent_id)
            .bind(&input.user_id)
            .bind(&input.actor_type)
            .bind(&input.actor_id)
            .bind(&input.entity_type)
            .bind(&input.entity_id)
            .bind(input.cursor.as_ref().map(|v| &v.created_at))
            .bind(input.cursor.as_ref().map(|v| &v.id));
        if page {
            query = query.bind((limit + 1) as i64);
        }
        let rows = query.fetch_all(&mut *tx).await?;
        let selected = &rows[..if page {
            rows.len().min(limit)
        } else {
            rows.len()
        }];
        let values = selected
            .iter()
            .map(project)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(",");
        if page {
            let cursor = if rows.len() > limit {
                #[derive(Serialize)]
                #[serde(rename_all = "camelCase")]
                struct WireCursor {
                    created_at: Option<String>,
                    id: String,
                }
                let row = &selected[selected.len() - 1];
                Some(
                    URL_SAFE_NO_PAD.encode(
                        serde_json::to_vec(&WireCursor {
                            created_at: row.try_get("cursor_created_at")?,
                            id: row.try_get("id")?,
                        })
                        .unwrap(),
                    ),
                )
            } else {
                None
            };
            format!(
                "{{\"items\":[{values}],\"nextCursor\":{}}}",
                serde_json::to_string(&cursor).unwrap()
            )
        } else {
            format!("[{values}]")
        }
    };
    tx.commit().await?;
    Ok(result)
}
