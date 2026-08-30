use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env,
    io::{self, Read, Write},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};
use thiserror::Error;

pub const MCP_MODERN_PROTOCOL_VERSION: &str = "2026-07-28";
pub const MCP_DEFAULT_PROTOCOL_VERSION: &str = "2025-11-25";
pub const MCP_LEGACY_PROTOCOL_VERSIONS: [&str; 5] = [
    MCP_DEFAULT_PROTOCOL_VERSION,
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];
pub const MAX_REQUEST_BYTES: usize = 1_000_000;
pub const MAX_CORE_RESULT_BYTES: usize = 1_000_000;
pub const MAX_BROWSER_RESULT_BYTES: usize = 16_000_000;
const MAX_HEADER_BYTES: usize = 8_192;
const MCP_TOOL_PAGE_SIZE: usize = 50;
const MCP_PROTOCOL_VERSION_META_KEY: &str = "io.modelcontextprotocol/protocolVersion";
const MCP_CLIENT_CAPABILITIES_META_KEY: &str = "io.modelcontextprotocol/clientCapabilities";
const MCP_SERVER_INFO_META_KEY: &str = "io.modelcontextprotocol/serverInfo";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Core,
    Browser,
}

impl Surface {
    pub fn server_name(self) -> &'static str {
        match self {
            Self::Core => "rudder-tools",
            Self::Browser => "rudder-browser",
        }
    }

    fn compatibility_arg(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Browser => "browser",
        }
    }

    fn accepts_category(self, category: &str) -> bool {
        match self {
            Self::Core => category != "browser",
            Self::Browser => category == "browser",
        }
    }

    fn result_budget(self) -> usize {
        match self {
            Self::Core => MAX_CORE_RESULT_BYTES,
            Self::Browser => MAX_BROWSER_RESULT_BYTES,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RuntimeContext {
    pub api_url: Option<String>,
    pub api_key: Option<String>,
    pub org_id: Option<String>,
    pub agent_id: Option<String>,
    pub run_id: Option<String>,
    pub browser_enabled: bool,
}

impl RuntimeContext {
    pub fn from_env() -> Self {
        Self {
            api_url: nonempty_env("RUDDER_API_URL"),
            api_key: nonempty_env("RUDDER_API_KEY"),
            org_id: nonempty_env("RUDDER_ORG_ID"),
            agent_id: nonempty_env("RUDDER_AGENT_ID"),
            run_id: nonempty_env("RUDDER_RUN_ID"),
            browser_enabled: nonempty_env("RUDDER_BROWSER_ENABLED")
                .is_some_and(|value| value.eq_ignore_ascii_case("true")),
        }
    }
}

fn nonempty_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

#[derive(Clone, Debug, Serialize)]
pub struct JsonRpcRequest {
    #[serde(default)]
    pub jsonrpc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<Value>,
    #[serde(skip)]
    id_present: bool,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Option<Value>,
}

impl<'de> Deserialize<'de> for JsonRpcRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Fields {
            #[serde(default)]
            jsonrpc: Option<String>,
            #[serde(default)]
            method: Option<String>,
            #[serde(default)]
            params: Option<Value>,
        }

        let mut value = Value::deserialize(deserializer)?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| de::Error::custom("JSON-RPC request must be an object"))?;
        let id_present = object.contains_key("id");
        let id = object.remove("id");
        let fields: Fields = serde_json::from_value(value).map_err(de::Error::custom)?;
        Ok(Self {
            jsonrpc: fields.jsonrpc,
            id,
            id_present,
            method: fields.method,
            params: fields.params,
        })
    }
}

pub trait ToolDispatcher {
    fn dispatch(&mut self, request: &JsonRpcRequest) -> Result<Value, FoundationError>;

    fn begin_request(&mut self, _request_id: &Value) {}

    fn finish_request(&mut self, _request_id: &Value) {}

    fn cancel(&mut self, _request_id: &Value) -> Result<(), FoundationError> {
        Ok(())
    }
}

#[derive(Clone)]
pub struct NodeCompatibilityDispatcher {
    binary: Option<String>,
    surface: Surface,
    active: Arc<Mutex<HashMap<String, u32>>>,
    pending: Arc<Mutex<HashSet<String>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
}

impl NodeCompatibilityDispatcher {
    pub fn from_env(surface: Surface) -> Self {
        Self {
            binary: nonempty_env("RUDDER_NODE_CLI_BIN"),
            surface,
            active: Arc::new(Mutex::new(HashMap::new())),
            pending: Arc::new(Mutex::new(HashSet::new())),
            cancelled: Arc::new(Mutex::new(HashSet::new())),
        }
    }
}

