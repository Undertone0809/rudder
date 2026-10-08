//! Organization-scoped Goal GET authority. All projections are public allowlists;
//! persisted contract, runtime and evidence internals never cross the bridge.
use crate::{
    StoreError,
    legacy_read_json::{normalize_legacy_read_json, parse_legacy_read_json},
    transaction,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use regex_lite::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::{collections::HashMap, sync::OnceLock};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;

mod workspace;

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GoalReadView {
    List,
    Detail,
    Activities,
    History,
    Dependencies,
    WorkspaceCards,
    Assigned,
    Workspace,
    AgentContext,
    Timeline,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GoalReadRequest {
    pub view: GoalReadView,
    #[serde(deserialize_with = "required_goal_id")]
    pub goal_id: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<String>,
    pub agent_id: Option<String>,
    pub lifecycle: Option<String>,
    pub focus: Option<bool>,
    pub facet: Option<String>,
}
fn required_goal_id<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}

#[derive(Debug, thiserror::Error)]
pub enum GoalReadError {
    #[error("Invalid Goal history cursor")]
    Cursor,
    #[error("Goal history limit must be between 1 and 100")]
    Limit,
    #[error("Goal activity timeline limit must be between 1 and 100")]
    TimelineLimit,
    #[error(transparent)]
    Store(#[from] StoreError),
}
impl From<sqlx::Error> for GoalReadError {
    fn from(error: sqlx::Error) -> Self {
        Self::Store(error.into())
    }
}

// Match Date.toJSON millisecond precision and UTC spelling, including nulls.
// Table names, aliases and columns below are constants, never request values.
fn json_strings(expression: &str) -> String {
    format!(
        "(SELECT COALESCE(jsonb_agg(e.value),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof({expression})='array' THEN {expression} ELSE '[]'::jsonb END) e WHERE jsonb_typeof(e.value)='string')"
    )
}
fn row_sql(table: &str, date_columns: &[&str]) -> String {
    // Select only fields used by this public view. Ignored/private JSON may be
    // arbitrarily deep, and must not poison an otherwise valid public read.
    let fields: &[&str] = match table {
        "goals" => &[
            "id",
            "org_id",
            "title",
            "description",
            "lifecycle",
            "status",
            "outcome_statement",
            "owner_agent_id",
            "focus",
            "continuation_kind",
            "continuation_summary",
            "wake_condition",
            "alignment_question",
            "close_reason",
            "plan_revision",
        ],
        "goal_activities" => &[
            "id",
            "org_id",
            "goal_id",
            "activity_kind",
            "summary",
            "submitted_by_agent_id",
            "run_ref",
        ],
        "goal_owner_assignments" => &["agent_id", "assignment_revision"],
        "goal_plans" => &["revision", "summary"],
        "goal_feedback_entries" => &["id", "actor_id", "body", "feedback_kind"],
        "goal_change_proposals" => &[
            "id",
            "rationale",
            "proposed_by_agent_id",
            "approval_id",
            "status",
        ],
        "goal_result_proposals" => &["id", "proposed_by_agent_id", "risk_summary", "status"],
        _ => unreachable!("static Goal table allowlist"),
    };
    let mut entries = fields
        .iter()
        .map(|name| format!("'{name}',t.{name}"))
        .collect::<Vec<_>>();
    entries.extend(date_columns.iter().map(|name| {
        format!("'{name}',to_char(t.{name} AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
    }));
    match table {
        "goals" => {
            entries.push("'criteria',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',e.value->'id','label',e.value->'label')),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.criteria)='array' THEN t.criteria ELSE '[]'::jsonb END) e WHERE jsonb_typeof(e.value->'id')='string' AND jsonb_typeof(e.value->'label')='string')".to_owned());
            entries.push("'evaluation_result',CASE WHEN jsonb_typeof(t.evaluation_result->'outcome')='string' THEN jsonb_build_object('outcome',t.evaluation_result->'outcome') ELSE NULL END".to_owned());
        }
        "goal_activities" | "goal_change_proposals" => entries.push(format!(
            "'evidence_refs',{}",
            json_strings("t.evidence_refs")
        )),
        "goal_result_proposals" => {
            entries.push(format!(
                "'candidate',jsonb_build_object('evidenceRefs',{})",
                json_strings("t.candidate->'evidenceRefs'")
            ));
            entries.push("'preflight',jsonb_build_object('outcome',CASE WHEN jsonb_typeof(t.preflight->'outcome')='string' THEN t.preflight->'outcome' ELSE NULL END)".to_owned());
        }
        "goal_feedback_entries" => {
            // Attachment contracts contain scalar fields. Discard unknown nested
            // metadata before structural decoding, just as the public mapper does.
            entries.push("'attachments',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',e.value->'name','mimeType',e.value->'mimeType','size',e.value->'size','uri',e.value->'uri')),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.attachments)='array' THEN t.attachments ELSE '[]'::jsonb END) e)".to_owned());
        }
        _ => (),
    }
    let opaque = if table == "goals" {
        ",t.owner_agent_runtime_overrides::text AS overrides"
    } else {
        ""
    };
    format!(
        "SELECT jsonb_build_object({})::text AS value{opaque} FROM {table} t",
        entries.join(",")
    )
}
// Runtime overrides are intentionally opaque in the public contract. Normalize
// numeric tokens iteratively and splice validated JSON into our serialized object
// so neither serde's structural ceiling nor its recursive serializer applies.
fn serialize_goal(goal: &Value, overrides: Option<&str>) -> Result<String, StoreError> {
    let mut shallow = goal.clone();
    shallow
        .as_object_mut()
        .ok_or(StoreError::InvalidReceipt)?
        .remove("ownerAgentRuntimeOverrides");
    let mut response = serde_json::to_string(&shallow).map_err(|_| StoreError::InvalidReceipt)?;
    response.pop();
    response.push_str(",\"ownerAgentRuntimeOverrides\":");
    response.push_str(
        &normalize_legacy_read_json(overrides.unwrap_or("null"))
            .map_err(|_| StoreError::InvalidReceipt)?,
    );
    response.push('}');
    Ok(response)
}

fn row(raw: &str) -> Result<Value, StoreError> {
    let Value::Object(source) =
        parse_legacy_read_json(raw).map_err(|_| StoreError::InvalidReceipt)?
    else {
        return Err(StoreError::InvalidReceipt);
    };
    let mut result = serde_json::Map::new();
    for (key, value) in source {
        let mut parts = key.split('_');
        let mut camel = parts.next().unwrap_or_default().to_owned();
        for part in parts {
            let mut chars = part.chars();
            if let Some(first) = chars.next() {
                camel.extend(first.to_uppercase());
            }
            camel.extend(chars);
        }
        result.insert(camel, value);
    }
    Ok(Value::Object(result))
}
fn pick(row: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .map(|key| ((*key).to_owned(), row[*key].clone()))
            .collect(),
    )
}
fn text(row: &Value, key: &str) -> String {
    row[key].as_str().unwrap_or_default().to_owned()
}
fn trim(value: &str) -> &str {
    value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}
fn regex(pattern: &str) -> Regex {
    // regex-lite has ASCII word boundaries, just like non-/u JavaScript regexes.
    // Spell ECMAScript whitespace explicitly rather than Rust's different set.
    let space = r"[\t-\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
    Regex::new(
        &pattern
            .replace(r"[^\s)]", &format!("[^{})]", &space[1..space.len() - 1]))
            .replace(r"\s", space),
    )
    .expect("constant Goal regex")
}
pub fn public_goal_text(value: &str) -> String {
    static PATTERNS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| [
        (r"(?i)\bgoal\s+contract\b", "Goal"),
        (r"(?i)\bcontract\s+revision\b", "Goal update"),
        (r"(?i)\bcontracts?\b", "agreement"),
        (r"(?i)\bobjective\s+mode\b", "Goal type"),
        (r"(?i)\bevaluator\b", "success check"),
        (r"(?i)\bevidence\s+requirements?\b", "what we need to verify"),
        (r"(?i)\bautonomy\s+envelope\b", "working boundaries"),
        (r"(?i)\bhuman\s+authorit(?:y|ies)\b", "decisions that need you"),
        (r"(?i)\bcontinuation\b", "next step"),
        (r"(?i)\bchange\s+proposal\b", "Goal update"),
        (r"(?i)\bresult\s+proposal\b", "result review"),
        (r"(?i)\bchange_proposal\b", "Goal update"),
        (r"(?i)\bresult_proposal\b", "result review"),
        (r"(?i)\bruntime\s+evidence\b", "supporting evidence"),
        (r"(?i)\brun\s+evidence\b", "supporting work"),
        (r"(?i)\bpara-memory-files\b", "shared notes"),
        (r"(?i)\b(?:the\s+)?[`]?shared notes[`]?\s+skill\b", "shared notes"),
        (r"(?i)\bdaily[- ]note\b", "notes"),
        (r"(?i)\b(?:runtime\s+)?evidence\s+(?:demonstrates?|shows?)\s+that\b", "Supporting work shows that"),
        (r"(?i)\b(?:goal-feedback|goal-start|goal-change-decision|goal-result-evaluation):[0-9a-f-]{8,}\b", "the related update"),
        (r"(?i)\b(?:artifact|run|issue|project|approval|decision|measurement|library-file|library-entry)://[^\s)]+", "supporting work"),
        (r"(?i)\b[0-9a-f]{8}-[0-9a-f-]{27,}\b", "the related item"),
        (r"(?i)\b(?:feedback|activity|proposal|request|run)\s+(?:the related item|[0-9a-f-]{8,})\b", "the related update"),
    ].into_iter().map(|(pattern, replacement)| (regex(pattern), replacement)).collect());
    patterns
        .iter()
        .fold(value.to_owned(), |value, (pattern, replacement)| {
            pattern.replace_all(&value, *replacement).into_owned()
        })
}
fn outcome(outcome: &str) -> &'static str {
    match outcome {
        "achieved" => "Goal achieved",
        "not_achieved" => "Goal not achieved",
        "maintained" => "Goal maintained",
        "breached" => "Goal condition breached",
        "completed_with_result" => "Goal completed with a measured result",
        "decided" => "Goal completed with a decision",
        _ => "Result needs more evidence",
    }
}
fn activity_summary(activity: &Value) -> String {
    static TECHNICAL: OnceLock<Vec<Regex>> = OnceLock::new();
    let summary = text(activity, "summary");
    if TECHNICAL.get_or_init(|| [
        r"(?i)(?:failed query|stack trace|traceback|drizzlequeryerror|connection ended|node_modules|\b(?:ECONN|ENOTFOUND|ETIMEDOUT)\b)",
        r"(?i)(?:^|\s)(?:error|exception):", r"(?i)\bat\s+[\w./-]+:\d+(?::\d+)?", r"(?i)(?:process adapter|missing command|adapter failure)",
    ].iter().map(|s| regex(s)).collect()).iter().any(|p| p.is_match(&summary)) {
        return "The Agent shared an update that needs attention.".to_owned();
    }
    let summary = public_goal_text(&summary);
    if activity["activityKind"] == "closeout" {
        static LEGACY: OnceLock<Regex> = OnceLock::new();
        if let Some(captures) = LEGACY
            .get_or_init(|| regex(r"(?i)^Goal evaluated as\s+([^\n\r\u{2028}\u{2029}]+)$"))
            .captures(&summary)
        {
            return outcome(trim(&captures[1])).to_owned();
        }
    }
    summary
}
fn public_goal(goal: &Value) -> Value {
    let mut result = pick(
        goal,
        &[
            "id",
            "orgId",
            "title",
            "description",
            "lifecycle",
            "status",
            "outcomeStatement",
            "ownerAgentId",
            "ownerAgentRuntimeOverrides",
            "focus",
            "evaluationDeadline",
            "actionDeadline",
            "continuationSummary",
            "wakeCondition",
            "alignmentQuestion",
            "closeReason",
            "createdAt",
            "updatedAt",
        ],
    );
    result["shortRef"] = json!(format!("gol_{}", &text(goal, "id")[..8]));
    for key in [
        "outcomeStatement",
        "continuationSummary",
        "wakeCondition",
        "alignmentQuestion",
    ] {
        if let Some(value) = goal[key].as_str() {
            result[key] = json!(public_goal_text(value));
        }
    }
    result["evaluationResult"] = if let Some(value) = goal["evaluationResult"]["outcome"].as_str() {
        json!({"outcome":value})
    } else {
        Value::Null
    };
    result["criteria"] = json!(
        goal["criteria"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|criterion| {
                let id = criterion["id"].as_str().filter(|s| !trim(s).is_empty())?;
                let label = criterion["label"]
                    .as_str()
                    .filter(|s| !trim(s).is_empty())?;
                Some(json!({"id":id,"label":public_goal_text(label)}))
            })
            .collect::<Vec<_>>()
    );
    result
}
fn uri_component(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(b) {
                (*b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn href(path: String, org_key: Option<&str>) -> String {
    match org_key.filter(|s| !s.is_empty()) {
        Some(org) => format!("/{}{path}", uri_component(org)),
        None => path,
    }
}
fn evidence(value: &Value, agent: Option<&str>, org_key: Option<&str>) -> Value {
    Value::Array(value.as_array().into_iter().flatten().filter_map(Value::as_str).enumerate().map(|(index, reference)| {
        let index = index + 1;
        let parsed = Url::parse(reference).ok();
        if let Some(url) = &parsed {
            if reference.starts_with("library-file://") && url.scheme() == "library-file" {
                let pairs = url.query_pairs().collect::<Vec<_>>();
                let path = pairs.iter().find(|(k,_)| k == "p").or_else(|| pairs.iter().find(|(k,_)| k == "path")).map(|(_,v)|trim(v)).unwrap_or_default();
                if !path.is_empty() {
                    let name = path.split('/').rfind(|s| !s.is_empty());
                    let search = url::form_urlencoded::Serializer::new(String::new()).append_pair("path", path).finish();
                    return json!({"label":name.map(|n| format!("Library file: {n}")).unwrap_or("Library file".to_owned()),"href":href(format!("/library?{search}"),org_key),"external":false});
                }
            }
            if reference.starts_with("library-entry://") && url.scheme() == "library-entry" {
                let id = format!("{}{}",url.host_str().unwrap_or_default(),url.path());
                let id = trim(id.trim_start_matches('/'));
                if !id.is_empty() {
                    let pairs = url.query_pairs().collect::<Vec<_>>();
                    let path = pairs.iter().find(|(k,_)| k == "p").or_else(|| pairs.iter().find(|(k,_)| k == "path")).map(|(_,v)|trim(v)).unwrap_or_default();
                    let mut search = url::form_urlencoded::Serializer::new(String::new()); search.append_pair("entry",id); if !path.is_empty() { search.append_pair("path",path); }
                    let label = if path.is_empty() { "Library entry".to_owned() } else { format!("Library entry: {}",path.split('/').rfind(|s| !s.is_empty()).unwrap_or("entry")) };
                    return json!({"label":label,"href":href(format!("/library?{}",search.finish()),org_key),"external":false});
                }
            }
        }
        let scheme = parsed.as_ref().map(Url::scheme).unwrap_or("");
        let entity = parsed.as_ref().filter(|u| u.username().is_empty() && u.password().is_none() && u.port().is_none() && ["","/"].contains(&u.path())).and_then(Url::host_str).filter(|s| !s.is_empty() && s.as_bytes()[0].is_ascii_alphanumeric() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)));
        if let Some(id) = entity {
            let path_label = match scheme {
                "issue" => Some((format!("/issues/{}",uri_component(id)),format!("Issue {index}"))),
                "project" => Some((format!("/projects/{}",uri_component(id)),format!("Project {index}"))),
                "approval" => Some((format!("/messenger/approvals/{}",uri_component(id)),format!("Approval {index}"))),
                "run" => agent.filter(|s|!s.is_empty()).map(|agent|(format!("/agents/{}/runs/{}",uri_component(agent),uri_component(id)),format!("Supporting work {index}"))),
                _ => None,
            };
            if let Some((path,label)) = path_label { return json!({"label":label,"href":href(path,org_key),"external":false}); }
        }
        if matches!(scheme,"http"|"https") { return json!({"label":format!("External supporting link {index}"),"href":null,"external":true}); }
        let label = match scheme { ""|"artifact" => "Supporting work".to_owned(), other => format!("{other} support") };
        json!({"label":format!("{label} {index}"),"href":null,"external":false})
    }).collect())
}
fn public_activity(activity: &Value) -> Value {
    let mut result = pick(
        activity,
        &[
            "id",
            "orgId",
            "goalId",
            "activityKind",
            "occurredAt",
            "createdAt",
        ],
    );
    result["summary"] = json!(activity_summary(activity));
    result["evidence"] = evidence(
        &activity["evidenceRefs"],
        activity["submittedByAgentId"].as_str(),
        None,
    );
    result["runId"] = activity["runRef"].clone();
    result
}

pub async fn read_goals(
    pool: &PgPool,
    organization_id: &str,
    input: &GoalReadRequest,
) -> Result<String, GoalReadError> {
    read_goals_for_actor(pool, organization_id, input, None).await
}

/// Execute a Goal read with the owner identity derived from a verified actor
/// envelope. The owner is deliberately not part of the signed request JSON.
pub async fn read_goals_for_actor(
    pool: &PgPool,
    organization_id: &str,
    input: &GoalReadRequest,
    verified_run_owner: Option<&str>,
) -> Result<String, GoalReadError> {
    let org = organization_id.to_ascii_lowercase();
    transaction::uuid(&org)?;
    let goal_id = input.goal_id.as_ref().map(|s| s.to_ascii_lowercase());
    if let Some(id) = &goal_id {
        transaction::uuid(id)?;
    }
    let collection_view = matches!(
        input.view,
        GoalReadView::List | GoalReadView::WorkspaceCards | GoalReadView::Assigned
    );
    if collection_view != goal_id.is_none()
        || (!matches!(input.view, GoalReadView::History | GoalReadView::Timeline)
            && input.cursor.is_some())
        || (!matches!(
            input.view,
            GoalReadView::History | GoalReadView::Timeline | GoalReadView::Assigned
        ) && input.limit.is_some())
    {
        return Err(StoreError::InvalidInput.into());
    }
    if matches!(
        input.view,
        GoalReadView::WorkspaceCards
            | GoalReadView::Assigned
            | GoalReadView::Workspace
            | GoalReadView::AgentContext
            | GoalReadView::Timeline
    ) {
        return workspace::read_workspace(pool, &org, input, verified_run_owner).await;
    }
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let sql = format!(
        "{} WHERE t.org_id=$1::uuid AND ($2::uuid IS NULL OR t.id=$2::uuid) ORDER BY t.created_at",
        row_sql(
            "goals",
            &[
                "created_at",
                "updated_at",
                "action_deadline",
                "evaluation_deadline"
            ]
        )
    );
    let raw_goals = sqlx::query(&sql)
        .bind(&org)
        .bind(&goal_id)
        .fetch_all(&mut *tx)
        .await?;
    let mut goals = Vec::new();
    let mut overrides = Vec::new();
    for raw in raw_goals {
        goals.push(row(&raw.try_get::<String, _>("value")?)?);
        overrides.push(raw.try_get::<Option<String>, _>("overrides")?);
    }
    let result = if input.view == GoalReadView::List {
        Value::Array(goals.iter().map(public_goal).collect())
    } else {
        let goal = goals.first().ok_or(StoreError::NotFound)?;
        let id = text(goal, "id");
        match input.view {
            GoalReadView::Detail | GoalReadView::Activities => {
                let sql = format!(
                    "{} WHERE t.org_id=$1::uuid AND t.goal_id=$2::uuid ORDER BY t.occurred_at DESC,t.created_at DESC LIMIT 100",
                    row_sql("goal_activities", &["created_at", "occurred_at"])
                );
                let activities = sqlx::query_scalar::<_, String>(&sql)
                    .bind(&org)
                    .bind(&id)
                    .fetch_all(&mut *tx)
                    .await?
                    .iter()
                    .map(|s| row(s).map(|r| public_activity(&r)))
                    .collect::<Result<Vec<_>, _>>()?;
                if input.view == GoalReadView::Activities {
                    json!(activities)
                } else {
                    let sql = format!(
                        "{} WHERE t.org_id=$1::uuid AND t.goal_id=$2::uuid AND t.ends_at IS NULL LIMIT 1",
                        row_sql("goal_owner_assignments", &["starts_at", "ends_at"])
                    );
                    let assignment = sqlx::query_scalar::<_, String>(&sql)
                        .bind(&org)
                        .bind(&id)
                        .fetch_optional(&mut *tx)
                        .await?
                        .map(|s| row(&s))
                        .transpose()?;
                    let sql = format!(
                        "{} WHERE t.org_id=$1::uuid AND t.goal_id=$2::uuid AND t.revision=$3 AND $3>0 LIMIT 1",
                        row_sql("goal_plans", &["created_at", "updated_at"])
                    );
                    let plan = sqlx::query_scalar::<_, String>(&sql)
                        .bind(&org)
                        .bind(&id)
                        .bind(goal["planRevision"].as_i64().unwrap_or(0) as i32)
                        .fetch_optional(&mut *tx)
                        .await?
                        .map(|s| row(&s))
                        .transpose()?;
                    let mut result = public_goal(goal);
                    result["ownerAssignment"] = assignment
                        .map(|a| pick(&a, &["agentId", "assignmentRevision", "startsAt", "endsAt"]))
                        .unwrap_or(Value::Null);
                    result["plan"] = plan.map(|p|json!({"revision":p["revision"],"summary":public_goal_text(&text(&p,"summary"))})).unwrap_or(Value::Null);
                    result["activities"] = json!(activities);
                    result
                }
            }
            GoalReadView::History => history(&mut tx, &org, &id, input).await?,
            GoalReadView::Dependencies => dependencies(&mut tx, &org, goal).await?,
            GoalReadView::List => unreachable!(),
            GoalReadView::WorkspaceCards
            | GoalReadView::Assigned
            | GoalReadView::Workspace
            | GoalReadView::AgentContext
            | GoalReadView::Timeline => {
                unreachable!("workspace views returned before list selection")
            }
        }
    };
    tx.commit().await?;
    match input.view {
        GoalReadView::List => {
            let goals = result.as_array().ok_or(StoreError::InvalidReceipt)?;
            let serialized = goals
                .iter()
                .zip(overrides.iter())
                .map(|(goal, raw)| serialize_goal(goal, raw.as_deref()))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[{}]", serialized.join(",")))
        }
        GoalReadView::Detail => Ok(serialize_goal(
            &result,
            overrides.first().and_then(|r| r.as_deref()),
        )?),
        _ => serde_json::to_string(&result).map_err(|_| StoreError::InvalidReceipt.into()),
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryCursor {
    version: u8,
    created_at: String,
    kind: String,
    id: String,
}
fn history_limit(raw: Option<&str>) -> Result<i64, GoalReadError> {
    let Some(raw) = raw else { return Ok(50) };
    let raw = trim(raw);
    let number = if raw.is_empty() {
        Some(0.0)
    } else if let Some(hex) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).ok().map(|n| n as f64)
    } else if let Some(bin) = raw.strip_prefix("0b").or_else(|| raw.strip_prefix("0B")) {
        u64::from_str_radix(bin, 2).ok().map(|n| n as f64)
    } else if let Some(octal) = raw.strip_prefix("0o").or_else(|| raw.strip_prefix("0O")) {
        u64::from_str_radix(octal, 8).ok().map(|n| n as f64)
    } else {
        raw.parse::<f64>().ok()
    };
    number
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 1.0 && *n <= 100.0)
        .map(|n| n as i64)
        .ok_or(GoalReadError::Limit)
}
fn decode_cursor(raw: Option<&str>) -> Result<Option<HistoryCursor>, GoalReadError> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let raw = raw
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_");
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| GoalReadError::Cursor)?;
    let cursor: HistoryCursor =
        serde_json::from_slice(&bytes).map_err(|_| GoalReadError::Cursor)?;
    if cursor.version != 1
        || ![
            "activity",
            "feedback",
            "change_proposal",
            "result_proposal",
            "agent_run",
        ]
        .contains(&cursor.kind.as_str())
        || cursor.id.is_empty()
        || OffsetDateTime::parse(&cursor.created_at, &Rfc3339).is_err()
    {
        return Err(GoalReadError::Cursor);
    }
    Ok(Some(cursor))
}
async fn history(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    id: &str,
    input: &GoalReadRequest,
) -> Result<Value, GoalReadError> {
    let cursor = decode_cursor(input.cursor.as_deref())?;
    let limit = history_limit(input.limit.as_deref())?;
    let org_key: Option<String> =
        sqlx::query_scalar("SELECT url_key FROM organizations WHERE id=$1::uuid")
            .bind(org)
            .fetch_one(&mut **tx)
            .await?;
    let mut sources = Vec::new();
    for (table, kind, time) in [
        ("goal_activities", "activity", "occurred_at"),
        ("goal_feedback_entries", "feedback", "created_at"),
        ("goal_change_proposals", "change_proposal", "created_at"),
        ("goal_result_proposals", "result_proposal", "created_at"),
    ] {
        let sql = format!(
            "{} WHERE t.org_id=$1::uuid AND t.goal_id=$2::uuid AND ($3::timestamptz IS NULL OR t.{time} < $3::timestamptz OR (t.{time}=$3::timestamptz AND ($4::text < $5::text OR ($4=$5 AND t.id::text > $6::text)))) ORDER BY t.{time} DESC,t.id ASC LIMIT $7",
            row_sql(
                table,
                if kind == "activity" {
                    &["occurred_at", "created_at"]
                } else {
                    &["created_at"]
                }
            )
        );
        let rows = sqlx::query_scalar::<_, String>(&sql)
            .bind(org)
            .bind(id)
            .bind(cursor.as_ref().map(|c| &c.created_at))
            .bind(cursor.as_ref().map(|c| &c.kind))
            .bind(kind)
            .bind(cursor.as_ref().map(|c| &c.id))
            .bind(limit + 1)
            .fetch_all(&mut **tx)
            .await?;
        for raw in rows {
            sources.push((kind, row(&raw)?));
        }
    }
    let mut agents = HashMap::<String, String>::new();
    let agent_ids = sources
        .iter()
        .filter_map(|(kind, row)| {
            row[if *kind == "activity" {
                "submittedByAgentId"
            } else {
                "proposedByAgentId"
            }]
            .as_str()
        })
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if !agent_ids.is_empty() {
        for row in sqlx::query(
            "SELECT id::text,name FROM agents WHERE org_id=$1::uuid AND id=ANY($2::text[]::uuid[])",
        )
        .bind(org)
        .bind(&agent_ids)
        .fetch_all(&mut **tx)
        .await?
        {
            agents.insert(row.try_get("id")?, row.try_get("name")?);
        }
    }
    let mut users = HashMap::<String, String>::new();
    let user_ids = sources
        .iter()
        .filter(|(kind, _)| *kind == "feedback")
        .filter_map(|(_, row)| row["actorId"].as_str())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if !user_ids.is_empty() {
        for row in sqlx::query("SELECT id,name FROM \"user\" WHERE id=ANY($1::text[])")
            .bind(&user_ids)
            .fetch_all(&mut **tx)
            .await?
        {
            users.insert(row.try_get("id")?, row.try_get("name")?);
        }
    }
    static ASSET: OnceLock<Regex> = OnceLock::new();
    let asset_pattern = ASSET.get_or_init(|| regex(r"(?i)^asset://([0-9a-f-]{36})$"));
    let asset_ids = sources
        .iter()
        .filter(|(kind, _)| *kind == "feedback")
        .flat_map(|(_, row)| row["attachments"].as_array().into_iter().flatten())
        .filter_map(|a| a["uri"].as_str())
        .filter_map(|uri| asset_pattern.captures(uri).map(|c| c[1].to_owned()))
        .collect::<Vec<_>>();
    // Invalid legacy UUID-shaped refs cannot poison the whole history request.
    // Compare text, avoiding a cast of untrusted attachment values to UUID.
    let valid_assets = if asset_ids.is_empty() {
        vec![]
    } else {
        sqlx::query_scalar::<_, String>(
            "SELECT id::text FROM assets WHERE org_id=$1::uuid AND id::text=ANY($2::text[])",
        )
        .bind(org)
        .bind(&asset_ids)
        .fetch_all(&mut **tx)
        .await?
    };
    let mut items = Vec::new();
    for (kind, row) in sources {
        let actor_id = if kind == "activity" {
            row["submittedByAgentId"].clone()
        } else if kind == "feedback" {
            row["actorId"].clone()
        } else {
            row["proposedByAgentId"].clone()
        };
        let actor_type = if kind == "feedback" {
            "user"
        } else if kind == "activity" && actor_id.is_null() {
            "system"
        } else {
            "agent"
        };
        let actor_name = match (actor_type, actor_id.as_str()) {
            ("system", _) | ("agent", None) => "System",
            ("agent", Some(id)) => agents.get(id).map(String::as_str).unwrap_or("Former agent"),
            (_, Some(id)) => users.get(id).map(String::as_str).unwrap_or("Board user"),
            _ => "Board user",
        };
        let summary = match kind {
            "activity" => activity_summary(&row),
            "feedback" => text(&row, "body"),
            "change_proposal" => public_goal_text(&text(&row, "rationale")),
            _ => public_goal_text(&format!(
                "{}. {}",
                outcome(row["preflight"]["outcome"].as_str().unwrap_or_default()),
                text(&row, "riskSummary")
            )),
        };
        let mut item = json!({"id":row["id"],"kind":kind,"summary":summary,"createdAt":row[if kind=="activity" {"occurredAt"} else {"createdAt"}],"actorType":actor_type,"actorId":actor_id,"actorName":actor_name,"attachments":[],"evidence":[]});
        if kind == "feedback" {
            item["feedbackKind"] = row["feedbackKind"].clone();
            item["attachments"] = json!(row["attachments"].as_array().into_iter().flatten().map(|a| {
                let asset_id = a["uri"].as_str().and_then(|uri|asset_pattern.captures(uri)).map(|c|c[1].to_owned());
                let path = asset_id.filter(|id|valid_assets.contains(id)).map(|id|format!("/api/assets/{id}/content"));
                json!({"name":a["name"],"mimeType":a["mimeType"],"size":a["size"],"contentPath":path})
            }).collect::<Vec<_>>());
        } else {
            item["evidence"] = evidence(
                if kind == "result_proposal" {
                    &row["candidate"]["evidenceRefs"]
                } else {
                    &row["evidenceRefs"]
                },
                actor_id.as_str(),
                org_key.as_deref(),
            );
            if kind == "activity" {
                item["runId"] = row["runRef"].clone();
            } else {
                item["status"] = row["status"].clone();
            }
            if kind == "change_proposal" {
                item["approvalId"] = row["approvalId"].clone();
            }
        }
        items.push(item);
    }
    items.sort_by(|a, b| {
        text(b, "createdAt")
            .cmp(&text(a, "createdAt"))
            .then_with(|| text(a, "kind").cmp(&text(b, "kind")))
            .then_with(|| text(a, "id").cmp(&text(b, "id")))
    });
    let more = items.len() > limit as usize;
    items.truncate(limit as usize);
    let next = if more {
        items.last().map(|item| {
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&HistoryCursor {
                    version: 1,
                    created_at: text(item, "createdAt"),
                    kind: text(item, "kind"),
                    id: text(item, "id"),
                })
                .expect("cursor serialization"),
            )
        })
    } else {
        None
    };
    Ok(json!({"items":items,"nextCursor":next}))
}

