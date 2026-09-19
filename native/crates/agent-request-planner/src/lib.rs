//! Pure request planning for the direct Agent v1 MCP capabilities.
//!
//! Authentication and HTTP execution deliberately live outside this crate. The
//! caller supplies trusted runtime identity; model arguments can never replace it.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub const CORE_RESPONSE_LIMIT: usize = 1_000_000;
pub const BROWSER_RESPONSE_LIMIT: usize = 16_000_000;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ManagedRuntimeIdentity {
    pub organization_id: Option<String>,
    pub agent_id: Option<String>,
    pub run_id: Option<String>,
    pub browser_enabled: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum HttpMethod {
    Get,
    Post,
    Patch,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequiredContext {
    pub organization: bool,
    pub agent: bool,
    pub run: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DirectRequest {
    pub capability_id: String,
    pub method: HttpMethod,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: Option<Value>,
    pub context: RequiredContext,
    pub response_limit: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PlanOutcome {
    Direct(DirectRequest),
    NotDirectCapability,
}

#[derive(Debug, Error, Eq, PartialEq)]
pub enum PlanError {
    #[error("unknown capability or tool: {0}")]
    UnknownCapability(String),
    #[error("runtime identity is managed; forbidden argument(s): {0}")]
    ReservedIdentity(String),
    #[error("unsupported argument(s) for {capability}: {arguments}")]
    UnknownArguments {
        capability: String,
        arguments: String,
    },
    #[error("invalid argument for {capability}: {detail}")]
    InvalidArgument { capability: String, detail: String },
    #[error("runtime context is incomplete; missing {0}")]
    MissingContext(String),
    #[error("browser is disabled or unavailable for this run")]
    BrowserDisabled,
}

pub fn plan_request(
    capability_or_tool: &str,
    arguments: Value,
    runtime: &ManagedRuntimeIdentity,
) -> Result<PlanOutcome, PlanError> {
    let contract = rudder_agent_contract_core::contract();
    let capabilities = contract["capabilities"]
        .as_array()
        .expect("contract capabilities");
    let capability = capabilities
        .iter()
        .find(|entry| {
            entry["id"].as_str() == Some(capability_or_tool)
                || entry["mcp"]["name"].as_str() == Some(capability_or_tool)
        })
        .ok_or_else(|| PlanError::UnknownCapability(capability_or_tool.into()))?;
    if capability["api"]["transport"].as_str() != Some("direct") {
        return Ok(PlanOutcome::NotDirectCapability);
    }
    let id = capability["id"].as_str().expect("capability id");
    let mut input = match arguments {
        Value::Null => Map::new(),
        Value::Object(value) => value,
        _ => return invalid(id, "arguments must be object"),
    };
    normalize_aliases(id, &mut input);
    reject_reserved(&input)?;
    let schema = &capability["mcp"]["inputSchema"];
    validate_schema(id, &Value::Object(input.clone()), schema, "arguments")?;
    reject_unmaterialized_images(id, &input)?;
    validate_browser_action(id, &input)?;

    let context = RequiredContext {
        organization: capability["cli"]["requiresOrgId"]
            .as_bool()
            .unwrap_or(false),
        agent: capability["cli"]["requiresAgentId"]
            .as_bool()
            .unwrap_or(false),
        run: capability["cli"]["requiresRunId"]
            .as_bool()
            .unwrap_or(false),
    };
    require_context(&context, runtime)?;
    if id.starts_with("browser.") && !runtime.browser_enabled {
        return Err(PlanError::BrowserDisabled);
    }
    let request = map_request(id, input, runtime, context)?;
    Ok(PlanOutcome::Direct(request))
}

fn map_request(
    id: &str,
    input: Map<String, Value>,
    runtime: &ManagedRuntimeIdentity,
    context: RequiredContext,
) -> Result<DirectRequest, PlanError> {
    let org =
        || runtime_string(runtime.organization_id.as_deref()).expect("validated organization");
    let s = |key: &str| required_string(id, &input, key);
    let mut query = Vec::new();
    let (method, path, body) = match id {
        "agent.me" => (HttpMethod::Get, "/api/agents/me".into(), None),
        "agent.inbox" => (HttpMethod::Get, "/api/agents/me/inbox-lite".into(), None),
        "organization.members.list" => {
            optional_query(&mut query, "query", input.get("query"));
            if let Some(value) = input.get("type") {
                optional_query(&mut query, "type", Some(value));
            } else {
                query.push(("type".into(), "all".into()));
            }
            query.push(("limit".into(), positive(input.get("limit"), 50).to_string()));
            optional_query(&mut query, "cursor", input.get("cursor"));
            (
                HttpMethod::Get,
                format!("/api/orgs/{}/members/directory", encode(org())),
                None,
            )
        }
        "goal.list" => {
            query.push(("lifecycle".into(), string_or(&input, "lifecycle", "active")));
            query.push(("limit".into(), positive(input.get("limit"), 20).to_string()));
            if let Some(Value::Bool(v)) = input.get("focus") {
                query.push(("focus".into(), v.to_string()));
            }
            optional_query(&mut query, "facet", input.get("facet"));
            (
                HttpMethod::Get,
                format!("/api/orgs/{}/goals/assigned", encode(org())),
                None,
            )
        }
        "goal.context" => (
            HttpMethod::Get,
            format!("/api/goals/{}/agent-context", encode(&s("goal")?)),
            None,
        ),
        "goal.progress" => {
            let mut body = project(
                &input,
                &["summary", "activityKind", "evidenceRefs", "idempotencyKey"],
                &[("activityKind", json!("progress"))],
            );
            trim_project_strings(&mut body, &["summary", "activityKind", "idempotencyKey"]);
            (
                HttpMethod::Post,
                format!("/api/goals/{}/activities", encode(&s("goal")?)),
                Some(body),
            )
        }
        "goal.checkpoint" => {
            let mut body = project(
                &input,
                &[
                    "summary",
                    "evidenceRefs",
                    "expectedPlanRevision",
                    "plan",
                    "continuation",
                    "idempotencyKey",
                ],
                &[],
            );
            trim_project_strings(&mut body, &["summary", "idempotencyKey"]);
            (
                HttpMethod::Post,
                format!("/api/goals/{}/checkpoint", encode(&s("goal")?)),
                Some(body),
            )
        }
        "goal.change.propose" => {
            let mut body = project(
                &input,
                &[
                    "afterContract",
                    "rationale",
                    "evidenceRefs",
                    "idempotencyKey",
                ],
                &[],
            );
            rename(
                &input,
                &mut body,
                "contractRevision",
                "expectedContractRevision",
            );
            trim_project_strings(&mut body, &["rationale", "idempotencyKey"]);
            (
                HttpMethod::Post,
                format!("/api/goals/{}/change-proposals", encode(&s("goal")?)),
                Some(body),
            )
        }
        "goal.result.propose" => {
            let mut body = project(
                &input,
                &[
                    "contractRevision",
                    "criteria",
                    "evidenceRefs",
                    "resultValue",
                    "decision",
                    "resultPayload",
                    "riskSummary",
                    "idempotencyKey",
                ],
                &[],
            );
            trim_project_strings(&mut body, &["decision", "riskSummary", "idempotencyKey"]);
            (
                HttpMethod::Post,
                format!("/api/goals/{}/result-proposals", encode(&s("goal")?)),
                Some(body),
            )
        }
        "issue.create" => {
            let mut body = project(
                &input,
                &[
                    "title",
                    "description",
                    "status",
                    "priority",
                    "assigneeAgentId",
                    "projectId",
                    "goalId",
                    "parentId",
                    "requestDepth",
                    "billingCode",
                    "labelIds",
                ],
                &[],
            );
            trim_project_strings(&mut body, &["title"]);
            (
                HttpMethod::Post,
                format!("/api/orgs/{}/issues", encode(org())),
                Some(body),
            )
        }
        "issue.get" => (
            HttpMethod::Get,
            format!("/api/issues/{}", encode(&s("issue")?)),
            None,
        ),
        "issue.context" => {
            optional_query(&mut query, "wakeCommentId", input.get("wakeCommentId"));
            (
                HttpMethod::Get,
                format!("/api/issues/{}/heartbeat-context", encode(&s("issue")?)),
                None,
            )
        }
        "issue.comments.list" => {
            optional_query(&mut query, "after", input.get("after"));
            optional_query(
                &mut query,
                "order",
                input.get("order").or(Some(&json!("desc"))),
            );
            (
                HttpMethod::Get,
                format!("/api/issues/{}/comments", encode(&s("issue")?)),
                None,
            )
        }
        "issue.comments.get" => (
            HttpMethod::Get,
            format!(
                "/api/issues/{}/comments/{}",
                encode(&s("issue")?),
                encode(&s("comment")?)
            ),
            None,
        ),
        "issue.checkout" => {
            let statuses = csv(input.get("expectedStatuses"), "todo,backlog,blocked");
            (
                HttpMethod::Post,
                format!("/api/issues/{}/checkout", encode(&s("issue")?)),
                Some(
                    json!({"agentId":runtime_string(runtime.agent_id.as_deref()),"expectedStatuses":statuses}),
                ),
            )
        }
        "issue.comment" => {
            let mut body = json!({
                "body": required_string_any(id, &input, &["body", "comment"])?
            });
            if input.get("reopen") == Some(&Value::Bool(true)) {
                body["reopen"] = json!(true)
            }
            (
                HttpMethod::Post,
                format!("/api/issues/{}/comments", encode(&s("issue")?)),
                Some(body),
            )
        }
        "issue.done" => (
            HttpMethod::Patch,
            format!("/api/issues/{}", encode(&s("issue")?)),
            Some(json!({
                "status": "done",
                "comment": required_string_any(id, &input, &["comment", "body"])?
            })),
        ),
        "runs.create" => {
            let mut body = json!({"task":s("task")?,"idempotencyKey":s("idempotencyKey")?});
            if let Some(target_agent_id) = optional_string(&input, "targetAgentId") {
                body["targetAgentId"] = json!(target_agent_id);
            }
            (
                HttpMethod::Post,
                "/api/agent-runs/delegation".into(),
                Some(body),
            )
        }
        "runs.list" => {
            query.push(("projection".into(), "summary".into()));
            for (out, key) in [
                ("updatedAfter", "updatedAfter"),
                ("runIdPrefix", "runIdPrefix"),
                ("agentId", "relatedAgentId"),
                ("status", "status"),
                ("runtime", "runtime"),
                ("issueId", "issueId"),
                ("usedSkill", "usedSkill"),
                ("loadedSkill", "loadedSkill"),
                ("createdBefore", "createdBefore"),
                ("cursor", "cursor"),
            ] {
                optional_query(&mut query, out, input.get(key));
            }
            query.push(("limit".into(), positive(input.get("limit"), 50).to_string()));
            (
                HttpMethod::Get,
                format!("/api/run-intelligence/orgs/{}/runs", encode(org())),
                None,
            )
        }
        "runs.get" => {
            query.push(("projection".into(), "summary".into()));
            (
                HttpMethod::Get,
                format!("/api/run-intelligence/runs/{}", encode(&s("run")?)),
                None,
            )
        }
        "runs.events" => {
            query.extend([
                (
                    "afterSeq".into(),
                    nonnegative(input.get("afterSeq"), 0).to_string(),
                ),
                (
                    "limit".into(),
                    positive(input.get("limit"), 200).to_string(),
                ),
                (
                    "maxChars".into(),
                    positive(input.get("maxChars"), 1200).to_string(),
                ),
                ("projection".into(), "compact".into()),
            ]);
            optional_query(&mut query, "cursor", input.get("cursor"));
            (
                HttpMethod::Get,
                format!("/api/run-intelligence/runs/{}/events", encode(&s("run")?)),
                None,
            )
        }
        "runs.log" => {
            query.extend([
                (
                    "offset".into(),
                    nonnegative(input.get("offset"), 0).to_string(),
                ),
                (
                    "limitBytes".into(),
                    positive(input.get("limitBytes"), 256000).to_string(),
                ),
            ]);
            (
                HttpMethod::Get,
                format!("/api/run-intelligence/runs/{}/log", encode(&s("run")?)),
                None,
            )
        }
        "runs.transcript" => {
            query.extend([
                (
                    "contextTurns".into(),
                    positive(input.get("contextTurns"), 1).to_string(),
                ),
                (
                    "order".into(),
                    if true_value(&input, "chronological") || true_value(&input, "narrative") {
                        "oldest"
                    } else {
                        "newest"
                    }
                    .into(),
                ),
                ("output".into(), "compact".into()),
                (
                    "includeOutputs".into(),
                    (true_value(&input, "includeOutput") || true_value(&input, "narrative"))
                        .to_string(),
                ),
                (
                    "maxChars".into(),
                    positive(input.get("maxChars").or(input.get("maxOutputChars")), 1200)
                        .to_string(),
                ),
            ]);
            if true_value(&input, "errorsOnly") {
                query.push(("errorsOnly".into(), "true".into()))
            }
            optional_query(&mut query, "aroundError", input.get("aroundError"));
            optional_query(&mut query, "cursor", input.get("cursor"));
            if input.contains_key("turnLimit") {
                query.push((
                    "turnLimit".into(),
                    positive(input.get("turnLimit"), 20).to_string(),
                ))
            }
            (
                HttpMethod::Get,
                format!(
                    "/api/run-intelligence/runs/{}/transcript",
                    encode(&s("run")?)
                ),
                None,
            )
        }
        "runs.errors" => {
            query.push((
                "maxChars".into(),
                positive(input.get("maxChars"), 1200).to_string(),
            ));
            optional_query(&mut query, "cursor", input.get("cursor"));
            (
                HttpMethod::Get,
                format!("/api/run-intelligence/runs/{}/errors", encode(&s("run")?)),
                None,
            )
        }
        browser if browser.starts_with("browser.") => map_browser(browser, &input)?,
        _ => unreachable!("every direct capability is mapped"),
    };
    Ok(DirectRequest {
        capability_id: id.into(),
        method,
        path,
        query,
        body,
        context,
        response_limit: if id.starts_with("browser.") {
            BROWSER_RESPONSE_LIMIT
        } else {
            CORE_RESPONSE_LIMIT
        },
    })
}

fn map_browser(
    id: &str,
    input: &Map<String, Value>,
) -> Result<(HttpMethod, String, Option<Value>), PlanError> {
    let endpoint = match id {
        "browser.user-tabs" => "user_tabs",
        "browser.dom-cua" => "dom_cua",
        _ => id.strip_prefix("browser.").unwrap(),
    };
    let body = match id {
        "browser.tabs" | "browser.user-tabs" => json!({}),
        "browser.open" => json!({"url":required_string(id,input,"url")?}),
        "browser.navigate" => {
            json!({"tabId":required_string(id,input,"tabId")?,"url":required_string(id,input,"url")?})
        }
        "browser.back" | "browser.forward" | "browser.reload" | "browser.read"
        | "browser.close" => json!({"tabId":required_string(id,input,"tabId")?}),
        "browser.viewport" => {
            let mut body = project(input, &["action", "width", "height"], &[]);
            trim_project_strings(&mut body, &["action"]);
            body
        }
        "browser.visibility" => project(input, &["visible"], &[]),
        "browser.click" => {
            json!({
                "tabId": required_string(id, input, "tabId")?,
                "ref": required_string(id, input, "ref")?,
            })
        }
        "browser.type" => {
            let mut v = json!({
                "tabId": required_string(id, input, "tabId")?,
                "ref": required_string(id, input, "ref")?,
                "text": required_string(id, input, "text")?,
            });
            if true_value(input, "submit") {
                v["submit"] = json!(true)
            }
            v
        }
        _ => Value::Object(input.clone()),
    };
    Ok((
        HttpMethod::Post,
        format!("/api/browser/{endpoint}"),
        Some(body),
    ))
}

fn normalize_aliases(id: &str, input: &mut Map<String, Value>) {
    let aliases: &[(&str, &str)] = match id {
        "goal.context"
        | "goal.progress"
        | "goal.checkpoint"
        | "goal.change.propose"
        | "goal.result.propose" => &[("goalId", "goal")],
        "issue.get"
        | "issue.context"
        | "issue.checkout"
        | "issue.comment"
        | "issue.comments.list"
        | "issue.done" => &[("issueId", "issue")],
        "issue.comments.get" => &[("issueId", "issue"), ("commentId", "comment")],
        "runs.transcript" => &[("maxOutputChars", "maxChars")],
        _ => &[],
    };
    for (old, new) in aliases {
        if let Some(value) = input.remove(*old) {
            input.entry(*new).or_insert(value);
        }
    }
}

fn reject_reserved(input: &Map<String, Value>) -> Result<(), PlanError> {
    let reserved = [
        "orgid",
        "companyid",
        "agentid",
        "runid",
        "apibase",
        "apikey",
        "authorization",
    ];
    let mut found: Vec<_> = input
        .keys()
        .filter(|key| {
            let normalized: String = key
                .chars()
                .filter(|c| c.is_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect();
            reserved.contains(&normalized.as_str())
                || key.to_ascii_uppercase().starts_with("RUDDER_")
        })
        .cloned()
        .collect();
    found.sort();
    if found.is_empty() {
        Ok(())
    } else {
        Err(PlanError::ReservedIdentity(found.join(", ")))
    }
}

fn reject_unmaterialized_images(id: &str, input: &Map<String, Value>) -> Result<(), PlanError> {
    if matches!(id, "issue.comment" | "issue.done")
        && input
            .get("images")
            .and_then(Value::as_array)
            .is_some_and(|images| !images.is_empty())
    {
        return invalid(id, "images require CLI attachment materialization");
    }
    Ok(())
}

fn validate_schema(id: &str, value: &Value, schema: &Value, at: &str) -> Result<(), PlanError> {
    if let Some(any) = schema.get("anyOf").and_then(Value::as_array)
        && !any
            .iter()
            .any(|candidate| validate_schema(id, value, candidate, at).is_ok())
    {
        return invalid(id, &format!("{at} does not match any allowed shape"));
    }
    if let Some(one) = schema.get("oneOf").and_then(Value::as_array) {
        let matching_branches = one
            .iter()
            .filter(|candidate| validate_schema(id, value, candidate, at).is_ok())
            .count();
        if matching_branches != 1 {
            return invalid(
                id,
                &format!("{at} does not match exactly one allowed shape"),
            );
        }
    }
    if let Some(types) = schema.get("type") {
        let valid = match types {
            Value::String(t) => type_matches(value, t),
            Value::Array(ts) => ts
                .iter()
                .filter_map(Value::as_str)
                .any(|t| type_matches(value, t)),
            _ => false,
        };
        if !valid {
            return invalid(id, &format!("{at} has wrong type"));
        }
    }
    if let Some(enums) = schema.get("enum").and_then(Value::as_array)
        && !enums.contains(value)
    {
        return invalid(id, &format!("{at} is not an allowed value"));
    }
    if let Some(text) = value.as_str() {
        let n = text.chars().count() as u64;
        if schema["minLength"].as_u64().is_some_and(|m| n < m)
            || schema["maxLength"].as_u64().is_some_and(|m| n > m)
        {
            return invalid(id, &format!("{at} has invalid length"));
        }
        if schema
            .get("format")
            .and_then(Value::as_str)
            .is_some_and(|format| {
                format == "date-time" && OffsetDateTime::parse(text, &Rfc3339).is_err()
            })
        {
            return invalid(id, &format!("{at} has invalid format"));
        }
    }
    if let Some(n) = value.as_f64()
        && (!n.is_finite()
            || schema["minimum"].as_f64().is_some_and(|m| n < m)
            || schema["maximum"].as_f64().is_some_and(|m| n > m))
    {
        return invalid(id, &format!("{at} is outside allowed range"));
    }
    if let Some(items) = value.as_array() {
        let n = items.len() as u64;
        if schema["minItems"].as_u64().is_some_and(|m| n < m)
            || schema["maxItems"].as_u64().is_some_and(|m| n > m)
        {
            return invalid(id, &format!("{at} has invalid item count"));
        }
        if let Some(child) = schema.get("items") {
            for (i, item) in items.iter().enumerate() {
                validate_schema(id, item, child, &format!("{at}[{i}]"))?;
            }
        }
    }
    if let Some(object) = value.as_object() {
        if schema["minProperties"]
            .as_u64()
            .is_some_and(|minimum| (object.len() as u64) < minimum)
        {
            return invalid(id, &format!("{at} has too few properties"));
        }
        let properties = schema.get("properties").and_then(Value::as_object);
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    return invalid(id, &format!("{at}.{key} is required"));
                }
            }
        }
        if schema["additionalProperties"] == Value::Bool(false) {
            let known = properties
                .map(|p| p.keys().cloned().collect::<BTreeSet<_>>())
                .unwrap_or_default();
            let unknown: Vec<_> = object
                .keys()
                .filter(|k| !known.contains(*k))
                .cloned()
                .collect();
            if !unknown.is_empty() {
                return Err(PlanError::UnknownArguments {
                    capability: id.into(),
                    arguments: unknown.join(", "),
                });
            }
        }
        if let Some(properties) = properties {
            for (key, child) in object {
                if let Some(child_schema) = properties.get(key) {
                    validate_schema(id, child, child_schema, &format!("{at}.{key}"))?;
                }
            }
        }
    }
    Ok(())
}
fn type_matches(v: &Value, t: &str) -> bool {
    match t {
        "string" => v.is_string(),
        "number" => v.is_number(),
        "integer" => v.as_i64().is_some() || v.as_u64().is_some(),
        "boolean" => v.is_boolean(),
        "array" => v.is_array(),
        "object" => v.is_object(),
        "null" => v.is_null(),
        _ => false,
    }
}
fn validate_browser_action(id: &str, input: &Map<String, Value>) -> Result<(), PlanError> {
    if id == "browser.locator" {
        let allowed = [
            "count",
            "allTextContents",
            "textContent",
            "innerText",
            "attribute",
            "visible",
            "enabled",
            "checked",
            "selected",
            "wait",
        ];
        if !input
            .get("action")
            .and_then(Value::as_str)
            .is_some_and(|v| allowed.contains(&v))
        {
            return invalid(id, "locator action is not read-only");
        }
    }
    if id == "browser.download" && input.get("mode").and_then(Value::as_str) != Some("media") {
        return invalid(id, "download mode must be media");
    }
    Ok(())
}
fn require_context(c: &RequiredContext, r: &ManagedRuntimeIdentity) -> Result<(), PlanError> {
    let mut missing = Vec::new();
    if c.organization && runtime_string(r.organization_id.as_deref()).is_none() {
        missing.push("organization")
    };
    if c.agent && runtime_string(r.agent_id.as_deref()).is_none() {
        missing.push("agent")
    };
    if c.run && runtime_string(r.run_id.as_deref()).is_none() {
        missing.push("run")
    };
    if missing.is_empty() {
        Ok(())
    } else {
        Err(PlanError::MissingContext(missing.join(", ")))
    }
}
fn invalid<T>(id: &str, detail: &str) -> Result<T, PlanError> {
    Err(PlanError::InvalidArgument {
        capability: id.into(),
        detail: detail.into(),
    })
}
fn runtime_string(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}
fn required_string(id: &str, m: &Map<String, Value>, key: &str) -> Result<String, PlanError> {
    m.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| PlanError::InvalidArgument {
            capability: id.into(),
            detail: format!("{key} is required"),
        })
}
fn required_string_any(
    id: &str,
    m: &Map<String, Value>,
    keys: &[&str],
) -> Result<String, PlanError> {
    keys.iter()
        .find_map(|key| {
            m.get(*key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
        .ok_or_else(|| PlanError::InvalidArgument {
            capability: id.into(),
            detail: format!("{} is required", keys.join(" or ")),
        })
}
fn project(m: &Map<String, Value>, keys: &[&str], defaults: &[(&str, Value)]) -> Value {
    let mut out = Map::new();
    for (k, v) in defaults {
        out.insert((*k).into(), v.clone());
    }
    for key in keys {
        if let Some(v) = m.get(*key)
            && !v.is_null()
        {
            out.insert((*key).into(), v.clone());
        }
    }
    Value::Object(out)
}
fn trim_project_strings(value: &mut Value, keys: &[&str]) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    for key in keys {
        if let Some(Value::String(string)) = object.get_mut(*key) {
            *string = string.trim().to_owned();
        }
    }
}
fn optional_string(m: &Map<String, Value>, key: &str) -> Option<String> {
    m.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
fn rename(input: &Map<String, Value>, body: &mut Value, from: &str, to: &str) {
    if let Some(v) = input.get(from)
        && !v.is_null()
    {
        body.as_object_mut().unwrap().insert(to.into(), v.clone());
    }
}
fn optional_query(q: &mut Vec<(String, String)>, key: &str, v: Option<&Value>) {
    if let Some(s) = v.and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        q.push((key.into(), s.trim().into()));
    }
}
fn positive(v: Option<&Value>, fallback: u64) -> u64 {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n.floor() as u64)
        .unwrap_or(fallback)
}
fn nonnegative(v: Option<&Value>, fallback: u64) -> u64 {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n.floor() as u64)
        .unwrap_or(fallback)
}
fn string_or(m: &Map<String, Value>, key: &str, fallback: &str) -> String {
    m.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .into()
}
fn true_value(m: &Map<String, Value>, key: &str) -> bool {
    m.get(key) == Some(&Value::Bool(true))
}
fn csv(v: Option<&Value>, fallback: &str) -> Vec<String> {
    let source = match v {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::String(s)) => s.clone(),
        _ => fallback.to_owned(),
    };
    source
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(*b as char)
        } else {
            out.push_str(&format!("%{b:02X}"))
        }
    }
    out
}