impl ToolDispatcher for NodeCompatibilityDispatcher {
    fn dispatch(&mut self, request: &JsonRpcRequest) -> Result<Value, FoundationError> {
        let request_key = request_id_key(request.id.as_ref().unwrap_or(&Value::Null));
        if self.cancelled.lock().unwrap().contains(&request_key) {
            return Err(FoundationError::Cancelled);
        }
        let binary = self
            .binary
            .as_deref()
            .ok_or(FoundationError::NodeCompatibilityNotConfigured)?;
        let mut child = Command::new(binary)
            .args(["mcp-server", "--server", self.surface.compatibility_arg()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| FoundationError::NodeCompatibility(error.to_string()))?;
        let child_id = child.id();
        self.active
            .lock()
            .unwrap()
            .insert(request_key.clone(), child_id);
        if self.cancelled.lock().unwrap().contains(&request_key) {
            terminate_process(child_id);
        }
        {
            let stdin = child.stdin.as_mut().ok_or_else(|| {
                FoundationError::NodeCompatibility("child stdin unavailable".to_owned())
            })?;
            serde_json::to_writer(&mut *stdin, request)?;
            stdin.write_all(b"\n")?;
        }
        drop(child.stdin.take());
        let output = child
            .wait_with_output()
            .map_err(|error| FoundationError::NodeCompatibility(error.to_string()))?;
        self.active.lock().unwrap().remove(&request_key);
        if self.cancelled.lock().unwrap().remove(&request_key) {
            return Err(FoundationError::Cancelled);
        }
        if !output.status.success() {
            return Err(FoundationError::NodeCompatibility(
                String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            ));
        }
        let line = String::from_utf8_lossy(&output.stdout);
        let response: Value = serde_json::from_str(
            line.lines()
                .find(|line| !line.trim().is_empty())
                .ok_or_else(|| {
                    FoundationError::NodeCompatibility("child returned no response".to_owned())
                })?,
        )?;
        response
            .get("result")
            .cloned()
            .or_else(|| {
                response
                    .get("error")
                    .cloned()
                    .map(|error| json!({ "isError": true, "error": error }))
            })
            .ok_or_else(|| {
                FoundationError::NodeCompatibility(
                    "child returned an invalid JSON-RPC response".to_owned(),
                )
            })
    }

    fn begin_request(&mut self, request_id: &Value) {
        self.pending
            .lock()
            .unwrap()
            .insert(request_id_key(request_id));
    }

    fn finish_request(&mut self, request_id: &Value) {
        let request_key = request_id_key(request_id);
        self.pending.lock().unwrap().remove(&request_key);
        self.active.lock().unwrap().remove(&request_key);
        self.cancelled.lock().unwrap().remove(&request_key);
    }

    fn cancel(&mut self, request_id: &Value) -> Result<(), FoundationError> {
        let request_key = request_id_key(request_id);
        if !self.pending.lock().unwrap().contains(&request_key)
            && !self.active.lock().unwrap().contains_key(&request_key)
        {
            return Ok(());
        }
        self.cancelled.lock().unwrap().insert(request_key.clone());
        if let Some(process_id) = self.active.lock().unwrap().get(&request_key).copied() {
            terminate_process(process_id);
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum FoundationError {
    #[error("invalid JSON-RPC request: {0}")]
    InvalidRequest(&'static str),
    #[error("unsupported MCP protocol version: {0}")]
    UnsupportedProtocol(String),
    #[error("Rudder MCP tool is not available: {0}")]
    ToolNotAvailable(String),
    #[error(
        "Rudder MCP runtime identity is managed by the server; do not pass these arguments: {0}"
    )]
    ReservedIdentity(String),
    #[error("Rudder MCP runtime context is incomplete. Missing {0}.")]
    MissingRuntimeContext(String),
    #[error("invalid arguments for {tool}: {reason}")]
    InvalidArguments { tool: String, reason: String },
    #[error("Node compatibility adapter is not configured; set RUDDER_NODE_CLI_BIN")]
    NodeCompatibilityNotConfigured,
    #[error("Node compatibility adapter failed: {0}")]
    NodeCompatibility(String),
    #[error("Rudder MCP request was cancelled")]
    Cancelled,
    #[error("Rudder Browser is disabled or unavailable for this run")]
    BrowserDisabled,
    #[error("MCP message exceeds the bounded byte limit")]
    MessageLimit,
    #[error("incomplete MCP message at end of input")]
    IncompleteMessage,
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl FoundationError {
    fn code(&self) -> &'static str {
        match self {
            Self::ReservedIdentity(_) => "rudder_mcp_reserved_identity_argument",
            Self::MissingRuntimeContext(_) => "rudder_mcp_missing_runtime_context",
            Self::ToolNotAvailable(_) => "rudder_mcp_tool_not_available",
            Self::InvalidArguments { .. } | Self::InvalidRequest(_) => {
                "rudder_mcp_invalid_arguments"
            }
            Self::UnsupportedProtocol(_) => "rudder_mcp_unsupported_protocol_version",
            Self::NodeCompatibilityNotConfigured => "rudder_mcp_node_compatibility_not_configured",
            Self::NodeCompatibility(_) => "rudder_mcp_node_compatibility_failed",
            Self::Cancelled => "rudder_mcp_cancelled",
            Self::BrowserDisabled => "browser_disabled",
            Self::MessageLimit => "rudder_mcp_message_limit",
            Self::IncompleteMessage | Self::Io(_) | Self::Json(_) => "rudder_mcp_protocol_error",
        }
    }
}

fn request_id_key(request_id: &Value) -> String {
    serde_json::to_string(request_id).unwrap_or_else(|_| "null".to_owned())
}

#[cfg(unix)]
fn terminate_process(process_id: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &process_id.to_string()])
        .status();
}

#[cfg(windows)]
fn terminate_process(process_id: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .status();
}

#[cfg(not(any(unix, windows)))]
fn terminate_process(_process_id: u32) {}

pub fn binary_identity(binary: &str) -> Value {
    json!({
        "schema": "rudder.native.agent-tools.identity.v1",
        "binary": binary,
        "binaryVersion": env!("CARGO_PKG_VERSION"),
        "contractVersion": rudder_agent_contract_core::contract()["contractVersion"],
        "manifestHash": rudder_agent_contract_core::artifact_hash(),
        "target": target_triple(),
        "productAuthority": "node",
        "compatibilityBoundary": "RUDDER_NODE_CLI_BIN",
    })
}

pub fn capabilities_manifest() -> Value {
    let manifest_capabilities = agent_capabilities()
        .into_iter()
        .map(|entry| {
            let mut cli = entry["cli"].as_object().cloned().unwrap_or_default();
            cli.insert("agentV1".to_owned(), Value::Bool(true));
            Value::Object(cli)
        })
        .collect::<Vec<_>>();
    let mcp_tools = capabilities(Surface::Core)
        .into_iter()
        .map(|entry| {
            let mut tool = entry["cli"].as_object().cloned().unwrap_or_default();
            tool.insert("agentV1".to_owned(), Value::Bool(true));
            tool.insert(
                "capabilityId".to_owned(),
                entry["mcp"]["capabilityId"].clone(),
            );
            tool.insert("name".to_owned(), entry["mcp"]["name"].clone());
            tool.insert(
                "inputSchema".to_owned(),
                entry["mcp"]["inputSchema"].clone(),
            );
            tool.insert(
                "semanticDescription".to_owned(),
                entry["mcp"]["description"].clone(),
            );
            tool.insert(
                "annotations".to_owned(),
                entry["mcp"]["annotations"].clone(),
            );
            tool.insert("outputMode".to_owned(), Value::String("json".to_owned()));
            Value::Object(tool)
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
        "capabilities": manifest_capabilities,
        "mcp": {
            "schema": "rudder.agent-mcp-tools/v1",
            "contract": "agent-v1",
            "serverName": "rudder-tools",
            "tools": mcp_tools,
        },
    })
}

pub fn tools_manifest(surface: Surface) -> Vec<Value> {
    capabilities(surface)
        .into_iter()
        .filter_map(|entry| entry.get("mcp").cloned())
        .map(|mcp| {
            json!({
                "name": mcp["name"],
                "description": mcp["description"],
                "inputSchema": mcp["inputSchema"],
                "annotations": mcp["annotations"],
            })
        })
        .collect()
}

fn capabilities(surface: Surface) -> Vec<Value> {
    agent_capabilities()
        .into_iter()
        .filter(|entry| {
            entry["cli"]["category"]
                .as_str()
                .is_some_and(|category| surface.accepts_category(category))
        })
        .collect()
}

fn agent_capabilities() -> Vec<Value> {
    rudder_agent_contract_core::contract()["capabilities"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["cli"]["contract"] == "agent-v1")
        .cloned()
        .collect()
}

fn protocol_version_from_params(params: Option<&Value>) -> Option<&str> {
    let params = params?.as_object()?;
    let modern = params
        .get("_meta")
        .and_then(Value::as_object)
        .and_then(|meta| meta.get(MCP_PROTOCOL_VERSION_META_KEY))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    modern.or_else(|| {
        params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn has_conflicting_protocol_versions(params: Option<&Value>) -> bool {
    let Some(params) = params.and_then(Value::as_object) else {
        return false;
    };
    let modern = params
        .get("_meta")
        .and_then(Value::as_object)
        .and_then(|meta| meta.get(MCP_PROTOCOL_VERSION_META_KEY))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let legacy = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    matches!((modern, legacy), (Some(left), Some(right)) if left != right)
}

fn has_modern_envelope(params: Option<&Value>) -> bool {
    let Some(meta) = params
        .and_then(Value::as_object)
        .and_then(|params| params.get("_meta"))
        .and_then(Value::as_object)
    else {
        return false;
    };
    meta.get(MCP_PROTOCOL_VERSION_META_KEY)
        .and_then(Value::as_str)
        == Some(MCP_MODERN_PROTOCOL_VERSION)
        && meta
            .get(MCP_CLIENT_CAPABILITIES_META_KEY)
            .is_some_and(Value::is_object)
}

fn is_modern_request(params: Option<&Value>) -> bool {
    protocol_version_from_params(params) == Some(MCP_MODERN_PROTOCOL_VERSION)
        && has_modern_envelope(params)
}

fn server_info(surface: Surface) -> Value {
    json!({ "name": surface.server_name(), "version": env!("CARGO_PKG_VERSION") })
}

fn modern_result(
    mut result: serde_json::Map<String, Value>,
    surface: Surface,
    cacheable: bool,
) -> Value {
    result.insert("resultType".to_owned(), json!("complete"));
    if cacheable {
        result.insert("ttlMs".to_owned(), json!(300_000));
        result.insert("cacheScope".to_owned(), json!("public"));
    }
    let meta = result
        .entry("_meta".to_owned())
        .or_insert_with(|| json!({}));
    if let Some(meta) = meta.as_object_mut() {
        meta.entry(MCP_SERVER_INFO_META_KEY.to_owned())
            .or_insert_with(|| server_info(surface));
    }
    Value::Object(result)
}

fn contract_hash(surface: Surface) -> String {
    let contracts = tools_manifest(surface)
        .into_iter()
        .map(|tool| {
            json!({
                "name": tool["name"],
                "description": tool["description"],
                "inputSchema": tool["inputSchema"],
            })
        })
        .collect::<Vec<_>>();
    let stable = stable_json(&Value::Array(contracts));
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&stable).expect("contract JSON"))
    )
}

fn stable_json(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(stable_json).collect()),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), stable_json(value)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn encode_tool_cursor(offset: usize) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({ "offset": offset })).unwrap())
}

