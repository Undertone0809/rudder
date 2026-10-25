//! Request planning for native direct and explicitly mapped CLI HTTP MCP capabilities.
//!
//! Authentication and HTTP execution deliberately live outside this crate. The
//! caller supplies trusted runtime identity; model arguments can never replace it.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use thiserror::Error;
use time::{
    Date, OffsetDateTime, PlainDateTime, Time, UtcOffset,
    format_description::{self, well_known::Rfc3339},
};

pub const CORE_RESPONSE_LIMIT: usize = 1_000_000;
pub const BROWSER_RESPONSE_LIMIT: usize = 16_000_000;

/// Bounded CLI-fallback capabilities that the additive Rust MCP transport
/// implements as direct HTTP requests. This is a transport allowlist, not a
/// claim that every endpoint's backend business authority has moved to Rust.
pub const CLI_FALLBACK_MCP_CAPABILITY_IDS: &[&str] = &[
    "agent.update",
    "agent.skills.create",
    "agent.skills.enable",
    "agent.skills.sync",
    "library.file.list",
    "library.file.get",
    "library.file.ref",
    "library.file.link",
    "library.file.put",
    "skill.list",
    "skill.search",
    "skill.get",
    "skill.file",
    "skill.import",
    "skill.scan-local",
    "skill.scan-projects",
    "issue.list",
    "issue.search",
    "issue.update",
    "issue.review",
    "issue.commit",
    "issue.block",
    "project.list",
    "project.get",
    "project.create",
    "approval.get",
    "approval.issues",
    "approval.comment",
    "user.activity",
    "plugin.search",
    "plugin.get",
    "automation.list",
    "automation.get",
    "automation.runs",
    "automation.triggers.list",
    "automation.triggers.create",
    "automation.triggers.update",
    "automation.triggers.delete",
    "automation.triggers.rotate-secret",
    "automation.create",
    "automation.update",
    "automation.enable",
    "automation.disable",
    "automation.run",
    "chat.list",
    "chat.search",
    "chat.get",
    "chat.messages",
    "chat.transcript",
    "chat.read",
    "chat.create",
    "chat.send",
    "chat.archive",
    "runs.by-skill",
    "runs.cancel",
    "runs.retry",
];

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
    Delete,
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
    pub headers: Vec<(String, String)>,
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
    plan_capability_request(capability_or_tool, arguments, runtime, "direct")
}

/// Plan the explicitly selected HTTP-backed CLI-fallback tools exposed by the
/// additive Rust MCP transport. These routes still have their existing
/// backend owner; this planner only replaces the Node CLI subprocess.
pub fn plan_cli_fallback_request(
    capability_or_tool: &str,
    arguments: Value,
    runtime: &ManagedRuntimeIdentity,
) -> Result<Option<Vec<DirectRequest>>, PlanError> {
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
    let id = capability["id"].as_str().expect("capability id");
    if capability["api"]["transport"].as_str() != Some("cli-fallback")
        || !CLI_FALLBACK_MCP_CAPABILITY_IDS.contains(&id)
    {
        return Ok(None);
    }
    let mut input = match arguments {
        Value::Null => Map::new(),
        Value::Object(value) => value,
        _ => return invalid(id, "arguments must be object"),
    };
    normalize_aliases(id, &mut input);
    reject_reserved(&input)?;
    let schema = &capability["mcp"]["inputSchema"];
    if schema.is_null() {
        return Ok(None);
    }
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
    let context = if matches!(
        id,
        "agent.update" | "agent.skills.create" | "agent.skills.enable" | "agent.skills.sync"
    ) {
        RequiredContext {
            agent: true,
            ..context
        }
    } else {
        context
    };
    require_context(&context, runtime)?;
    map_cli_fallback_requests(id, input, runtime, context).map(Some)
}

fn plan_capability_request(
    capability_or_tool: &str,
    arguments: Value,
    runtime: &ManagedRuntimeIdentity,
    expected_transport: &str,
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
    if capability["api"]["transport"].as_str() != Some(expected_transport) {
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
                format!("/api/orgs/{}/members/directory", encode_path_segment(org())),
                None,
            )
        }
        "organization.brand_color.update" => {
            let mut branding = Map::new();
            for key in ["brandColor", "logoAssetId"] {
                if let Some(value) = input.get(key) {
                    branding.insert(key.to_owned(), value.clone());
                }
            }
            (
                HttpMethod::Patch,
                format!("/api/orgs/{}/branding", encode_path_segment(org())),
                Some(Value::Object(branding)),
            )
        }
        "project.update" => {
            if let Some(org_id) = runtime_string(runtime.organization_id.as_deref()) {
                query.push(("orgId".into(), org_id.into()));
            }
            (
                HttpMethod::Patch,
                format!("/api/projects/{}", encode_path_segment(&s("project")?)),
                Some(project(
                    &input,
                    &[
                        "name",
                        "description",
                        "status",
                        "goalId",
                        "goalIds",
                        "leadAgentId",
                        "targetDate",
                        "color",
                        "archivedAt",
                    ],
                    &[],
                )),
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
                format!("/api/orgs/{}/goals/assigned", encode_path_segment(org())),
                None,
            )
        }
        "goal.context" => (
            HttpMethod::Get,
            format!(
                "/api/goals/{}/agent-context",
                encode_path_segment(&s("goal")?)
            ),
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
                format!("/api/goals/{}/activities", encode_path_segment(&s("goal")?)),
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
                format!("/api/goals/{}/checkpoint", encode_path_segment(&s("goal")?)),
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
                &[("evidenceRefs", json!([]))],
            );
            rename(
                &input,
                &mut body,
                "contractRevision",
                "expectedContractRevision",
            );
            trim_project_strings(&mut body, &["rationale", "idempotencyKey"]);
            normalize_goal_contract_dates(id, &mut body)?;
            (
                HttpMethod::Post,
                format!(
                    "/api/goals/{}/change-proposals",
                    encode_path_segment(&s("goal")?)
                ),
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
                &[("resultPayload", json!({}))],
            );
            trim_project_strings(&mut body, &["decision", "riskSummary", "idempotencyKey"]);
            (
                HttpMethod::Post,
                format!(
                    "/api/goals/{}/result-proposals",
                    encode_path_segment(&s("goal")?)
                ),
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
                &[
                    ("status", json!("backlog")),
                    ("priority", json!("medium")),
                    ("requestDepth", json!(0)),
                ],
            );
            trim_project_strings(&mut body, &["title"]);
            (
                HttpMethod::Post,
                format!("/api/orgs/{}/issues", encode_path_segment(org())),
                Some(body),
            )
        }
        "issue.get" => (
            HttpMethod::Get,
            format!("/api/issues/{}", encode_path_segment(&s("issue")?)),
            None,
        ),
        "issue.context" => {
            optional_query(&mut query, "wakeCommentId", input.get("wakeCommentId"));
            (
                HttpMethod::Get,
                format!(
                    "/api/issues/{}/heartbeat-context",
                    encode_path_segment(&s("issue")?)
                ),
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
                format!("/api/issues/{}/comments", encode_path_segment(&s("issue")?)),
                None,
            )
        }
        "issue.comments.get" => (
            HttpMethod::Get,
            format!(
                "/api/issues/{}/comments/{}",
                encode_path_segment(&s("issue")?),
                encode_path_segment(&s("comment")?)
            ),
            None,
        ),
        "issue.checkout" => {
            let statuses = csv(input.get("expectedStatuses"), "todo,backlog,blocked");
            (
                HttpMethod::Post,
                format!("/api/issues/{}/checkout", encode_path_segment(&s("issue")?)),
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
                format!("/api/issues/{}/comments", encode_path_segment(&s("issue")?)),
                Some(body),
            )
        }
        "issue.done" => (
            HttpMethod::Patch,
            format!("/api/issues/{}", encode_path_segment(&s("issue")?)),
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
                format!(
                    "/api/run-intelligence/orgs/{}/runs",
                    encode_path_segment(org())
                ),
                None,
            )
        }
        "runs.get" => {
            query.push(("projection".into(), "summary".into()));
            (
                HttpMethod::Get,
                format!(
                    "/api/run-intelligence/runs/{}",
                    encode_path_segment(&s("run")?)
                ),
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
                format!(
                    "/api/run-intelligence/runs/{}/events",
                    encode_path_segment(&s("run")?)
                ),
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
                format!(
                    "/api/run-intelligence/runs/{}/log",
                    encode_path_segment(&s("run")?)
                ),
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
                    encode_path_segment(&s("run")?)
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
                format!(
                    "/api/run-intelligence/runs/{}/errors",
                    encode_path_segment(&s("run")?)
                ),
                None,
            )
        }
        browser if browser.starts_with("browser.") => map_browser(browser, &input)?,
        _ => unreachable!("every direct capability is mapped"),
    };
    let headers = if id == "organization.brand_color.update" {
        vec![
            ("x-rudder-idempotency-key".into(), s("idempotencyKey")?),
            ("x-rudder-required-authority".into(), "rust".into()),
        ]
    } else if id == "project.update" {
        let has_goal_mutation = input.contains_key("goalId") || input.contains_key("goalIds");
        let key = if has_goal_mutation || input.contains_key("idempotencyKey") {
            s("idempotencyKey")?
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        let mut headers = vec![("x-rudder-idempotency-key".into(), key)];
        if has_goal_mutation {
            headers.push(("x-rudder-required-authority".into(), "rust".into()));
        }
        headers
    } else {
        Vec::new()
    };
    Ok(DirectRequest {
        capability_id: id.into(),
        method,
        path,
        query,
        headers,
        body,
        context,
        response_limit: if id.starts_with("browser.") {
            BROWSER_RESPONSE_LIMIT
        } else {
            CORE_RESPONSE_LIMIT
        },
    })
}

