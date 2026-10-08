use super::audit::audit;
use super::common::object;
use super::common::{
    Audit, EVENT_KINDS, EVENT_STATUSES, OWNER_TYPES, SOURCE_MODES, VISIBILITIES, bool_field,
    date_field, enum_field, event_json, event_summary, list_value, optional_text, string_field,
    uuid_optional, validate_event_shape,
};
use super::projections::{list_derived_events, list_projected_events};
use super::{Result, http, text};
use serde_json::{Map, Value, json};
use sqlx::{PgPool, Row};

#[derive(Clone, Debug)]
pub(super) struct EventInput {
    fields: Map<String, Value>,
}

impl EventInput {
    pub(super) fn parse(value: &Value, partial: bool) -> Result<Self> {
        let fields = object(value)?;
        let mut parsed = Map::new();
        for (key, allowed, min, max) in [
            ("eventKind", EVENT_KINDS, 0, 0),
            ("eventStatus", EVENT_STATUSES, 0, 0),
            ("ownerType", OWNER_TYPES, 0, 0),
            ("visibility", VISIBILITIES, 0, 0),
            ("sourceMode", SOURCE_MODES, 0, 0),
        ] {
            if let Some(found) = enum_field(value, key, allowed, None)? {
                parsed.insert(key.to_owned(), Value::String(found));
            } else if !partial && key == "eventStatus" {
                parsed.insert(key.to_owned(), Value::String("planned".to_owned()));
            } else if !partial && key == "visibility" {
                parsed.insert(key.to_owned(), Value::String("full".to_owned()));
            } else if !partial && key == "sourceMode" {
                parsed.insert(key.to_owned(), Value::String("manual".to_owned()));
            }
            let _ = (min, max);
        }
        for key in [
            "sourceId",
            "ownerAgentId",
            "issueId",
            "projectId",
            "goalId",
            "approvalId",
            "heartbeatRunId",
            "activityId",
        ] {
            if let Some(id) = uuid_optional(value, key)? {
                parsed.insert(key.to_owned(), id.map(Value::String).unwrap_or(Value::Null));
            }
        }
        for key in [
            "ownerUserId",
            "description",
            "externalProvider",
            "externalCalendarId",
            "externalEventId",
            "externalEtag",
        ] {
            let parsed_text = if key == "description" {
                match value.get(key) {
                    None => None,
                    Some(Value::Null) => Some(None),
                    Some(Value::String(text)) => Some(Some(text.clone())),
                    _ => return Err(http(400, "Validation error")),
                }
            } else {
                optional_text(value, key)?
            };
            if let Some(v) = parsed_text {
                if let Some(text) = &v {
                    let length = text.encode_utf16().count();
                    let maximum = match key {
                        "externalProvider" => Some(80),
                        "externalCalendarId" | "externalEventId" | "externalEtag" => Some(512),
                        _ => None,
                    };
                    if key != "description"
                        && (length == 0 || maximum.is_some_and(|max| length > max))
                    {
                        return Err(http(400, "Validation error"));
                    }
                }
                parsed.insert(key.to_owned(), v.map(Value::String).unwrap_or(Value::Null));
            }
        }
        if let Some(title) = string_field(value, "title", 1, 240)? {
            parsed.insert("title".into(), Value::String(title));
        } else if !partial {
            return Err(http(400, "Validation error"));
        }
        if let Some(timezone) = string_field(value, "timezone", 1, 80)? {
            parsed.insert("timezone".into(), Value::String(timezone));
        } else if !partial {
            parsed.insert("timezone".into(), Value::String("UTC".into()));
        }
        for key in ["startAt", "endAt", "externalUpdatedAt"] {
            if let Some(date) = date_field(value, key, !partial && key != "externalUpdatedAt")? {
                parsed.insert(key.to_owned(), Value::String(date));
            } else if key == "externalUpdatedAt" && value.get(key).is_some_and(Value::is_null) {
                parsed.insert(key.to_owned(), Value::Null);
            }
        }
        if let (Some(start), Some(end)) = (
            parsed.get("startAt").and_then(Value::as_str),
            parsed.get("endAt").and_then(Value::as_str),
        ) {
            let start =
                time::OffsetDateTime::parse(start, &time::format_description::well_known::Rfc3339)
                    .map_err(|_| http(400, "Validation error"))?;
            let end =
                time::OffsetDateTime::parse(end, &time::format_description::well_known::Rfc3339)
                    .map_err(|_| http(400, "Validation error"))?;
            if end <= start {
                return Err(http(400, "Validation error"));
            }
        }
        if let Some(all_day) =
            bool_field(value, "allDay", if partial { None } else { Some(false) })?
        {
            parsed.insert("allDay".into(), Value::Bool(all_day));
        }
        if !partial && (!parsed.contains_key("eventKind") || !parsed.contains_key("ownerType")) {
            return Err(http(400, "Validation error"));
        }
        if parsed
            .keys()
            .any(|key| fields.get(key).is_some_and(|v| v.is_array()))
        {
            return Err(http(400, "Validation error"));
        }
        Ok(Self { fields: parsed })
    }