fn parse_tool_cursor(cursor: &str) -> Option<usize> {
    let decoded = URL_SAFE_NO_PAD.decode(cursor).ok()?;
    serde_json::from_slice::<Value>(&decoded).ok()?["offset"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
}

fn paginated_tools(
    surface: Surface,
    context: &RuntimeContext,
    params: Option<&Value>,
) -> Result<Value, FoundationError> {
    let tools = if surface == Surface::Browser && !context.browser_enabled {
        Vec::new()
    } else {
        tools_manifest(surface)
    };
    if !is_modern_request(params) {
        return Ok(json!({ "tools": tools }));
    }
    let cursor = params
        .and_then(Value::as_object)
        .and_then(|params| params.get("cursor"))
        .and_then(Value::as_str);
    let offset = match cursor {
        Some(cursor) => parse_tool_cursor(cursor)
            .ok_or(FoundationError::InvalidRequest("Invalid tools/list cursor"))?,
        None => 0,
    };
    let page = tools
        .iter()
        .skip(offset)
        .take(MCP_TOOL_PAGE_SIZE)
        .cloned()
        .collect::<Vec<_>>();
    let next_offset = offset + page.len();
    let mut result = serde_json::Map::from_iter([("tools".to_owned(), Value::Array(page))]);
    if next_offset < tools.len() {
        result.insert(
            "nextCursor".to_owned(),
            json!(encode_tool_cursor(next_offset)),
        );
    }
    Ok(Value::Object(result))
}

pub fn handle_message(
    request: &JsonRpcRequest,
    surface: Surface,
    context: &RuntimeContext,
    dispatcher: &mut impl ToolDispatcher,
) -> Option<Value> {
    let id = request.id.clone().unwrap_or(Value::Null);
    let notification = !request.id_present;
    if has_conflicting_protocol_versions(request.params.as_ref()) {
        return Some(rpc_error(
            id,
            -32602,
            "Conflicting MCP protocol versions",
            None,
        ));
    }
    let requested_protocol = protocol_version_from_params(request.params.as_ref());
    if requested_protocol == Some(MCP_MODERN_PROTOCOL_VERSION)
        && request.method.as_deref() != Some("server/discover")
        && !has_modern_envelope(request.params.as_ref())
    {
        return Some(rpc_error(
            id,
            -32602,
            "Invalid _meta envelope for protocol revision 2026-07-28",
            Some(
                json!({ "required": [MCP_PROTOCOL_VERSION_META_KEY, MCP_CLIENT_CAPABILITIES_META_KEY] }),
            ),
        ));
    }
    let result = match request.method.as_deref() {
        Some("notifications/initialized") => {
            if notification {
                return None;
            }
            Ok(json!({}))
        }
        Some("notifications/cancelled") => {
            let request_id = request
                .params
                .as_ref()
                .and_then(|params| params.get("requestId"))
                .unwrap_or(&Value::Null);
            let _ = dispatcher.cancel(request_id);
            return None;
        }
        Some("initialize") => {
            let requested = request
                .params
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|params| params.get("protocolVersion"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(MCP_DEFAULT_PROTOCOL_VERSION);
            if !MCP_LEGACY_PROTOCOL_VERSIONS.contains(&requested) {
                Err(FoundationError::UnsupportedProtocol(requested.to_owned()))
            } else {
                Ok(json!({
                    "protocolVersion": requested,
                    "capabilities": { "tools": {}, "experimental": { "rudder": {
                        "contractVersion": "rudder.agent-mcp-tools/v1",
                        "coreContractHash": contract_hash(Surface::Core),
                        "browserContractHash": contract_hash(Surface::Browser),
                    }}},
                    "serverInfo": server_info(surface),
                }))
            }
        }
        Some("server/discover") => {
            if requested_protocol.is_some_and(|version| version != MCP_MODERN_PROTOCOL_VERSION) {
                Err(FoundationError::UnsupportedProtocol(
                    requested_protocol.unwrap_or_default().to_owned(),
                ))
            } else if !has_modern_envelope(request.params.as_ref()) {
                Err(FoundationError::InvalidRequest(
                    "Invalid _meta envelope for protocol revision 2026-07-28",
                ))
            } else {
                Ok(modern_result(
                    serde_json::Map::from_iter([
                        (
                            "supportedVersions".to_owned(),
                            json!([MCP_MODERN_PROTOCOL_VERSION]),
                        ),
                        (
                            "capabilities".to_owned(),
                            json!({
                                "tools": { "listChanged": false },
                                "experimental": { "rudder": {
                                    "contractVersion": "rudder.agent-mcp-tools/v1",
                                    "coreContractHash": contract_hash(Surface::Core),
                                    "browserContractHash": contract_hash(Surface::Browser),
                                }}
                            }),
                        ),
                    ]),
                    surface,
                    true,
                ))
            }
        }
        Some("tools/list") => {
            paginated_tools(surface, context, request.params.as_ref()).map(|result| {
                if is_modern_request(request.params.as_ref()) {
                    modern_result(
                        result.as_object().cloned().unwrap_or_default(),
                        surface,
                        true,
                    )
                } else {
                    result
                }
            })
        }
        Some("ping") => Ok(if is_modern_request(request.params.as_ref()) {
            modern_result(serde_json::Map::new(), surface, false)
        } else {
            json!({})
        }),
        Some("tools/call") => prepare_tool_call(request, surface, context)
            .and_then(|request| dispatcher.dispatch(&request))
            .map(|result| {
                if is_modern_request(request.params.as_ref()) {
                    modern_result(
                        result.as_object().cloned().unwrap_or_default(),
                        surface,
                        false,
                    )
                } else {
                    result
                }
            }),
        Some(_) | None => {
            if notification {
                return None;
            }
            return Some(rpc_error(id, -32601, "Unsupported JSON-RPC method", None));
        }
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(error) if request.method.as_deref() == Some("tools/call") => tool_error_response(
            id,
            error,
            surface,
            is_modern_request(request.params.as_ref()),
        ),
        Err(FoundationError::UnsupportedProtocol(requested)) => rpc_error(
            id,
            -32022,
            &format!("Unsupported protocol version: {requested}"),
            Some(
                json!({ "supported": if request.method.as_deref() == Some("server/discover") {
                json!([MCP_MODERN_PROTOCOL_VERSION])
            } else {
                json!(MCP_LEGACY_PROTOCOL_VERSIONS)
            }, "requested": requested }),
            ),
        ),
        Err(error) => rpc_foundation_error(id, error),
    })
}

fn prepare_tool_call(
    request: &JsonRpcRequest,
    surface: Surface,
    context: &RuntimeContext,
) -> Result<JsonRpcRequest, FoundationError> {
    let params = request.params.as_ref().and_then(Value::as_object).ok_or(
        FoundationError::InvalidRequest("tools/call params must be an object"),
    )?;
    let name =
        params
            .get("name")
            .and_then(Value::as_str)
            .ok_or(FoundationError::InvalidRequest(
                "tools/call name is required",
            ))?;
    let raw_args = match params.get("arguments") {
        None => serde_json::Map::new(),
        Some(value) => value
            .as_object()
            .cloned()
            .ok_or(FoundationError::InvalidRequest(
                "tools/call arguments must be an object",
            ))?,
    };
    let capability = capabilities(surface)
        .into_iter()
        .find(|entry| entry["mcp"]["name"] == name)
        .ok_or_else(|| FoundationError::ToolNotAvailable(name.to_owned()))?;
    let capability_id = capability["id"]
        .as_str()
        .ok_or(FoundationError::InvalidRequest(
            "generated capability id is missing",
        ))?;
    let args = normalize_legacy_arguments(capability_id, raw_args);
    reject_reserved_identity(&args)?;
    validate_schema(name, &args, &capability["mcp"]["inputSchema"])?;
    if surface == Surface::Browser && !context.browser_enabled {
        return Err(FoundationError::BrowserDisabled);
    }
    validate_runtime_context(&capability, context)?;
    let mut normalized = request.clone();
    let mut normalized_params = params.clone();
    normalized_params.insert("arguments".to_owned(), Value::Object(args));
    normalized.params = Some(Value::Object(normalized_params));
    Ok(normalized)
}

fn normalize_legacy_arguments(
    capability_id: &str,
    mut args: serde_json::Map<String, Value>,
) -> serde_json::Map<String, Value> {
    for &(alias, canonical) in legacy_argument_aliases(capability_id) {
        let Some(value) = args.remove(alias) else {
            continue;
        };
        args.entry(canonical.to_owned()).or_insert(value);
    }
    args
}

fn legacy_argument_aliases(capability_id: &str) -> &'static [(&'static str, &'static str)] {
    match capability_id {
        "agent.skills.enable" => &[("selections", "selectionRefs"), ("skills", "selectionRefs")],
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
        | "issue.update"
        | "issue.review"
        | "issue.commit"
        | "issue.done"
        | "issue.block" => &[("issueId", "issue")],
        "issue.comments.get" => &[("issueId", "issue"), ("commentId", "comment")],
        "project.get" | "project.update" => &[("projectId", "project")],
        "approval.get" | "approval.issues" | "approval.comment" => &[("approvalId", "approval")],
        "skill.get" | "skill.file" => &[("skillId", "skill")],
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
        "runs.transcript" => &[("maxOutputChars", "maxChars")],
        "chat.get" | "chat.messages" | "chat.transcript" | "chat.read" | "chat.send"
        | "chat.archive" => &[("chatId", "chat")],
        _ => &[],
    }
}