fn map_cli_fallback_requests(
    id: &str,
    input: Map<String, Value>,
    runtime: &ManagedRuntimeIdentity,
    context: RequiredContext,
) -> Result<Vec<DirectRequest>, PlanError> {
    if id == "chat.read" {
        let chat_id = required_string_any(id, &input, &["chat"])?;
        let mut page_query = vec![
            ("envelope".into(), "true".into()),
            ("order".into(), "newest".into()),
            (
                "limit".into(),
                cli_positive(input.get("turnLimit").or_else(|| input.get("limit")), 20).to_string(),
            ),
        ];
        optional_query(&mut page_query, "cursor", input.get("cursor"));
        if input
            .get("includeTranscript")
            .or_else(|| input.get("includeOutput"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            page_query.push(("includeTranscript".into(), "true".into()));
        }
        return Ok(vec![
            cli_fallback_request(
                id,
                HttpMethod::Get,
                format!("/api/chats/{}", encode_path_segment(&chat_id)),
                Vec::new(),
                None,
                context.clone(),
            ),
            cli_fallback_request(
                id,
                HttpMethod::Get,
                format!("/api/chats/{}/messages", encode_path_segment(&chat_id)),
                page_query,
                None,
                context,
            ),
        ]);
    }

    if matches!(id, "issue.list" | "issue.search") {
        let mut query = Vec::new();
        optional_query(&mut query, "status", input.get("status"));
        optional_query(&mut query, "assigneeAgentId", input.get("assigneeAgentId"));
        optional_query(&mut query, "projectId", input.get("projectId"));
        if id == "issue.search" {
            optional_query(&mut query, "q", input.get("query"));
            query.push(("searchFields".into(), "title,description,comment".into()));
        }
        return Ok(vec![cli_fallback_request(
            id,
            HttpMethod::Get,
            format!(
                "/api/orgs/{}/issues",
                encode_path_segment(runtime_org(id, runtime)?)
            ),
            query,
            None,
            context,
        )]);
    }

    let (method, path, query, body) = match id {
        "agent.update" => {
            let agent_id = runtime_string(runtime.agent_id.as_deref())
                .ok_or_else(|| PlanError::MissingContext("RUDDER_AGENT_ID".into()))?;
            let mut body = Map::new();
            add_optional_text(&mut body, "name", input.get("name"));
            add_optional_text(&mut body, "role", input.get("role"));
            if cli_optional_scalar(input.get("title")).is_some()
                && input.get("clearTitle").and_then(Value::as_bool) == Some(true)
            {
                return invalid(id, "pass only one of title or clearTitle");
            }
            if input.get("clearTitle").and_then(Value::as_bool) == Some(true) {
                body.insert("title".into(), Value::Null);
            } else {
                add_optional_text(&mut body, "title", input.get("title"));
            }

            let capabilities = input
                .get("capabilities")
                .or_else(|| input.get("description"));
            let clear_capabilities = input
                .get("clearCapabilities")
                .or_else(|| input.get("clearDescription"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if cli_optional_scalar(capabilities).is_some() && clear_capabilities {
                return invalid(
                    id,
                    "pass either capabilities/description input or a clear flag, not both",
                );
            }
            if clear_capabilities {
                body.insert("capabilities".into(), Value::Null);
            } else {
                add_optional_text(&mut body, "capabilities", capabilities);
            }
            if body.is_empty() {
                return invalid(id, "no agent fields to update");
            }
            let mut query = Vec::new();
            if let Some(org_id) = runtime_string(runtime.organization_id.as_deref()) {
                query.push(("orgId".into(), org_id.to_owned()));
            }
            (
                HttpMethod::Patch,
                format!("/api/agents/{}", encode_path_segment(agent_id)),
                query,
                Some(Value::Object(body)),
            )
        }
        "agent.skills.enable" => {
            let agent_id = runtime_string(runtime.agent_id.as_deref())
                .ok_or_else(|| PlanError::MissingContext("RUDDER_AGENT_ID".into()))?;
            let skills = input
                .get("selectionRefs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| Value::String(value.to_owned()))
                .collect::<Vec<_>>();
            if skills.is_empty() {
                return invalid(id, "at least one skill selection is required");
            }
            (
                HttpMethod::Post,
                format!(
                    "/api/agents/{}/skills/enable",
                    encode_path_segment(agent_id)
                ),
                Vec::new(),
                Some(json!({"skills": skills})),
            )
        }
        "agent.skills.sync" => {
            let agent_id = runtime_string(runtime.agent_id.as_deref())
                .ok_or_else(|| PlanError::MissingContext("RUDDER_AGENT_ID".into()))?;
            required_string(id, &input, "desiredSkills")?;
            let desired_skills = split_csv(&input, "desiredSkills", "");
            (
                HttpMethod::Post,
                format!("/api/agents/{}/skills/sync", encode_path_segment(agent_id)),
                Vec::new(),
                Some(json!({"desiredSkills": desired_skills})),
            )
        }
        "agent.skills.create" => {
            let agent_id = runtime_string(runtime.agent_id.as_deref())
                .ok_or_else(|| PlanError::MissingContext("RUDDER_AGENT_ID".into()))?;
            let mut body = Map::new();
            body.insert("name".into(), json!(required_string(id, &input, "name")?));
            body.insert(
                "slug".into(),
                optional_string(&input, "slug").map_or(Value::Null, Value::String),
            );
            body.insert(
                "description".into(),
                optional_string(&input, "description").map_or(Value::Null, Value::String),
            );
            body.insert(
                "markdown".into(),
                optional_string(&input, "markdown")
                    .or_else(|| optional_string(&input, "body"))
                    .map_or(Value::Null, Value::String),
            );
            (
                HttpMethod::Post,
                format!(
                    "/api/agents/{}/skills/private",
                    encode_path_segment(agent_id)
                ),
                Vec::new(),
                Some(Value::Object(body)),
            )
        }
        "issue.update" => {
            let mut body = Map::new();
            for key in [
                "title",
                "description",
                "status",
                "priority",
                "assigneeAgentId",
                "projectId",
                "goalId",
                "parentId",
                "billingCode",
            ] {
                add_optional_text(&mut body, key, input.get(key));
            }
            if let Some(request_depth) = parse_cli_optional_int(id, input.get("requestDepth"))? {
                body.insert("requestDepth".into(), json!(request_depth));
            }
            if let Some(hidden_at) = input.get("hiddenAt").and_then(Value::as_str) {
                body.insert(
                    "hiddenAt".into(),
                    if hidden_at.trim().eq_ignore_ascii_case("null") {
                        Value::Null
                    } else {
                        Value::String(hidden_at.to_owned())
                    },
                );
            }
            if let Some(comment) =
                optional_string(&input, "comment").or_else(|| optional_string(&input, "body"))
            {
                body.insert("comment".into(), json!(comment));
            }
            if body.is_empty() {
                return invalid(id, "no issue fields to update");
            }
            (
                HttpMethod::Patch,
                format!(
                    "/api/issues/{}",
                    encode_path_segment(&required_string(id, &input, "issue")?)
                ),
                Vec::new(),
                Some(Value::Object(body)),
            )
        }
        "issue.review" => {
            let comment = required_string_any(id, &input, &["comment", "body"])?;
            let mut body = Map::new();
            body.insert(
                "reviewDecision".into(),
                json!(required_string(id, &input, "decision")?),
            );
            body.insert("comment".into(), json!(comment));
            (
                HttpMethod::Patch,
                format!(
                    "/api/issues/{}",
                    encode_path_segment(&required_string(id, &input, "issue")?)
                ),
                Vec::new(),
                Some(Value::Object(body)),
            )
        }
        "issue.commit" => {
            let mut body = Map::new();
            for key in ["sha", "message", "branch", "repoPath", "workspacePath"] {
                add_optional_text(&mut body, key, input.get(key));
            }
            if let Some(count) = parse_cli_optional_int(id, input.get("count"))? {
                body.insert("commitCount".into(), json!(count));
            }
            (
                HttpMethod::Post,
                format!(
                    "/api/issues/{}/commit",
                    encode_path_segment(&required_string(id, &input, "issue")?)
                ),
                Vec::new(),
                Some(Value::Object(body)),
            )
        }
        "issue.block" => (
            HttpMethod::Patch,
            format!(
                "/api/issues/{}",
                encode_path_segment(&required_string(id, &input, "issue")?)
            ),
            Vec::new(),
            Some(json!({
                "status":"blocked",
                "comment":required_string_any(id, &input, &["comment", "body"])?
            })),
        ),
        "library.file.list" => {
            let path = input
                .get("directory")
                .filter(|value| !value.is_null())
                .or_else(|| input.get("path"));
            let mut query = Vec::new();
            optional_query(&mut query, "path", path);
            (
                HttpMethod::Get,
                format!(
                    "/api/orgs/{}/workspace/files",
                    encode_path_segment(runtime_org(id, runtime)?)
                ),
                query,
                None,
            )
        }
        "library.file.get" | "library.file.ref" | "library.file.link" => {
            let mut query = Vec::new();
            optional_query(&mut query, "path", input.get("path"));
            (
                HttpMethod::Get,
                format!(
                    "/api/orgs/{}/workspace/file",
                    encode_path_segment(runtime_org(id, runtime)?)
                ),
                query,
                None,
            )
        }
        "library.file.put" => {
            let path = required_string(id, &input, "path")?;
            let content = input
                .get("body")
                .filter(|value| !value.is_null())
                .or_else(|| input.get("content"))
                .and_then(Value::as_str)
                .ok_or_else(|| PlanError::InvalidArgument {
                    capability: id.into(),
                    detail: "body is required".into(),
                })?;
            (
                HttpMethod::Patch,
                format!(
                    "/api/orgs/{}/workspace/file",
                    encode_path_segment(runtime_org(id, runtime)?)
                ),
                vec![("path".into(), path)],
                Some(json!({"content":content})),
            )
        }
        "skill.list" | "skill.search" => (
            HttpMethod::Get,
            format!(
                "/api/orgs/{}/skills",
                encode_path_segment(runtime_org(id, runtime)?)
            ),
            Vec::new(),
            None,
        ),
        "skill.get" => (
            HttpMethod::Get,
            format!(
                "/api/orgs/{}/skills/{}",
                encode_path_segment(runtime_org(id, runtime)?),
                encode_path_segment(&required_string_any(id, &input, &["skill", "skillId"])?),
            ),
            Vec::new(),
            None,
        ),
        "skill.file" => {
            let skill = required_string_any(id, &input, &["skill", "skillId"])?;
            let path = input
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("SKILL.md");
            (
                HttpMethod::Get,
                format!(
                    "/api/orgs/{}/skills/{}/files",
                    encode_path_segment(runtime_org(id, runtime)?),
                    encode_path_segment(&skill)
                ),
                vec![("path".into(), path.to_owned())],
                None,
            )
        }
        "skill.import" => (
            HttpMethod::Post,
            format!(
                "/api/orgs/{}/skills/import",
                encode_path_segment(runtime_org(id, runtime)?)
            ),
            Vec::new(),
            Some(json!({"source": required_string(id, &input, "source")?})),
        ),
        "skill.scan-local" => {
            let mut body = Map::new();
            if input.contains_key("roots") {
                body.insert("roots".into(), json!(split_csv(&input, "roots", "")));
            }
            (
                HttpMethod::Post,
                format!(
                    "/api/orgs/{}/skills/scan-local",
                    encode_path_segment(runtime_org(id, runtime)?)
                ),
                Vec::new(),
                Some(Value::Object(body)),
            )
        }
        "skill.scan-projects" => {
            let mut body = Map::new();
            for key in ["projectIds", "workspaceIds"] {
                if input.contains_key(key) {
                    body.insert(key.into(), json!(split_csv(&input, key, "")));
                }
            }
            (
                HttpMethod::Post,
                format!(
                    "/api/orgs/{}/skills/scan-projects",
                    encode_path_segment(runtime_org(id, runtime)?)
                ),
                Vec::new(),
                Some(Value::Object(body)),
            )
        }
        "project.list" => (
            HttpMethod::Get,
            format!(
                "/api/orgs/{}/projects",
                encode_path_segment(runtime_org(id, runtime)?)
            ),
            Vec::new(),
            None,
        ),
        "project.get" => {
            let mut query = Vec::new();
            if let Some(org_id) = runtime_string(runtime.organization_id.as_deref()) {
                query.push(("orgId".into(), org_id.to_owned()));
            }
            (
                HttpMethod::Get,
                format!(
                    "/api/projects/{}",
                    encode_path_segment(&required_string_any(id, &input, &["project"])?)
                ),
                query,
                None,
            )
        }
        "project.create" => {
            let mut body = Map::new();
            body.insert("name".into(), json!(required_string(id, &input, "name")?));
            for key in [
                "description",
                "status",
                "goalId",
                "goalIds",
                "leadAgentId",
                "targetDate",
                "color",
            ] {
                if let Some(value) = input.get(key) {
                    body.insert(key.into(), cli_project_create_value(key, value));
                }
            }
            (
                HttpMethod::Post,
                format!(
                    "/api/orgs/{}/projects",
                    encode_path_segment(runtime_org(id, runtime)?)
                ),
                Vec::new(),
                Some(Value::Object(body)),
            )
        }
        "approval.get" | "approval.issues" | "approval.comment" => {
            let approval = required_string_any(id, &input, &["approval"])?;
            let path = match id {
                "approval.get" => format!("/api/approvals/{}", encode_path_segment(&approval)),
                "approval.issues" => {
                    format!("/api/approvals/{}/issues", encode_path_segment(&approval))
                }
                _ => format!("/api/approvals/{}/comments", encode_path_segment(&approval)),
            };
            let (method, body) = if id == "approval.comment" {
                (
                    HttpMethod::Post,
                    Some(json!({"body": required_string_any(id, &input, &["body", "comment"])?})),
                )
            } else {
                (HttpMethod::Get, None)
            };
            (method, path, Vec::new(), body)
        }
        "user.activity" => {
            let user = input
                .get("user")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("me");
            let mut query = vec![(
                "since".into(),
                input
                    .get("since")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .unwrap_or("today")
                    .into(),
            )];
            for (argument, query_key) in [
                ("until", "until"),
                ("include", "include"),
                ("relatedAgentId", "agentId"),
                ("projectId", "projectId"),
                ("issueId", "issueId"),
                ("limit", "limit"),
                ("cursor", "cursor"),
            ] {
                if let Some(value) = cli_optional_scalar(input.get(argument)) {
                    query.push((query_key.into(), value));
                }
            }
            (
                HttpMethod::Get,
                format!(
                    "/api/orgs/{}/users/{}/activity-ledger",
                    encode_path_segment(runtime_org(id, runtime)?),
                    encode_path_segment(user)
                ),
                query,
                None,
            )
        }
        "plugin.search" | "plugin.get" => {
            let org_id = encode_path_segment(runtime_org(id, runtime)?);
            let path = if id == "plugin.search" {
                required_string(id, &input, "query")?;
                format!("/api/orgs/{org_id}/plugins")
            } else {
                format!(
                    "/api/orgs/{org_id}/plugins/{}",
                    encode_path_segment(&required_string_any(id, &input, &["plugin"])?)
                )
            };
            (HttpMethod::Get, path, Vec::new(), None)
        }
        "automation.list" => (
            HttpMethod::Get,
            format!(
                "/api/orgs/{}/automations",
                encode_path_segment(runtime_org(id, runtime)?)
            ),
            Vec::new(),
            None,
        ),
        "automation.get" | "automation.triggers.list" | "automation.runs" => {
            let automation = required_string_any(id, &input, &["automation"])?;
            let mut query = Vec::new();
            let path = if id == "automation.runs" {
                query.push((
                    "limit".into(),
                    cli_positive(input.get("limit"), 50).to_string(),
                ));
                format!("/api/automations/{}/runs", encode_path_segment(&automation))
            } else {
                format!("/api/automations/{}", encode_path_segment(&automation))
            };
            (HttpMethod::Get, path, query, None)
        }
        "automation.triggers.create" => {
            let automation = required_string_any(id, &input, &["automation"])?;
            let mut body = payload_object(id, input.get("payload"))?;
            merge_trigger_options(id, &mut body, &input, true)?;
            if body
                .get("kind")
                .and_then(Value::as_str)
                .map(str::trim)
                .is_none_or(str::is_empty)
            {
                return invalid(id, "kind is required");
            }
            (
                HttpMethod::Post,
                format!(
                    "/api/automations/{}/triggers",
                    encode_path_segment(&automation)
                ),
                Vec::new(),
                Some(body),
            )
        }
        "automation.triggers.update" => {
            let trigger = required_string_any(id, &input, &["trigger"])?;
            let mut body = payload_object(id, input.get("payload"))?;
            merge_trigger_options(id, &mut body, &input, false)?;
            (
                HttpMethod::Patch,
                format!("/api/automation-triggers/{}", encode_path_segment(&trigger)),
                Vec::new(),
                Some(body),
            )
        }
        "automation.triggers.delete" => {
            let trigger = required_string_any(id, &input, &["trigger"])?;
            (
                HttpMethod::Delete,
                format!("/api/automation-triggers/{}", encode_path_segment(&trigger)),
                Vec::new(),
                None,
            )
        }
        "automation.triggers.rotate-secret" => {
            let trigger = required_string_any(id, &input, &["trigger"])?;
            (
                HttpMethod::Post,
                format!(
                    "/api/automation-triggers/{}/rotate-secret",
                    encode_path_segment(&trigger)
                ),
                Vec::new(),
                Some(json!({})),
            )
        }
        "automation.create" | "automation.update" => {
            let mut body = payload_object(id, input.get("payload"))?;
            merge_automation_options(&mut body, &input);
            if id == "automation.create" {
                (
                    HttpMethod::Post,
                    format!(
                        "/api/orgs/{}/automations",
                        encode_path_segment(runtime_org(id, runtime)?)
                    ),
                    Vec::new(),
                    Some(body),
                )
            } else {
                let automation = required_string_any(id, &input, &["automation"])?;
                (
                    HttpMethod::Patch,
                    format!("/api/automations/{}", encode_path_segment(&automation)),
                    Vec::new(),
                    Some(body),
                )
            }
        }
        "automation.enable" | "automation.disable" => {
            let automation = required_string_any(id, &input, &["automation"])?;
            (
                HttpMethod::Patch,
                format!("/api/automations/{}", encode_path_segment(&automation)),
                Vec::new(),
                Some(
                    json!({"status": if id == "automation.enable" { "active" } else { "paused" }}),
                ),
            )
        }
        "automation.run" => {
            let automation = required_string_any(id, &input, &["automation"])?;
            let mut body = Map::new();
            add_input_value(&mut body, "triggerId", input.get("triggerId"));
            if let Some(payload) = cli_optional_json_object(id, input.get("payload"))? {
                body.insert("payload".into(), payload);
            }
            add_input_value(&mut body, "idempotencyKey", input.get("idempotencyKey"));
            body.insert(
                "source".into(),
                json!(
                    input
                        .get("source")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                        .unwrap_or("manual")
                ),
            );
            (
                HttpMethod::Post,
                format!("/api/automations/{}/run", encode_path_segment(&automation)),
                Vec::new(),
                Some(Value::Object(body)),
            )
        }
        "chat.list" | "chat.search" => {
            if id == "chat.search" {
                required_string(id, &input, "query")?;
            }
            let mut query = vec![(
                "status".into(),
                input
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or(if id == "chat.search" { "all" } else { "active" })
                    .into(),
            )];
            optional_query(&mut query, "q", input.get("query"));
            (
                HttpMethod::Get,
                format!(
                    "/api/orgs/{}/chats",
                    encode_path_segment(runtime_org(id, runtime)?)
                ),
                query,
                None,
            )
        }
        "chat.get" | "chat.messages" | "chat.transcript" | "chat.send" | "chat.archive" => {
            let chat = required_string_any(id, &input, &["chat"])?;
            let chat_path = format!("/api/chats/{}", encode_path_segment(&chat));
            match id {
                "chat.get" => (HttpMethod::Get, chat_path, Vec::new(), None),
                "chat.archive" => (
                    HttpMethod::Patch,
                    chat_path,
                    Vec::new(),
                    Some(json!({"status":"archived"})),
                ),
                "chat.send" => {
                    let mut body = Map::new();
                    body.insert("body".into(), json!(required_string(id, &input, "body")?));
                    add_optional_text(
                        &mut body,
                        "editUserMessageId",
                        input.get("editUserMessageId"),
                    );
                    (
                        HttpMethod::Post,
                        format!("{chat_path}/messages"),
                        Vec::new(),
                        Some(Value::Object(body)),
                    )
                }
                _ => {
                    let mut query = vec![
                        ("envelope".into(), "true".into()),
                        ("order".into(), "newest".into()),
                        (
                            "limit".into(),
                            cli_positive(input.get("limit"), 50).to_string(),
                        ),
                    ];
                    optional_query(&mut query, "cursor", input.get("cursor"));
                    let include_transcript = if id == "chat.transcript" {
                        true
                    } else {
                        input
                            .get("includeTranscript")
                            .or_else(|| input.get("includeOutput"))
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                    };
                    if include_transcript {
                        query.push(("includeTranscript".into(), "true".into()));
                    }
                    (
                        HttpMethod::Get,
                        format!("{chat_path}/messages"),
                        query,
                        None,
                    )
                }
            }
        }
        "chat.create" => {
            let mut body = payload_object(id, input.get("payload"))?;
            body["initialMessage"] = json!({"body": required_string(id, &input, "body")?});
            let body = body
                .as_object_mut()
                .expect("payload_object returns an object");
            for (from, to) in [
                ("title", "title"),
                ("summary", "summary"),
                ("preferredAgentId", "preferredAgentId"),
                ("issueCreationMode", "issueCreationMode"),
            ] {
                add_optional_text(body, to, input.get(from));
            }
            if input.get("planMode").and_then(Value::as_bool) == Some(true) {
                body.insert("planMode".into(), json!(true));
            }
            (
                HttpMethod::Post,
                format!(
                    "/api/orgs/{}/chats",
                    encode_path_segment(runtime_org(id, runtime)?)
                ),
                Vec::new(),
                Some(Value::Object(body.clone())),
            )
        }
        "runs.by-skill" => {
            let evidence = input
                .get("evidence")
                .and_then(Value::as_str)
                .unwrap_or("used");
            let mut query = vec![
                ("projection".into(), "summary".into()),
                (
                    if evidence == "loaded" {
                        "loadedSkill"
                    } else {
                        "usedSkill"
                    }
                    .into(),
                    required_string(id, &input, "skill")?,
                ),
            ];
            for (argument, key) in [
                ("relatedAgentId", "agentId"),
                ("status", "status"),
                ("runtime", "runtime"),
                ("issueId", "issueId"),
                ("createdBefore", "createdBefore"),
                ("cursor", "cursor"),
            ] {
                optional_query(&mut query, key, input.get(argument));
            }
            query.push(("limit".into(), positive(input.get("limit"), 50).to_string()));
            (
                HttpMethod::Get,
                format!(
                    "/api/run-intelligence/orgs/{}/runs",
                    encode_path_segment(runtime_org(id, runtime)?)
                ),
                query,
                None,
            )
        }
        "runs.cancel" | "runs.retry" => {
            let run = required_string(id, &input, "run")?;
            (
                HttpMethod::Post,
                format!(
                    "/api/heartbeat-runs/{}/{}",
                    encode_path_segment(&run),
                    if id == "runs.cancel" {
                        "cancel"
                    } else {
                        "retry"
                    }
                ),
                Vec::new(),
                Some(json!({})),
            )
        }
        _ => {
            return invalid(
                id,
                "CLI HTTP fallback is not implemented by the Rust MCP transport",
            );
        }
    };

    Ok(vec![cli_fallback_request(
        id, method, path, query, body, context,
    )])
}

fn cli_fallback_request(
    id: &str,
    method: HttpMethod,
    path: String,
    query: Vec<(String, String)>,
    body: Option<Value>,
    context: RequiredContext,
) -> DirectRequest {
    DirectRequest {
        capability_id: id.into(),
        method,
        path,
        query,
        headers: Vec::new(),
        body,
        context,
        response_limit: CORE_RESPONSE_LIMIT,
    }
}

fn runtime_org<'a>(id: &str, runtime: &'a ManagedRuntimeIdentity) -> Result<&'a str, PlanError> {
    runtime_string(runtime.organization_id.as_deref())
        .ok_or_else(|| PlanError::MissingContext(format!("RUDDER_ORG_ID required by {id}")))
}

fn add_input_value(body: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        body.insert(key.into(), value.clone());
    }
}

fn cli_project_create_value(key: &str, value: &Value) -> Value {
    if key == "goalIds" {
        return Value::Array(
            value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(|entry| Value::String(entry.to_owned()))
                .collect(),
        );
    }
    value.clone()
}

fn add_optional_text(body: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        body.insert(key.into(), json!(value));
    }
}