    pub(super) fn value(&self) -> Value {
        Value::Object(self.fields.clone())
    }
}

pub(super) fn list_strings(value: &Value, key: &str) -> Result<Vec<String>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| http(400, "Validation error"))
            })
            .collect(),
        _ => Err(http(400, "Validation error")),
    }
}

pub(super) fn parse_filters(value: &Value) -> Result<Value> {
    let map = object(value)?;
    let start = date_field(value, "start", true)?.ok_or_else(|| http(400, "Validation error"))?;
    let end = date_field(value, "end", true)?.ok_or_else(|| http(400, "Validation error"))?;
    let s = time::OffsetDateTime::parse(&start, &time::format_description::well_known::Rfc3339)
        .map_err(|_| http(400, "Validation error"))?;
    let e = time::OffsetDateTime::parse(&end, &time::format_description::well_known::Rfc3339)
        .map_err(|_| http(400, "Validation error"))?;
    if e <= s {
        return Err(http(400, "Validation error"));
    }
    let mut out = Map::new();
    out.insert("start".into(), Value::String(start));
    out.insert("end".into(), Value::String(end));
    for key in ["agentIds", "sourceIds", "eventKinds", "statuses"] {
        let values = match value.get(key) {
            None | Some(Value::Null) => vec![],
            Some(Value::String(raw)) => raw
                .split(',')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(str::to_owned)
                .collect(),
            _ => return Err(http(400, "Validation error")),
        };
        out.insert(
            key.into(),
            serde_json::to_value(values).unwrap_or(Value::Null),
        );
    }
    let _ = map;
    Ok(Value::Object(out))
}

