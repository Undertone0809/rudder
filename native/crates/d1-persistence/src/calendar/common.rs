use super::{Result, http, text};

pub(super) fn object(value: &Value) -> Result<&Map<String, Value>> {
    value
        .as_object()
        .ok_or_else(|| http(400, "Validation error"))
}

use serde_json::{Map, Value, json};
use sqlx::{PgPool, Row, postgres::PgRow};
use uuid::Uuid;

pub(super) fn optional_text(value: &Value, key: &str) -> Result<Option<Option<String>>> {
    match value.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(text)) => Ok(Some(Some(text.trim().to_owned()))),
        _ => Err(http(400, "Validation error")),
    }
}

pub(super) fn string_field(
    value: &Value,
    key: &str,
    min: usize,
    max: usize,
) -> Result<Option<String>> {
    match value.get(key) {
        None => Ok(None),
        Some(Value::String(text)) => {
            let text = text.trim();
            let length = text.encode_utf16().count();
            if length < min || length > max {
                Err(http(400, "Validation error"))
            } else {
                Ok(Some(text.to_owned()))
            }
        }
        _ => Err(http(400, "Validation error")),
    }
}

pub(super) fn enum_field(
    value: &Value,
    key: &str,
    allowed: &[&str],
    default: Option<&str>,
) -> Result<Option<String>> {
    let candidate = match value.get(key) {
        None => default,
        Some(Value::String(value)) => Some(value.as_str()),
        _ => return Err(http(400, "Validation error")),
    };
    if candidate.is_some_and(|item| !allowed.contains(&item)) {
        return Err(http(400, "Validation error"));
    }
    Ok(candidate.map(str::to_owned))
}

pub(super) fn uuid_optional(value: &Value, key: &str) -> Result<Option<Option<String>>> {
    match value.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(raw)) => Uuid::parse_str(raw)
            .map(|parsed| Some(Some(parsed.to_string())))
            .map_err(|_| http(400, "Validation error")),
        _ => Err(http(400, "Validation error")),
    }
}

const JS_DATE_MAX_MILLIS: f64 = 8_640_000_000_000_000.0;

fn date_millis(value: f64) -> Result<String> {
    if !value.is_finite() || value.abs() > JS_DATE_MAX_MILLIS {
        return Err(http(400, "Validation error"));
    }
    let millis = value.trunc() as i64;
    let parsed = time::OffsetDateTime::from_unix_timestamp_nanos(millis as i128 * 1_000_000)
        .map_err(|_| http(400, "Validation error"))?;
    parsed
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| http(400, "Validation error"))
}

fn parse_local_datetime(value: &str) -> Option<time::PrimitiveDateTime> {
    const FORMATS: &[&str] = &[
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:1+]",
        "[year]-[month]-[day]T[hour]:[minute]:[second]",
        "[year]-[month]-[day]T[hour]:[minute]",
        "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond digits:1+]",
        "[year]-[month]-[day] [hour]:[minute]:[second]",
        "[year]-[month]-[day] [hour]:[minute]",
    ];
    FORMATS.iter().find_map(|description| {
        let format = time::format_description::parse_borrowed::<2>(description).ok()?;
        time::PrimitiveDateTime::parse(value, &format).ok()
    })
}

fn parse_legacy_offset(value: &str) -> Option<time::UtcOffset> {
    let bytes = value.as_bytes();
    if !bytes.is_ascii() {
        return None;
    }
    let sign = match bytes.first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits = &value[1..];
    let (hours, minutes) = match digits.len() {
        2 => (digits, "00"),
        4 => (&digits[..2], &digits[2..]),
        5 if digits.as_bytes()[2] == b':' => (&digits[..2], &digits[3..]),
        _ => return None,
    };
    if !hours.bytes().all(|byte| byte.is_ascii_digit())
        || !minutes.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let hours = hours.parse::<i8>().ok()?;
    let minutes = minutes.parse::<i8>().ok()?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    time::UtcOffset::from_hms(sign * hours, sign * minutes, 0).ok()
}

fn split_legacy_offset(value: &str) -> Option<(&str, time::UtcOffset)> {
    let separator = value.rfind(['+', '-'])?;
    if separator <= 10 {
        return None;
    }
    Some((
        &value[..separator],
        parse_legacy_offset(&value[separator..])?,
    ))
}