fn reject_reserved_identity(args: &serde_json::Map<String, Value>) -> Result<(), FoundationError> {
    let mut reserved = args
        .keys()
        .filter(|key| {
            let normalized = key
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>();
            matches!(
                normalized.as_str(),
                "orgid"
                    | "companyid"
                    | "agentid"
                    | "runid"
                    | "apibase"
                    | "apikey"
                    | "authorization"
            ) || key.to_ascii_uppercase().starts_with("RUDDER_")
        })
        .cloned()
        .collect::<Vec<_>>();
    reserved.sort();
    if reserved.is_empty() {
        Ok(())
    } else {
        Err(FoundationError::ReservedIdentity(reserved.join(", ")))
    }
}

fn validate_runtime_context(
    capability: &Value,
    context: &RuntimeContext,
) -> Result<(), FoundationError> {
    let cli = &capability["cli"];
    let mut missing = Vec::new();
    if context.api_url.is_none() {
        missing.push("RUDDER_API_URL");
    }
    if context.api_key.is_none() {
        missing.push("RUDDER_API_KEY");
    }
    if cli["requiresOrgId"] == true && context.org_id.is_none() {
        missing.push("RUDDER_ORG_ID");
    }
    if cli["requiresAgentId"] == true && context.agent_id.is_none() {
        missing.push("RUDDER_AGENT_ID");
    }
    if cli["requiresRunId"] == true && context.run_id.is_none() {
        missing.push("RUDDER_RUN_ID");
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(FoundationError::MissingRuntimeContext(missing.join(", ")))
    }
}

fn validate_schema(
    tool: &str,
    args: &serde_json::Map<String, Value>,
    schema: &Value,
) -> Result<(), FoundationError> {
    let value = Value::Object(args.clone());
    schema_violation(&value, schema).map_or(Ok(()), |reason| {
        Err(FoundationError::InvalidArguments {
            tool: tool.to_owned(),
            reason: format!("{reason}. Consult tools/list for the exact schema."),
        })
    })
}