fn cli_optional_scalar(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_owned())
        }
        Value::Number(value) => value
            .as_f64()
            .filter(|value| value.is_finite())
            .map(|_| value.to_string()),
        _ => None,
    }
}

fn cli_optional_json_object(id: &str, value: Option<&Value>) -> Result<Option<Value>, PlanError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let parsed = match value {
        Value::Object(_) => value.clone(),
        Value::String(text) if text.trim().is_empty() => return Ok(None),
        Value::String(text) => {
            serde_json::from_str::<Value>(text.trim()).map_err(|_| PlanError::InvalidArgument {
                capability: id.into(),
                detail: "payload must be valid JSON".into(),
            })?
        }
        _ => return invalid(id, "payload must be a JSON object or JSON string"),
    };
    if !parsed.is_object() {
        return invalid(id, "payload must be a JSON object");
    }
    Ok(Some(parsed))
}

fn payload_object(id: &str, payload: Option<&Value>) -> Result<Value, PlanError> {
    let Some(payload) = payload else {
        return Ok(json!({}));
    };
    let parsed = match payload {
        Value::Object(_) => payload.clone(),
        Value::String(text) if !text.trim().is_empty() => {
            serde_json::from_str::<Value>(text.trim()).map_err(|_| PlanError::InvalidArgument {
                capability: id.into(),
                detail: "payload must be a JSON object".into(),
            })?
        }
        Value::String(_) | Value::Null => return Ok(json!({})),
        _ => {
            return invalid(id, "payload must be a JSON object");
        }
    };
    if !parsed.is_object() {
        return invalid(id, "payload must be a JSON object");
    }
    Ok(parsed)
}

