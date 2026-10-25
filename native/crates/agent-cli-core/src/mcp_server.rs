//! Additive Rust MCP server for explicitly mapped first-party API capabilities.
//!
//! This entry exposes the direct APIs and bounded CLI-fallback HTTP mappings
//! implemented here, plus the local agent capabilities manifest. It does not
//! invoke the Node CLI or advertise unmapped local-I/O, Browser, or Computer
//! tools. Some mapped endpoints still have their existing Node backend owner.

use super::issue_transport_budget::{
    BudgetFailure, FailureOutcome, IssueTransportBudget, ReserveOutcome, TransportSurface,
};
use super::skill_cli;
use super::{CliError, api_response_error, build_request_url, redact_json, request_timeout};
use reqwest::blocking::{Client, Response};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderName, HeaderValue};
use reqwest::redirect::Policy;
use rudder_agent_contract_core::contract;
use rudder_agent_request_planner::{
    CLI_FALLBACK_MCP_CAPABILITY_IDS, DirectRequest, HttpMethod, ManagedRuntimeIdentity, PlanError,
    PlanOutcome, plan_cli_fallback_request, plan_request, query_string,
};
use rudder_cli_mcp_contract_core::{
    FrameLimits, FrameMode, IdentityRequirements, InputParser, RUDDER_MCP_CONTRACT_VERSION,
    RUDDER_MCP_LEGACY_PROTOCOL_VERSIONS, RUDDER_MCP_MODERN_PROTOCOL_VERSION,
    validate_managed_identity,
};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};

const SERVER_NAME: &str = "rudder-tools";
const CORE_MCP_CONTRACT_HASH: &str =
    "0c857b06fba2c6bbe65adb71e546e6fc8cadea28cf5d1a438d5fb37954e95120";
const DEFAULT_PROTOCOL_VERSION: &str = "2025-11-25";
const MAX_RESULT_BYTES: usize = 1_000_000;
const MAX_INLINE_TEXT_BYTES: usize = 32_000;
const TOOL_RESULT_TOO_LARGE: &str = "Rudder MCP response exceeded the bounded tool-result budget.";

// These IDs are an explicit implementation boundary. Do not widen this list
// just because a descriptor becomes `direct`; each addition needs a checked
// request mapping and any transport-specific behavior it relies on.
const SUPPORTED_CAPABILITY_IDS: &[&str] = &[
    "agent.me",
    "agent.inbox",
    "organization.members.list",
    "organization.brand_color.update",
    "goal.list",
    "goal.context",
    "goal.progress",
    "goal.checkpoint",
    "goal.change.propose",
    "goal.result.propose",
    "project.update",
    "issue.create",
    "issue.get",
    "issue.context",
    "issue.checkout",
    "issue.comment",
    "issue.comments.list",
    "issue.comments.get",
    "issue.done",
    "runs.list",
    "runs.get",
    "runs.events",
    "runs.log",
    "runs.transcript",
    "runs.errors",
    "runs.create",
];
const SUPPORTED_LOCAL_CAPABILITY_IDS: &[&str] = &["agent.capabilities"];

const PROTOCOL_VERSION_META_KEY: &str = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY: &str = "io.modelcontextprotocol/clientCapabilities";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StdioMode {
    Newline,
    ContentLength,
}

/// Run the additive Rust MCP server over the supplied stdio.
pub fn run<R: Read, W: Write>(
    mut input: R,
    mut output: W,
    environment: &BTreeMap<String, String>,
) -> Result<(), String> {
    let mut parser =
        InputParser::with_limits(FrameLimits::default()).map_err(|error| error.to_string())?;
    let mut mode = None;
    let mut mode_probe = Vec::new();
    let mut chunk = [0_u8; 8192];

    loop {
        let read = input
            .read(&mut chunk)
            .map_err(|_| "MCP input could not be read".to_owned())?;
        if read == 0 {
            parser.finish().map_err(|error| error.to_string())?;
            return Ok(());
        }
        let bytes = &chunk[..read];
        if mode.is_none() {
            mode_probe.extend_from_slice(bytes);
            mode = detect_stdio_mode(&mode_probe);
        }
        let messages = parser.push(bytes).map_err(|error| error.to_string())?;
        let Some(mode) = mode else {
            continue;
        };
        for message in messages {
            let Some(response) = handle_message(&message, environment) else {
                continue;
            };
            let frame_mode = match mode {
                StdioMode::Newline => FrameMode::Newline,
                StdioMode::ContentLength => FrameMode::ContentLength,
            };
            let frame = rudder_cli_mcp_contract_core::encode_frame(
                &response,
                frame_mode,
                FrameLimits::default(),
            )
            .map_err(|error| error.to_string())?;
            output
                .write_all(&frame)
                .and_then(|_| output.flush())
                .map_err(|_| "MCP response could not be written".to_owned())?;
        }
    }
}

fn detect_stdio_mode(probe: &[u8]) -> Option<StdioMode> {
    let trimmed = probe
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .map(|index| &probe[index..])?;
    const PREFIX: &[u8] = b"Content-Length:";
    let common = trimmed.len().min(PREFIX.len());
    if trimmed[..common].eq_ignore_ascii_case(&PREFIX[..common]) {
        if trimmed.len() < PREFIX.len() {
            return None;
        }
        return Some(StdioMode::ContentLength);
    }
    Some(StdioMode::Newline)
}

fn handle_message(message: &Value, environment: &BTreeMap<String, String>) -> Option<Value> {
    let request = message.as_object();
    let id = request.and_then(|value| value.get("id")).cloned();
    let notification = id.is_none();
    let Some(object) = request else {
        return Some(rpc_error(
            Value::Null,
            -32600,
            "Invalid JSON-RPC request",
            None,
        ));
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(rpc_error(
            id.unwrap_or(Value::Null),
            -32600,
            "Invalid JSON-RPC request",
            None,
        ));
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return Some(rpc_error(
            id.unwrap_or(Value::Null),
            -32600,
            "Invalid JSON-RPC request",
            None,
        ));
    };
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    let response_id = id.unwrap_or(Value::Null);

    if rudder_cli_mcp_contract_core::has_conflicting_protocol_versions(&params) {
        return if notification {
            None
        } else {
            Some(rpc_error(
                response_id,
                -32602,
                "Conflicting MCP protocol versions",
                None,
            ))
        };
    }
    let requested_version = protocol_version_from_params(&params);
    let modern_request = has_modern_envelope(&params);
    if requested_version.as_deref() == Some(RUDDER_MCP_MODERN_PROTOCOL_VERSION)
        && method != "server/discover"
        && !modern_request
    {
        return if notification {
            None
        } else {
            Some(rpc_error(
                response_id,
                -32602,
                "Invalid _meta envelope for protocol revision 2026-07-28",
                Some(json!({"required":[PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY]})),
            ))
        };
    }

    match method {
        "notifications/initialized" => {
            if notification {
                None
            } else {
                Some(rpc_result(response_id, json!({})))
            }
        }
        "initialize" => Some(initialize(response_id, &params)),
        "server/discover" => Some(discover(response_id, &params)),
        "tools/list" => {
            if modern_request && params.get("cursor").and_then(Value::as_str).is_some() {
                return Some(rpc_error(
                    response_id,
                    -32602,
                    "Invalid tools/list cursor",
                    None,
                ));
            }
            let mut result = json!({"tools": tool_manifest()});
            if modern_request {
                decorate_modern_result(&mut result, true);
            }
            Some(rpc_result(response_id, result))
        }
        "ping" => {
            let mut result = json!({});
            if modern_request {
                decorate_modern_result(&mut result, false);
            }
            Some(rpc_result(response_id, result))
        }
        "tools/call" => {
            let tool_result = call_tool(&params, environment);
            let mut result = tool_result;
            if modern_request {
                decorate_modern_result(&mut result, false);
            }
            let response = rpc_result(response_id, result);
            Some(bound_response(response))
        }
        _ if notification => None,
        _ => Some(rpc_error(
            response_id,
            -32601,
            &format!("Unsupported JSON-RPC method: {method}"),
            None,
        )),
    }
}

fn initialize(id: Value, params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(DEFAULT_PROTOCOL_VERSION)
        .trim();
    if !RUDDER_MCP_LEGACY_PROTOCOL_VERSIONS.contains(&requested) {
        return rpc_error(
            id,
            -32022,
            &format!("Unsupported protocol version: {requested}"),
            Some(json!({
                "supported": RUDDER_MCP_LEGACY_PROTOCOL_VERSIONS,
                "requested": requested,
            })),
        );
    }
    rpc_result(
        id,
        json!({
            "protocolVersion": requested,
            "capabilities": {
                "tools": {},
                "experimental": {
                    "rudder": {
                        "contractVersion": RUDDER_MCP_CONTRACT_VERSION,
                        "coreContractHash": CORE_MCP_CONTRACT_HASH,
                    }
                }
            },
            "serverInfo": server_info(),
        }),
    )
}

fn discover(id: Value, params: &Value) -> Value {
    let requested = protocol_version_from_params(params);
    if requested
        .as_deref()
        .is_some_and(|version| version != RUDDER_MCP_MODERN_PROTOCOL_VERSION)
    {
        return rpc_error(
            id,
            -32022,
            &format!(
                "Unsupported protocol version: {}",
                requested.as_deref().unwrap_or_default()
            ),
            Some(json!({"supported":[RUDDER_MCP_MODERN_PROTOCOL_VERSION]})),
        );
    }
    if !has_modern_envelope(params) {
        return rpc_error(
            id,
            -32602,
            "Invalid _meta envelope for protocol revision 2026-07-28",
            Some(json!({"required":[PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY]})),
        );
    }
    let mut result = json!({
        "supportedVersions": [RUDDER_MCP_MODERN_PROTOCOL_VERSION],
        "capabilities": {"tools": {"listChanged": false}},
        "resultType": "complete",
        "ttlMs": 300_000,
        "cacheScope": "public",
    });
    result["_meta"] = json!({"io.modelcontextprotocol/serverInfo": server_info()});
    rpc_result(id, result)
}