pub fn query_string(query: &[(String, String)]) -> String {
    query
        .iter()
        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_of_requires_exactly_one_matching_branch() {
        let schema = json!({
            "oneOf": [
                {"type": "string", "minLength": 1},
                {"type": "string", "maxLength": 5}
            ]
        });

        assert!(validate_schema("test", &json!("hello"), &schema, "value").is_err());
        assert!(validate_schema("test", &json!("longer"), &schema, "value").is_ok());
        assert!(validate_schema("test", &json!(""), &schema, "value").is_ok());
        assert!(validate_schema("test", &json!(42), &schema, "value").is_err());
    }

    #[test]
    fn required_empty_values_follow_declared_length_constraints() {
        let schema = json!({
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "items": {"type": "array"},
                "boundedText": {"type": "string", "minLength": 1},
                "boundedItems": {"type": "array", "minItems": 1},
                "nullable": {
                    "oneOf": [
                        {"type": "string", "minLength": 1},
                        {"type": "null"}
                    ]
                },
                "optionalText": {"type": "string", "minLength": 1}
            },
            "required": ["text", "items", "boundedText", "boundedItems", "nullable"]
        });

        let mut valid = json!({
            "text": "",
            "items": [],
            "boundedText": "ok",
            "boundedItems": [1],
            "nullable": null
        });
        assert!(validate_schema("test", &valid, &schema, "arguments").is_ok());

        valid["boundedText"] = json!("");
        assert!(validate_schema("test", &valid, &schema, "arguments").is_err());

        valid["boundedText"] = json!("ok");
        valid["boundedItems"] = json!([]);
        assert!(validate_schema("test", &valid, &schema, "arguments").is_err());

        valid["boundedItems"] = json!([1]);
        valid["optionalText"] = json!("");
        assert!(validate_schema("test", &valid, &schema, "arguments").is_err());

        valid.as_object_mut().unwrap().remove("optionalText");
        assert!(validate_schema("test", &valid, &schema, "arguments").is_ok());
    }
}