fn schema_violation(value: &Value, schema: &Value) -> Option<String> {
    let schema = schema.as_object()?;
    if let Some(one_of) = schema.get("oneOf").and_then(Value::as_array)
        && !one_of
            .iter()
            .any(|candidate| schema_violation(value, candidate).is_none())
    {
        return Some("does not match any allowed shape".to_owned());
    }
    if let Some(any_of) = schema.get("anyOf").and_then(Value::as_array)
        && !any_of
            .iter()
            .any(|candidate| schema_violation(value, candidate).is_none())
    {
        return Some("does not match any allowed shape".to_owned());
    }

    if let Some(types) = schema.get("type") {
        let types = types
            .as_array()
            .cloned()
            .unwrap_or_else(|| vec![types.clone()]);
        if !types
            .iter()
            .any(|kind| value_matches_type(value, kind.as_str()))
        {
            let expected = types
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" or ");
            return Some(format!("must be {expected}"));
        }
    }
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array)
        && !allowed.contains(value)
    {
        return Some(format!(
            "must be one of: {}",
            allowed
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    if let Some(text) = value.as_str() {
        let length = text.chars().count();
        if let Some(minimum) = schema.get("minLength").and_then(Value::as_u64)
            && length < minimum as usize
        {
            return Some(format!("must contain at least {minimum} character(s)"));
        }
        if let Some(maximum) = schema.get("maxLength").and_then(Value::as_u64)
            && length > maximum as usize
        {
            return Some(format!("must contain at most {maximum} characters"));
        }
    }
    if let Some(number) = value.as_f64() {
        if let Some(minimum) = schema.get("minimum").and_then(Value::as_f64)
            && number < minimum
        {
            return Some(format!("must be at least {minimum}"));
        }
        if let Some(maximum) = schema.get("maximum").and_then(Value::as_f64)
            && number > maximum
        {
            return Some(format!("must be at most {maximum}"));
        }
    }
    if let Some(items) = value.as_array() {
        if let Some(minimum) = schema.get("minItems").and_then(Value::as_u64)
            && items.len() < minimum as usize
        {
            return Some(format!("must contain at least {minimum} items"));
        }
        if let Some(maximum) = schema.get("maxItems").and_then(Value::as_u64)
            && items.len() > maximum as usize
        {
            return Some(format!("must contain at most {maximum} items"));
        }
        if let Some(item_schema) = schema.get("items") {
            for (index, item) in items.iter().enumerate() {
                if let Some(reason) = schema_violation(item, item_schema) {
                    return Some(format!("item {index} {reason}"));
                }
            }
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(minimum) = schema.get("minProperties").and_then(Value::as_u64)
            && object.len() < minimum as usize
        {
            return Some(format!("must contain at least {minimum} properties"));
        }
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for required in schema
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let missing = object.get(required).is_none_or(|value| {
                value.is_null()
                    || value.as_str().is_some_and(|value| value.trim().is_empty())
                    || value.as_array().is_some_and(Vec::is_empty)
            });
            if missing {
                return Some(format!("field {required} is required"));
            }
        }
        if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
            let mut unsupported = object
                .keys()
                .filter(|key| !properties.contains_key(*key))
                .cloned()
                .collect::<Vec<_>>();
            unsupported.sort();
            if !unsupported.is_empty() {
                return Some(format!(
                    "contains unsupported field(s): {}",
                    unsupported.join(", ")
                ));
            }
        }
        for (key, child) in object {
            let Some(child_schema) = properties.get(key) else {
                continue;
            };
            if let Some(reason) = schema_violation(child, child_schema) {
                return Some(format!("field {key} {reason}"));
            }
        }
    }
    None
}

fn value_matches_type(value: &Value, kind: Option<&str>) -> bool {
    match kind {
        Some("string") => value.is_string(),
        Some("number") => value.is_number(),
        Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
        Some("boolean") => value.is_boolean(),
        Some("array") => value.is_array(),
        Some("object") => value.is_object(),
        Some("null") => value.is_null(),
        None => true,
        Some(_) => false,
    }
}

fn rpc_error(id: Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut error = BTreeMap::from([("code", json!(code)), ("message", json!(message))]);
    if let Some(data) = data {
        error.insert("data", data);
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StdioMode {
    Newline,
    Framed,
}

struct MessageReader<R> {
    input: R,
    buffer: Vec<u8>,
    mode: Option<StdioMode>,
    eof: bool,
}

impl<R: Read> MessageReader<R> {
    fn new(input: R) -> Self {
        Self {
            input,
            buffer: Vec::new(),
            mode: None,
            eof: false,
        }
    }

    fn mode(&self) -> Option<StdioMode> {
        self.mode
    }

    fn next_message(&mut self) -> Result<Option<Vec<u8>>, FoundationError> {
        loop {
            if self.mode.is_none() {
                self.mode = detect_mode(&self.buffer, self.eof)?;
            }
            match self.mode {
                Some(StdioMode::Newline) => {
                    if let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
                        if end > MAX_REQUEST_BYTES {
                            return Err(FoundationError::MessageLimit);
                        }
                        let mut payload = self.buffer.drain(..=end).collect::<Vec<_>>();
                        while matches!(payload.last(), Some(b'\n' | b'\r')) {
                            payload.pop();
                        }
                        if payload.iter().all(u8::is_ascii_whitespace) {
                            continue;
                        }
                        return Ok(Some(payload));
                    }
                    if self.buffer.len() > MAX_REQUEST_BYTES {
                        return Err(FoundationError::MessageLimit);
                    }
                    if self.eof {
                        return if self.buffer.is_empty() {
                            Ok(None)
                        } else {
                            Err(FoundationError::IncompleteMessage)
                        };
                    }
                }
                Some(StdioMode::Framed) => {
                    if let Some(header_end) = find_bytes(&self.buffer, b"\r\n\r\n") {
                        if header_end > MAX_HEADER_BYTES {
                            return Err(FoundationError::MessageLimit);
                        }
                        let header =
                            std::str::from_utf8(&self.buffer[..header_end]).map_err(|_| {
                                FoundationError::InvalidRequest("MCP frame header must be UTF-8")
                            })?;
                        let length = content_length(header)?;
                        if length > MAX_REQUEST_BYTES {
                            return Err(FoundationError::MessageLimit);
                        }
                        let body_start = header_end + 4;
                        let body_end = body_start + length;
                        if self.buffer.len() >= body_end {
                            let payload = self.buffer[body_start..body_end].to_vec();
                            self.buffer.drain(..body_end);
                            return Ok(Some(payload));
                        }
                    } else if self.buffer.len() > MAX_HEADER_BYTES {
                        return Err(FoundationError::MessageLimit);
                    }
                    if self.eof {
                        return if self.buffer.is_empty() {
                            Ok(None)
                        } else {
                            Err(FoundationError::IncompleteMessage)
                        };
                    }
                }
                None => {
                    if self.buffer.len() > MAX_REQUEST_BYTES {
                        return Err(FoundationError::MessageLimit);
                    }
                    if self.eof {
                        return Ok(None);
                    }
                }
            }
            let mut chunk = [0_u8; 8_192];
            let count = self.input.read(&mut chunk)?;
            if count == 0 {
                self.eof = true;
            } else {
                self.buffer.extend_from_slice(&chunk[..count]);
                if self.mode.is_none() && self.buffer.len() > MAX_REQUEST_BYTES {
                    return Err(FoundationError::MessageLimit);
                }
            }
        }
    }
}

pub fn run_stdio(
    input: impl Read,
    mut output: impl Write,
    surface: Surface,
    context: RuntimeContext,
    mut dispatcher: impl ToolDispatcher,
) -> Result<(), FoundationError> {
    let mut input = MessageReader::new(input);
    loop {
        let Some(payload) = input.next_message()? else {
            break;
        };
        let mode = input.mode().expect("message mode must be selected");
        let request: JsonRpcRequest = serde_json::from_slice(&payload)?;
        let Some(response) = handle_message(&request, surface, &context, &mut dispatcher) else {
            continue;
        };
        write_response(&mut output, mode, surface, &response)?;
    }
    Ok(())
}

pub fn run_concurrent_stdio<R, W, D>(
    input: R,
    output: W,
    surface: Surface,
    context: RuntimeContext,
    mut dispatcher: D,
) -> Result<(), FoundationError>
where
    R: Read,
    W: Write + Send + 'static,
    D: ToolDispatcher + Clone + Send + 'static,
{
    let mut input = MessageReader::new(input);
    let output = Arc::new(Mutex::new(output));
    let mut workers = Vec::new();
    let active = Arc::new(Mutex::new(HashSet::<String>::new()));
    loop {
        let Some(payload) = input.next_message()? else {
            break;
        };
        let mode = input.mode().expect("message mode must be selected");
        let request: JsonRpcRequest = serde_json::from_slice(&payload)?;
        if request.method.as_deref() == Some("notifications/cancelled") {
            if let Some(request_id) = request
                .params
                .as_ref()
                .and_then(|params| params.get("requestId"))
            {
                let key = request_id_key(request_id);
                if active.lock().unwrap().contains(&key) {
                    dispatcher.cancel(request_id)?;
                }
            }
            continue;
        }
        if request.method.as_deref() == Some("tools/call") {
            let request = match prepare_tool_call(&request, surface, &context) {
                Ok(request) => request,
                Err(error) => {
                    let response = tool_error_response(
                        request.id.unwrap_or(Value::Null),
                        error,
                        surface,
                        is_modern_request(request.params.as_ref()),
                    );
                    write_stdio_response(&output, mode, surface, &response)?;
                    continue;
                }
            };
            let id = request.id.clone().unwrap_or(Value::Null);
            dispatcher.begin_request(&id);
            active.lock().unwrap().insert(request_id_key(&id));
            let mut worker_dispatcher = dispatcher.clone();
            let worker_output = Arc::clone(&output);
            let worker_active = Arc::clone(&active);
            workers.push(thread::spawn(move || {
                let modern = is_modern_request(request.params.as_ref());
                let response = match worker_dispatcher.dispatch(&request) {
                    Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": if modern {
                        modern_result(result.as_object().cloned().unwrap_or_default(), surface, false)
                    } else { result } }),
                    Err(error) => tool_error_response(id.clone(), error, surface, modern),
                };
                worker_dispatcher.finish_request(&id);
                worker_active.lock().unwrap().remove(&request_id_key(&id));
                let _ = write_stdio_response(&worker_output, mode, surface, &response);
            }));
            continue;
        }
        if let Some(response) = handle_message(&request, surface, &context, &mut dispatcher) {
            write_stdio_response(&output, mode, surface, &response)?;
        }
    }
    let active_ids = active.lock().unwrap().iter().cloned().collect::<Vec<_>>();
    for key in active_ids {
        let request_id = serde_json::from_str(&key).unwrap_or(Value::Null);
        dispatcher.cancel(&request_id)?;
    }
    for worker in workers {
        worker.join().map_err(|_| {
            FoundationError::NodeCompatibility("dispatch worker panicked".to_owned())
        })?;
    }
    Ok(())
}

fn rpc_foundation_error(id: Value, error: FoundationError) -> Value {
    let data = json!({ "code": error.code(), "details": Value::Null });
    let rpc_code = match error {
        FoundationError::InvalidRequest(_) | FoundationError::InvalidArguments { .. } => -32602,
        FoundationError::UnsupportedProtocol(_) => -32022,
        _ => -32000,
    };
    rpc_error(id, rpc_code, &error.to_string(), Some(data))
}

fn tool_error_result(error: &FoundationError) -> Value {
    let payload = json!({
        "status": "error",
        "code": error.code(),
        "message": error.to_string(),
        "details": Value::Null,
    });
    json!({
        "content": [{ "type": "text", "text": payload.to_string() }],
        "structuredContent": payload,
        "isError": true,
    })
}

fn tool_error_response(id: Value, error: FoundationError, surface: Surface, modern: bool) -> Value {
    let result = tool_error_result(&error);
    let result = if modern {
        modern_result(
            result.as_object().cloned().unwrap_or_default(),
            surface,
            false,
        )
    } else {
        result
    };
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn write_stdio_response<W: Write>(
    output: &Arc<Mutex<W>>,
    mode: StdioMode,
    surface: Surface,
    response: &Value,
) -> Result<(), FoundationError> {
    let mut output = output.lock().unwrap();
    write_response(&mut *output, mode, surface, response)
}

fn write_response(
    output: &mut impl Write,
    mode: StdioMode,
    surface: Surface,
    response: &Value,
) -> Result<(), FoundationError> {
    let body = bounded_response_body(response, surface)?;
    match mode {
        StdioMode::Newline => {
            output.write_all(&body)?;
            output.write_all(b"\n")?;
        }
        StdioMode::Framed => {
            write!(output, "Content-Length: {}\r\n\r\n", body.len())?;
            output.write_all(&body)?;
        }
    }
    output.flush()?;
    Ok(())
}

fn bounded_response_body(response: &Value, surface: Surface) -> Result<Vec<u8>, FoundationError> {
    let body = serde_json::to_vec(response)?;
    let budget = surface.result_budget();
    if body.len() <= budget {
        return Ok(body);
    }
    let payload = json!({
        "status": "error",
        "code": "rudder_mcp_response_too_large",
        "message": "Rudder MCP response exceeded the bounded tool-result budget. Use pagination or a ranged log read.",
        "details": { "maxBytes": budget, "responseBytes": body.len() },
    });
    let mut result = serde_json::Map::from_iter([
        (
            "content".to_owned(),
            json!([{ "type": "text", "text": payload.to_string() }]),
        ),
        ("structuredContent".to_owned(), payload),
        ("isError".to_owned(), Value::Bool(true)),
    ]);
    let modern = response["result"]["resultType"] == "complete";
    if modern {
        result = modern_result(result, surface, false)
            .as_object()
            .cloned()
            .unwrap_or_default();
    }
    Ok(serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "id": response.get("id").cloned().unwrap_or(Value::Null),
        "result": result,
    }))?)
}