fn merge_automation_options(body: &mut Value, input: &Map<String, Value>) {
    let Some(body) = body.as_object_mut() else {
        return;
    };
    for (source, target) in [
        ("title", "title"),
        ("assigneeAgentId", "assigneeAgentId"),
        ("projectId", "projectId"),
        ("goalId", "goalId"),
        ("parentIssueId", "parentIssueId"),
        ("priority", "priority"),
        ("status", "status"),
        ("outputMode", "outputMode"),
        ("concurrencyPolicy", "concurrencyPolicy"),
        ("catchUpPolicy", "catchUpPolicy"),
    ] {
        add_optional_text(body, target, input.get(source));
    }
    let instructions = input
        .get("instructions")
        .filter(|value| !value.is_null())
        .or_else(|| input.get("description"));
    add_optional_text(body, "instructions", instructions);
    if input.get("notifyOnIssueCreated").and_then(Value::as_bool) == Some(true) {
        body.insert("notifyOnIssueCreated".into(), json!(true));
    }
}

fn merge_trigger_options(
    id: &str,
    body: &mut Value,
    input: &Map<String, Value>,
    include_kind: bool,
) -> Result<(), PlanError> {
    let Some(body) = body.as_object_mut() else {
        return invalid(id, "payload must be a JSON object");
    };
    if include_kind {
        add_optional_text(body, "kind", input.get("kind"));
    }
    for (source, target) in [
        ("label", "label"),
        ("cronExpression", "cronExpression"),
        ("timezone", "timezone"),
        ("signingMode", "signingMode"),
    ] {
        add_optional_text(body, target, input.get(source));
    }
    let enabled = input.get("enabled").and_then(Value::as_bool) == Some(true);
    let disabled = input.get("disabled").and_then(Value::as_bool) == Some(true);
    if enabled && disabled {
        return invalid(id, "pass only one of enabled or disabled");
    }
    if enabled {
        body.insert("enabled".into(), json!(true));
    } else if disabled {
        body.insert("enabled".into(), json!(false));
    }
    if let Some(value) = input.get("replayWindowSec") {
        let parsed = value
            .as_str()
            .and_then(|text| text.trim().parse::<i64>().ok())
            .or_else(|| value.as_i64())
            .ok_or_else(|| PlanError::InvalidArgument {
                capability: id.into(),
                detail: "replayWindowSec must be an integer".into(),
            })?;
        body.insert("replayWindowSec".into(), json!(parsed));
    }
    Ok(())
}

