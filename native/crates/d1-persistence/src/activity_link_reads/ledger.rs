//! Four-source ledger paging. SQL source caps precede hydration/filtering, as in Node.
use super::{
    ActivityLinkReadError, ActivityLinkReadInput, Object, array, details, encode_object, js_string,
    json_text, ledger_query, object, text, value,
};
use crate::{StoreError, activity_reads::JsString};
use base64::{
    Engine, alphabet,
    engine::{
        DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig, general_purpose::URL_SAFE_NO_PAD,
    },
};
use sqlx::{Postgres, Row, Transaction};
use std::cmp::Ordering;
use time::{Date, Month};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Source {
    Chat,
    Comment,
    Approval,
    Activity,
}
impl Source {
    pub(super) fn rank(self) -> u8 {
        match self {
            Self::Activity => 0,
            Self::Approval => 1,
            Self::Chat => 2,
            Self::Comment => 3,
        }
    }
    fn kind(self) -> &'static str {
        match self {
            Self::Activity => "activity_event",
            Self::Approval => "approval_comment",
            Self::Chat => "chat_message",
            Self::Comment => "issue_comment",
        }
    }
    fn from_kind(kind: &str) -> Option<Self> {
        match kind {
            "activity_event" => Some(Self::Activity),
            "approval_comment" => Some(Self::Approval),
            "chat_message" => Some(Self::Chat),
            "issue_comment" => Some(Self::Comment),
            _ => None,
        }
    }
}
pub(super) struct Cursor {
    pub id: String,
    pub occurred_at: String,
    pub normalized_at: String,
    pub millis: i64,
    pub source: Source,
    year_zero: bool,
}
fn invalid_cursor() -> ActivityLinkReadError {
    ActivityLinkReadError::BadRequest("User activity cursor is invalid or expired".into())
}
fn decode_cursor(raw: Option<&str>) -> Result<Option<Cursor>, ActivityLinkReadError> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    // Node Buffer's base64url decoder accepts the standard alphabet, ignores
    // nonalphabet bytes, and ignores an incomplete final sextet.
    let mut encoded = raw
        .bytes()
        .take_while(|b| *b != b'=')
        .filter_map(|b| match b {
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(b),
            _ => None,
        })
        .collect::<Vec<_>>();
    if encoded.len() % 4 == 1 {
        encoded.pop();
    }
    let decoder = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let bytes = decoder.decode(encoded).map_err(|_| invalid_cursor())?;
    let decoded = String::from_utf8_lossy(&bytes);
    let raw = decoded.trim_matches([' ', '\n', '\r', '\t']);
    let row = object(raw).map_err(|_| invalid_cursor())?;
    let id = text(&row, "id")
        .map_err(|_| invalid_cursor())?
        .ok_or_else(invalid_cursor)?;
    let kind = text(&row, "kind")
        .map_err(|_| invalid_cursor())?
        .ok_or_else(invalid_cursor)?;
    // Explicit cursor contract: only the four kinds emitted by this endpoint.
    let source = Source::from_kind(&kind).ok_or_else(invalid_cursor)?;
    let occurred_at = text(&row, "occurredAt")
        .map_err(|_| invalid_cursor())?
        .ok_or_else(invalid_cursor)?;
    if !regex_lite::Regex::new(
        r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    )
    .unwrap()
    .is_match(&id)
        || !regex_lite::Regex::new(
            r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$",
        )
        .unwrap()
        .is_match(&occurred_at)
    {
        return Err(invalid_cursor());
    }
    let number = |range: std::ops::Range<usize>| {
        occurred_at[range]
            .parse::<i32>()
            .map_err(|_| invalid_cursor())
    };
    let year = number(0..4)?;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    let sub = number(20..23)?;
    if !(1..=31).contains(&day)
        || !(0..=24).contains(&hour)
        || minute > 59
        || second > 59
        || (hour == 24 && (minute != 0 || second != 0 || sub != 0))
    {
        return Err(invalid_cursor());
    }
    let month = Month::try_from(month as u8).map_err(|_| invalid_cursor())?;
    let start = Date::from_calendar_date(year, month, 1)
        .map_err(|_| invalid_cursor())?
        .midnight()
        .assume_utc()
        .unix_timestamp();
    // JS ISO parsing permits day overflow within 1..31 and midnight24. Keep
    // the raw timestamp separately for PostgreSQL's equality branch.
    let millis = (start
        + i64::from(day - 1) * 86400
        + i64::from(hour) * 3600
        + i64::from(minute) * 60
        + i64::from(second))
        * 1000
        + i64::from(sub);
    let mut normalized_year = year;
    let mut normalized_month = month as u8;
    let mut normalized_day = day + i32::from(hour == 24);
    loop {
        let leap =
            normalized_year % 4 == 0 && (normalized_year % 100 != 0 || normalized_year % 400 == 0);
        let days = match normalized_month {
            2 if leap => 29,
            2 => 28,
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        if normalized_day <= days {
            break;
        }
        normalized_day -= days;
        normalized_month += 1;
        if normalized_month == 13 {
            normalized_month = 1;
            normalized_year += 1;
        }
    }
    let normalized_year = if normalized_year >= 10000 {
        format!("+{normalized_year:06}")
    } else {
        format!("{normalized_year:04}")
    };
    let normalized_hour = if hour == 24 { 0 } else { hour };
    let normalized_at = format!(
        "{normalized_year}-{normalized_month:02}-{normalized_day:02}T{normalized_hour:02}:{minute:02}:{second:02}.{sub:03}Z"
    );
    Ok(Some(Cursor {
        id,
        occurred_at,
        normalized_at,
        millis,
        source,
        year_zero: year == 0,
    }))
}
fn whitespace(unit: u16) -> bool {
    matches!(unit,0x09..=0x0d|0x20|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
fn trim(value: JsString) -> JsString {
    let first = value
        .0
        .iter()
        .position(|c| !whitespace(*c))
        .unwrap_or(value.0.len());
    let last = value
        .0
        .iter()
        .rposition(|c| !whitespace(*c))
        .map_or(first, |i| i + 1);
    JsString(value.0[first..last].to_vec())
}
fn excerpt(value: Option<JsString>) -> String {
    let Some(value) = value else {
        return "null".into();
    };
    let mut collapsed = Vec::new();
    let mut pending = false;
    for unit in value.0 {
        if whitespace(unit) {
            pending = !collapsed.is_empty();
        } else {
            if pending {
                collapsed.push(32);
                pending = false;
            }
            collapsed.push(unit);
        }
    }
    if collapsed.is_empty() {
        return "null".into();
    }
    if collapsed.len() > 240 {
        collapsed.truncate(237);
        while collapsed.last().is_some_and(|c| whitespace(*c)) {
            collapsed.pop();
        }
        collapsed.extend([46, 46, 46]);
    }
    JsString(collapsed).json()
}
fn string_field(row: &Object, key: &str) -> Result<Option<JsString>, StoreError> {
    match value(row, key) {
        Some(raw) if raw.starts_with('"') => js_string(raw).map(Some),
        _ => Ok(None),
    }
}
fn title(details: &Object) -> Result<Option<JsString>, StoreError> {
    for key in ["title", "issueTitle", "name", "summary"] {
        if let Some(value) = string_field(details, key)? {
            let value = trim(value);
            if !value.0.is_empty() {
                return Ok(Some(value));
            }
        }
    }
    Ok(None)
}
fn raw(row: &Object, key: &str) -> String {
    value(row, key).unwrap_or("null").to_owned()
}
fn needed(row: &Object, key: &str) -> Result<String, StoreError> {
    text(row, key)?.ok_or(StoreError::InvalidReceipt)
}
fn related(out: &mut Vec<String>, kind: &str, id: Option<String>, label: Option<String>) {
    if let Some(id) = id {
        let mut row = Object::new();
        row.insert("type".into(), json_text(kind));
        row.insert("id".into(), json_text(&id));
        if let Some(label) = label {
            row.insert("label".into(), label);
        }
        out.push(encode_object(row));
    }
}
fn label(row: &Object, primary: &str, fallback: &str) -> String {
    let a = raw(row, primary);
    if a == "null" { raw(row, fallback) } else { a }
}
fn metadata_fields(row: &Object, keys: &[&str]) -> Object {
    keys.iter()
        .map(|key| (JsString::from(*key), raw(row, key)))
        .collect()
}
struct Item {
    id: String,
    source: Source,
    occurred_at: String,
    millis: i64,
    body: String,
}
fn item(
    source: Source,
    row: Object,
    occurred_at: String,
    millis: i64,
    user: &str,
    actor: &str,
) -> Result<Option<Item>, ActivityLinkReadError> {
    let id = needed(&row, "id")?;
    let org = needed(&row, "orgId")?;
    let mut links = Vec::new();
    let summary: String;
    let excerpt_json: String;
    let metadata: Object;
    let source_type: &str;
    let source_id: String;
    let source_link: Option<String>;
    let table: &str;
    match source {
        Source::Chat => {
            let conversation = needed(&row, "conversationId")?;
            let title = text(&row, "conversationTitle")?.unwrap_or_default();
            let reply = text(&row, "replyingAgentId")?;
            let preferred = text(&row, "preferredAgentId")?;
            let routed = text(&row, "routedAgentId")?;
            related(
                &mut links,
                "chat",
                Some(conversation.clone()),
                Some(raw(&row, "conversationTitle")),
            );
            related(&mut links, "agent", reply.clone(), None);
            if preferred != reply {
                related(&mut links, "agent", preferred.clone(), None);
            }
            if routed != reply && routed != preferred {
                related(&mut links, "agent", routed, None);
            }
            related(
                &mut links,
                "issue",
                text(&row, "primaryIssueId")?,
                Some(label(&row, "issueIdentifier", "issueTitle")),
            );
            related(&mut links, "project", text(&row, "issueProjectId")?, None);
            related(&mut links, "goal", text(&row, "issueGoalId")?, None);
            summary = json_text(&format!(
                "User message in chat: {}",
                if title.is_empty() {
                    "Untitled chat"
                } else {
                    &title
                }
            ));
            excerpt_json = excerpt(string_field(&row, "body")?);
            let mut m = metadata_fields(&row, &["messageKind", "messageStatus", "runId"]);
            m.insert("messageId".into(), json_text(&id));
            metadata = m;
            source_type = "chat";
            source_id = conversation.clone();
            source_link = Some(format!("chat://{conversation}"));
            table = "chat_messages";
        }
        Source::Comment => {
            let issue = needed(&row, "issueId")?;
            let assignee = text(&row, "assigneeAgentId")?;
            let reviewer = text(&row, "reviewerAgentId")?;
            related(
                &mut links,
                "issue",
                Some(issue.clone()),
                Some(label(&row, "issueIdentifier", "issueTitle")),
            );
            related(&mut links, "project", text(&row, "projectId")?, None);
            related(&mut links, "goal", text(&row, "goalId")?, None);
            related(&mut links, "agent", assignee.clone(), None);
            if reviewer != assignee {
                related(&mut links, "agent", reviewer, None);
            }
            summary = json_text(&format!(
                "User commented on {}: {}",
                text(&row, "issueIdentifier")?.as_deref().unwrap_or("issue"),
                needed(&row, "issueTitle")?
            ));
            excerpt_json = excerpt(string_field(&row, "body")?);
            metadata = metadata_fields(&row, &["issueId", "issueIdentifier", "issueStatus"]);
            source_type = "comment";
            source_id = id.clone();
            source_link = Some(format!("issue://{issue}?c={id}"));
            table = "issue_comments";
        }
        Source::Approval => {
            let approval = needed(&row, "approvalId")?;
            let kind = needed(&row, "approvalType")?;
            related(
                &mut links,
                "approval",
                Some(approval.clone()),
                Some(json_text(&kind)),
            );
            related(&mut links, "agent", text(&row, "requestedByAgentId")?, None);
            summary = json_text(&format!("User commented on {kind} approval"));
            excerpt_json = excerpt(string_field(&row, "body")?);
            metadata = metadata_fields(&row, &["approvalId", "approvalType", "approvalStatus"]);
            source_type = "approval";
            source_id = approval.clone();
            source_link = Some(format!("approval://{approval}?c={id}"));
            table = "approval_comments";
        }
        Source::Activity => {
            let entity = needed(&row, "entityType")?;
            let entity_id = needed(&row, "entityId")?;
            let action = needed(&row, "action")?;
            if entity == "issue"
                && text(&row, "issueIdentifier")?.is_none_or(|v| v.is_empty())
                && text(&row, "issueTitle")?.is_none_or(|v| v.is_empty())
            {
                return Ok(None);
            }
            if entity == "approval" && text(&row, "approvalType")?.is_none_or(|v| v.is_empty()) {
                return Ok(None);
            }
            let detail = details(value(&row, "details"))?;
            let fields = object(&detail)?;
            let agent = text(&row, "agentId")?;
            let requested = text(&row, "approvalRequestedByAgentId")?;
            related(
                &mut links,
                "agent",
                agent.clone(),
                Some(raw(&row, "agentName")),
            );
            if requested != agent {
                related(&mut links, "agent", requested, None);
            }
            related(&mut links, "run", text(&row, "runId")?, None);
            match entity.as_str() {
                "issue" => related(
                    &mut links,
                    "issue",
                    Some(entity_id.clone()),
                    Some(label(&row, "issueIdentifier", "issueTitle")),
                ),
                "approval" => related(
                    &mut links,
                    "approval",
                    Some(entity_id.clone()),
                    Some(raw(&row, "approvalType")),
                ),
                "chat" | "project" => related(&mut links, &entity, Some(entity_id.clone()), None),
                _ => (),
            }
            related(&mut links, "project", text(&row, "issueProjectId")?, None);
            related(&mut links, "goal", text(&row, "issueGoalId")?, None);
            let mut sentence = JsString::from(format!("User {action} on {entity}").as_str());
            if let Some(title) = title(&fields)? {
                sentence.0.extend(": ".encode_utf16());
                sentence.0.extend(title.0);
            }
            summary = sentence.json();
            excerpt_json =
                excerpt(string_field(&fields, "note")?.or(string_field(&fields, "comment")?));
            let mut m = metadata_fields(&row, &["action", "entityType", "entityId"]);
            m.insert("details".into(), detail);
            metadata = m;
            source_type = "activity";
            source_id = id.clone();
            source_link = (entity == "issue").then(|| format!("issue://{entity_id}"));
            table = "activity_log";
        }
    }
    let source_json=serde_json::json!({"type":source_type,"id":source_id,"link":source_link,"provenance":{"table":table,"id":id,"orgId":org}}).to_string();
    let mut result = Object::new();
    for (key, val) in [
        ("id", json_text(&id)),
        ("kind", json_text(source.kind())),
        ("occurredAt", json_text(&occurred_at)),
        ("userId", json_text(user)),
        ("actor", actor.to_owned()),
        ("summary", summary),
        ("excerpt", excerpt_json),
        ("source", source_json),
        ("related", array(links)),
        ("metadata", encode_object(metadata)),
    ] {
        result.insert(key.into(), val);
    }
    Ok(Some(Item {
        id,
        source,
        occurred_at,
        millis,
        body: encode_object(result),
    }))
}
pub(super) async fn read(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    owner: Option<&str>,
    input: &ActivityLinkReadInput,
) -> Result<String, ActivityLinkReadError> {
    let limit = input.limit.unwrap_or(30.0).floor();
    if !(1.0..=100.0).contains(&limit) {
        return Err(ActivityLinkReadError::BadRequest(
            "'limit' must be between 1 and 100".into(),
        ));
    }
    let limit = limit as usize;
    let cursor = decode_cursor(input.cursor.as_deref())?;
    // postgres-js rejects an Invalid Date while serializing parameters, even
    // when the selected source has no rows. A generic SQL plan may never
    // evaluate a row-level timestamp cast, so preserve that failure explicitly
    // after the same limit/cursor checks rather than relying on the SQL cast.
    if [input.since.as_deref(), input.until.as_deref()].contains(&Some("Invalid Date")) {
        return Err(StoreError::InvalidReceipt.into());
    }
    if cursor.as_ref().is_some_and(|c| c.year_zero) {
        return Err(StoreError::InvalidReceipt.into());
    }
    let includes = input
        .include
        .as_ref()
        .filter(|values| !values.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            ["chat", "comments", "approvals", "activity"]
                .map(str::to_owned)
                .to_vec()
        });
    let has = |name: &str| includes.iter().any(|v| v == name);
    let user = input.user_id.as_deref().ok_or(StoreError::InvalidInput)?;
    let name = sqlx::query_scalar::<_, Option<String>>(
        "SELECT nickname FROM operator_profiles WHERE user_id=$1 LIMIT 1",
    )
    .bind(user)
    .fetch_optional(&mut **tx)
    .await?
    .flatten();
    let actor = serde_json::json!({"type":"user","id":user,"displayName":name}).to_string();
    let locale = input
        .canonical_locale
        .as_deref()
        .ok_or(StoreError::InvalidInput)?
        .parse::<icu_locale_core::Locale>()
        .map_err(|_| StoreError::InvalidInput)?;
    let collator = icu_collator::Collator::try_new(
        locale.into(),
        icu_collator::options::CollatorOptions::default(),
    )
    .map_err(|_| StoreError::InvalidReceipt)?;
    let mut items = Vec::new();
    for source in [
        Source::Chat,
        Source::Comment,
        Source::Approval,
        Source::Activity,
    ] {
        let enabled = match source {
            Source::Chat => has("chat"),
            Source::Comment => has("comments") || has("issues"),
            Source::Approval => has("approvals"),
            Source::Activity => has("activity") || has("issues") || has("approvals"),
        };
        if !enabled {
            continue;
        }
        let query = ledger_query::query(
            source,
            cursor.as_ref(),
            has("activity"),
            has("issues"),
            has("approvals"),
        );
        let mut query = sqlx::query(&query)
            .bind(org)
            .bind(user)
            .bind(&input.since)
            .bind(&input.until)
            .bind(&input.agent_id)
            .bind(&input.project_id)
            .bind(&input.issue_id)
            .bind(owner);
        if let Some(cursor) = &cursor {
            query = query.bind(&cursor.normalized_at);
            let order = source.rank().cmp(&cursor.source.rank());
            if !order.is_lt() {
                query = query.bind(&cursor.occurred_at);
                if order.is_eq() {
                    query = query.bind(&cursor.id);
                }
            }
        }
        let rows = query.bind((limit + 1) as i64).fetch_all(&mut **tx).await?;
        for row in rows {
            let data = object(&row.try_get::<String, _>("payload")?)?;
            // Missing/hidden issue and approval hydration is discarded before
            // Node calls toISOString; these rows still consumed the SQL cap.
            if source == Source::Activity {
                let entity = text(&data, "entityType")?;
                if (entity.as_deref() == Some("issue")
                    && text(&data, "issueIdentifier")?.is_none_or(|v| v.is_empty())
                    && text(&data, "issueTitle")?.is_none_or(|v| v.is_empty()))
                    || (entity.as_deref() == Some("approval")
                        && text(&data, "approvalType")?.is_none_or(|v| v.is_empty()))
                {
                    continue;
                }
            }
            // Legacy toISOString throws for invalid Dates before sorting, so
            // surviving invalid rows are a 500, never an inconsistent comparator.
            let stamp = row
                .try_get::<Option<String>, _>("occurred_at")?
                .ok_or(StoreError::InvalidReceipt)?;
            let millis = row
                .try_get::<Option<i64>, _>("millis")?
                .ok_or(StoreError::InvalidReceipt)?;
            if let Some(item) = item(source, data, stamp, millis, user, &actor)? {
                items.push(item);
            }
        }
    }
    items.retain(|item| {
        cursor.as_ref().is_none_or(|cursor| {
            cursor
                .millis
                .cmp(&item.millis)
                .then_with(|| item.source.rank().cmp(&cursor.source.rank()))
                .then_with(|| collator.compare(&item.id, &cursor.id))
                == Ordering::Greater
        })
    });
    items.sort_by(|a, b| {
        b.millis
            .cmp(&a.millis)
            .then_with(|| a.source.rank().cmp(&b.source.rank()))
            .then_with(|| collator.compare(&a.id, &b.id))
    });
    let more = items.len() > limit;
    items.truncate(limit);
    let next = if more {
        items
            .last()
            .map(|last| {
                URL_SAFE_NO_PAD.encode(format!(
                    "{{\"occurredAt\":{},\"kind\":{},\"id\":{}}}",
                    json_text(&last.occurred_at),
                    json_text(last.source.kind()),
                    json_text(&last.id)
                ))
            })
            .map(|v| json_text(&v))
            .unwrap_or_else(|| "null".into())
    } else {
        "null".into()
    };
    Ok(format!(
        "{{\"items\":{},\"nextCursor\":{next}}}",
        array(items.into_iter().map(|item| item.body).collect())
    ))
}