pub(super) async fn list_events(
    pool: &PgPool,
    org: &str,
    owner_id: &str,
    filters: &Value,
) -> Result<Value> {
    let start = text(filters, "start").ok_or_else(|| http(400, "Validation error"))?;
    let end = text(filters, "end").ok_or_else(|| http(400, "Validation error"))?;
    let agent_ids = list_strings(filters, "agentIds")?;
    let source_ids = list_strings(filters, "sourceIds")?;
    let kinds = list_strings(filters, "eventKinds")?;
    let statuses = list_strings(filters, "statuses")?;
    let ejson = event_json("e", "j");
    let query = format!(
        "SELECT {ejson} AS value FROM calendar_events e LEFT JOIN calendar_sources j_source ON j_source.id=e.source_id AND j_source.org_id=e.org_id LEFT JOIN agents j_agent ON j_agent.id=e.owner_agent_id AND j_agent.org_id=e.org_id LEFT JOIN issues j_issue ON j_issue.id=e.issue_id AND j_issue.org_id=e.org_id LEFT JOIN automations j_automation ON j_automation.org_id=j_issue.org_id AND j_issue.origin_kind='automation_execution' AND j_issue.origin_id=j_automation.id::text WHERE e.org_id=$1::uuid AND e.deleted_at IS NULL AND e.start_at<$3::timestamptz AND e.end_at>$2::timestamptz AND (cardinality($4::text[])=0 OR e.owner_agent_id=ANY(($4::text[])::uuid[])) AND (cardinality($5::text[])=0 OR e.source_id=ANY(($5::text[])::uuid[])) AND (cardinality($6::text[])=0 OR e.event_kind=ANY($6::text[])) AND (cardinality($7::text[])=0 OR e.event_status=ANY($7::text[])) ORDER BY e.start_at,e.title"
    );
    let persisted = sqlx::query(&query)
        .bind(org)
        .bind(start)
        .bind(end)
        .bind(agent_ids.clone())
        .bind(source_ids.clone())
        .bind(kinds.clone())
        .bind(statuses.clone())
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(list_value)
        .collect::<Result<Vec<_>>>()?;
    let derived = list_derived_events(
        pool,
        org,
        owner_id,
        start,
        end,
        &agent_ids,
        &source_ids,
        &kinds,
        &statuses,
        None,
    )
    .await?;
    let projected = list_projected_events(
        pool,
        org,
        start,
        end,
        &agent_ids,
        &source_ids,
        &kinds,
        &statuses,
    )
    .await?;
    let mut events = persisted
        .into_iter()
        .chain(derived)
        .chain(projected)
        .collect::<Vec<_>>();
    events.sort_by(|left, right| {
        left["startAt"]
            .as_str()
            .cmp(&right["startAt"].as_str())
            .then_with(|| {
                left["title"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase()
                    .cmp(&right["title"].as_str().unwrap_or_default().to_lowercase())
            })
    });
    Ok(json!({"events":events}))
}

pub(super) async fn get_persisted_event(
    pool: &PgPool,
    org: &str,
    id: &str,
) -> Result<Option<Value>> {
    let projection = event_json("e", "j");
    let sql = format!(
        "SELECT {projection} AS value FROM calendar_events e LEFT JOIN calendar_sources j_source ON j_source.id=e.source_id AND j_source.org_id=e.org_id LEFT JOIN agents j_agent ON j_agent.id=e.owner_agent_id AND j_agent.org_id=e.org_id LEFT JOIN issues j_issue ON j_issue.id=e.issue_id AND j_issue.org_id=e.org_id LEFT JOIN automations j_automation ON j_automation.org_id=j_issue.org_id AND j_issue.origin_kind='automation_execution' AND j_issue.origin_id=j_automation.id::text WHERE e.id=$1::uuid AND e.org_id=$2::uuid AND e.deleted_at IS NULL"
    );
    sqlx::query(&sql)
        .bind(id)
        .bind(org)
        .fetch_optional(pool)
        .await?
        .map(list_value)
        .transpose()
}

pub(super) async fn get_persisted_event_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: &str,
    id: &str,
) -> Result<Option<Value>> {
    let projection = event_json("e", "j");
    let sql = format!(
        "SELECT {projection} AS value FROM calendar_events e LEFT JOIN calendar_sources j_source ON j_source.id=e.source_id AND j_source.org_id=e.org_id LEFT JOIN agents j_agent ON j_agent.id=e.owner_agent_id AND j_agent.org_id=e.org_id LEFT JOIN issues j_issue ON j_issue.id=e.issue_id AND j_issue.org_id=e.org_id LEFT JOIN automations j_automation ON j_automation.org_id=j_issue.org_id AND j_issue.origin_kind='automation_execution' AND j_issue.origin_id=j_automation.id::text WHERE e.id=$1::uuid AND e.org_id=$2::uuid AND e.deleted_at IS NULL"
    );
    sqlx::query(&sql)
        .bind(id)
        .bind(org)
        .fetch_optional(&mut **tx)
        .await?
        .map(list_value)
        .transpose()
}

pub(super) async fn get_writable_event(pool: &PgPool, org: &str, id: &str) -> Result<Value> {
    let event = get_persisted_event(pool, org, id)
        .await?
        .ok_or_else(|| http(404, "Calendar event not found"))?;
    if event["sourceMode"] != "manual" {
        return Err(http(
            409,
            "Imported and derived calendar events are read-only",
        ));
    }
    if event["eventKind"] != "human_event" {
        return Err(http(409, "Only My Calendar events can be edited"));
    }
    Ok(event)
}

