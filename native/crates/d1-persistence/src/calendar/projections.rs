use super::{Result, http};
use crate::run_visibility;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};

pub(super) fn any_or_all(values: &[String], item: &str) -> bool {
    values.is_empty() || values.iter().any(|value| value == item)
}

#[derive(Clone, Copy)]
pub(super) struct ProjectionFilters<'a> {
    pub start: &'a str,
    pub end: &'a str,
    pub agent_ids: &'a [String],
    pub source_ids: &'a [String],
    pub kinds: &'a [String],
    pub statuses: &'a [String],
}

pub(super) async fn list_derived_events(
    pool: &PgPool,
    org: &str,
    owner_id: &str,
    filters: ProjectionFilters<'_>,
    run_id: Option<&str>,
) -> Result<Vec<Value>> {
    let ProjectionFilters {
        start,
        end,
        agent_ids,
        source_ids,
        kinds,
        statuses,
    } = filters;
    if !source_ids.is_empty() || !any_or_all(kinds, "agent_work_block") {
        return Ok(vec![]);
    }
    let query = format!(
        "SELECT r.id::text AS run_id,r.org_id::text AS org_id,r.agent_id::text AS agent_id,r.status AS run_status,to_char(COALESCE(r.started_at,r.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS started_at,to_char(COALESCE(r.finished_at,now()) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS ended_at,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,to_char(r.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at,r.trigger_detail,a.name AS agent_name,a.role AS agent_role,a.title AS agent_title,a.workspace_key AS agent_url_key,issue.id::text AS issue_id,issue.identifier AS issue_identifier,issue.title AS issue_title,issue.status AS issue_status,issue.priority AS issue_priority,automation.id::text AS automation_id,automation.title AS automation_title,fallback.activity_id::text AS fallback_activity_id,fallback.issue_id::text AS fallback_issue_id,fallback.issue_identifier AS fallback_issue_identifier,fallback.issue_title AS fallback_issue_title,fallback.issue_status AS fallback_issue_status,fallback.issue_priority AS fallback_issue_priority,fallback.automation_id::text AS fallback_automation_id,fallback.automation_title AS fallback_automation_title FROM heartbeat_runs r JOIN agents a ON a.id=r.agent_id AND a.org_id=r.org_id LEFT JOIN issues issue ON issue.id::text=r.context_snapshot->>'issueId' AND issue.org_id=r.org_id AND issue.hidden_at IS NULL LEFT JOIN automations automation ON issue.origin_kind='automation_execution' AND issue.origin_id=automation.id::text AND automation.org_id=issue.org_id LEFT JOIN LATERAL (SELECT activity.id AS activity_id,issues.id AS issue_id,issues.identifier AS issue_identifier,issues.title AS issue_title,issues.status AS issue_status,issues.priority AS issue_priority,automations.id AS automation_id,automations.title AS automation_title FROM activity_log activity JOIN issues ON issues.id::text=activity.entity_id AND issues.org_id=activity.org_id AND issues.hidden_at IS NULL LEFT JOIN automations ON issues.origin_kind='automation_execution' AND issues.origin_id=automations.id::text AND automations.org_id=issues.org_id WHERE activity.org_id=r.org_id AND activity.run_id=r.id AND activity.entity_type='issue' ORDER BY activity.created_at DESC LIMIT 1) fallback ON true WHERE r.org_id=$1::uuid AND COALESCE(r.started_at,r.created_at)<$3::timestamptz AND COALESCE(r.finished_at,now())>$2::timestamptz AND (cardinality($4::text[])=0 OR r.agent_id=ANY(($4::text[])::uuid[])) AND ({}) AND ($5::uuid IS NULL OR r.id=$5::uuid) ORDER BY COALESCE(r.started_at,r.created_at)",
        run_visibility::predicate("r", 6)
    );
    let run = run_id.map(str::to_owned);
    let rows = sqlx::query(&query)
        .bind(org)
        .bind(start)
        .bind(end)
        .bind(agent_ids)
        .bind(run.as_deref())
        .bind(owner_id)
        .fetch_all(pool)
        .await?;
    let mut events = vec![];
    for row in rows {
        let run_id: String = row.try_get("run_id")?;
        let org_id: String = row.try_get("org_id")?;
        let agent_id: String = row.try_get("agent_id")?;
        let status: String = row.try_get("run_status")?;
        let event_status = if status == "queued" || status == "running" {
            "in_progress"
        } else {
            "actual"
        };
        if !any_or_all(statuses, event_status) {
            continue;
        }
        let get = |key: &str| row.try_get::<Option<String>, _>(key).unwrap_or(None);
        let issue_id = get("issue_id").or_else(|| get("fallback_issue_id"));
        let issue_title = get("issue_title").or_else(|| get("fallback_issue_title"));
        let issue = if let (Some(id), Some(title)) = (issue_id.clone(), issue_title.clone()) {
            Some(
                json!({"id":id,"identifier":get("issue_identifier").or_else(||get("fallback_issue_identifier")),"title":title,"status":get("issue_status").or_else(||get("fallback_issue_status")).unwrap_or("todo".into()),"priority":get("issue_priority").or_else(||get("fallback_issue_priority")).unwrap_or("medium".into())}),
            )
        } else {
            None
        };
        let automation_id = get("automation_id").or_else(|| get("fallback_automation_id"));
        let automation = automation_id
            .zip(get("automation_title").or_else(|| get("fallback_automation_title")))
            .map(|(id, title)| json!({"id":id,"title":title}));
        let agent_name: String = row.try_get("agent_name")?;
        let trigger: Option<String> = row.try_get("trigger_detail")?;
        let start_text: String = row.try_get("started_at")?;
        let end_text: String = row.try_get("ended_at")?;
        let created_text: String = row.try_get("created_at")?;
        let updated_text: String = row.try_get("updated_at")?;
        let title = issue_title
            .map(|title| format!("{agent_name} · {title}"))
            .unwrap_or_else(|| format!("{agent_name} · Agent run"));
        let source = json!({"id":"derived:agent-work","type":"agent_work","name":"Agent work history","visibilityDefault":"full","externalProvider":null});
        let agent = json!({"id":agent_id,"name":agent_name,"role":row.try_get::<String,_>("agent_role")?,"title":row.try_get::<Option<String>,_>("agent_title")?,"urlKey":row.try_get::<Option<String>,_>("agent_url_key")?});
        let mut event = json!({"id":format!("run:{run_id}"),"orgId":org_id,"sourceId":null,"eventKind":"agent_work_block","eventStatus":event_status,"ownerType":"agent","ownerUserId":null,"ownerAgentId":agent_id,"title":title,"description":trigger.map(|value|format!("Run trigger: {value}")),"startAt":start_text,"endAt":end_text,"timezone":"UTC","allDay":false,"visibility":"full","issueId":issue.as_ref().and_then(|v|v["id"].as_str()),"projectId":null,"goalId":null,"approvalId":null,"heartbeatRunId":run_id,"activityId":get("fallback_activity_id"),"sourceMode":"derived","externalProvider":null,"externalCalendarId":null,"externalEventId":null,"externalEtag":null,"externalUpdatedAt":null,"createdByUserId":null,"updatedByUserId":null,"createdAt":created_text,"updatedAt":updated_text,"deletedAt":null,"source":source,"agent":agent,"issue":issue,"automation":automation});
        // Response IDs and date ranges are computed by the original run query.
        event.as_object_mut().unwrap().remove("_ignored");
        events.push(event);
    }
    Ok(events)
}