fn cli_positive(value: Option<&Value>, fallback: i64) -> i64 {
    let parsed = match value {
        Some(Value::Number(number)) => number.as_f64().map(|number| number as i64),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok().map(|number| number as i64),
        _ => None,
    };
    parsed.filter(|value| *value > 0).unwrap_or(fallback)
}

fn split_csv(input: &Map<String, Value>, key: &str, fallback: &str) -> Vec<String> {
    let source = match input.get(key) {
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::String(value)) if !value.trim().is_empty() => value.clone(),
        _ => fallback.to_owned(),
    };
    source
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
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
        "agent.skills.enable" => &[("selections", "selectionRefs"), ("skills", "selectionRefs")],
        "skill.get" | "skill.file" => &[("skillId", "skill")],
        "project.get" => &[("projectId", "project")],
        "approval.get" | "approval.issues" | "approval.comment" => &[("approvalId", "approval")],
        "plugin.get" => &[("pluginId", "plugin")],
        "automation.get"
        | "automation.runs"
        | "automation.triggers.list"
        | "automation.triggers.create"
        | "automation.update"
        | "automation.enable"
        | "automation.disable"
        | "automation.run" => &[("automationId", "automation")],
        "automation.triggers.update"
        | "automation.triggers.delete"
        | "automation.triggers.rotate-secret" => &[("triggerId", "trigger")],
        "chat.get" | "chat.messages" | "chat.transcript" | "chat.read" | "chat.send"
        | "chat.archive" => &[("chatId", "chat")],
        "goal.context"
        | "goal.progress"
        | "goal.checkpoint"
        | "goal.change.propose"
        | "goal.result.propose" => &[("goalId", "goal")],
        "issue.get"
        | "issue.context"
        | "issue.checkout"
        | "issue.comment"
        | "issue.update"
        | "issue.review"
        | "issue.commit"
        | "issue.block"
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
    if matches!(
        id,
        "issue.comment" | "issue.done" | "issue.update" | "issue.block"
    ) && input
        .get("images")
        .and_then(Value::as_array)
        .is_some_and(|images| !images.is_empty())
    {
        return invalid(id, "images require CLI attachment materialization");
    }
    Ok(())
}

fn parse_cli_optional_int(id: &str, value: Option<&Value>) -> Result<Option<i64>, PlanError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => {
            return invalid(id, "integer value must be a number or numeric string");
        }
    };
    let trimmed = text.trim_start();
    let (sign, digits) = match trimmed.as_bytes().first() {
        Some(b'-') => (-1_i64, &trimmed[1..]),
        Some(b'+') => (1_i64, &trimmed[1..]),
        _ => (1_i64, trimmed),
    };
    let digit_count = digits.bytes().take_while(u8::is_ascii_digit).count();
    if digit_count == 0 {
        return invalid(id, &format!("Invalid integer value: {text}"));
    }
    let parsed = digits[..digit_count]
        .parse::<i64>()
        .ok()
        .and_then(|value| value.checked_mul(sign))
        .ok_or_else(|| PlanError::InvalidArgument {
            capability: id.to_owned(),
            detail: format!("Invalid integer value: {text}"),
        })?;
    Ok(Some(parsed))
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
            .is_some_and(|format| format == "date-time" && !accepts_ts_coerce_date(text))
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

fn accepts_ts_coerce_date(text: &str) -> bool {
    parse_ts_coerce_date(text).is_some()
}

fn parse_ts_coerce_date(text: &str) -> Option<OffsetDateTime> {
    let text = text.trim();
    OffsetDateTime::parse(text, &Rfc3339)
        .ok()
        .or_else(|| parse_local_plain_datetime(text))
        .or_else(|| {
            format_description::parse_borrowed::<1>("[year]-[month]-[day]")
                .ok()
                .and_then(|format| Date::parse(text, &format).ok())
                .map(|date| OffsetDateTime::new_utc(date, Time::MIDNIGHT))
        })
}