fn tool_manifest() -> Vec<Value> {
    let contract = contract();
    contract["capabilities"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|capability| {
            let id = capability["id"].as_str().unwrap_or_default();
            is_supported_capability_id(id) && capability["mcp"].is_object()
        })
        .map(|capability| {
            let descriptor = &capability["mcp"];
            json!({
                "name": descriptor["name"],
                "description": descriptor["description"],
                "inputSchema": descriptor["inputSchema"],
                "annotations": descriptor["annotations"],
            })
        })
        .collect()
}

fn call_tool(params: &Value, environment: &BTreeMap<String, String>) -> Value {
    let Some(params) = params.as_object() else {
        return tool_error(
            "rudder_mcp_invalid_request",
            "tools/call params must be an object",
            Value::Null,
        );
    };
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return tool_error(
            "rudder_mcp_invalid_request",
            "MCP tool name is required",
            Value::Null,
        );
    };
    let Some(capability_id) = capability_id_for_tool(name) else {
        return tool_error(
            "rudder_mcp_tool_not_available",
            &format!("Rudder native MCP tool is not available: {name}"),
            Value::Null,
        );
    };
    let mut arguments = match params.get("arguments") {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(Value::Object(value)) => Value::Object(value.clone()),
        Some(_) => {
            return tool_error(
                "rudder_mcp_invalid_argument",
                "MCP tool arguments must be an object",
                Value::Null,
            );
        }
    };
    if capability_id == "agent.capabilities" {
        if !arguments.as_object().is_some_and(Map::is_empty) {
            return tool_error(
                "rudder_mcp_invalid_arguments",
                "Unsupported argument for rudder_agent_capabilities",
                Value::Null,
            );
        }
        return success_tool_result(shorten_cli_output(agent_capabilities_manifest()));
    }
    if capability_id == "organization.brand_color.update"
        && let Err(message) = normalize_branding_arguments(&mut arguments)
    {
        return tool_error("rudder_mcp_invalid_argument", &message, Value::Null);
    }
    if capability_id == "library.file.list"
        && let Some(object) = arguments.as_object_mut()
        && !object.contains_key("directory")
        && !object.contains_key("path")
    {
        let default_path = environment
            .get("RUDDER_PROJECT_LIBRARY_PATH")
            .cloned()
            .unwrap_or_else(|| "projects".to_owned());
        object.insert("directory".into(), Value::String(default_path));
    }
    let runtime = ManagedRuntimeIdentity {
        organization_id: env_value(environment, "RUDDER_ORG_ID"),
        agent_id: env_value(environment, "RUDDER_AGENT_ID"),
        run_id: env_value(environment, "RUDDER_RUN_ID"),
        browser_enabled: false,
    };
    let (mut requests, is_cli_fallback) = match plan_request(
        &capability_id,
        arguments.clone(),
        &runtime,
    ) {
        Ok(PlanOutcome::Direct(request)) => (vec![request], false),
        Ok(PlanOutcome::NotDirectCapability) => {
            match plan_cli_fallback_request(&capability_id, arguments.clone(), &runtime) {
                Ok(Some(requests)) => (requests, true),
                Ok(None) => {
                    return tool_error(
                        "rudder_mcp_tool_not_available",
                        "The selected capability has no request mapping in this Rust MCP surface",
                        Value::Null,
                    );
                }
                Err(error) => return plan_error(error),
            }
        }
        Err(error) => return plan_error(error),
    };
    if is_cli_fallback
        && let Err(error) =
            normalize_cli_fallback_requests(&capability_id, &arguments, &mut requests)
    {
        return cli_error_result(error);
    }
    if is_cli_fallback && capability_id == "agent.skills.create" {
        return match execute_agent_skill_create(&requests, &arguments, &runtime, environment) {
            Ok(value) => success_tool_result(shorten_cli_output(value)),
            Err(error) => cli_error_result(error),
        };
    }
    if is_cli_fallback && capability_id == "library.file.put" {
        return match execute_library_file_put(&requests, &arguments, environment) {
            Ok(value) => success_tool_result(shorten_cli_output(value)),
            Err(error) => cli_error_result(error),
        };
    }
    match execute_requests(&requests, environment) {
        Ok(values) => {
            let value = if is_cli_fallback {
                project_cli_fallback_output(&capability_id, &arguments, values)
            } else {
                values.into_iter().next().unwrap_or_else(|| json!({}))
            };
            success_tool_result(shorten_cli_output(value))
        }
        Err(error) => cli_error_result(error),
    }
}

fn is_supported_capability_id(id: &str) -> bool {
    SUPPORTED_CAPABILITY_IDS.contains(&id)
        || CLI_FALLBACK_MCP_CAPABILITY_IDS.contains(&id)
        || SUPPORTED_LOCAL_CAPABILITY_IDS.contains(&id)
}

fn normalize_branding_arguments(arguments: &mut Value) -> Result<(), String> {
    let Some(object) = arguments.as_object_mut() else {
        return Err("branding arguments must be an object".to_owned());
    };
    let mut has_patch = false;
    for field in ["brandColor", "logoAssetId"] {
        let Some(value) = object.get_mut(field) else {
            continue;
        };
        has_patch = true;
        if value.is_null() {
            continue;
        }
        let Some(text) = value.as_str() else {
            continue;
        };
        let normalized = text.trim();
        if normalized.is_empty() {
            return Err(format!("Invalid branding argument: {field}"));
        }
        *value = Value::String(if field == "logoAssetId" {
            normalized.to_ascii_lowercase()
        } else {
            normalized.to_owned()
        });
    }
    if !has_patch {
        return Err("Provide brandColor or logoAssetId to update".to_owned());
    }
    Ok(())
}

fn capability_id_for_tool(name: &str) -> Option<String> {
    let contract = contract();
    contract["capabilities"]
        .as_array()?
        .iter()
        .find(|capability| {
            capability["mcp"]["name"].as_str() == Some(name)
                && is_supported_capability_id(capability["id"].as_str().unwrap_or_default())
        })
        .and_then(|capability| capability["id"].as_str())
        .map(str::to_owned)
}

fn agent_capabilities_manifest() -> Value {
    let all = contract();
    let capabilities = all["capabilities"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["cli"]["contract"].as_str() == Some("agent-v1"))
        .map(cli_manifest_entry)
        .collect::<Vec<_>>();
    let tools = all["capabilities"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| {
            entry["cli"]["contract"].as_str() == Some("agent-v1")
                && entry["cli"]["category"].as_str() != Some("browser")
                && entry["mcp"].is_object()
        })
        .map(|entry| {
            let cli = &entry["cli"];
            let descriptor = &entry["mcp"];
            json!({
                "id": cli["id"],
                "command": cli["command"],
                "category": cli["category"],
                "description": cli["description"],
                "mutating": cli["mutating"],
                "contract": cli["contract"],
                "requiresOrgId": cli["requiresOrgId"],
                "requiresAgentId": cli["requiresAgentId"],
                "requiresRunId": cli["requiresRunId"],
                "attachesRunIdWhenAvailable": cli["attachesRunIdWhenAvailable"],
                "agentV1": true,
                "capabilityId": cli["id"],
                "name": descriptor["name"],
                "inputSchema": descriptor["inputSchema"],
                "semanticDescription": descriptor["description"],
                "annotations": descriptor["annotations"],
                "outputMode": "json",
            })
        })
        .collect::<Vec<_>>();
    json!({
        "schema": "rudder.agent-capabilities/v1",
        "contract": "agent-v1",
        "defaults": {
            "orgIdEnvVar": "RUDDER_ORG_ID",
            "agentIdEnvVar": "RUDDER_AGENT_ID",
            "runIdEnvVar": "RUDDER_RUN_ID",
            "jsonErrors": "stderr-error-envelope",
        },
        "capabilities": capabilities,
        "mcp": {
            "schema": "rudder.agent-mcp-tools/v1",
            "contract": "agent-v1",
            "serverName": "rudder-tools",
            "tools": tools,
        },
    })
}

fn cli_manifest_entry(entry: &Value) -> Value {
    let cli = &entry["cli"];
    json!({
        "id": cli["id"],
        "command": cli["command"],
        "category": cli["category"],
        "description": cli["description"],
        "mutating": cli["mutating"],
        "contract": cli["contract"],
        "requiresOrgId": cli["requiresOrgId"],
        "requiresAgentId": cli["requiresAgentId"],
        "requiresRunId": cli["requiresRunId"],
        "attachesRunIdWhenAvailable": cli["attachesRunIdWhenAvailable"],
        "agentV1": true,
    })
}

fn execute_requests(
    requests: &[DirectRequest],
    environment: &BTreeMap<String, String>,
) -> Result<Vec<Value>, CliError> {
    if requests.len() <= 1 {
        return requests
            .first()
            .map(|request| execute_direct_request(request, environment).map(|value| vec![value]))
            .unwrap_or_else(|| Ok(Vec::new()));
    }
    std::thread::scope(|scope| {
        let handles = requests
            .iter()
            .map(|request| scope.spawn(move || execute_direct_request(request, environment)))
            .collect::<Vec<_>>();
        let mut values = Vec::with_capacity(handles.len());
        for handle in handles {
            match handle.join() {
                Ok(Ok(value)) => values.push(value),
                Ok(Err(error)) => return Err(error),
                Err(_) => {
                    return Err(CliError::transport(
                        "api_transport_error",
                        "API request worker failed before returning a response",
                    ));
                }
            }
        }
        Ok(values)
    })
}