fn local_offset_for(value: time::PrimitiveDateTime) -> Option<time::UtcOffset> {
    // Probe both sides of nearby transitions. For a fold, both candidate
    // offsets are valid and ECMAScript chooses the earlier instant. For a gap,
    // neither is valid and ECMAScript advances by the gap, equivalent to using
    // the pre-transition (smaller) offset on the original wall time.
    let nominal = value.assume_utc();
    let mut offsets = Vec::new();
    for hours in [-48, -24, 0, 24, 48] {
        if let Ok(offset) = time::UtcOffset::local_offset_at(nominal + time::Duration::hours(hours))
            && !offsets.contains(&offset)
        {
            offsets.push(offset);
        }
    }
    let valid = offsets.iter().copied().filter_map(|offset| {
        let candidate = value.assume_offset(offset);
        (time::UtcOffset::local_offset_at(candidate).ok()? == offset).then_some(candidate)
    });
    if let Some(earliest) = valid.min_by_key(|candidate| candidate.unix_timestamp_nanos()) {
        return Some(earliest.offset());
    }
    offsets
        .into_iter()
        .min_by_key(|offset| offset.whole_seconds())
}

fn normalize_date(parsed: time::OffsetDateTime) -> Result<String> {
    let millis = parsed.unix_timestamp_nanos() / 1_000_000;
    if millis.unsigned_abs() > JS_DATE_MAX_MILLIS as u128 {
        return Err(http(400, "Validation error"));
    }
    let clipped = time::OffsetDateTime::from_unix_timestamp_nanos(millis * 1_000_000)
        .map_err(|_| http(400, "Validation error"))?
        .to_offset(time::UtcOffset::UTC);
    clipped
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| http(400, "Validation error"))
}

fn parse_legacy_date(value: &str) -> Result<String> {
    let value = value.trim();
    if let Ok(parsed) =
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
    {
        return normalize_date(parsed);
    }
    if let Ok(parsed) = time::OffsetDateTime::parse(
        value,
        &time::format_description::well_known::Iso8601::DEFAULT,
    ) {
        return normalize_date(parsed);
    }
    let bytes = value.as_bytes();
    let is_date_only = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit());
    if is_date_only
        && let Ok(date) =
            time::Date::parse(value, &time::format_description::well_known::Iso8601::DATE)
    {
        return normalize_date(date.with_time(time::Time::MIDNIGHT).assume_utc());
    }
    if let Some(base) = value.strip_suffix(['Z', 'z'])
        && let Some(parsed) = parse_local_datetime(base)
    {
        return normalize_date(parsed.assume_utc());
    }
    if let Some((base, offset)) = split_legacy_offset(value)
        && let Some(parsed) = parse_local_datetime(base)
    {
        return normalize_date(parsed.assume_offset(offset));
    }
    if let Some(parsed) = parse_local_datetime(value) {
        let offset = local_offset_for(parsed).ok_or_else(|| http(400, "Validation error"))?;
        return normalize_date(parsed.assume_offset(offset));
    }
    Err(http(400, "Validation error"))
}

pub(super) fn date_field(value: &Value, key: &str, required: bool) -> Result<Option<String>> {
    match value.get(key) {
        None if !required => Ok(None),
        Some(Value::String(raw)) => Ok(Some(parse_legacy_date(raw)?)),
        Some(Value::Number(ms)) => {
            let millis = ms
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(|| http(400, "Validation error"))? as i64;
            Ok(Some(date_millis(millis as f64)?))
        }
        Some(Value::Bool(value)) => Ok(Some(date_millis(if *value { 1.0 } else { 0.0 })?)),
        Some(Value::Null) if matches!(key, "externalUpdatedAt" | "lastSyncedAt") => Ok(None),
        Some(Value::Null) => Ok(Some(date_millis(0.0)?)),
        _ => Err(http(400, "Validation error")),
    }
}

pub(super) fn bool_field(value: &Value, key: &str, default: Option<bool>) -> Result<Option<bool>> {
    match value.get(key) {
        None => Ok(default),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        _ => Err(http(400, "Validation error")),
    }
}