fn parse_local_plain_datetime(text: &str) -> Option<OffsetDateTime> {
    let local = [
        "[year]-[month]-[day]T[hour]:[minute]",
        "[year]-[month]-[day]T[hour]:[minute]:[second]",
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond]",
    ]
    .into_iter()
    .find_map(|description| {
        let format = format_description::parse_borrowed::<1>(description).ok()?;
        PlainDateTime::parse(text, &format).ok()
    })?;

    // JavaScript treats an ISO datetime without an offset as local wall-clock
    // time. Re-resolve the offset after applying the first estimate so ordinary
    // local dates use the offset for the represented instant, not for now. The
    // iterative resolution also follows Node's tested gap/overlap choices, but
    // remains dependent on the host timezone database and local-offset API.
    let mut offset = UtcOffset::local_offset_at(local.assume_utc()).ok()?;
    for _ in 0..2 {
        let candidate = local.assume_offset(offset);
        let resolved = UtcOffset::local_offset_at(candidate).ok()?;
        if resolved == offset {
            return Some(candidate);
        }
        offset = resolved;
    }
    Some(local.assume_offset(offset))
}

fn canonical_ts_coerce_date(text: &str) -> Option<String> {
    let value = parse_ts_coerce_date(text)?.to_offset(UtcOffset::UTC);
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.millisecond(),
    ))
}

fn normalize_goal_contract_dates(id: &str, body: &mut Value) -> Result<(), PlanError> {
    let Some(after_contract) = body.get_mut("afterContract").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    for key in ["actionDeadline", "evaluationDeadline"] {
        let raw = after_contract
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(raw) = raw {
            let normalized =
                canonical_ts_coerce_date(&raw).ok_or_else(|| PlanError::InvalidArgument {
                    capability: id.into(),
                    detail: format!("afterContract.{key} has invalid format"),
                })?;
            after_contract.insert(key.into(), Value::String(normalized));
        }
    }
    Ok(())
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
fn encode_path_segment(value: &str) -> String {
    let mut out = String::new();
    for b in value.as_bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            out.push(*b as char)
        } else {
            out.push_str(&format!("%{b:02X}"))
        }
    }
    out
}

fn encode_query_component(value: &str) -> String {
    let mut out = String::new();
    for b in value.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'*') {
            out.push(*b as char)
        } else if *b == b' ' {
            out.push('+')
        } else {
            out.push_str(&format!("%{b:02X}"))
        }
    }
    out
}