fn project_cli_fallback_output(id: &str, arguments: &Value, mut values: Vec<Value>) -> Value {
    let first = values.first().cloned().unwrap_or(Value::Null);
    match id {
        "automation.triggers.list" => first
            .get("triggers")
            .cloned()
            .filter(Value::is_array)
            .unwrap_or_else(|| json!([])),
        "automation.triggers.delete" => json!({
            "id": value_string_any(arguments, &["trigger", "triggerId"]).unwrap_or_default(),
            "deleted": true,
        }),
        "automation.list" => filter_automation_rows(first, arguments),
        "library.file.ref" | "library.file.link" => json!({
            "filePath": first.get("filePath").cloned().unwrap_or(Value::Null),
            "libraryEntryId": first.get("libraryEntryId").cloned().unwrap_or(Value::Null),
            "mentionHref": first.get("mentionHref").cloned().unwrap_or(Value::Null),
            "markdownLink": first.get("markdownLink").cloned().unwrap_or(Value::Null),
        }),
        "skill.search" => {
            let rows = first.as_array().cloned().unwrap_or_default();
            let query = arguments
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Value::Array(skill_cli::search_organization_skills(&rows, query))
        }
        "plugin.search" => search_plugin_directory(
            first,
            value_string_any(arguments, &["query"]).unwrap_or_default(),
        ),
        "chat.list" => limit_rows(first, value_number(arguments.get("limit"), None)),
        "chat.search" => search_chat_rows(first, arguments),
        "chat.read" => {
            let conversation = values.first().cloned().unwrap_or(Value::Null);
            let page = values.get_mut(1).cloned().unwrap_or(Value::Null);
            let mut output = Map::new();
            output.insert("conversation".into(), conversation);
            if let Some(messages) = page.get("messages") {
                output.insert("messages".into(), messages.clone());
            }
            if let Some(page_info) = page.get("page") {
                output.insert("page".into(), page_info.clone());
            }
            Value::Object(output)
        }
        "runs.by-skill" => run_by_skill_report(first, arguments),
        _ => first,
    }
}

fn normalize_cli_fallback_requests(
    id: &str,
    arguments: &Value,
    requests: &mut [DirectRequest],
) -> Result<(), CliError> {
    let Some(request) = requests.first_mut() else {
        return Ok(());
    };
    match id {
        "agent.skills.create" => {
            let markdown = skill_cli::agent_skill_markdown_argument(
                arguments.get("markdown"),
                arguments.get("body"),
            );
            if let Some(body) = request.body.as_mut().and_then(Value::as_object_mut) {
                body.insert(
                    "markdown".into(),
                    markdown.map_or(Value::Null, Value::String),
                );
            }
        }
        "skill.file" => {
            let path = skill_cli::normalize_skill_file_path(arguments.get("path"));
            request.query = vec![("path".into(), path)];
        }
        "skill.import" => {
            let source = skill_cli::skill_import_source(arguments.get("source"))
                .map_err(|error| CliError::cli(error.to_string()))?;
            request.body = Some(json!({"source":source}));
        }
        "skill.scan-local" => {
            let roots = skill_cli::parse_csv_option(arguments.get("roots"));
            let mut body = Map::new();
            if let Some(roots) = roots {
                body.insert("roots".into(), json!(roots));
            }
            request.body = Some(Value::Object(body));
        }
        "skill.scan-projects" => {
            let mut body = Map::new();
            for key in ["projectIds", "workspaceIds"] {
                if let Some(values) = skill_cli::parse_csv_option(arguments.get(key)) {
                    body.insert(key.into(), json!(values));
                }
            }
            request.body = Some(Value::Object(body));
        }
        _ => {}
    }
    Ok(())
}

fn execute_agent_skill_create(
    requests: &[DirectRequest],
    arguments: &Value,
    runtime: &ManagedRuntimeIdentity,
    environment: &BTreeMap<String, String>,
) -> Result<Value, CliError> {
    let request = requests
        .first()
        .ok_or_else(|| CliError::cli("agent.skills.create has no request mapping"))?;
    let created = execute_direct_request(request, environment)?;
    let enabled_snapshot = if arguments.get("enable").and_then(Value::as_bool) == Some(true) {
        let selection_key = created
            .get("selectionKey")
            .and_then(Value::as_str)
            .ok_or_else(|| CliError {
                message: "Agent skill creation response did not include selectionKey".into(),
                status: Some(502),
                code: "invalid_api_response".into(),
                details: None,
            })?;
        let planned = plan_cli_fallback_request(
            "agent.skills.enable",
            json!({"selectionRefs":[selection_key]}),
            runtime,
        )
        .map_err(|error| CliError::cli(error.to_string()))?
        .ok_or_else(|| CliError::cli("agent.skills.enable has no request mapping"))?;
        execute_direct_request(
            planned
                .first()
                .ok_or_else(|| CliError::cli("agent.skills.enable has no request mapping"))?,
            environment,
        )?
    } else {
        Value::Null
    };
    Ok(json!({"created":created,"enabledSnapshot":enabled_snapshot}))
}

fn execute_library_file_put(
    requests: &[DirectRequest],
    arguments: &Value,
    environment: &BTreeMap<String, String>,
) -> Result<Value, CliError> {
    let request = requests
        .first()
        .ok_or_else(|| CliError::cli("library.file.put has no request mapping"))?;
    match execute_direct_request(request, environment) {
        Ok(value) => Ok(value),
        Err(error) if error.status == Some(404) => {
            let mut create_request = request.clone();
            create_request.method = HttpMethod::Post;
            create_request.query.clear();
            let file_path = arguments
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| CliError::cli("path is required"))?;
            let content = arguments
                .get("body")
                .filter(|value| !value.is_null())
                .or_else(|| arguments.get("content"))
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::cli("body is required"))?;
            create_request.body = Some(json!({"filePath":file_path,"content":content}));
            execute_direct_request(&create_request, environment)
        }
        Err(error) => Err(error),
    }
}

fn filter_automation_rows(value: Value, arguments: &Value) -> Value {
    let Some(rows) = value.as_array() else {
        return json!([]);
    };
    let filters = ["status", "assigneeAgentId", "projectId", "outputMode"];
    Value::Array(
        rows.iter()
            .filter(|row| {
                filters.iter().all(|key| {
                    let Some(filter) = optional_input_string(arguments.get(*key)) else {
                        return true;
                    };
                    row.get(*key).and_then(Value::as_str) == Some(filter.as_str())
                })
            })
            .cloned()
            .collect(),
    )
}

fn search_chat_rows(value: Value, arguments: &Value) -> Value {
    let Some(rows) = value.as_array() else {
        return json!([]);
    };
    let query = value_string_any(arguments, &["query"])
        .unwrap_or_default()
        .to_lowercase();
    let scope = optional_input_string(arguments.get("scope")).unwrap_or_else(|| "all".into());
    let filtered = rows
        .iter()
        .filter(|row| match scope.as_str() {
            "title" => contains_query(row.get("title"), &query),
            "summary" => contains_query(row.get("summary"), &query),
            "messages" => contains_query(row.get("searchPreview"), &query),
            _ => true,
        })
        .cloned()
        .collect::<Vec<_>>();
    let limit = value_number(arguments.get("limit"), Some(20));
    Value::Array(filtered.into_iter().take(limit.unwrap_or(20)).collect())
}

fn limit_rows(value: Value, limit: Option<usize>) -> Value {
    let Some(rows) = value.as_array() else {
        return json!([]);
    };
    Value::Array(
        rows.iter()
            .take(limit.unwrap_or(rows.len()))
            .cloned()
            .collect(),
    )
}

fn search_plugin_directory(directory: Value, query: String) -> Value {
    let normalized = query.trim().to_lowercase();
    let buckets = ["installed", "localApps", "discover"];
    let mut output = Map::new();
    for bucket in buckets {
        let rows = directory
            .get(bucket)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let matched = rows
            .into_iter()
            .filter(|row| plugin_entry_matches(bucket, row, &normalized))
            .collect::<Vec<_>>();
        output.insert(bucket.into(), Value::Array(matched));
    }
    Value::Object(output)
}

fn plugin_entry_matches(bucket: &str, row: &Value, query: &str) -> bool {
    if query.is_empty() {
        return false;
    }
    let keys: &[&str] = match bucket {
        "installed" => &[
            "id",
            "name",
            "displayName",
            "description",
            "publisher",
            "sourceLabel",
        ],
        "localApps" => &["id", "appId", "name", "description", "appKey"],
        _ => &[
            "reportId",
            "packageId",
            "name",
            "displayName",
            "description",
            "publisher",
            "sourceLabel",
            "category",
        ],
    };
    keys.iter().any(|key| contains_query(row.get(*key), query))
        || row
            .get("components")
            .and_then(Value::as_array)
            .is_some_and(|components| {
                let component_keys: &[&str] = if bucket == "installed" {
                    &["key", "displayName", "type"]
                } else {
                    &["key", "name", "type"]
                };
                components.iter().any(|component| {
                    component_keys
                        .iter()
                        .any(|key| contains_query(component.get(*key), query))
                })
            })
}

fn contains_query(value: Option<&Value>, query: &str) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| value.to_lowercase().contains(query))
}