pub(super) async fn list_projected_events(
    pool: &PgPool,
    org: &str,
    filters: ProjectionFilters<'_>,
) -> Result<Vec<Value>> {
    let ProjectionFilters {
        start,
        end,
        agent_ids,
        source_ids,
        kinds,
        statuses,
    } = filters;
    if !source_ids.is_empty()
        || !any_or_all(kinds, "agent_work_block")
        || !any_or_all(statuses, "projected")
    {
        return Ok(vec![]);
    }
    let now = time::OffsetDateTime::now_utc();
    let start_date =
        time::OffsetDateTime::parse(start, &time::format_description::well_known::Rfc3339)
            .map_err(|_| http(400, "Validation error"))?;
    let end_date = time::OffsetDateTime::parse(end, &time::format_description::well_known::Rfc3339)
        .map_err(|_| http(400, "Validation error"))?;
    let projection_start = if start_date > now { start_date } else { now };
    if end_date <= projection_start {
        return Ok(vec![]);
    }
    let agents = sqlx::query("SELECT id::text,org_id::text,name,role,title,workspace_key,status,COALESCE(runtime_config,'{}'::jsonb) AS runtime_config,CASE WHEN last_heartbeat_at IS NULL THEN NULL ELSE to_char(last_heartbeat_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') END AS last_heartbeat_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS created_at,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS updated_at FROM agents WHERE org_id=$1::uuid AND status NOT IN ('paused','terminated','pending_approval') AND (cardinality($2::text[])=0 OR id=ANY(($2::text[])::uuid[])) ORDER BY name")
        .bind(org).bind(agent_ids).fetch_all(pool).await?;
    let mut events = vec![];
    for agent in agents {
        let runtime: Value = agent.try_get("runtime_config")?;
        let heartbeat = runtime
            .get("heartbeat")
            .filter(|v| v.is_object())
            .unwrap_or(&Value::Null);
        let enabled = heartbeat
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let interval = heartbeat
            .get("intervalSec")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(0.0)
            .max(0.0);
        if !enabled || interval <= 0.0 {
            continue;
        }
        let interval_ms = interval * 1000.0;
        if interval_ms <= 0.0 {
            continue;
        }
        let baseline: Option<String> = agent.try_get("last_heartbeat_at")?;
        let baseline = baseline.unwrap_or(agent.try_get("created_at")?);
        let baseline =
            time::OffsetDateTime::parse(&baseline, &time::format_description::well_known::Rfc3339)
                .map_err(|_| http(500, "Internal server error"))?;
        let projection_ms = (projection_start.unix_timestamp_nanos() / 1_000_000) as f64;
        let baseline_ms = (baseline.unix_timestamp_nanos() / 1_000_000) as f64;
        let mut next_ms = baseline_ms + interval_ms;
        if next_ms < projection_ms {
            let elapsed = projection_ms - baseline_ms;
            next_ms = baseline_ms + (elapsed / interval_ms).ceil() * interval_ms;
        }
        let end_ms = (end_date.unix_timestamp_nanos() / 1_000_000) as f64;
        let range_end = end_ms;
        let created: String = agent.try_get("created_at")?;
        let updated: String = agent.try_get("updated_at")?;
        let iso_string = |millis: f64| -> Result<String> {
            let t =
                time::OffsetDateTime::from_unix_timestamp_nanos(millis.trunc() as i128 * 1_000_000)
                    .map_err(|_| http(500, "Internal server error"))?;
            Ok(format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
                t.year(),
                u8::from(t.month()),
                t.day(),
                t.hour(),
                t.minute(),
                t.second(),
                t.millisecond(),
            ))
        };
        let id: String = agent.try_get("id")?;
        let name: String = agent.try_get("name")?;
        let role: String = agent.try_get("role")?;
        let title: Option<String> = agent.try_get("title")?;
        let url_key: Option<String> = agent.try_get("workspace_key")?;
        let org_id: String = agent.try_get("org_id")?;
        for _ in 0..96 {
            if next_ms >= range_end {
                break;
            }
            let event_start = iso_string(next_ms)?;
            let event_end = iso_string((next_ms + 900_000.0).min(range_end))?;
            events.push(json!({"id":format!("projected-heartbeat:{id}:{event_start}"),"orgId":org_id,"sourceId":null,"eventKind":"agent_work_block","eventStatus":"projected","ownerType":"agent","ownerUserId":null,"ownerAgentId":id,"title":format!("{name} · Projected heartbeat"),"description":format!("Projected from this agent's {interval}s timer heartbeat. This does not schedule or guarantee execution."),"startAt":event_start,"endAt":event_end,"timezone":"UTC","allDay":false,"visibility":"full","issueId":null,"projectId":null,"goalId":null,"approvalId":null,"heartbeatRunId":null,"activityId":null,"sourceMode":"derived","externalProvider":null,"externalCalendarId":null,"externalEventId":null,"externalEtag":null,"externalUpdatedAt":null,"createdByUserId":null,"updatedByUserId":null,"createdAt":created,"updatedAt":updated,"deletedAt":null,"source":{"id":"derived:projected-heartbeats","type":"system","name":"Projected heartbeats","visibilityDefault":"full","externalProvider":null},"agent":{"id":id,"name":name,"role":role,"title":title,"urlKey":url_key},"issue":null}));
            next_ms += interval_ms;
        }
    }
    Ok(events)
}