fn detect_mode(bytes: &[u8], eof: bool) -> Result<Option<StdioMode>, FoundationError> {
    let trimmed = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .map_or(&[][..], |start| &bytes[start..]);
    if trimmed.is_empty() {
        return Ok(None);
    }
    let prefix = b"content-length:";
    let compared = trimmed.len().min(prefix.len());
    let prefix_matches = trimmed[..compared]
        .iter()
        .zip(prefix[..compared].iter())
        .all(|(left, right)| left.to_ascii_lowercase() == *right);
    if prefix_matches && trimmed.len() < prefix.len() {
        return if eof {
            Err(FoundationError::IncompleteMessage)
        } else {
            Ok(None)
        };
    }
    Ok(Some(if prefix_matches {
        StdioMode::Framed
    } else {
        StdioMode::Newline
    }))
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn content_length(header: &str) -> Result<usize, FoundationError> {
    header
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("Content-Length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .ok_or(FoundationError::InvalidRequest(
            "Content-Length is required",
        ))
}

fn target_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else {
        "unsupported"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[derive(Default)]
    struct RecordingDispatcher {
        calls: usize,
        cancelled: Vec<Value>,
    }

    #[derive(Clone)]
    struct LargeDispatcher {
        bytes: usize,
    }

    impl ToolDispatcher for LargeDispatcher {
        fn dispatch(&mut self, _request: &JsonRpcRequest) -> Result<Value, FoundationError> {
            Ok(json!({
                "content": [{ "type": "text", "text": "x".repeat(self.bytes) }],
                "structuredContent": { "payload": "x".repeat(self.bytes) },
                "isError": false,
            }))
        }
    }

    struct OneByteReader<'a> {
        bytes: &'a [u8],
        offset: usize,
    }

    struct DelayedEofReader<'a> {
        bytes: &'a [u8],
        delivered: bool,
    }

    impl Read for DelayedEofReader<'_> {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            if !self.delivered {
                output[..self.bytes.len()].copy_from_slice(self.bytes);
                self.delivered = true;
                return Ok(self.bytes.len());
            }
            thread::sleep(std::time::Duration::from_millis(50));
            Ok(0)
        }
    }

    #[derive(Clone, Default)]
    struct SelectiveDispatcher {
        cancelled: Arc<Mutex<HashSet<String>>>,
    }

    impl ToolDispatcher for SelectiveDispatcher {
        fn dispatch(&mut self, request: &JsonRpcRequest) -> Result<Value, FoundationError> {
            let key = request_id_key(request.id.as_ref().unwrap());
            if request.id == Some(json!(2)) {
                return Ok(json!({ "content": [], "structuredContent": {}, "isError": false }));
            }
            for _ in 0..100 {
                if self.cancelled.lock().unwrap().contains(&key) {
                    return Err(FoundationError::Cancelled);
                }
                thread::sleep(std::time::Duration::from_millis(1));
            }
            Ok(json!({ "content": [], "structuredContent": {}, "isError": false }))
        }

        fn cancel(&mut self, request_id: &Value) -> Result<(), FoundationError> {
            self.cancelled
                .lock()
                .unwrap()
                .insert(request_id_key(request_id));
            Ok(())
        }
    }

    impl Read for OneByteReader<'_> {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            if self.offset == self.bytes.len() {
                return Ok(0);
            }
            output[0] = self.bytes[self.offset];
            self.offset += 1;
            Ok(1)
        }
    }

    #[derive(Clone, Default)]
    struct CancellableDispatcher {
        cancelled: Arc<Mutex<HashSet<String>>>,
    }

    impl ToolDispatcher for CancellableDispatcher {
        fn dispatch(&mut self, request: &JsonRpcRequest) -> Result<Value, FoundationError> {
            let key = request_id_key(request.id.as_ref().unwrap());
            for _ in 0..100 {
                if self.cancelled.lock().unwrap().contains(&key) {
                    return Err(FoundationError::Cancelled);
                }
                thread::sleep(std::time::Duration::from_millis(2));
            }
            Ok(json!({}))
        }

        fn cancel(&mut self, request_id: &Value) -> Result<(), FoundationError> {
            self.cancelled
                .lock()
                .unwrap()
                .insert(request_id_key(request_id));
            Ok(())
        }
    }

    impl ToolDispatcher for RecordingDispatcher {
        fn dispatch(&mut self, _request: &JsonRpcRequest) -> Result<Value, FoundationError> {
            self.calls += 1;
            Ok(json!({ "content": [{ "type": "text", "text": "{}" }] }))
        }

        fn cancel(&mut self, request_id: &Value) -> Result<(), FoundationError> {
            self.cancelled.push(request_id.clone());
            Ok(())
        }
    }

    fn request(id: i64, method: &str, params: Value) -> JsonRpcRequest {
        serde_json::from_value(
            json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )
        .unwrap()
    }

    fn collect_schema_coverage(
        schema: &Value,
        keywords: &mut BTreeSet<String>,
        value_types: &mut BTreeSet<String>,
    ) {
        let Some(schema) = schema.as_object() else {
            return;
        };
        keywords.extend(schema.keys().cloned());
        if let Some(schema_types) = schema.get("type") {
            for schema_type in schema_types
                .as_array()
                .into_iter()
                .flatten()
                .chain(std::iter::once(schema_types))
                .filter_map(Value::as_str)
            {
                value_types.insert(schema_type.to_owned());
            }
        }
        for child in schema
            .get("properties")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|properties| properties.values())
        {
            collect_schema_coverage(child, keywords, value_types);
        }
        if let Some(items) = schema.get("items") {
            collect_schema_coverage(items, keywords, value_types);
        }
        for child in ["oneOf", "anyOf"]
            .into_iter()
            .flat_map(|key| schema.get(key).and_then(Value::as_array))
            .flatten()
        {
            collect_schema_coverage(child, keywords, value_types);
        }
    }

    fn complete_context() -> RuntimeContext {
        RuntimeContext {
            api_url: Some("http://127.0.0.1:3100".to_owned()),
            api_key: Some("redacted".to_owned()),
            org_id: Some("org".to_owned()),
            agent_id: Some("agent".to_owned()),
            run_id: Some("run".to_owned()),
            browser_enabled: true,
        }
    }

    #[test]
    fn generated_manifests_preserve_contract_parity() {
        assert_eq!(tools_manifest(Surface::Core).len(), 82);
        assert_eq!(tools_manifest(Surface::Browser).len(), 25);
        assert_eq!(
            capabilities_manifest()["capabilities"]
                .as_array()
                .unwrap()
                .len(),
            107
        );
        assert_eq!(
            capabilities_manifest()["schema"],
            "rudder.agent-capabilities/v1"
        );
        assert_eq!(capabilities_manifest()["capabilities"][0]["agentV1"], true);
        assert_eq!(
            capabilities_manifest()["mcp"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            82
        );
        assert_eq!(
            binary_identity("rudder-mcp-foundation")["manifestHash"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
        assert_eq!(
            contract_hash(Surface::Core),
            "457869e72e5cd04a54f036324e167365ff4c13aa396a74ec3ed11676f7c70e67"
        );
        assert_eq!(
            contract_hash(Surface::Browser),
            "640c060df9ef9ae3c649d973d123fdcfc0d1456217cbe1ec48dbba337de75923"
        );
    }

    #[test]
    fn distinguishes_missing_ids_from_explicit_null_ids() {
        let missing: JsonRpcRequest =
            serde_json::from_value(json!({ "jsonrpc": "2.0", "method": "ping" })).unwrap();
        let explicit_null: JsonRpcRequest =
            serde_json::from_value(json!({ "jsonrpc": "2.0", "id": null, "method": "ping" }))
                .unwrap();
        assert!(!missing.id_present);
        assert!(missing.id.is_none());
        assert!(explicit_null.id_present);
        assert_eq!(explicit_null.id, Some(Value::Null));
        assert!(serde_json::to_value(missing).unwrap().get("id").is_none());
        assert_eq!(
            serde_json::to_value(explicit_null).unwrap()["id"],
            Value::Null
        );
    }

    #[test]
    fn negotiates_legacy_and_modern_protocol_contracts() {
        let mut dispatcher = RecordingDispatcher::default();
        let legacy = request(1, "initialize", json!({ "protocolVersion": "2025-06-18" }));
        let response = handle_message(
            &legacy,
            Surface::Core,
            &RuntimeContext::default(),
            &mut dispatcher,
        )
        .unwrap();
        assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(
            response["result"]["capabilities"]["experimental"]["rudder"]["contractVersion"],
            "rudder.agent-mcp-tools/v1"
        );

        let modern_params = json!({ "_meta": {
            MCP_PROTOCOL_VERSION_META_KEY: MCP_MODERN_PROTOCOL_VERSION,
            MCP_CLIENT_CAPABILITIES_META_KEY: {},
        }});
        let discovery = request(2, "server/discover", modern_params.clone());
        let response = handle_message(
            &discovery,
            Surface::Core,
            &RuntimeContext::default(),
            &mut dispatcher,
        )
        .unwrap();
        assert_eq!(response["result"]["resultType"], "complete");
        assert_eq!(
            response["result"]["supportedVersions"],
            json!([MCP_MODERN_PROTOCOL_VERSION])
        );

        let first_page = request(3, "tools/list", modern_params.clone());
        let response = handle_message(
            &first_page,
            Surface::Core,
            &RuntimeContext::default(),
            &mut dispatcher,
        )
        .unwrap();
        assert_eq!(response["result"]["tools"].as_array().unwrap().len(), 50);
        let cursor = response["result"]["nextCursor"].as_str().unwrap();
        let mut second_params = modern_params;
        second_params["cursor"] = json!(cursor);
        let second_page = request(4, "tools/list", second_params);
        let response = handle_message(
            &second_page,
            Surface::Core,
            &RuntimeContext::default(),
            &mut dispatcher,
        )
        .unwrap();
        assert_eq!(response["result"]["tools"].as_array().unwrap().len(), 32);
        assert!(response["result"].get("nextCursor").is_none());
    }

    #[test]
    fn validates_complete_generated_schema_shapes() {
        let schema = json!({
            "type": "object",
            "additionalProperties": false,
            "minProperties": 4,
            "required": ["name", "nested", "items", "shape"],
            "properties": {
                "name": { "type": "string", "minLength": 1, "maxLength": 3, "enum": ["ok", "no"] },
                "count": { "type": "number", "minimum": 1, "maximum": 2 },
                "nested": {
                    "type": "object", "additionalProperties": false, "required": ["flag"],
                    "properties": { "flag": { "type": "boolean" } }
                },
                "items": { "type": "array", "minItems": 1, "maxItems": 2, "items": { "type": "string", "maxLength": 2 } },
                "shape": { "oneOf": [{ "type": "string" }, { "type": "object" }] }
            }
        });
        assert!(schema_violation(
            &json!({ "name": "ok", "count": 2, "nested": { "flag": true }, "items": ["a"], "shape": {} }),
            &schema,
        )
        .is_none());
        for invalid in [
            json!({ "name": 1, "nested": { "flag": true }, "items": ["a"], "shape": {} }),
            json!({ "name": "bad", "nested": { "flag": true }, "items": ["a"], "shape": {} }),
            json!({ "name": "ok", "count": 3, "nested": { "flag": true }, "items": ["a"], "shape": {} }),
            json!({ "name": "ok", "nested": { "flag": "yes" }, "items": ["a"], "shape": {} }),
            json!({ "name": "ok", "nested": { "flag": true }, "items": [], "shape": {} }),
            json!({ "name": "ok", "nested": { "flag": true }, "items": ["long"], "shape": {} }),
            json!({ "name": "ok", "nested": { "flag": true }, "items": ["a"], "shape": 4 }),
        ] {
            assert!(schema_violation(&invalid, &schema).is_some(), "{invalid}");
        }

        let mut dispatcher = RecordingDispatcher::default();
        let wrong_type = request(
            9,
            "tools/call",
            json!({ "name": "rudder_issue_get", "arguments": { "issue": 123 } }),
        );
        let response = handle_message(
            &wrong_type,
            Surface::Core,
            &complete_context(),
            &mut dispatcher,
        )
        .unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["code"],
            "rudder_mcp_invalid_arguments"
        );
        assert_eq!(dispatcher.calls, 0);

        let empty_change = request(
            10,
            "tools/call",
            json!({
                "name": "rudder_goal_change_propose",
                "arguments": {
                    "goal": "gol_1",
                    "contractRevision": 1,
                    "afterContract": {},
                    "rationale": "evidence changed",
                    "idempotencyKey": "key"
                }
            }),
        );
        let response = handle_message(
            &empty_change,
            Surface::Core,
            &complete_context(),
            &mut dispatcher,
        )
        .unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["code"],
            "rudder_mcp_invalid_arguments"
        );
    }

    #[test]
    fn generated_input_schemas_use_only_covered_keywords() {
        let mut actual = BTreeSet::new();
        let mut actual_types = BTreeSet::new();
        for capability in capabilities(Surface::Core)
            .into_iter()
            .chain(capabilities(Surface::Browser))
        {
            collect_schema_coverage(
                &capability["mcp"]["inputSchema"],
                &mut actual,
                &mut actual_types,
            );
        }
        let covered = BTreeSet::from_iter(
            [
                "additionalProperties",
                "anyOf",
                "description",
                "enum",
                "format",
                "items",
                "maxItems",
                "maxLength",
                "maximum",
                "minItems",
                "minLength",
                "minProperties",
                "minimum",
                "oneOf",
                "properties",
                "required",
                "type",
            ]
            .into_iter()
            .map(str::to_owned),
        );
        assert_eq!(actual, covered);
        assert_eq!(
            actual_types,
            BTreeSet::from_iter(
                ["array", "boolean", "null", "number", "object", "string"]
                    .into_iter()
                    .map(str::to_owned),
            )
        );
    }

    #[test]
    fn browser_surface_is_runtime_locked() {
        let mut dispatcher = RecordingDispatcher::default();
        let list = request(1, "tools/list", json!({}));
        let disabled = handle_message(
            &list,
            Surface::Browser,
            &RuntimeContext::default(),
            &mut dispatcher,
        )
        .unwrap();
        assert_eq!(disabled["result"]["tools"].as_array().unwrap().len(), 0);
        let enabled = handle_message(
            &list,
            Surface::Browser,
            &complete_context(),
            &mut dispatcher,
        )
        .unwrap();
        assert_eq!(enabled["result"]["tools"].as_array().unwrap().len(), 25);
    }

    #[test]
    fn rejects_reserved_identity_and_missing_context_before_dispatch() {
        let mut dispatcher = RecordingDispatcher::default();
        let reserved = request(
            1,
            "tools/call",
            json!({
                "name": "rudder_agent_me", "arguments": { "RUDDER_API_KEY": "secret" }
            }),
        );
        let response = handle_message(
            &reserved,
            Surface::Core,
            &complete_context(),
            &mut dispatcher,
        )
        .unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["code"],
            "rudder_mcp_reserved_identity_argument"
        );
        assert_eq!(response["result"]["isError"], true);

        let missing = request(
            2,
            "tools/call",
            json!({ "name": "rudder_issue_list", "arguments": {} }),
        );
        let response = handle_message(
            &missing,
            Surface::Core,
            &RuntimeContext::default(),
            &mut dispatcher,
        )
        .unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["code"],
            "rudder_mcp_missing_runtime_context"
        );
        assert_eq!(dispatcher.calls, 0);
    }

    #[test]
    fn string_schema_lengths_count_unicode_code_points() {
        let schema = json!({ "type": "string", "minLength": 1, "maxLength": 1 });

        assert!(schema_violation(&json!("\u{1f642}"), &schema).is_none());
        assert!(schema_violation(&json!("\u{1f642}\u{1f642}"), &schema).is_some());
    }

    #[test]
    fn supports_newline_and_content_length_framing() {
        let initialize = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
        let mut newline = Vec::new();
        run_stdio(
            [&initialize[..], b"\n"].concat().as_slice(),
            &mut newline,
            Surface::Core,
            RuntimeContext::default(),
            RecordingDispatcher::default(),
        )
        .unwrap();
        assert!(String::from_utf8(newline).unwrap().contains("rudder-tools"));

        let framed = format!(
            "Content-Length: {}\r\n\r\n{}",
            initialize.len(),
            String::from_utf8_lossy(initialize)
        );
        let mut output = Vec::new();
        run_stdio(
            framed.as_bytes(),
            &mut output,
            Surface::Core,
            RuntimeContext::default(),
            RecordingDispatcher::default(),
        )
        .unwrap();
        assert!(
            String::from_utf8(output)
                .unwrap()
                .starts_with("Content-Length:")
        );
    }

    #[test]
    fn framing_is_incremental_bounded_and_byte_exact() {
        let first = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "clientInfo": { "name": "\u{4e2d}\u{6587}" } }
        }))
        .unwrap();
        let second = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": 2, "method": "ping", "params": {}
        }))
        .unwrap();
        let stream = [
            format!("Content-Length: {}\r\n\r\n", first.len()).into_bytes(),
            first,
            format!("Content-Length: {}\r\n\r\n", second.len()).into_bytes(),
            second,
        ]
        .concat();
        let mut output = Vec::new();
        run_stdio(
            OneByteReader {
                bytes: &stream,
                offset: 0,
            },
            &mut output,
            Surface::Core,
            RuntimeContext::default(),
            RecordingDispatcher::default(),
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(output)
                .unwrap()
                .matches("Content-Length:")
                .count(),
            2
        );

        let incomplete = b"Content-Len";
        let error = run_stdio(
            OneByteReader {
                bytes: incomplete,
                offset: 0,
            },
            Vec::new(),
            Surface::Core,
            RuntimeContext::default(),
            RecordingDispatcher::default(),
        )
        .unwrap_err();
        assert!(matches!(error, FoundationError::IncompleteMessage));

        let oversized_header = [
            b"Content-Length: 1\r\nX-Test: ".as_slice(),
            &vec![b'x'; MAX_HEADER_BYTES],
            b"\r\n\r\n{}",
        ]
        .concat();
        let error = run_stdio(
            oversized_header.as_slice(),
            Vec::new(),
            Surface::Core,
            RuntimeContext::default(),
            RecordingDispatcher::default(),
        )
        .unwrap_err();
        assert!(matches!(error, FoundationError::MessageLimit));
    }

    #[test]
    fn unknown_and_late_cancellation_do_not_poison_reused_ids() {
        let mut dispatcher = NodeCompatibilityDispatcher::from_env(Surface::Core);
        let id = json!(42);
        dispatcher.cancel(&id).unwrap();
        assert!(dispatcher.cancelled.lock().unwrap().is_empty());
        dispatcher.begin_request(&id);
        dispatcher.cancel(&id).unwrap();
        assert!(
            dispatcher
                .cancelled
                .lock()
                .unwrap()
                .contains(&request_id_key(&id))
        );
        dispatcher.finish_request(&id);
        dispatcher.cancel(&id).unwrap();
        assert!(dispatcher.cancelled.lock().unwrap().is_empty());
        dispatcher.begin_request(&id);
        assert!(dispatcher.cancelled.lock().unwrap().is_empty());
    }

    #[test]
    fn result_budgets_are_surface_specific_and_recover_with_structured_error() {
        let core_call = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": { "name": "rudder_agent_me", "arguments": {} }
        }))
        .unwrap();
        let mut core_output = Vec::new();
        run_stdio(
            [core_call.as_slice(), b"\n"].concat().as_slice(),
            &mut core_output,
            Surface::Core,
            complete_context(),
            LargeDispatcher { bytes: 600_000 },
        )
        .unwrap();
        let core_response: Value = serde_json::from_slice(&core_output).unwrap();
        assert_eq!(
            core_response["result"]["structuredContent"]["code"],
            "rudder_mcp_response_too_large"
        );

        let browser_call = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "rudder_browser_tabs", "arguments": {} }
        }))
        .unwrap();
        let mut browser_output = Vec::new();
        run_stdio(
            [browser_call.as_slice(), b"\n"].concat().as_slice(),
            &mut browser_output,
            Surface::Browser,
            complete_context(),
            LargeDispatcher { bytes: 600_000 },
        )
        .unwrap();
        let browser_response: Value = serde_json::from_slice(&browser_output).unwrap();
        assert_eq!(browser_response["result"]["isError"], false);
        assert!(browser_output.len() > MAX_CORE_RESULT_BYTES);
        assert!(browser_output.len() < MAX_BROWSER_RESULT_BYTES);
    }

    #[test]
    fn cancellation_notifications_reach_the_dispatcher() {
        let mut dispatcher = RecordingDispatcher::default();
        let notification: JsonRpcRequest = serde_json::from_value(json!({
            "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 42 }
        }))
        .unwrap();
        assert!(
            handle_message(
                &notification,
                Surface::Core,
                &complete_context(),
                &mut dispatcher
            )
            .is_none()
        );
        assert_eq!(dispatcher.cancelled, vec![json!(42)]);
    }

    #[test]
    fn concurrent_stdio_cancels_an_active_dispatch() {
        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":42,\"method\":\"tools/call\",\"params\":{\"name\":\"rudder_agent_me\",\"arguments\":{}}}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":42}}\n",
        );
        let output = Arc::new(Mutex::new(Vec::new()));
        struct SharedOutput(Arc<Mutex<Vec<u8>>>);
        impl Write for SharedOutput {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().write(bytes)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        run_concurrent_stdio(
            input.as_bytes(),
            SharedOutput(Arc::clone(&output)),
            Surface::Core,
            complete_context(),
            CancellableDispatcher::default(),
        )
        .unwrap();
        let response: Value = serde_json::from_slice(&output.lock().unwrap()).unwrap();
        assert_eq!(response["id"], 42);
        assert_eq!(
            response["result"]["structuredContent"]["code"],
            "rudder_mcp_cancelled"
        );
    }

    #[test]
    fn concurrent_stdio_cancels_only_the_selected_request() {
        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"rudder_agent_me\",\"arguments\":{}}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"rudder_agent_me\",\"arguments\":{}}}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":1}}\n",
        );
        let output = Arc::new(Mutex::new(Vec::new()));
        struct SharedOutput(Arc<Mutex<Vec<u8>>>);
        impl Write for SharedOutput {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().write(bytes)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        run_concurrent_stdio(
            DelayedEofReader {
                bytes: input.as_bytes(),
                delivered: false,
            },
            SharedOutput(Arc::clone(&output)),
            Surface::Core,
            complete_context(),
            SelectiveDispatcher::default(),
        )
        .unwrap();
        let responses = String::from_utf8(output.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(responses.len(), 2);
        let cancelled = responses
            .iter()
            .find(|response| response["id"] == 1)
            .unwrap();
        let succeeded = responses
            .iter()
            .find(|response| response["id"] == 2)
            .unwrap();
        assert_eq!(
            cancelled["result"]["structuredContent"]["code"],
            "rudder_mcp_cancelled"
        );
        assert_eq!(succeeded["result"]["isError"], false);
    }

    #[test]
    fn stdin_eof_cancels_active_dispatch() {
        let input = "{\"jsonrpc\":\"2.0\",\"id\":42,\"method\":\"tools/call\",\"params\":{\"name\":\"rudder_agent_me\",\"arguments\":{}}}\n";
        let output = Arc::new(Mutex::new(Vec::new()));
        struct SharedOutput(Arc<Mutex<Vec<u8>>>);
        impl Write for SharedOutput {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().write(bytes)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        run_concurrent_stdio(
            input.as_bytes(),
            SharedOutput(Arc::clone(&output)),
            Surface::Core,
            complete_context(),
            CancellableDispatcher::default(),
        )
        .unwrap();
        let response: Value = serde_json::from_slice(&output.lock().unwrap()).unwrap();
        assert_eq!(
            response["result"]["structuredContent"]["code"],
            "rudder_mcp_cancelled"
        );
    }
}