fn optional_input_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn value_string_any(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| optional_input_string(value.get(*key)))
}

fn value_number(value: Option<&Value>, fallback: Option<usize>) -> Option<usize> {
    let parsed = match value {
        Some(Value::Number(number)) => number.as_u64().map(|number| number as usize),
        Some(Value::String(text)) => text.trim().parse::<usize>().ok(),
        _ => None,
    };
    parsed.filter(|value| *value > 0).or(fallback)
}

fn run_by_skill_report(page: Value, arguments: &Value) -> Value {
    let items = page
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let skill = value_string_any(arguments, &["skill"]).unwrap_or_default();
    let evidence = value_string_any(arguments, &["evidence"]).unwrap_or_else(|| "used".into());
    let mut status_counts = BTreeMap::<&str, usize>::from([
        ("succeeded", 0),
        ("failed", 0),
        ("cancelled", 0),
        ("timedOut", 0),
        ("running", 0),
        ("queued", 0),
        ("other", 0),
    ]);
    let mut agents: Vec<(String, Value, usize)> = Vec::new();
    let mut issues: Vec<(String, Value, Value, usize)> = Vec::new();
    let mut errors: Vec<(String, usize)> = Vec::new();

    for row in &items {
        match row
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "succeeded" => *status_counts.get_mut("succeeded").unwrap() += 1,
            "failed" => *status_counts.get_mut("failed").unwrap() += 1,
            "cancelled" => *status_counts.get_mut("cancelled").unwrap() += 1,
            "timed_out" => *status_counts.get_mut("timedOut").unwrap() += 1,
            "running" => *status_counts.get_mut("running").unwrap() += 1,
            "queued" => *status_counts.get_mut("queued").unwrap() += 1,
            _ => *status_counts.get_mut("other").unwrap() += 1,
        }
        let agent_id = row
            .get("agentId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if let Some(agent) = agents.iter_mut().find(|agent| agent.0 == agent_id) {
            agent.2 += 1;
        } else {
            agents.push((
                agent_id,
                row.get("agentName").cloned().unwrap_or(Value::Null),
                1,
            ));
        }
        if let Some(issue) = row.get("issue").filter(|value| !value.is_null()) {
            let issue_id = issue.get("id").and_then(Value::as_str).unwrap_or_default();
            if let Some(existing) = issues.iter_mut().find(|entry| entry.0 == issue_id) {
                existing.3 += 1;
            } else {
                issues.push((
                    issue_id.to_owned(),
                    issue.get("identifier").cloned().unwrap_or(Value::Null),
                    issue.get("title").cloned().unwrap_or(Value::Null),
                    1,
                ));
            }
        }
        if let Some(error) = row
            .get("error")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if let Some(existing) = errors.iter_mut().find(|entry| entry.0 == error) {
                existing.1 += 1;
            } else {
                errors.push((error.to_owned(), 1));
            }
        }
    }
    agents.sort_by_key(|entry| std::cmp::Reverse(entry.2));
    issues.sort_by_key(|entry| std::cmp::Reverse(entry.3));
    errors.sort_by_key(|entry| std::cmp::Reverse(entry.1));

    let agents_output = agents
        .into_iter()
        .map(|(id, name, count)| json!({"id":id,"name":name,"count":count}))
        .collect::<Vec<_>>();
    let issues_output = issues
        .into_iter()
        .map(|(id, identifier, title, count)| {
            json!({"id":id,"identifier":identifier,"title":title,"count":count})
        })
        .collect::<Vec<_>>();
    let common_errors = errors
        .into_iter()
        .take(5)
        .map(|(summary, count)| json!({"summary":summary,"count":count}))
        .collect::<Vec<_>>();
    let next_commands = items
        .iter()
        .take(5)
        .map(|row| {
            let empty = Map::new();
            let parent = row.as_object().unwrap_or(&empty);
            let run_id = row
                .get("id")
                .and_then(Value::as_str)
                .map(|id| display_id_for_cli("runId", id, parent).unwrap_or_else(|| id.to_owned()))
                .unwrap_or_default();
            if row.get("status").and_then(Value::as_str) == Some("failed") {
                format!("rudder runs errors {run_id}")
            } else {
                format!("rudder runs transcript {run_id}")
            }
        })
        .collect::<Vec<_>>();
    let mut output = json!({
        "skill": {"query":skill,"evidenceType":evidence},
        "summary": {
            "total": items.len(),
            "succeeded": status_counts["succeeded"],
            "failed": status_counts["failed"],
            "cancelled": status_counts["cancelled"],
            "timedOut": status_counts["timedOut"],
            "running": status_counts["running"],
            "queued": status_counts["queued"],
            "other": status_counts["other"],
            "agents": agents_output,
            "issues": issues_output,
            "commonErrors": common_errors,
        },
        "rows": items,
        "nextCommands": next_commands,
    });
    if let Some(page_info) = page.get("page") {
        output["page"] = page_info.clone();
    }
    output
}

fn execute_direct_request(
    request: &DirectRequest,
    environment: &BTreeMap<String, String>,
) -> Result<Value, CliError> {
    let identity = validate_managed_identity(
        environment,
        IdentityRequirements {
            require_api_url: true,
            require_api_key: true,
            require_org_id: request.context.organization,
            require_agent_id: request.context.agent,
            require_run_id: request.context.run,
        },
    )
    .map_err(|error| CliError::cli(error.to_string()))?;

    let encoded_query = query_string(&request.query);
    let public_request_path = if encoded_query.is_empty() {
        request.path.clone()
    } else {
        format!("{}?{encoded_query}", request.path)
    };
    let url = build_request_url(identity.api_url(), &request.path, &encoded_query)?;
    let timeout = request_timeout(environment)?;
    let client = Client::builder()
        .timeout(timeout)
        .redirect(Policy::none())
        .build()
        .map_err(|_| {
            CliError::transport("api_transport_error", "could not initialize API client")
        })?;
    let mut builder = match request.method {
        HttpMethod::Get => client.get(url),
        HttpMethod::Post => client.post(url),
        HttpMethod::Patch => client.patch(url),
        HttpMethod::Delete => client.delete(url),
    }
    .header(ACCEPT, "application/json")
    .header(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", identity.api_key())).map_err(|_| {
            CliError::cli("API key contains characters that are invalid in an HTTP header")
        })?,
    );

    if request.method != HttpMethod::Get {
        if let Some(agent_id) = identity.agent_id() {
            builder = builder.header("x-rudder-agent-id", agent_id);
        }
        if let Some(run_id) = identity.run_id() {
            builder = builder.header("x-rudder-run-id", run_id);
        }
    }
    for (name, value) in &request.headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| CliError::cli("invalid header in direct API request plan"))?;
        let value = HeaderValue::from_str(value)
            .map_err(|_| CliError::cli("invalid header value in direct API request plan"))?;
        builder = builder.header(name, value);
    }
    if let Some(body) = &request.body {
        builder = builder.header(CONTENT_TYPE, "application/json").json(body);
    }

    let issue_transport_budget =
        IssueTransportBudget::from_environment(environment, TransportSurface::Mcp);
    let reservation = match issue_transport_budget.reserve(
        Some(http_method_name(request.method)),
        &public_request_path,
        request.body.as_ref(),
    ) {
        Ok(ReserveOutcome::Untracked) => None,
        Ok(ReserveOutcome::Allowed(reservation)) => Some(reservation),
        Ok(ReserveOutcome::Blocked(error)) | Err(error) => {
            return Err(issue_budget_error(error));
        }
    };

    let response = match builder.send() {
        Ok(response) => response,
        Err(error) => {
            issue_transport_budget
                .succeed(reservation.as_ref())
                .map_err(issue_budget_error)?;
            return Err(if error.is_timeout() {
                CliError::transport("request_timeout", "API request timed out")
            } else {
                CliError::transport(
                    "api_transport_error",
                    "API request failed before receiving a response",
                )
            });
        }
    };
    let status = response.status().as_u16();
    if (200..300).contains(&status) {
        issue_transport_budget
            .succeed(reservation.as_ref())
            .map_err(issue_budget_error)?;
    }
    let body = read_bounded_with_limit(response, request.response_limit)?;
    if !(200..300).contains(&status) {
        let upstream_error = api_response_error(status, &body, identity.api_key());
        let outcome = issue_transport_budget
            .fail(
                reservation.as_ref(),
                status,
                &upstream_error.code,
                &upstream_error.message,
                upstream_error.details.as_ref(),
            )
            .map_err(issue_budget_error)?;
        return Err(issue_budget_outcome_error(outcome));
    }
    if body.is_empty() {
        return Ok(json!({}));
    }
    let mut value = serde_json::from_slice(&body)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&body).into_owned()));
    redact_json(&mut value, identity.api_key());
    Ok(value)
}

fn http_method_name(method: HttpMethod) -> &'static str {
    match method {
        HttpMethod::Get => "GET",
        HttpMethod::Post => "POST",
        HttpMethod::Patch => "PATCH",
        HttpMethod::Delete => "DELETE",
    }
}

fn issue_budget_error(error: BudgetFailure) -> CliError {
    CliError {
        message: error.message,
        status: Some(error.status),
        code: error.code,
        details: Some(error.details),
    }
}

fn issue_budget_outcome_error(error: FailureOutcome) -> CliError {
    CliError {
        message: error.message,
        status: Some(error.status),
        code: error.code,
        details: error.details,
    }
}