async fn dependencies(
    tx: &mut Transaction<'_, Postgres>,
    org: &str,
    goal: &Value,
) -> Result<Value, GoalReadError> {
    let id = text(goal, "id");
    let mut counts = serde_json::Map::new();
    let mut previews = serde_json::Map::new();
    let mut blockers = Vec::new();
    for (key, blocker, sql) in [
        (
            "childGoals",
            "child_goals",
            "SELECT id::text,title,status AS subtitle FROM goals WHERE org_id=$1::uuid AND parent_id=$2::uuid ORDER BY created_at",
        ),
        // Joined projects come first, then unique legacy links, matching Map insertion order.
        (
            "linkedProjects",
            "linked_projects",
            "SELECT id::text,name AS title,status AS subtitle FROM (SELECT p.*,0 AS source FROM project_goals pg JOIN projects p ON p.id=pg.project_id AND p.org_id=pg.org_id WHERE pg.org_id=$1::uuid AND pg.goal_id=$2::uuid UNION ALL SELECT p.*,1 AS source FROM projects p WHERE p.org_id=$1::uuid AND p.goal_id=$2::uuid AND NOT EXISTS (SELECT 1 FROM project_goals pg WHERE pg.org_id=$1::uuid AND pg.goal_id=$2::uuid AND pg.project_id=p.id)) p ORDER BY source,created_at",
        ),
        (
            "linkedIssues",
            "linked_issues",
            "SELECT id::text,title,COALESCE(identifier,status) AS subtitle FROM issues WHERE org_id=$1::uuid AND goal_id=$2::uuid ORDER BY created_at",
        ),
        (
            "automations",
            "automations",
            "SELECT id::text,title,status AS subtitle FROM automations WHERE org_id=$1::uuid AND goal_id=$2::uuid ORDER BY created_at",
        ),
        (
            "calendarEvents",
            "calendar_events",
            "SELECT id::text,title,event_status AS subtitle FROM calendar_events WHERE org_id=$1::uuid AND goal_id=$2::uuid AND deleted_at IS NULL ORDER BY created_at",
        ),
    ] {
        let rows = sqlx::query(sql)
            .bind(org)
            .bind(&id)
            .fetch_all(&mut **tx)
            .await?;
        counts.insert(key.to_owned(), json!(rows.len()));
        if !rows.is_empty() {
            blockers.push(blocker);
        }
        let preview = rows.into_iter().take(5).map(|row|Ok(json!({"id":row.try_get::<String,_>("id")?,"title":row.try_get::<String,_>("title")?,"subtitle":row.try_get::<Option<String>,_>("subtitle")?}))).collect::<Result<Vec<_>,sqlx::Error>>()?;
        previews.insert(key.to_owned(), json!(preview));
    }
    for (key, blocker, table) in [
        ("costEvents", "cost_events", "cost_events"),
        ("financeEvents", "finance_events", "finance_events"),
    ] {
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {table} WHERE org_id=$1::uuid AND goal_id=$2::uuid"
        ))
        .bind(org)
        .bind(&id)
        .fetch_one(&mut **tx)
        .await?;
        counts.insert(key.to_owned(), json!(count));
        if count > 0 {
            blockers.push(blocker);
        }
    }
    let can_delete = blockers.is_empty() && goal["lifecycle"] == "draft";
    if goal["lifecycle"] != "draft" {
        blockers.push("goal_not_draft");
    }
    Ok(
        json!({"goalId":id,"orgId":org,"canDelete":can_delete,"blockers":blockers,"isLastRootOrganizationGoal":false,"counts":counts,"previews":previews}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_goal_projection_sanitizes_and_keeps_nulls_and_long_text() {
        let long = "A".repeat(100_000);
        let goal = json!({"id":"30000000-0000-4000-8000-000000000001","orgId":"org","title":long,"description":null,"outcomeStatement":"Goal contract continuation with artifact://secret","criteria":[{"id":"ok","label":"Evaluator evidence requirements","secret":"hidden"},{"id":" ","label":"invalid"},null,1],"evaluationResult":{"outcome":"achieved","private":"secret"},"contractRevision":88,"autonomyEnvelope":{"private":true}});
        let result = public_goal(&goal);
        assert_eq!(result["title"].as_str().unwrap().len(), 100_000);
        assert_eq!(result["shortRef"], "gol_30000000");
        assert_eq!(result["description"], Value::Null);
        assert_eq!(
            result["outcomeStatement"],
            "Goal next step with supporting work"
        );
        assert_eq!(
            result["criteria"],
            json!([{"id":"ok","label":"success check what we need to verify"}])
        );
        assert_eq!(result["evaluationResult"], json!({"outcome":"achieved"}));
        assert!(result.get("contractRevision").is_none());
        assert!(result.get("autonomyEnvelope").is_none());
    }
    #[test]
    fn public_text_preserves_javascript_boundary_whitespace_and_technical_rules() {
        assert_eq!(
            public_goal_text(
                "Goal\u{feff}contract / contracté / éxcontract / goal\u{0085}contract"
            ),
            "Goal / agreementé / éxcontract / goal\u{0085}agreement"
        );
        assert_eq!(
            public_goal_text("issue://secret) run 30000000-0000-4000-8000-000000000001"),
            "supporting work) the related update"
        );
        assert_eq!(
            activity_summary(
                &json!({"summary":"error: private database dump","activityKind":"progress"})
            ),
            "The Agent shared an update that needs attention."
        );
        assert_eq!(
            activity_summary(
                &json!({"summary":"Goal evaluated as achieved","activityKind":"closeout"})
            ),
            "Goal achieved"
        );
    }
    #[test]
    fn evidence_is_allowlisted_with_encoded_library_paths_and_no_external_secrets() {
        let result = evidence(
            &json!([
                "library-file://file?p=a%2Fhello+world.md",
                "library-entry://abc?p=notes%2Fentry.md",
                "issue://ABC-1",
                "run://run-1",
                "https://secret.example/token",
                "artifact://private",
                3,
                "javascript:alert(1)"
            ]),
            Some("agent/a"),
            Some("Org /"),
        );
        assert_eq!(
            result[0],
            json!({"label":"Library file: hello world.md","href":"/Org%20%2F/library?path=a%2Fhello+world.md","external":false})
        );
        assert_eq!(
            result[1]["href"],
            "/Org%20%2F/library?entry=abc&path=notes%2Fentry.md"
        );
        assert_eq!(result[2]["href"], "/Org%20%2F/issues/ABC-1");
        assert_eq!(result[3]["href"], "/Org%20%2F/agents/agent%2Fa/runs/run-1");
        assert_eq!(
            result[4],
            json!({"label":"External supporting link 5","href":null,"external":true})
        );
        assert!(!result.to_string().contains("private"));
        assert!(!result.to_string().contains("secret.example"));
    }
    #[test]
    fn opaque_public_overrides_do_not_inherit_structural_depth_limits() {
        let deep = format!("{}1e400{}", "[".repeat(1024), "]".repeat(1024));
        let serialized = serialize_goal(
            &json!({"id":"goal","ownerAgentRuntimeOverrides":null}),
            Some(&deep),
        )
        .unwrap();
        assert_eq!(
            serialized,
            format!(
                "{{\"id\":\"goal\",\"ownerAgentRuntimeOverrides\":{}null{}}}",
                "[".repeat(1024),
                "]".repeat(1024)
            )
        );
        for separator in ["\r", "\u{2028}", "\u{2029}", "\n"] {
            let summary = format!("Goal evaluated as achieved{separator}ignored");
            assert_eq!(
                activity_summary(&json!({"activityKind":"closeout","summary":summary})),
                summary
            );
        }
    }
    #[test]
    fn history_input_limits_and_cursor_fail_closed() {
        for raw in ["1", "1e0", "0x1", "0b1", "0o1", " 1 "] {
            assert_eq!(history_limit(Some(raw)).unwrap(), 1);
        }
        for raw in ["", "NaN", "Infinity", "0", "101", "1.5", "invalid"] {
            assert!(matches!(
                history_limit(Some(raw)),
                Err(GoalReadError::Limit)
            ));
        }
        assert_eq!(history_limit(None).unwrap(), 50);
        assert!(matches!(
            decode_cursor(Some("invalid")),
            Err(GoalReadError::Cursor)
        ));
        let value = json!({"version":1,"createdAt":"2026-10-08T12:00:00.000Z","kind":"agent_run","id":"id"});
        let cursor = URL_SAFE_NO_PAD.encode(value.to_string());
        assert_eq!(
            decode_cursor(Some(&cursor)).unwrap().unwrap().kind,
            "agent_run"
        );
    }
}