pub(super) fn list_value(row: PgRow) -> Result<Value> {
    let raw: String = row.try_get("value")?;
    serde_json::from_str(&raw).map_err(|_| http(500, "Internal server error"))
}

pub(super) fn iso(expr: &str) -> String {
    format!("to_char({expr} AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
}

pub(super) fn source_json(alias: &str) -> String {
    let cursor = format!("{alias}.sync_cursor_json");
    format!(
        "jsonb_build_object('id',{alias}.id::text,'orgId',{alias}.org_id::text,'type',{alias}.type,'name',{alias}.name,'ownerType',{alias}.owner_type,'ownerUserId',{alias}.owner_user_id,'ownerAgentId',{alias}.owner_agent_id::text,'externalProvider',{alias}.external_provider,'externalCalendarId',{alias}.external_calendar_id,'visibilityDefault',{alias}.visibility_default,'status',{alias}.status,'lastSyncedAt',CASE WHEN {alias}.last_synced_at IS NULL THEN NULL ELSE {} END,'syncCursorJson',CASE WHEN jsonb_typeof({cursor})='object' THEN ({cursor} - 'accessToken' - 'refreshToken') || CASE WHEN jsonb_typeof({cursor}->'accessToken')='string' THEN jsonb_build_object('accessToken','[redacted]') ELSE '{{}}'::jsonb END || CASE WHEN jsonb_typeof({cursor}->'refreshToken')='string' THEN jsonb_build_object('refreshToken','[redacted]') ELSE '{{}}'::jsonb END ELSE NULL END,'createdAt',{},'updatedAt',{})::text",
        iso(&format!("{alias}.last_synced_at")),
        iso(&format!("{alias}.created_at")),
        iso(&format!("{alias}.updated_at")),
    )
}

pub(super) fn event_json(e: &str, joins: &str) -> String {
    let s = format!("{joins}_source");
    let a = format!("{joins}_agent");
    let i = format!("{joins}_issue");
    let automation = format!("{joins}_automation");
    format!(
        "jsonb_build_object('id',{e}.id::text,'orgId',{e}.org_id::text,'sourceId',{e}.source_id::text,'eventKind',{e}.event_kind,'eventStatus',{e}.event_status,'ownerType',{e}.owner_type,'ownerUserId',{e}.owner_user_id,'ownerAgentId',{e}.owner_agent_id::text,'title',{e}.title,'description',{e}.description,'startAt',{},'endAt',{},'timezone',{e}.timezone,'allDay',{e}.all_day,'visibility',{e}.visibility,'issueId',{e}.issue_id::text,'projectId',{e}.project_id::text,'goalId',{e}.goal_id::text,'approvalId',{e}.approval_id::text,'heartbeatRunId',{e}.heartbeat_run_id::text,'activityId',{e}.activity_id::text,'sourceMode',{e}.source_mode,'externalProvider',{e}.external_provider,'externalCalendarId',{e}.external_calendar_id,'externalEventId',{e}.external_event_id,'externalEtag',{e}.external_etag,'externalUpdatedAt',CASE WHEN {e}.external_updated_at IS NULL THEN NULL ELSE {} END,'createdByUserId',{e}.created_by_user_id,'updatedByUserId',{e}.updated_by_user_id,'createdAt',{},'updatedAt',{},'deletedAt',CASE WHEN {e}.deleted_at IS NULL THEN NULL ELSE {} END,'source',CASE WHEN {s}.id IS NULL THEN NULL ELSE jsonb_build_object('id',{s}.id::text,'type',{s}.type,'name',COALESCE({s}.name,'Calendar'),'visibilityDefault',COALESCE({s}.visibility_default,'full'),'externalProvider',{s}.external_provider) END,'agent',CASE WHEN {a}.id IS NULL OR {a}.name='' THEN NULL ELSE jsonb_build_object('id',{a}.id::text,'name',{a}.name,'role',COALESCE({a}.role,'general'),'title',{a}.title,'urlKey',{a}.workspace_key) END,'issue',CASE WHEN {i}.id IS NULL OR {i}.title='' THEN NULL ELSE jsonb_build_object('id',{i}.id::text,'identifier',{i}.identifier,'title',{i}.title,'status',COALESCE({i}.status,'todo'),'priority',COALESCE({i}.priority,'medium')) END,'automation',CASE WHEN {automation}.id IS NULL OR {automation}.title='' THEN NULL ELSE jsonb_build_object('id',{automation}.id::text,'title',{automation}.title) END)::text",
        iso(&format!("{e}.start_at")),
        iso(&format!("{e}.end_at")),
        iso(&format!("{e}.external_updated_at")),
        iso(&format!("{e}.created_at")),
        iso(&format!("{e}.updated_at")),
        iso(&format!("{e}.deleted_at")),
    )
}

pub(super) const SOURCE_TYPES: &[&str] =
    &["rudder_local", "google_calendar", "agent_work", "system"];
pub(super) const OWNER_TYPES: &[&str] = &["user", "agent", "system"];
pub(super) const VISIBILITIES: &[&str] = &["full", "busy_only", "private"];
pub(super) const SOURCE_STATUSES: &[&str] = &["active", "paused", "disconnected", "error"];
pub(super) const EVENT_KINDS: &[&str] = &[
    "human_event",
    "agent_work_block",
    "external_event",
    "system_event",
];
pub(super) const EVENT_STATUSES: &[&str] = &[
    "planned",
    "in_progress",
    "actual",
    "cancelled",
    "external",
    "projected",
];
pub(super) const SOURCE_MODES: &[&str] = &["manual", "derived", "imported"];

#[derive(Clone, Debug)]
pub(super) struct Audit {
    pub(super) actor_type: &'static str,
    pub(super) actor_id: String,
    pub(super) run_id: Option<String>,
}

pub(super) async fn assert_org_reference(
    pool: &PgPool,
    org: &str,
    table: &str,
    id: &str,
    label: &str,
) -> Result<()> {
    // Table names are hard-coded by callers; identifiers always remain bound values.
    let found = sqlx::query(&format!(
        "SELECT org_id::text FROM {table} WHERE id=$1::uuid"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    let Some(found) = found else {
        return Err(http(404, format!("{label} not found")));
    };
    let owner_org: String = found.try_get("org_id")?;
    if owner_org != org {
        return Err(http(
            422,
            format!("{label} must belong to same organization"),
        ));
    }
    Ok(())
}

pub(super) async fn validate_event_shape(pool: &PgPool, org: &str, input: &Value) -> Result<()> {
    let event_kind = text(input, "eventKind").unwrap_or_default();
    let owner_type = text(input, "ownerType").unwrap_or_default();
    if event_kind == "agent_work_block" {
        if input.get("ownerAgentId").is_none_or(Value::is_null) {
            return Err(http(422, "Agent work blocks require an agent"));
        }
        if owner_type != "agent" {
            return Err(http(422, "Agent work blocks must be owned by an agent"));
        }
    }
    if event_kind == "human_event" && owner_type != "user" {
        return Err(http(422, "Human calendar events must be owned by a user"));
    }
    if input
        .get("sourceMode")
        .and_then(Value::as_str)
        .is_some_and(|v| v != "manual" && v != "imported")
    {
        return Err(http(403, "Derived calendar events are read-only"));
    }
    if let Some(id) = text(input, "sourceId") {
        if sqlx::query("SELECT 1 FROM calendar_sources WHERE id=$1::uuid AND org_id=$2::uuid")
            .bind(id)
            .bind(org)
            .fetch_optional(pool)
            .await?
            .is_none()
        {
            return Err(http(404, "Calendar source not found"));
        }
    }
    if let Some(id) = text(input, "ownerAgentId") {
        let row = sqlx::query("SELECT org_id::text,status FROM agents WHERE id=$1::uuid")
            .bind(id)
            .fetch_optional(pool)
            .await?;
        let Some(row) = row else {
            return Err(http(404, "Agent not found"));
        };
        let owner_org: String = row.try_get("org_id")?;
        let status: String = row.try_get("status")?;
        if owner_org != org {
            return Err(http(422, "Agent must belong to same organization"));
        }
        if status == "terminated" {
            return Err(http(
                409,
                "Cannot create calendar blocks for terminated agents",
            ));
        }
    }
    for (key, table, label) in [
        ("issueId", "issues", "Issue"),
        ("projectId", "projects", "Project"),
        ("goalId", "goals", "Goal"),
        ("approvalId", "approvals", "Approval"),
        ("heartbeatRunId", "heartbeat_runs", "Agent run"),
        ("activityId", "activity_log", "Activity event"),
    ] {
        if let Some(id) = text(input, key) {
            if table == "issues" {
                let row = sqlx::query("SELECT org_id::text, hidden_at IS NOT NULL AS is_hidden FROM issues WHERE id=$1::uuid").bind(id).fetch_optional(pool).await?;
                let Some(row) = row else {
                    return Err(http(404, "Issue not found"));
                };
                let owner_org: String = row.try_get("org_id")?;
                let is_hidden: bool = row.try_get("is_hidden")?;
                if is_hidden {
                    return Err(http(404, "Issue not found"));
                }
                if owner_org != org {
                    return Err(http(422, "Issue must belong to same organization"));
                }
            } else {
                assert_org_reference(pool, org, table, id, label).await?;
            }
        }
    }
    let start = text(input, "startAt");
    let end = text(input, "endAt");
    if let (Some(start), Some(end)) = (start, end) {
        let start =
            time::OffsetDateTime::parse(start, &time::format_description::well_known::Rfc3339)
                .map_err(|_| http(400, "Validation error"))?;
        let end = time::OffsetDateTime::parse(end, &time::format_description::well_known::Rfc3339)
            .map_err(|_| http(400, "Validation error"))?;
        if end <= start {
            return Err(http(422, "End time must be after start time"));
        }
    }
    Ok(())
}

pub(super) fn event_summary(event: &Value) -> Value {
    json!({"title":event["title"],"eventKind":event["eventKind"],"eventStatus":event["eventStatus"],"startAt":event["startAt"],"endAt":event["endAt"],"ownerAgentId":event["ownerAgentId"],"issueId":event["issueId"]})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parsed_millis(value: &str) -> i128 {
        let normalized = parse_legacy_date(value).unwrap();
        time::OffsetDateTime::parse(&normalized, &time::format_description::well_known::Rfc3339)
            .unwrap()
            .unix_timestamp_nanos()
            / 1_000_000
    }

    #[test]
    fn legacy_date_coercion_preserves_date_only_minute_offset_and_timeclip() {
        assert_eq!(parsed_millis("2024-10-08"), 1_728_345_600_000);
        assert_eq!(parsed_millis("2024-10-08T17:20Z"), 1_728_408_000_000);
        assert_eq!(parsed_millis("2024-10-08T17:20+05:30"), 1_728_388_200_000);
        assert_eq!(parsed_millis("2024-10-08T17:20+0530"), 1_728_388_200_000);
        assert_eq!(
            parsed_millis("2024-10-08T17:20:30.987654Z"),
            1_728_408_030_987
        );
        assert!(parse_legacy_date("2024-10-08T17:20+1é1").is_err());
    }

    #[test]
    fn date_field_matches_coercive_null_boolean_and_optional_nullable_shapes() {
        assert_eq!(
            date_field(&json!({"startAt":null}), "startAt", true).unwrap(),
            Some("1970-01-01T00:00:00Z".to_owned())
        );
        assert_eq!(
            date_field(&json!({"startAt":true}), "startAt", true).unwrap(),
            Some("1970-01-01T00:00:00.001Z".to_owned())
        );
        assert_eq!(
            date_field(&json!({"lastSyncedAt":null}), "lastSyncedAt", false).unwrap(),
            None
        );
        assert_eq!(
            date_field(
                &json!({"externalUpdatedAt":null}),
                "externalUpdatedAt",
                false
            )
            .unwrap(),
            None
        );
        assert!(date_field(&json!({}), "startAt", true).is_err());
        assert!(date_field(&json!({"startAt":""}), "startAt", true).is_err());
        assert!(date_field(&json!({"startAt":{}}), "startAt", true).is_err());
    }

    #[test]
    fn local_wall_time_matches_javascript_dst_gap_and_fold_disambiguation() {
        if std::env::var("TZ").as_deref() != Ok("America/Los_Angeles") {
            return;
        }
        assert_eq!(parsed_millis("2024-03-10T02:30"), 1_710_066_600_000);
        assert_eq!(parsed_millis("2024-11-03T01:30"), 1_730_622_600_000);
    }
}