fn read_bounded_with_limit(response: Response, limit: usize) -> Result<Vec<u8>, CliError> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(CliError::response_too_large());
    }
    let mut bytes = Vec::new();
    response
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut {
                CliError::transport(
                    "request_timeout",
                    "API request timed out while reading the response",
                )
            } else {
                CliError::transport("api_transport_error", "API response could not be read")
            }
        })?;
    if bytes.len() > limit {
        return Err(CliError::response_too_large());
    }
    Ok(bytes)
}

fn plan_error(error: PlanError) -> Value {
    let code = match &error {
        PlanError::ReservedIdentity(_) => "rudder_mcp_reserved_identity_argument",
        PlanError::MissingContext(_) => "rudder_mcp_missing_runtime_context",
        PlanError::UnknownCapability(_) => "rudder_mcp_tool_not_available",
        PlanError::UnknownArguments { .. } | PlanError::InvalidArgument { .. } => {
            "rudder_mcp_invalid_argument"
        }
        PlanError::BrowserDisabled => "rudder_mcp_tool_not_available",
    };
    tool_error(code, &error.to_string(), Value::Null)
}

fn cli_error_result(error: CliError) -> Value {
    let details = error.json_value();
    let code = details["code"]
        .as_str()
        .unwrap_or("rudder_mcp_tool_error")
        .to_owned();
    tool_error(&code, &error.message, details)
}

fn success_tool_result(value: Value) -> Value {
    let full_text = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_owned());
    let full_text_bytes = full_text.len();
    let text = if full_text_bytes <= MAX_INLINE_TEXT_BYTES {
        full_text
    } else {
        json!({
            "status": "ok",
            "output": "structuredContent",
            "originalLength": full_text.chars().count(),
            "originalBytes": full_text_bytes,
        })
        .to_string()
    };
    json!({
        "content": [{"type":"text", "text":text}],
        "structuredContent": value,
        "isError": false,
    })
}

fn tool_error(code: &str, message: &str, details: Value) -> Value {
    let payload = json!({
        "status": "error",
        "code": code,
        "message": message,
        "details": details,
    });
    json!({
        "content": [{"type":"text", "text":payload.to_string()}],
        "structuredContent": payload,
        "isError": true,
    })
}

fn bound_response(response: Value) -> Value {
    if serde_json::to_vec(&response)
        .map(|bytes| bytes.len() <= MAX_RESULT_BYTES)
        .unwrap_or(false)
    {
        return response;
    }
    let payload = json!({
        "status":"error",
        "code":"rudder_mcp_response_too_large",
        "message": TOOL_RESULT_TOO_LARGE,
        "details":{"maxBytes":MAX_RESULT_BYTES},
    });
    let id = response.get("id").cloned().unwrap_or(Value::Null);
    rpc_result(
        id,
        json!({
            "content":[{"type":"text","text":payload.to_string()}],
            "structuredContent":payload,
            "isError":true,
        }),
    )
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "result":result})
}

fn rpc_error(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut error = json!({"code":code,"message":message});
    if let Some(data) = data {
        error["data"] = data;
    }
    json!({"jsonrpc":"2.0", "id":id, "error":error})
}

fn server_info() -> Value {
    json!({"name":SERVER_NAME,"version":env!("CARGO_PKG_VERSION")})
}

fn decorate_modern_result(result: &mut Value, cacheable: bool) {
    let Some(object) = result.as_object_mut() else {
        return;
    };
    object.insert("resultType".to_owned(), json!("complete"));
    if cacheable {
        object.insert("ttlMs".to_owned(), json!(300_000));
        object.insert("cacheScope".to_owned(), json!("public"));
    }
    object.insert(
        "_meta".to_owned(),
        json!({"io.modelcontextprotocol/serverInfo":server_info()}),
    );
}

fn protocol_version_from_params(params: &Value) -> Option<String> {
    params
        .get("_meta")
        .and_then(|meta| meta.get(PROTOCOL_VERSION_META_KEY))
        .and_then(Value::as_str)
        .or_else(|| params.get("protocolVersion").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn has_modern_envelope(params: &Value) -> bool {
    params
        .get("_meta")
        .and_then(|meta| meta.get(PROTOCOL_VERSION_META_KEY))
        .and_then(Value::as_str)
        == Some(RUDDER_MCP_MODERN_PROTOCOL_VERSION)
        && params
            .get("_meta")
            .and_then(|meta| meta.get(CLIENT_CAPABILITIES_META_KEY))
            .is_some_and(Value::is_object)
}

fn env_value(environment: &BTreeMap<String, String>, key: &str) -> Option<String> {
    environment
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn shorten_cli_output(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(shorten_cli_output).collect()),
        Value::Object(object) => {
            let mut output = Map::new();
            for (key, child) in &object {
                let value = match child {
                    Value::String(text) if is_cli_id_key(key) && is_uuid_like(text) => {
                        display_id_for_cli(key, text, &object)
                            .map(Value::String)
                            .unwrap_or_else(|| Value::String(text.clone()))
                    }
                    Value::String(text) if is_cli_reference_string_key(key) => {
                        Value::String(shorten_uuid_references(text))
                    }
                    Value::Array(items) if is_cli_id_list_key(key) => {
                        let singular = singularize_id_list_key(key);
                        Value::Array(
                            items
                                .iter()
                                .map(|item| match item {
                                    Value::String(text) if is_uuid_like(text) => {
                                        display_id_for_cli(&singular, text, &object)
                                            .map(Value::String)
                                            .unwrap_or_else(|| Value::String(text.clone()))
                                    }
                                    other => shorten_cli_output(other.clone()),
                                })
                                .collect(),
                        )
                    }
                    other => shorten_cli_output(other.clone()),
                };
                output.insert(key.clone(), value);
            }
            Value::Object(output)
        }
        other => other,
    }
}

fn display_id_for_cli(key: &str, uuid: &str, parent: &Map<String, Value>) -> Option<String> {
    if key == "entityId"
        && parent.get("entityType").and_then(Value::as_str) == Some("issue")
        && let Some(identifier) = issue_identifier(parent)
    {
        return Some(identifier);
    }
    if key == "id" {
        if let Some(short_ref) = parent
            .get("shortRef")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            return Some(short_ref.to_owned());
        }
        if let Some(identifier) = parent
            .get("identifier")
            .or_else(|| parent.get("issueIdentifier"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            return Some(identifier.to_owned());
        }
    }
    if let Some(kind) = typed_ref_kind_for_id_key(key, parent) {
        return Some(format!("{}_{}", kind_prefix(kind), compact_uuid(uuid)?));
    }
    short_uuid(uuid)
}

fn issue_identifier(parent: &Map<String, Value>) -> Option<String> {
    parent
        .get("identifier")
        .or_else(|| parent.get("issueIdentifier"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            parent
                .get("details")
                .and_then(|details| {
                    details
                        .get("identifier")
                        .or_else(|| details.get("issueIdentifier"))
                })
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .map(str::to_owned)
}

fn typed_ref_kind_for_id_key(key: &str, parent: &Map<String, Value>) -> Option<&'static str> {
    let lower = key.to_ascii_lowercase();
    if key == "id" {
        let entity = parent
            .get("type")
            .and_then(Value::as_str)?
            .to_ascii_lowercase();
        return match entity.as_str() {
            "agent" => Some("agent"),
            "chat" | "chat_conversation" | "conversation" => Some("chat"),
            "conversation_message" | "chat_message" | "message" => Some("message"),
            "run" | "heartbeat_run" => Some("run"),
            "project" => Some("project"),
            "goal" => Some("goal"),
            "user" => Some("user"),
            "issue" => Some("issue"),
            "issue_comment" | "comment" => Some("issue_comment"),
            _ => None,
        };
    }
    if lower.contains("agentid")
        || (key == "actorId" && parent.get("actorType").and_then(Value::as_str) == Some("agent"))
    {
        return Some("agent");
    }
    if lower.contains("commentid") {
        return Some("issue_comment");
    }
    if lower.contains("runid") {
        return Some("run");
    }
    if lower.contains("messageid") || lower.contains("conversationmessageid") {
        return Some("message");
    }
    if lower.contains("chatid") || lower.contains("conversationid") {
        return Some("chat");
    }
    if lower.contains("projectid") {
        return Some("project");
    }
    if lower.contains("goalid") {
        return Some("goal");
    }
    if lower.contains("userid")
        || (key == "actorId" && parent.get("actorType").and_then(Value::as_str) == Some("user"))
    {
        return Some("user");
    }
    if lower.contains("issueid") {
        return Some("issue");
    }
    if key == "entityId" && parent.get("entityType").and_then(Value::as_str) == Some("issue") {
        return Some("issue");
    }
    None
}

fn kind_prefix(kind: &str) -> &'static str {
    match kind {
        "agent" => "agt",
        "chat" => "cht",
        "issue_comment" => "cmt",
        "run" => "run",
        "message" => "msg",
        "project" => "prj",
        "goal" => "gol",
        "user" => "usr",
        "issue" => "iss",
        _ => unreachable!("known short-ref kind"),
    }
}

fn compact_uuid(value: &str) -> Option<String> {
    is_uuid_like(value).then(|| {
        value
            .chars()
            .filter(|character| *character != '-')
            .take(8)
            .collect::<String>()
            .to_ascii_lowercase()
    })
}

fn short_uuid(value: &str) -> Option<String> {
    is_uuid_like(value).then(|| {
        value
            .chars()
            .filter(|character| *character != '-')
            .take(12)
            .collect::<String>()
            .to_ascii_lowercase()
    })
}

fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes.iter().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                true
            } else {
                byte.is_ascii_hexdigit()
            }
        })
        && matches!(bytes[14].to_ascii_lowercase(), b'1'..=b'5')
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}