pub(super) async fn event_create(
    pool: &PgPool,
    org: &str,
    audit_ctx: &Audit,
    input: &Value,
) -> Result<Value> {
    let input = EventInput::parse(input, false)?.value();
    validate_event_shape(pool, org, &input).await?;
    let mut tx = pool.begin().await?;
    let row=sqlx::query("INSERT INTO calendar_events (org_id,source_id,event_kind,event_status,owner_type,owner_user_id,owner_agent_id,title,description,start_at,end_at,timezone,all_day,visibility,issue_id,project_id,goal_id,approval_id,heartbeat_run_id,activity_id,source_mode,external_provider,external_calendar_id,external_event_id,external_etag,external_updated_at,created_by_user_id,updated_by_user_id) VALUES ($1::uuid,NULLIF($2,'')::uuid,$3,$4,$5,$6,NULLIF($7,'')::uuid,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14,NULLIF($15,'')::uuid,NULLIF($16,'')::uuid,NULLIF($17,'')::uuid,NULLIF($18,'')::uuid,NULLIF($19,'')::uuid,NULLIF($20,'')::uuid,$21,$22,$23,$24,$25,NULLIF($26,'')::timestamptz,$27,$27) RETURNING id::text")
        .bind(org).bind(input["sourceId"].as_str().unwrap_or("")).bind(input["eventKind"].as_str()).bind(input["eventStatus"].as_str()).bind(input["ownerType"].as_str()).bind(input.get("ownerUserId").and_then(Value::as_str)).bind(input["ownerAgentId"].as_str().unwrap_or("")).bind(input["title"].as_str()).bind(input.get("description").and_then(Value::as_str)).bind(input["startAt"].as_str()).bind(input["endAt"].as_str()).bind(input["timezone"].as_str()).bind(input["allDay"].as_bool()).bind(input["visibility"].as_str()).bind(input["issueId"].as_str().unwrap_or("")).bind(input["projectId"].as_str().unwrap_or("")).bind(input["goalId"].as_str().unwrap_or("")).bind(input["approvalId"].as_str().unwrap_or("")).bind(input["heartbeatRunId"].as_str().unwrap_or("")).bind(input["activityId"].as_str().unwrap_or("")).bind(input["sourceMode"].as_str()).bind(input.get("externalProvider").and_then(Value::as_str)).bind(input.get("externalCalendarId").and_then(Value::as_str)).bind(input.get("externalEventId").and_then(Value::as_str)).bind(input.get("externalEtag").and_then(Value::as_str)).bind(input.get("externalUpdatedAt").and_then(Value::as_str)).bind(&audit_ctx.actor_id).fetch_one(&mut *tx).await?;
    let id: String = row.try_get("id")?;
    let event = get_persisted_event_tx(&mut tx, org, &id)
        .await?
        .ok_or_else(|| http(500, "Calendar event was not created"))?;
    audit(
        &mut tx,
        org,
        audit_ctx,
        "calendar.event_created",
        "calendar_event",
        &id,
        Some(&event_summary(&event)),
    )
    .await?;
    tx.commit().await?;
    Ok(event)
}