pub fn query_string(query: &[(String, String)]) -> String {
    query
        .iter()
        .map(|(k, v)| {
            format!(
                "{}={}",
                encode_query_component(k),
                encode_query_component(v)
            )
        })
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fallback_runtime() -> ManagedRuntimeIdentity {
        ManagedRuntimeIdentity {
            organization_id: Some("org-one".into()),
            agent_id: Some("agent-one".into()),
            run_id: Some("run-one".into()),
            browser_enabled: false,
        }
    }

    #[test]
    fn every_explicit_http_cli_fallback_has_a_rust_request_mapping() {
        let runtime = fallback_runtime();
        let cases = [
            (
                "agent.update",
                json!({"name":"Agent"}),
                HttpMethod::Patch,
                "/api/agents/agent-one",
            ),
            (
                "agent.skills.enable",
                json!({"selectionRefs":["rudder/docs"]}),
                HttpMethod::Post,
                "/api/agents/agent-one/skills/enable",
            ),
            (
                "agent.skills.sync",
                json!({"desiredSkills":"rudder/docs"}),
                HttpMethod::Post,
                "/api/agents/agent-one/skills/sync",
            ),
            (
                "agent.skills.create",
                json!({"name":"Project skill","enable":true}),
                HttpMethod::Post,
                "/api/agents/agent-one/skills/private",
            ),
            (
                "library.file.list",
                json!({"directory":"projects/team"}),
                HttpMethod::Get,
                "/api/orgs/org-one/workspace/files",
            ),
            (
                "library.file.get",
                json!({"path":"projects/team/plan.md"}),
                HttpMethod::Get,
                "/api/orgs/org-one/workspace/file",
            ),
            (
                "library.file.ref",
                json!({"path":"projects/team/plan.md"}),
                HttpMethod::Get,
                "/api/orgs/org-one/workspace/file",
            ),
            (
                "library.file.link",
                json!({"path":"projects/team/plan.md"}),
                HttpMethod::Get,
                "/api/orgs/org-one/workspace/file",
            ),
            (
                "library.file.put",
                json!({"path":"projects/team/plan.md","body":"# Plan"}),
                HttpMethod::Patch,
                "/api/orgs/org-one/workspace/file",
            ),
            (
                "skill.list",
                json!({}),
                HttpMethod::Get,
                "/api/orgs/org-one/skills",
            ),
            (
                "skill.search",
                json!({"query":"docs"}),
                HttpMethod::Get,
                "/api/orgs/org-one/skills",
            ),
            (
                "skill.get",
                json!({"skill":"skill-one"}),
                HttpMethod::Get,
                "/api/orgs/org-one/skills/skill-one",
            ),
            (
                "skill.file",
                json!({"skill":"skill-one"}),
                HttpMethod::Get,
                "/api/orgs/org-one/skills/skill-one/files",
            ),
            (
                "skill.import",
                json!({"source":"/tmp/package"}),
                HttpMethod::Post,
                "/api/orgs/org-one/skills/import",
            ),
            (
                "skill.scan-local",
                json!({"roots":"/tmp/a,/tmp/b"}),
                HttpMethod::Post,
                "/api/orgs/org-one/skills/scan-local",
            ),
            (
                "skill.scan-projects",
                json!({"projectIds":"project-one","workspaceIds":"workspace-one"}),
                HttpMethod::Post,
                "/api/orgs/org-one/skills/scan-projects",
            ),
            (
                "issue.list",
                json!({"status":"todo,blocked","projectId":"project-one"}),
                HttpMethod::Get,
                "/api/orgs/org-one/issues",
            ),
            (
                "issue.search",
                json!({"query":"dependency","assigneeAgentId":"agent-one"}),
                HttpMethod::Get,
                "/api/orgs/org-one/issues",
            ),
            (
                "issue.update",
                json!({"issue":"issue-one","requestDepth":"3","hiddenAt":"null"}),
                HttpMethod::Patch,
                "/api/issues/issue-one",
            ),
            (
                "issue.review",
                json!({"issue":"issue-one","decision":"request_changes","body":"Needs a fix"}),
                HttpMethod::Patch,
                "/api/issues/issue-one",
            ),
            (
                "issue.commit",
                json!({"issue":"issue-one","sha":"abc123","message":"Fix issue","count":2}),
                HttpMethod::Post,
                "/api/issues/issue-one/commit",
            ),
            (
                "issue.block",
                json!({"issue":"issue-one","comment":"Blocked on access"}),
                HttpMethod::Patch,
                "/api/issues/issue-one",
            ),
            (
                "project.list",
                json!({}),
                HttpMethod::Get,
                "/api/orgs/org-one/projects",
            ),
            (
                "project.get",
                json!({"project":"project-one"}),
                HttpMethod::Get,
                "/api/projects/project-one",
            ),
            (
                "project.create",
                json!({"name":"Project"}),
                HttpMethod::Post,
                "/api/orgs/org-one/projects",
            ),
            (
                "approval.get",
                json!({"approval":"approval-one"}),
                HttpMethod::Get,
                "/api/approvals/approval-one",
            ),
            (
                "approval.issues",
                json!({"approval":"approval-one"}),
                HttpMethod::Get,
                "/api/approvals/approval-one/issues",
            ),
            (
                "approval.comment",
                json!({"approval":"approval-one","body":"Looks good"}),
                HttpMethod::Post,
                "/api/approvals/approval-one/comments",
            ),
            (
                "user.activity",
                json!({"limit":4}),
                HttpMethod::Get,
                "/api/orgs/org-one/users/me/activity-ledger",
            ),
            (
                "plugin.search",
                json!({"query":"calendar"}),
                HttpMethod::Get,
                "/api/orgs/org-one/plugins",
            ),
            (
                "plugin.get",
                json!({"plugin":"calendar"}),
                HttpMethod::Get,
                "/api/orgs/org-one/plugins/calendar",
            ),
            (
                "automation.list",
                json!({}),
                HttpMethod::Get,
                "/api/orgs/org-one/automations",
            ),
            (
                "automation.get",
                json!({"automation":"automation-one"}),
                HttpMethod::Get,
                "/api/automations/automation-one",
            ),
            (
                "automation.runs",
                json!({"automation":"automation-one"}),
                HttpMethod::Get,
                "/api/automations/automation-one/runs",
            ),
            (
                "automation.triggers.list",
                json!({"automation":"automation-one"}),
                HttpMethod::Get,
                "/api/automations/automation-one",
            ),
            (
                "automation.triggers.create",
                json!({"automation":"automation-one","kind":"api"}),
                HttpMethod::Post,
                "/api/automations/automation-one/triggers",
            ),
            (
                "automation.triggers.update",
                json!({"trigger":"trigger-one","payload":{"label":"new"}}),
                HttpMethod::Patch,
                "/api/automation-triggers/trigger-one",
            ),
            (
                "automation.triggers.delete",
                json!({"trigger":"trigger-one"}),
                HttpMethod::Delete,
                "/api/automation-triggers/trigger-one",
            ),
            (
                "automation.triggers.rotate-secret",
                json!({"trigger":"trigger-one"}),
                HttpMethod::Post,
                "/api/automation-triggers/trigger-one/rotate-secret",
            ),
            (
                "automation.create",
                json!({"payload":{"title":"Task"}}),
                HttpMethod::Post,
                "/api/orgs/org-one/automations",
            ),
            (
                "automation.update",
                json!({"automation":"automation-one","payload":{"title":"Task"}}),
                HttpMethod::Patch,
                "/api/automations/automation-one",
            ),
            (
                "automation.enable",
                json!({"automation":"automation-one"}),
                HttpMethod::Patch,
                "/api/automations/automation-one",
            ),
            (
                "automation.disable",
                json!({"automation":"automation-one"}),
                HttpMethod::Patch,
                "/api/automations/automation-one",
            ),
            (
                "automation.run",
                json!({"automation":"automation-one"}),
                HttpMethod::Post,
                "/api/automations/automation-one/run",
            ),
            (
                "chat.list",
                json!({}),
                HttpMethod::Get,
                "/api/orgs/org-one/chats",
            ),
            (
                "chat.search",
                json!({"query":"planning"}),
                HttpMethod::Get,
                "/api/orgs/org-one/chats",
            ),
            (
                "chat.get",
                json!({"chat":"chat-one"}),
                HttpMethod::Get,
                "/api/chats/chat-one",
            ),
            (
                "chat.messages",
                json!({"chat":"chat-one"}),
                HttpMethod::Get,
                "/api/chats/chat-one/messages",
            ),
            (
                "chat.transcript",
                json!({"chat":"chat-one"}),
                HttpMethod::Get,
                "/api/chats/chat-one/messages",
            ),
            (
                "chat.read",
                json!({"chat":"chat-one"}),
                HttpMethod::Get,
                "/api/chats/chat-one",
            ),
            (
                "chat.create",
                json!({"body":"Hello"}),
                HttpMethod::Post,
                "/api/orgs/org-one/chats",
            ),
            (
                "chat.send",
                json!({"chat":"chat-one","body":"Hello"}),
                HttpMethod::Post,
                "/api/chats/chat-one/messages",
            ),
            (
                "chat.archive",
                json!({"chat":"chat-one"}),
                HttpMethod::Patch,
                "/api/chats/chat-one",
            ),
            (
                "runs.by-skill",
                json!({"skill":"rudder/docs"}),
                HttpMethod::Get,
                "/api/run-intelligence/orgs/org-one/runs",
            ),
            (
                "runs.cancel",
                json!({"run":"run-one"}),
                HttpMethod::Post,
                "/api/heartbeat-runs/run-one/cancel",
            ),
            (
                "runs.retry",
                json!({"run":"run-one"}),
                HttpMethod::Post,
                "/api/heartbeat-runs/run-one/retry",
            ),
        ];

        assert_eq!(cases.len(), CLI_FALLBACK_MCP_CAPABILITY_IDS.len());
        for (id, arguments, method, path) in cases {
            let requests = plan_cli_fallback_request(id, arguments, &runtime)
                .unwrap_or_else(|error| panic!("{id} should plan: {error}"))
                .unwrap_or_else(|| panic!("{id} should be explicitly mapped"));
            assert!(!requests.is_empty(), "{id} must map to a request");
            assert!(requests.iter().all(|request| request.capability_id == id));
            assert_eq!(requests[0].method, method, "{id} HTTP method");
            assert_eq!(requests[0].path, path, "{id} HTTP path");
        }
    }

    #[test]
    fn direct_issue_and_run_list_requests_keep_the_public_contract_mappings() {
        let runtime = fallback_runtime();
        let cases = [
            (
                "issue.create",
                json!({"title":"New issue"}),
                HttpMethod::Post,
                "/api/orgs/org-one/issues",
            ),
            (
                "issue.get",
                json!({"issue":"ISS-1"}),
                HttpMethod::Get,
                "/api/issues/ISS-1",
            ),
            (
                "issue.context",
                json!({"issue":"ISS-1","wakeCommentId":"cmt_1234"}),
                HttpMethod::Get,
                "/api/issues/ISS-1/heartbeat-context",
            ),
            (
                "issue.checkout",
                json!({"issue":"ISS-1"}),
                HttpMethod::Post,
                "/api/issues/ISS-1/checkout",
            ),
            (
                "issue.comment",
                json!({"issue":"ISS-1","body":"Progress"}),
                HttpMethod::Post,
                "/api/issues/ISS-1/comments",
            ),
            (
                "issue.comments.list",
                json!({"issue":"ISS-1","order":"asc"}),
                HttpMethod::Get,
                "/api/issues/ISS-1/comments",
            ),
            (
                "issue.comments.get",
                json!({"issue":"ISS-1","comment":"cmt_1234"}),
                HttpMethod::Get,
                "/api/issues/ISS-1/comments/cmt_1234",
            ),
            (
                "issue.done",
                json!({"issue":"ISS-1","comment":"Done"}),
                HttpMethod::Patch,
                "/api/issues/ISS-1",
            ),
            (
                "runs.list",
                json!({"loadedSkill":"rust/cli","issueId":"ISS-1"}),
                HttpMethod::Get,
                "/api/run-intelligence/orgs/org-one/runs",
            ),
        ];

        for (id, arguments, method, path) in cases {
            let PlanOutcome::Direct(request) = plan_request(id, arguments, &runtime)
                .unwrap_or_else(|error| panic!("{id} should plan: {error}"))
            else {
                panic!("{id} should produce a direct request");
            };
            assert_eq!(request.method, method, "{id} HTTP method");
            assert_eq!(request.path, path, "{id} HTTP path");
        }

        let PlanOutcome::Direct(run_list) = plan_request(
            "runs.list",
            json!({"loadedSkill":"rust/cli","issueId":"ISS-1"}),
            &runtime,
        )
        .unwrap() else {
            panic!("runs.list should produce a direct request");
        };
        assert_eq!(
            run_list.query,
            vec![
                ("projection".into(), "summary".into()),
                ("issueId".into(), "ISS-1".into()),
                ("loadedSkill".into(), "rust/cli".into()),
                ("limit".into(), "50".into()),
            ]
        );
    }

    #[test]
    fn issue_fallback_mappings_preserve_search_filters_and_mutation_payloads() {
        let runtime = fallback_runtime();

        let list = plan_cli_fallback_request(
            "issue.list",
            json!({"status":"todo, blocked", "assigneeAgentId":" agent-one ", "projectId":"project one"}),
            &runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            query_string(&list[0].query),
            "status=todo%2C+blocked&assigneeAgentId=agent-one&projectId=project+one"
        );

        let search = plan_cli_fallback_request(
            "issue.search",
            json!({"query":" dependency ", "status":"blocked"}),
            &runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            query_string(&search[0].query),
            "status=blocked&q=dependency&searchFields=title%2Cdescription%2Ccomment"
        );

        let update = plan_cli_fallback_request(
            "issue.update",
            json!({
                "issue":"issue-one",
                "title":" Updated ",
                "requestDepth":"12.8",
                "hiddenAt":"null",
                "body":" Note "
            }),
            &runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            update[0].body,
            Some(json!({"title":"Updated","requestDepth":12,"hiddenAt":null,"comment":"Note"}))
        );

        let review = plan_cli_fallback_request(
            "issue.review",
            json!({"issue":"issue-one","decision":"approve","comment":" Looks good "}),
            &runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            review[0].body,
            Some(json!({"reviewDecision":"approve","comment":"Looks good"}))
        );

        let commit = plan_cli_fallback_request(
            "issue.commit",
            json!({"issue":"issue-one","sha":"abc123","message":"Fix","count":2}),
            &runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            commit[0].body,
            Some(json!({"sha":"abc123","message":"Fix","commitCount":2}))
        );

        let block = plan_cli_fallback_request(
            "issue.block",
            json!({"issue":"issue-one","body":" Need help "}),
            &runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            block[0].body,
            Some(json!({"status":"blocked","comment":"Need help"}))
        );
    }

    #[test]
    fn issue_mutations_reject_unmaterialized_images_and_bad_integer_inputs() {
        let runtime = fallback_runtime();
        for (id, arguments) in [
            (
                "issue.update",
                json!({"issue":"issue-one","images":["/tmp/image.png"]}),
            ),
            (
                "issue.block",
                json!({"issue":"issue-one","comment":"blocked","images":["/tmp/image.png"]}),
            ),
        ] {
            let error = plan_cli_fallback_request(id, arguments, &runtime).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("images require CLI attachment materialization")
            );
        }

        let error = plan_cli_fallback_request(
            "issue.update",
            json!({"issue":"issue-one","requestDepth":"nope"}),
            &runtime,
        )
        .unwrap_err();
        assert!(error.to_string().contains("Invalid integer value"));
    }

    #[test]
    fn library_and_skill_fallbacks_keep_cli_route_and_payload_contracts() {
        let runtime = fallback_runtime();

        let library_list = plan_cli_fallback_request(
            "library.file.list",
            json!({"directory":" projects/team "}),
            &runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(library_list[0].path, "/api/orgs/org-one/workspace/files");
        assert_eq!(query_string(&library_list[0].query), "path=projects%2Fteam");

        let library_put = plan_cli_fallback_request(
            "library.file.put",
            json!({"path":" projects/team/plan.md ","body":"# Plan\n"}),
            &runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            query_string(&library_put[0].query),
            "path=projects%2Fteam%2Fplan.md"
        );
        assert_eq!(library_put[0].body, Some(json!({"content":"# Plan\n"})));

        let skill_file =
            plan_cli_fallback_request("skill.file", json!({"skillId":"skill-one"}), &runtime)
                .unwrap()
                .unwrap();
        assert_eq!(
            skill_file[0].path,
            "/api/orgs/org-one/skills/skill-one/files"
        );
        assert_eq!(query_string(&skill_file[0].query), "path=SKILL.md");

        let scan_local = plan_cli_fallback_request(
            "skill.scan-local",
            json!({"roots":" /tmp/one, ,/tmp/two "}),
            &runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            scan_local[0].body,
            Some(json!({"roots":["/tmp/one","/tmp/two"]}))
        );

        let scan_projects = plan_cli_fallback_request(
            "skill.scan-projects",
            json!({"projectIds":"project-one, project-two"}),
            &runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            scan_projects[0].body,
            Some(json!({"projectIds":["project-one","project-two"]}))
        );

        let created = plan_cli_fallback_request(
            "agent.skills.create",
            json!({"name":" New skill ","slug":" slug ","body":"markdown"}),
            &runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(created[0].method, HttpMethod::Post);
        assert_eq!(
            created[0].body,
            Some(json!({
                "name":"New skill",
                "slug":"slug",
                "description":null,
                "markdown":"markdown"
            }))
        );
    }

    #[test]
    fn cli_fallback_mapping_preserves_aliases_clears_and_query_types() {
        let runtime = fallback_runtime();

        let agent = plan_cli_fallback_request(
            "agent.update",
            json!({"clearTitle":true,"clearDescription":true}),
            &runtime,
        )
        .unwrap()
        .unwrap()
        .remove(0);
        assert_eq!(agent.method, HttpMethod::Patch);
        assert_eq!(agent.path, "/api/agents/agent-one");
        assert_eq!(agent.query, vec![("orgId".into(), "org-one".into())]);
        assert_eq!(agent.body, Some(json!({"title":null,"capabilities":null})));

        let skills = plan_cli_fallback_request(
            "agent.skills.enable",
            json!({"skills":[" rudder/docs ","   ","local/private"]}),
            &runtime,
        )
        .unwrap()
        .unwrap()
        .remove(0);
        assert_eq!(
            skills.body,
            Some(json!({"skills":["rudder/docs","local/private"]}))
        );

        let project = plan_cli_fallback_request(
            "project.create",
            json!({"name":"Project","goalIds":[" goal-one ","  ","goal-two"]}),
            &runtime,
        )
        .unwrap()
        .unwrap()
        .remove(0);
        assert_eq!(
            project.body,
            Some(json!({"name":"Project","goalIds":["goal-one","goal-two"]}))
        );

        let activity = plan_cli_fallback_request(
            "user.activity",
            json!({"user":" me ","limit":4,"relatedAgentId":"agent-2"}),
            &runtime,
        )
        .unwrap()
        .unwrap()
        .remove(0);
        assert_eq!(activity.path, "/api/orgs/org-one/users/me/activity-ledger");
        assert_eq!(
            activity.query,
            vec![
                ("since".into(), "today".into()),
                ("agentId".into(), "agent-2".into()),
                ("limit".into(), "4".into()),
            ]
        );

        let read = plan_cli_fallback_request(
            "chat.read",
            json!({"chatId":"chat-one","turnLimit":12,"includeOutput":true}),
            &runtime,
        )
        .unwrap()
        .unwrap();
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].path, "/api/chats/chat-one");
        assert_eq!(read[1].path, "/api/chats/chat-one/messages");
        assert_eq!(
            read[1].query,
            vec![
                ("envelope".into(), "true".into()),
                ("order".into(), "newest".into()),
                ("limit".into(), "12".into()),
                ("includeTranscript".into(), "true".into()),
            ]
        );

        let run = plan_cli_fallback_request(
            "runs.by-skill",
            json!({"skill":"docs","evidence":"loaded","relatedAgentId":"agent-2"}),
            &runtime,
        )
        .unwrap()
        .unwrap()
        .remove(0);
        assert_eq!(
            run.query,
            vec![
                ("projection".into(), "summary".into()),
                ("loadedSkill".into(), "docs".into()),
                ("agentId".into(), "agent-2".into()),
                ("limit".into(), "50".into()),
            ]
        );

        let automation = plan_cli_fallback_request(
            "automation.run",
            json!({"automation":"automation-one","payload":"{\"key\":\"value\"}"}),
            &runtime,
        )
        .unwrap()
        .unwrap()
        .remove(0);
        assert_eq!(
            automation.body,
            Some(json!({"payload":{"key":"value"},"source":"manual"}))
        );
        assert!(matches!(
            plan_cli_fallback_request(
                "automation.run",
                json!({"automation":"automation-one","payload":"not json"}),
                &runtime,
            ),
            Err(PlanError::InvalidArgument { .. })
        ));
        assert!(matches!(
            plan_cli_fallback_request(
                "automation.run",
                json!({"automation":"automation-one","payload":"[]"}),
                &runtime,
            ),
            Err(PlanError::InvalidArgument { .. })
        ));
    }

    #[test]
    fn cli_fallback_planner_does_not_expand_to_unmapped_or_direct_capabilities() {
        let runtime = fallback_runtime();
        assert_eq!(
            plan_cli_fallback_request(
                "project.update",
                json!({"project":"p","name":"new"}),
                &runtime
            )
            .unwrap(),
            None
        );
        assert_eq!(
            plan_cli_fallback_request("agent.capabilities", json!({}), &runtime).unwrap(),
            None
        );
        assert_eq!(
            plan_cli_fallback_request("agent.list", json!({}), &runtime).unwrap(),
            None
        );
        for (id, args) in [
            ("plugin.search", json!({"query":"   "})),
            ("chat.search", json!({"query":"   "})),
        ] {
            assert!(matches!(
                plan_cli_fallback_request(id, args, &runtime),
                Err(PlanError::InvalidArgument { .. })
            ));
        }
    }

    #[test]
    fn organization_branding_maps_logo_only_and_nullable_clears_without_defaults() {
        let runtime = ManagedRuntimeIdentity {
            organization_id: Some("org/one".into()),
            ..ManagedRuntimeIdentity::default()
        };
        let tool = "rudder_organization_brand_color_update";
        let logo_asset_id = "11111111-1111-4111-8111-111111111111";

        let PlanOutcome::Direct(logo_request) = plan_request(
            tool,
            json!({"logoAssetId": logo_asset_id, "idempotencyKey": "logo-link-1"}),
            &runtime,
        )
        .unwrap() else {
            panic!("branding capability should be direct");
        };
        assert_eq!(logo_request.path, "/api/orgs/org%2Fone/branding");
        assert_eq!(
            logo_request.body,
            Some(json!({"logoAssetId": logo_asset_id}))
        );
        assert_eq!(
            logo_request.headers,
            vec![
                ("x-rudder-idempotency-key".into(), "logo-link-1".into()),
                ("x-rudder-required-authority".into(), "rust".into()),
            ]
        );

        let PlanOutcome::Direct(clear_request) = plan_request(
            tool,
            json!({"brandColor": null, "logoAssetId": null, "idempotencyKey": "clear-1"}),
            &runtime,
        )
        .unwrap() else {
            panic!("branding capability should be direct");
        };
        assert_eq!(
            clear_request.body,
            Some(json!({"brandColor": null, "logoAssetId": null}))
        );
        assert!(plan_request(tool, json!({"idempotencyKey": "empty-1"}), &runtime).is_err());
    }

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