fn shorten_uuid_references(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    while cursor < bytes.len() {
        if cursor + 36 <= bytes.len()
            && value.is_char_boundary(cursor)
            && value.is_char_boundary(cursor + 36)
        {
            let candidate = &value[cursor..cursor + 36];
            let left_boundary = cursor == 0 || !is_word_byte(bytes[cursor - 1]);
            let right_boundary = cursor + 36 == bytes.len() || !is_word_byte(bytes[cursor + 36]);
            if left_boundary && right_boundary && is_uuid_like(candidate) {
                output.push_str(
                    &candidate
                        .chars()
                        .filter(|character| *character != '-')
                        .take(12)
                        .collect::<String>()
                        .to_ascii_lowercase(),
                );
                cursor += 36;
                continue;
            }
        }
        let character = value[cursor..].chars().next().expect("valid UTF-8 cursor");
        output.push(character);
        cursor += character.len_utf8();
    }
    output
}

fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn is_cli_id_key(key: &str) -> bool {
    key == "id" || key.ends_with("Id")
}

fn is_cli_id_list_key(key: &str) -> bool {
    key.ends_with("Ids")
}

fn is_cli_reference_string_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    lower.ends_with("ref") || lower.ends_with("path")
}

fn singularize_id_list_key(key: &str) -> String {
    format!("{}Id", &key[..key.len() - 3])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Cursor;
    use std::net::{TcpListener, TcpStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn issue_budget_test_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "rudder-mcp-issue-budget-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).expect("create test state directory");
        path
    }

    fn invoke_stdio_tool(
        name: &str,
        arguments: Value,
        environment: &BTreeMap<String, String>,
    ) -> Value {
        let input = json!({
            "jsonrpc":"2.0",
            "id":1,
            "method":"tools/call",
            "params":{"name":name,"arguments":arguments}
        })
        .to_string()
            + "\n";
        let mut output = Vec::new();
        run(Cursor::new(input.as_bytes()), &mut output, environment).unwrap();
        serde_json::from_slice(output.strip_suffix(b"\n").unwrap()).unwrap()
    }

    fn read_http_request_head(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut byte = [0_u8; 1];
        while !bytes.ends_with(b"\r\n\r\n") {
            assert_eq!(stream.read(&mut byte).unwrap(), 1);
            bytes.push(byte[0]);
        }
        String::from_utf8(bytes).unwrap()
    }

    fn read_http_request(stream: &mut TcpStream) -> (String, String) {
        let head = read_http_request_head(stream);
        let content_length = head
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        let mut body = vec![0; content_length];
        stream.read_exact(&mut body).unwrap();
        (head, String::from_utf8(body).unwrap())
    }

    fn write_http_response(stream: &mut TcpStream, status: &str, body: &str) {
        write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
    }

    #[test]
    fn agent_skill_create_waits_for_create_before_enabling_selection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut create, _) = listener.accept().unwrap();
            let (head, body) = read_http_request(&mut create);
            assert!(head.starts_with("POST /api/agents/agent-7/skills/private HTTP/1.1\r\n"));
            assert!(
                head.to_ascii_lowercase()
                    .contains("x-rudder-agent-id: agent-7\r\n")
            );
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({
                    "name":"Release checklist",
                    "slug":null,
                    "description":null,
                    "markdown":"# Release"
                })
            );
            write_http_response(
                &mut create,
                "200 OK",
                r#"{"id":"skill-1","selectionKey":"agent:release-checklist","key":"release-checklist"}"#,
            );
            drop(create);

            let (mut enable, _) = listener.accept().unwrap();
            let (head, body) = read_http_request(&mut enable);
            assert!(head.starts_with("POST /api/agents/agent-7/skills/enable HTTP/1.1\r\n"));
            assert!(
                head.to_ascii_lowercase()
                    .contains("x-rudder-agent-id: agent-7\r\n")
            );
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"skills":["agent:release-checklist"]})
            );
            write_http_response(
                &mut enable,
                "200 OK",
                r#"{"desiredSkills":["agent:release-checklist"],"entries":[]}"#,
            );
        });
        let environment = BTreeMap::from([
            ("RUDDER_API_URL".to_owned(), format!("http://{address}")),
            ("RUDDER_API_KEY".to_owned(), "test-token".to_owned()),
            ("RUDDER_AGENT_ID".to_owned(), "agent-7".to_owned()),
        ]);
        let result = invoke_stdio_tool(
            "rudder_agent_skills_create",
            json!({
                "name":" Release checklist ",
                "markdown":"  # Release  ",
                "body":"ignored fallback",
                "enable":true
            }),
            &environment,
        );
        server.join().unwrap();
        assert_eq!(result["result"]["isError"], false);
        assert_eq!(
            result["result"]["structuredContent"]["created"]["selectionKey"],
            "agent:release-checklist"
        );
        assert_eq!(
            result["result"]["structuredContent"]["enabledSnapshot"]["desiredSkills"][0],
            "agent:release-checklist"
        );
    }

    #[test]
    fn library_put_creates_only_after_existing_file_patch_returns_404() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut patch, _) = listener.accept().unwrap();
            let (head, body) = read_http_request(&mut patch);
            assert!(head.starts_with(
                "PATCH /api/orgs/org-4/workspace/file?path=projects%2Fteam%2Fplan.md HTTP/1.1\r\n"
            ));
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"content":"# Plan"})
            );
            write_http_response(&mut patch, "404 Not Found", r#"{"error":"not found"}"#);
            drop(patch);

            let (mut create, _) = listener.accept().unwrap();
            let (head, body) = read_http_request(&mut create);
            assert!(head.starts_with("POST /api/orgs/org-4/workspace/file HTTP/1.1\r\n"));
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"filePath":"projects/team/plan.md","content":"# Plan"})
            );
            write_http_response(
                &mut create,
                "200 OK",
                r#"{"filePath":"projects/team/plan.md","libraryEntryId":"entry-1","mentionHref":"/library/entry-1","markdownLink":"[Plan](/library/entry-1)"}"#,
            );
        });
        let environment = BTreeMap::from([
            ("RUDDER_API_URL".to_owned(), format!("http://{address}")),
            ("RUDDER_API_KEY".to_owned(), "test-token".to_owned()),
            ("RUDDER_ORG_ID".to_owned(), "org-4".to_owned()),
        ]);
        let result = invoke_stdio_tool(
            "rudder_library_file_put",
            json!({"path":" projects/team/plan.md ","content":"# Plan"}),
            &environment,
        );
        server.join().unwrap();
        assert_eq!(result["result"]["isError"], false);
        assert_eq!(
            result["result"]["structuredContent"]["libraryEntryId"],
            "entry-1"
        );
    }

    #[test]
    fn skill_search_projects_filtered_rows_and_skill_file_defaults_path() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut search, _) = listener.accept().unwrap();
            let (head, _) = read_http_request(&mut search);
            assert!(head.starts_with("GET /api/orgs/org-4/skills HTTP/1.1\r\n"));
            write_http_response(
                &mut search,
                "200 OK",
                r#"[{"id":"skill-1","name":"Release guide","sourcePath":"/docs/release"},{"id":"skill-2","name":"Design notes"}]"#,
            );
            drop(search);

            let (mut file, _) = listener.accept().unwrap();
            let (head, _) = read_http_request(&mut file);
            assert!(head.starts_with(
                "GET /api/orgs/org-4/skills/skill-1/files?path=SKILL.md HTTP/1.1\r\n"
            ));
            write_http_response(
                &mut file,
                "200 OK",
                r##"{"skillId":"skill-1","path":"SKILL.md","content":"# Release"}"##,
            );
            drop(file);

            let (mut scan, _) = listener.accept().unwrap();
            let (head, body) = read_http_request(&mut scan);
            assert!(head.starts_with("POST /api/orgs/org-4/skills/scan-local HTTP/1.1\r\n"));
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"roots":["/tmp/a","/tmp/b"]})
            );
            write_http_response(&mut scan, "200 OK", r#"{"scannedRoots":2,"discovered":0}"#);
            drop(scan);

            let (mut import, _) = listener.accept().unwrap();
            let (head, body) = read_http_request(&mut import);
            assert!(head.starts_with("POST /api/orgs/org-4/skills/import HTTP/1.1\r\n"));
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"source":"https://example.test/skills/release"})
            );
            write_http_response(&mut import, "200 OK", r#"{"id":"skill-3"}"#);
        });
        let environment = BTreeMap::from([
            ("RUDDER_API_URL".to_owned(), format!("http://{address}")),
            ("RUDDER_API_KEY".to_owned(), "test-token".to_owned()),
            ("RUDDER_ORG_ID".to_owned(), "org-4".to_owned()),
        ]);
        let search = invoke_stdio_tool(
            "rudder_skill_search",
            json!({"query":" release "}),
            &environment,
        );
        let file = invoke_stdio_tool(
            "rudder_skill_file",
            json!({"skill":"skill-1"}),
            &environment,
        );
        let scan = invoke_stdio_tool(
            "rudder_skill_scan_local",
            json!({"roots":" /tmp/a, , /tmp/b "}),
            &environment,
        );
        let import = invoke_stdio_tool(
            "rudder_skill_import",
            json!({"source":" https://example.test/skills/release "}),
            &environment,
        );
        server.join().unwrap();
        assert_eq!(
            search["result"]["structuredContent"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(search["result"]["structuredContent"][0]["id"], "skill-1");
        assert_eq!(file["result"]["structuredContent"]["content"], "# Release");
        assert_eq!(scan["result"]["isError"], false);
        assert_eq!(import["result"]["isError"], false);
    }

    fn issue_budget_environment(
        address: std::net::SocketAddr,
        state_dir: &Path,
    ) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("RUDDER_API_URL".to_owned(), format!("http://{address}")),
            ("RUDDER_API_KEY".to_owned(), "test-token".to_owned()),
            ("RUDDER_ORG_ID".to_owned(), "org-4".to_owned()),
            ("RUDDER_RUN_ID".to_owned(), "run-9".to_owned()),
            (
                "RUDDER_RUNTIME_TMPDIR".to_owned(),
                state_dir.to_string_lossy().into_owned(),
            ),
        ])
    }

    #[test]
    fn oversized_non_success_budget_response_keeps_its_reservation_active() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_http_request_head(&mut stream);
            assert!(
                request.starts_with("GET /api/orgs/org-4/issues?projectId=project-1 HTTP/1.1\r\n")
            );
            write!(
                stream,
                "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: 1000001\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        let state_dir = issue_budget_test_dir("unreadable-failure-body");
        let environment = issue_budget_environment(address, &state_dir);

        let result = invoke_stdio_tool(
            "rudder_issue_list",
            json!({"projectId":"project-1"}),
            &environment,
        );
        assert_eq!(result["result"]["isError"], true);
        assert_eq!(
            result["result"]["structuredContent"]["code"],
            "response_too_large"
        );
        server.join().unwrap();

        let state_directory = state_dir.join("issue-transport-budget");
        let state_path = fs::read_dir(&state_directory)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .expect("the failed request leaves its budget state");
        let state: Value = serde_json::from_slice(&fs::read(state_path).unwrap()).unwrap();
        assert_eq!(state["phase"], "probe_in_flight");
        assert_eq!(state["activeReservations"].as_array().unwrap().len(), 1);
        fs::remove_dir_all(state_dir).unwrap();
    }

    #[test]
    fn issue_search_and_list_share_the_mcp_issue_transport_budget() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_http_request_head(&mut stream);
            assert!(request.starts_with(
                "GET /api/orgs/org-4/issues?projectId=project-1&q=release+blocker&searchFields=title%2Cdescription%2Ccomment HTTP/1.1\r\n"
            ));
            write_http_response(
                &mut stream,
                "503 Service Unavailable",
                r#"{"error":"Issue service unavailable","code":"issue_backend_unavailable","details":{"retryable":true}}"#,
            );
        });
        let state_dir = issue_budget_test_dir("issue-collection");
        let environment = issue_budget_environment(address, &state_dir);

        let search = invoke_stdio_tool(
            "rudder_issue_search",
            json!({"query":"release blocker","projectId":"project-1"}),
            &environment,
        );
        assert_eq!(search["result"]["isError"], true);
        assert_eq!(
            search["result"]["structuredContent"]["details"]["details"]["issueTransport"]["operation"],
            "issue.search"
        );
        assert_eq!(
            search["result"]["structuredContent"]["details"]["details"]["issueTransport"]["state"],
            "fallback_available"
        );

        let list = invoke_stdio_tool(
            "rudder_issue_list",
            json!({"projectId":"project-1"}),
            &environment,
        );
        assert_eq!(list["result"]["isError"], true);
        assert_eq!(
            list["result"]["structuredContent"]["code"],
            "issue_transport_unavailable"
        );
        assert_eq!(
            list["result"]["structuredContent"]["details"]["details"]["issueTransport"]["state"],
            "fallback_available"
        );

        server.join().unwrap();
        fs::remove_dir_all(state_dir).unwrap();
    }

    #[test]
    fn runs_by_skill_and_runs_list_share_the_mcp_run_transport_budget() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_http_request_head(&mut stream);
            assert!(request.starts_with(
                "GET /api/run-intelligence/orgs/org-4/runs?projection=summary&loadedSkill=rust%2Fcli&issueId=issue-1&limit=50 HTTP/1.1\r\n"
            ));
            write_http_response(
                &mut stream,
                "503 Service Unavailable",
                r#"{"error":"Run service unavailable","code":"run_backend_unavailable"}"#,
            );
        });
        let state_dir = issue_budget_test_dir("runs-by-skill");
        let environment = issue_budget_environment(address, &state_dir);

        let by_skill = invoke_stdio_tool(
            "rudder_runs_by_skill",
            json!({"skill":"rust/cli","evidence":"loaded","issueId":"issue-1"}),
            &environment,
        );
        assert_eq!(by_skill["result"]["isError"], true);
        assert_eq!(
            by_skill["result"]["structuredContent"]["details"]["details"]["issueTransport"]["operation"],
            "runs.list"
        );
        assert_eq!(
            by_skill["result"]["structuredContent"]["details"]["details"]["issueTransport"]["state"],
            "fallback_available"
        );

        let list = invoke_stdio_tool(
            "rudder_runs_list",
            json!({"issueId":"issue-1"}),
            &environment,
        );
        assert_eq!(list["result"]["isError"], true);
        assert_eq!(
            list["result"]["structuredContent"]["code"],
            "issue_transport_unavailable"
        );
        assert_eq!(
            list["result"]["structuredContent"]["details"]["details"]["issueTransport"]["state"],
            "fallback_available"
        );

        server.join().unwrap();
        fs::remove_dir_all(state_dir).unwrap();
    }

    #[test]
    fn manifest_contains_only_explicitly_supported_direct_http_and_local_tools() {
        let tools = tool_manifest();
        assert_eq!(
            tools.len(),
            SUPPORTED_CAPABILITY_IDS.len()
                + CLI_FALLBACK_MCP_CAPABILITY_IDS.len()
                + SUPPORTED_LOCAL_CAPABILITY_IDS.len()
        );
        assert!(tools.iter().all(|tool| tool["name"].as_str().is_some()));
        let serialized = serde_json::to_string(&tools).unwrap();
        assert!(!serialized.contains("rudder_browser_"));
        assert!(!serialized.contains("rudder_computer_"));
        assert!(serialized.contains("rudder_library_file_list"));
        assert!(serialized.contains("rudder_library_file_get"));
        assert!(serialized.contains("rudder_library_file_put"));
        assert!(serialized.contains("rudder_skill_list"));
        assert!(serialized.contains("rudder_skill_import"));
        assert!(!serialized.contains("rudder_issue_labels_list"));
        assert!(!serialized.contains("rudder_skill_create"));
        assert!(serialized.contains("rudder_agent_update"));
        assert!(serialized.contains("rudder_automation_triggers_delete"));
        assert!(serialized.contains("rudder_chat_read"));
        assert!(serialized.contains("rudder_issue_get"));
        assert!(serialized.contains("rudder_issue_comment"));
        assert!(serialized.contains("rudder_issue_search"));
        assert!(serialized.contains("rudder_issue_review"));
        assert!(serialized.contains("rudder_issue_commit"));
        assert!(serialized.contains("rudder_issue_block"));
        assert!(serialized.contains("rudder_runs_list"));
        assert!(serialized.contains("rudder_agent_skills_create"));
    }

    #[test]
    fn agent_capabilities_is_a_local_manifest_tool() {
        let result = call_tool(
            &json!({"name":"rudder_agent_capabilities","arguments":{}}),
            &BTreeMap::new(),
        );
        assert_eq!(result["isError"], false);
        let manifest = &result["structuredContent"];
        assert_eq!(manifest["schema"], "rudder.agent-capabilities/v1");
        assert_eq!(manifest["contract"], "agent-v1");
        assert_eq!(manifest["defaults"]["orgIdEnvVar"], "RUDDER_ORG_ID");
        assert!(
            manifest["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["id"] == "agent.update")
        );
        assert!(
            manifest["mcp"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["name"] == "rudder_agent_update")
        );
        assert!(!manifest.to_string().contains("rudder_browser_"));
    }

    #[test]
    fn cli_fallback_output_projection_preserves_existing_cli_shapes() {
        let automation = project_cli_fallback_output(
            "automation.triggers.list",
            &json!({}),
            vec![json!({"id":"a","triggers":[{"id":"t"}]})],
        );
        assert_eq!(automation, json!([{"id":"t"}]));

        let deleted = project_cli_fallback_output(
            "automation.triggers.delete",
            &json!({"triggerId":"trigger-one"}),
            vec![json!({})],
        );
        assert_eq!(deleted, json!({"id":"trigger-one","deleted":true}));

        let plugins = project_cli_fallback_output(
            "plugin.search",
            &json!({"query":"calendar"}),
            vec![json!({
                "installed":[{"id":"calendar-plugin","name":"Calendar"},{"id":"notes","name":"Notes"}],
                "localApps":[{"id":"desktop-calendar","name":"Calendar app"}],
                "discover":[{"packageId":"calendar-source","description":"Calendar bridge"}]
            })],
        );
        assert_eq!(plugins["installed"].as_array().unwrap().len(), 1);
        assert_eq!(plugins["localApps"].as_array().unwrap().len(), 1);
        assert_eq!(plugins["discover"].as_array().unwrap().len(), 1);

        let chats = project_cli_fallback_output(
            "chat.search",
            &json!({"query":"launch","scope":"summary","limit":1}),
            vec![json!([
                {"id":"chat-1","summary":"Launch plan"},
                {"id":"chat-2","summary":"Other"},
                {"id":"chat-3","summary":"Launch review"}
            ])],
        );
        assert_eq!(chats, json!([{"id":"chat-1","summary":"Launch plan"}]));

        let library_ref = project_cli_fallback_output(
            "library.file.ref",
            &json!({}),
            vec![json!({
                "filePath":"projects/plan.md",
                "libraryEntryId":"entry-1",
                "mentionHref":"/library/entry-1",
                "markdownLink":"[Plan](/library/entry-1)",
                "content":"must not be included"
            })],
        );
        assert_eq!(
            library_ref,
            json!({
                "filePath":"projects/plan.md",
                "libraryEntryId":"entry-1",
                "mentionHref":"/library/entry-1",
                "markdownLink":"[Plan](/library/entry-1)"
            })
        );

        let searched_skills = project_cli_fallback_output(
            "skill.search",
            &json!({"query":" release "}),
            vec![json!([
                {"id":"skill-1","name":"Release guide"},
                {"id":"skill-2","name":"Design notes"}
            ])],
        );
        assert_eq!(
            searched_skills,
            json!([{"id":"skill-1","name":"Release guide"}])
        );

        let report = run_by_skill_report(
            json!({
                "items":[
                    {"id":"run-1","status":"failed","agentId":"agent-1","agentName":"Agent","issue":{"id":"issue-1","identifier":"RUD-1","title":"Bug"},"error":"  timeout "},
                    {"id":"run-2","status":"succeeded","agentId":"agent-1","agentName":"Agent","issue":{"id":"issue-1","identifier":"RUD-1","title":"Bug"}}
                ],
                "page":{"nextCursor":"next"}
            }),
            &json!({"skill":"docs","evidence":"loaded"}),
        );
        assert_eq!(report["summary"]["total"], 2);
        assert_eq!(report["summary"]["failed"], 1);
        assert_eq!(report["summary"]["agents"][0]["count"], 2);
        assert_eq!(report["summary"]["issues"][0]["count"], 2);
        assert_eq!(report["summary"]["commonErrors"][0]["summary"], "timeout");
        assert_eq!(report["page"]["nextCursor"], "next");
        assert_eq!(report["nextCommands"][0], "rudder runs errors run-1");
    }

    #[test]
    fn mcp_direct_call_uses_managed_http_and_canonical_short_id_projection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut byte = [0_u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                assert_eq!(stream.read(&mut byte).unwrap(), 1);
                request.push(byte[0]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("GET /api/agents/me HTTP/1.1\r\n"));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer test-token\r\n")
            );
            let body = r#"{"id":"123e4567-e89b-12d3-a456-426614174000","shortRef":"agt_123e4567","name":"Agent"}"#;
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        });
        let env = BTreeMap::from([
            ("RUDDER_API_URL".to_owned(), format!("http://{address}")),
            ("RUDDER_API_KEY".to_owned(), "test-token".to_owned()),
        ]);
        let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"rudder_agent_me\",\"arguments\":{}}}\n";
        let mut output = Vec::new();
        run(Cursor::new(input.as_bytes()), &mut output, &env).unwrap();
        server.join().unwrap();
        let response: Value = serde_json::from_slice(output.strip_suffix(b"\n").unwrap()).unwrap();
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(
            response["result"]["structuredContent"]["id"],
            "agt_123e4567"
        );
    }

    #[test]
    fn stdio_goal_tool_call_forwards_auth_context_and_planned_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut byte = [0_u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                assert_eq!(stream.read(&mut byte).unwrap(), 1);
                request.push(byte[0]);
            }
            let header_end = request.len();
            let headers = String::from_utf8(request.clone()).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .expect("request body length");
            while request.len() < header_end + content_length {
                let remaining = header_end + content_length - request.len();
                let mut buffer = vec![0_u8; remaining.min(1024)];
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0, "HTTP request body ended early");
                request.extend_from_slice(&buffer[..read]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("POST /api/goals/goal-1/change-proposals HTTP/1.1\r\n"));
            let lower = request.to_ascii_lowercase();
            assert!(lower.contains("authorization: bearer test-token\r\n"));
            assert!(lower.contains("x-rudder-agent-id: agent-7\r\n"));
            assert!(lower.contains("x-rudder-run-id: run-9\r\n"));
            let body = &request[header_end..];
            let body: Value = serde_json::from_str(body).unwrap();
            assert_eq!(body["expectedContractRevision"], 4);
            assert_eq!(body["afterContract"]["outcomeStatement"], "Updated outcome");
            assert_eq!(body["rationale"], "Evidence changed.");
            assert_eq!(body["idempotencyKey"], "proposal-1");

            let response_body =
                r#"{"id":"123e4567-e89b-12d3-a456-426614174000","shortRef":"gcp_123e4567"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            )
            .unwrap();
        });
        let environment = BTreeMap::from([
            ("RUDDER_API_URL".to_owned(), format!("http://{address}")),
            ("RUDDER_API_KEY".to_owned(), "test-token".to_owned()),
            ("RUDDER_AGENT_ID".to_owned(), "agent-7".to_owned()),
            ("RUDDER_RUN_ID".to_owned(), "run-9".to_owned()),
        ]);
        let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"rudder_goal_change_propose\",\"arguments\":{\"goal\":\"goal-1\",\"contractRevision\":4,\"afterContract\":{\"outcomeStatement\":\"Updated outcome\"},\"rationale\":\" Evidence changed. \",\"idempotencyKey\":\"proposal-1\"}}}\n";
        let mut output = Vec::new();
        run(Cursor::new(input.as_bytes()), &mut output, &environment).unwrap();
        server.join().unwrap();
        let response: Value = serde_json::from_slice(output.strip_suffix(b"\n").unwrap()).unwrap();
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(
            response["result"]["structuredContent"]["id"],
            "gcp_123e4567"
        );
    }

    #[test]
    fn stdio_agent_update_uses_http_transport_with_managed_identity_and_aliases() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut byte = [0_u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                assert_eq!(stream.read(&mut byte).unwrap(), 1);
                request.push(byte[0]);
            }
            let header_end = request.len();
            let headers = String::from_utf8(request.clone()).unwrap();
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .expect("request body length");
            while request.len() < header_end + content_length {
                let remaining = header_end + content_length - request.len();
                let mut buffer = vec![0_u8; remaining.min(1024)];
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0, "HTTP request body ended early");
                request.extend_from_slice(&buffer[..read]);
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("PATCH /api/agents/agent-7?orgId=org-4 HTTP/1.1\r\n"));
            let lower = request.to_ascii_lowercase();
            assert!(lower.contains("authorization: bearer test-token\r\n"));
            assert!(lower.contains("x-rudder-agent-id: agent-7\r\n"));
            assert!(lower.contains("x-rudder-run-id: run-9\r\n"));
            let body: Value = serde_json::from_str(&request[header_end..]).unwrap();
            assert_eq!(body, json!({"title":null,"capabilities":"Ready"}));

            let response_body = r#"{"id":"123e4567-e89b-12d3-a456-426614174000","shortRef":"agt_123e4567","name":"Agent"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            )
            .unwrap();
        });
        let environment = BTreeMap::from([
            ("RUDDER_API_URL".to_owned(), format!("http://{address}")),
            ("RUDDER_API_KEY".to_owned(), "test-token".to_owned()),
            ("RUDDER_ORG_ID".to_owned(), "org-4".to_owned()),
            ("RUDDER_AGENT_ID".to_owned(), "agent-7".to_owned()),
            ("RUDDER_RUN_ID".to_owned(), "run-9".to_owned()),
        ]);
        let input = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"rudder_agent_update\",\"arguments\":{\"description\":\" Ready \",\"clearTitle\":true}}}\n";
        let mut output = Vec::new();
        run(Cursor::new(input.as_bytes()), &mut output, &environment).unwrap();
        server.join().unwrap();
        let response: Value = serde_json::from_slice(output.strip_suffix(b"\n").unwrap()).unwrap();
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(
            response["result"]["structuredContent"]["id"],
            "agt_123e4567"
        );
    }

    #[test]
    fn protocol_handles_initialize_and_rejects_unadvertised_tools() {
        let env = BTreeMap::new();
        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\"}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"rudder_issue_labels_list\",\"arguments\":{}}}\n"
        );
        let mut output = Vec::new();
        run(Cursor::new(input.as_bytes()), &mut output, &env).unwrap();
        let lines = String::from_utf8(output).unwrap();
        let mut responses = lines
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap());
        let initialized = responses.next().unwrap();
        assert_eq!(initialized["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(initialized["result"]["serverInfo"]["name"], "rudder-tools");
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["rudder"]["contractVersion"],
            RUDDER_MCP_CONTRACT_VERSION
        );
        assert_eq!(
            initialized["result"]["capabilities"]["experimental"]["rudder"]["coreContractHash"],
            CORE_MCP_CONTRACT_HASH
        );
        let rejected = responses.next().unwrap();
        assert_eq!(rejected["result"]["isError"], true);
        assert_eq!(
            rejected["result"]["structuredContent"]["code"],
            "rudder_mcp_tool_not_available"
        );
    }

    #[test]
    fn id_projection_matches_cli_typed_refs_and_reference_shortening() {
        let value = json!({
            "id":"123e4567-e89b-12d3-a456-426614174000",
            "agentId":"123e4567-e89b-12d3-a456-426614174001",
            "path":"see /goals/123e4567-e89b-12d3-a456-426614174002",
            "type":"goal"
        });
        let projected = shorten_cli_output(value);
        assert_eq!(projected["id"], "gol_123e4567");
        assert_eq!(projected["agentId"], "agt_123e4567");
        assert_eq!(projected["path"], "see /goals/123e4567e89b");

        let generic = shorten_cli_output(json!({
            "id":"123e4567-e89b-12d3-a456-426614174000",
            "triggerId":"123e4567-e89b-12d3-a456-426614174001",
        }));
        assert_eq!(generic["id"], "123e4567e89b");
        assert_eq!(generic["triggerId"], "123e4567e89b");
    }
}