pub(super) async fn event_update(
    pool: &PgPool,
    org: &str,
    audit_ctx: &Audit,
    id: &str,
    value: &Value,
) -> Result<Value> {
    let previous = get_writable_event(pool, org, id).await?;
    let patch = EventInput::parse(value, true)?.value();
    let mut merged = previous.clone();
    for (key, v) in patch.as_object().unwrap() {
        merged[key] = v.clone();
    }
    validate_event_shape(pool, org, &merged).await?;
    let patch_json = serde_json::to_string(&patch).map_err(|_| http(400, "Validation error"))?;
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE calendar_events SET source_id=CASE WHEN $3::jsonb ? 'sourceId' THEN NULLIF(($3::jsonb)->>'sourceId','')::uuid ELSE source_id END,event_kind=CASE WHEN $3::jsonb ? 'eventKind' THEN ($3::jsonb)->>'eventKind' ELSE event_kind END,event_status=CASE WHEN $3::jsonb ? 'eventStatus' THEN ($3::jsonb)->>'eventStatus' ELSE event_status END,owner_type=CASE WHEN $3::jsonb ? 'ownerType' THEN ($3::jsonb)->>'ownerType' ELSE owner_type END,owner_user_id=CASE WHEN $3::jsonb ? 'ownerUserId' THEN ($3::jsonb)->>'ownerUserId' ELSE owner_user_id END,owner_agent_id=CASE WHEN $3::jsonb ? 'ownerAgentId' THEN NULLIF(($3::jsonb)->>'ownerAgentId','')::uuid ELSE owner_agent_id END,title=CASE WHEN $3::jsonb ? 'title' THEN ($3::jsonb)->>'title' ELSE title END,description=CASE WHEN $3::jsonb ? 'description' THEN ($3::jsonb)->>'description' ELSE description END,start_at=CASE WHEN $3::jsonb ? 'startAt' THEN (($3::jsonb)->>'startAt')::timestamptz ELSE start_at END,end_at=CASE WHEN $3::jsonb ? 'endAt' THEN (($3::jsonb)->>'endAt')::timestamptz ELSE end_at END,timezone=CASE WHEN $3::jsonb ? 'timezone' THEN ($3::jsonb)->>'timezone' ELSE timezone END,all_day=CASE WHEN $3::jsonb ? 'allDay' THEN (($3::jsonb)->>'allDay')::boolean ELSE all_day END,visibility=CASE WHEN $3::jsonb ? 'visibility' THEN ($3::jsonb)->>'visibility' ELSE visibility END,issue_id=CASE WHEN $3::jsonb ? 'issueId' THEN NULLIF(($3::jsonb)->>'issueId','')::uuid ELSE issue_id END,project_id=CASE WHEN $3::jsonb ? 'projectId' THEN NULLIF(($3::jsonb)->>'projectId','')::uuid ELSE project_id END,goal_id=CASE WHEN $3::jsonb ? 'goalId' THEN NULLIF(($3::jsonb)->>'goalId','')::uuid ELSE goal_id END,approval_id=CASE WHEN $3::jsonb ? 'approvalId' THEN NULLIF(($3::jsonb)->>'approvalId','')::uuid ELSE approval_id END,heartbeat_run_id=CASE WHEN $3::jsonb ? 'heartbeatRunId' THEN NULLIF(($3::jsonb)->>'heartbeatRunId','')::uuid ELSE heartbeat_run_id END,activity_id=CASE WHEN $3::jsonb ? 'activityId' THEN NULLIF(($3::jsonb)->>'activityId','')::uuid ELSE activity_id END,source_mode=CASE WHEN $3::jsonb ? 'sourceMode' THEN ($3::jsonb)->>'sourceMode' ELSE source_mode END,external_provider=CASE WHEN $3::jsonb ? 'externalProvider' THEN ($3::jsonb)->>'externalProvider' ELSE external_provider END,external_calendar_id=CASE WHEN $3::jsonb ? 'externalCalendarId' THEN ($3::jsonb)->>'externalCalendarId' ELSE external_calendar_id END,external_event_id=CASE WHEN $3::jsonb ? 'externalEventId' THEN ($3::jsonb)->>'externalEventId' ELSE external_event_id END,external_etag=CASE WHEN $3::jsonb ? 'externalEtag' THEN ($3::jsonb)->>'externalEtag' ELSE external_etag END,external_updated_at=CASE WHEN $3::jsonb ? 'externalUpdatedAt' THEN NULLIF(($3::jsonb)->>'externalUpdatedAt','')::timestamptz ELSE external_updated_at END,updated_by_user_id=$4,updated_at=now() WHERE id=$1::uuid AND org_id=$2::uuid")
        .bind(id).bind(org).bind(patch_json).bind(&audit_ctx.actor_id).execute(&mut *tx).await?;
    let event = get_persisted_event_tx(&mut tx, org, id)
        .await?
        .ok_or_else(|| http(500, "Calendar event was not updated"))?;
    let details = json!({"previous":event_summary(&previous),"current":event_summary(&event)});
    audit(
        &mut tx,
        org,
        audit_ctx,
        "calendar.event_updated",
        "calendar_event",
        id,
        Some(&details),
    )
    .await?;
    tx.commit().await?;
    Ok(event)
}

pub(super) async fn event_delete(
    pool: &PgPool,
    org: &str,
    audit_ctx: &Audit,
    id: &str,
) -> Result<Value> {
    let event = get_writable_event(pool, org, id).await?;
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE calendar_events SET deleted_at=now(),updated_at=now(),updated_by_user_id=$3,event_status='cancelled' WHERE id=$1::uuid AND org_id=$2::uuid")
        .bind(id).bind(org).bind(&audit_ctx.actor_id).execute(&mut *tx).await?;
    audit(
        &mut tx,
        org,
        audit_ctx,
        "calendar.event_deleted",
        "calendar_event",
        id,
        Some(&event_summary(&event)),
    )
    .await?;
    tx.commit().await?;
    Ok(json!({"ok":true}))
}
