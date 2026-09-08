//! Contract and transport primitives for the first-party Rust Agent surfaces.
//!
//! The crate intentionally does not own authentication, product writes, or
//! database state. It validates the host-provided runtime envelope and exposes
//! bounded protocol helpers that a future Rust CLI/MCP binary can reuse.

use rudder_workspace_manifest_core::{ManifestLimits, list_directory};
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::Path;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use thiserror::Error;

pub const RUDDER_MCP_CONTRACT_VERSION: &str = "rudder.agent-mcp-tools/v1";
pub const RUDDER_MCP_MODERN_PROTOCOL_VERSION: &str = "2026-07-28";
pub const RUDDER_MCP_LEGACY_PROTOCOL_VERSIONS: &[&str] = &[
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];
pub const DEFAULT_WORKSPACE_MAX_ENTRIES: u64 = 10_000;
pub const DEFAULT_WORKSPACE_MAX_PATH_BYTES: u64 = 1_048_576;
const MAX_WORKSPACE_ENTRIES: u64 = 100_000;
const MAX_WORKSPACE_PATH_BYTES: u64 = 16 * 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES: usize = 1_000_000;
const DEFAULT_MAX_HEADER_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("{code}: {message}")]
pub struct McpError {
    code: &'static str,
    message: String,
    missing_keys: Vec<&'static str>,
    reserved_arguments: Vec<String>,
}

impl McpError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            missing_keys: Vec::new(),
            reserved_arguments: Vec::new(),
        }
    }

    fn with_missing(
        code: &'static str,
        message: impl Into<String>,
        keys: Vec<&'static str>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            missing_keys: keys,
            reserved_arguments: Vec::new(),
        }
    }

    fn with_reserved(arguments: Vec<String>) -> Self {
        Self {
            code: "rudder_mcp_reserved_identity_argument",
            message: "model arguments cannot override managed runtime identity".to_owned(),
            missing_keys: Vec::new(),
            reserved_arguments: arguments,
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("rudder_mcp_invalid_request", message)
    }

    fn too_large(message: impl Into<String>) -> Self {
        Self::new("rudder_mcp_response_too_large", message)
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn missing_keys(&self) -> &[&'static str] {
        &self.missing_keys
    }

    pub fn reserved_arguments(&self) -> &[String] {
        &self.reserved_arguments
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityContract {
    pub id: &'static str,
    pub command: &'static str,
    pub mcp_name: &'static str,
    pub mutating: bool,
    pub read_only: bool,
    pub host_scoped_root: bool,
    pub requires_org_id: bool,
    pub requires_agent_id: bool,
    pub requires_run_id: bool,
}

impl CapabilityContract {
    pub fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "directory": { "type": "string" },
                "maxEntries": { "type": "integer", "minimum": 1 },
                "maxPathBytes": { "type": "integer", "minimum": 1 }
            }
        })
    }
}

static WORKSPACE_LIST: CapabilityContract = CapabilityContract {
    id: "workspace.list",
    command: "workspace list",
    mcp_name: "rudder_workspace_list",
    mutating: false,
    read_only: true,
    host_scoped_root: true,
    requires_org_id: false,
    requires_agent_id: false,
    requires_run_id: false,
};

pub fn capability_by_id(id: &str) -> Option<&'static CapabilityContract> {
    (id == WORKSPACE_LIST.id).then_some(&WORKSPACE_LIST)
}

pub fn capabilities() -> Vec<&'static CapabilityContract> {
    vec![&WORKSPACE_LIST]
}

pub fn capability_registry() -> BTreeMap<String, &'static CapabilityContract> {
    [(WORKSPACE_LIST.id.to_owned(), &WORKSPACE_LIST)]
        .into_iter()
        .collect()
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListRequest {
    pub directory: String,
    pub max_entries: u64,
    pub max_path_bytes: u64,
}

impl WorkspaceListRequest {
    pub fn from_json(value: &Value) -> Result<Self, McpError> {
        let object = value
            .as_object()
            .ok_or_else(|| McpError::invalid("workspace.list params must be an object"))?;
        let allowed = BTreeSet::from(["directory", "maxEntries", "maxPathBytes"]);
        if let Some(unknown) = object.keys().find(|key| !allowed.contains(key.as_str())) {
            return Err(McpError::invalid(format!(
                "unknown workspace.list argument {unknown}"
            )));
        }
        if object.contains_key("root") {
            return Err(McpError::invalid(
                "workspace root is supplied by the managed host",
            ));
        }
        let directory = object
            .get("directory")
            .and_then(Value::as_str)
            .unwrap_or("projects")
            .to_owned();
        if directory.trim().is_empty() {
            return Err(McpError::invalid("directory must not be empty"));
        }
        let max_entries = object
            .get("maxEntries")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_WORKSPACE_MAX_ENTRIES);
        let max_path_bytes = object
            .get("maxPathBytes")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_WORKSPACE_MAX_PATH_BYTES);
        if !(1..=MAX_WORKSPACE_ENTRIES).contains(&max_entries)
            || !(1..=MAX_WORKSPACE_PATH_BYTES).contains(&max_path_bytes)
        {
            return Err(McpError::invalid(
                "workspace.list limits are outside the bounded range",
            ));
        }
        Ok(Self {
            directory,
            max_entries,
            max_path_bytes,
        })
    }
}

impl Default for WorkspaceListRequest {
    fn default() -> Self {
        Self {
            directory: "projects".to_owned(),
            max_entries: DEFAULT_WORKSPACE_MAX_ENTRIES,
            max_path_bytes: DEFAULT_WORKSPACE_MAX_PATH_BYTES,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceListResult {
    pub directory_path: String,
    pub entries: Vec<WorkspaceListEntry>,
}

pub fn list_workspace_directory(
    root: &Path,
    request: &WorkspaceListRequest,
) -> Result<WorkspaceListResult, McpError> {
    let result = list_directory(
        root,
        Path::new(&request.directory),
        ManifestLimits {
            max_entries: request.max_entries,
            max_path_bytes: request.max_path_bytes,
        },
    )
    .map_err(|error| McpError::new("rudder_mcp_workspace_error", error.to_string()))?;
    Ok(WorkspaceListResult {
        directory_path: result.directory_path,
        entries: result
            .entries
            .into_iter()
            .map(|entry| WorkspaceListEntry {
                name: entry.name,
                path: entry.path,
                is_directory: entry.is_directory,
            })
            .collect(),
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdentityRequirements {
    pub require_api_url: bool,
    pub require_api_key: bool,
    pub require_org_id: bool,
    pub require_agent_id: bool,
    pub require_run_id: bool,
}

impl Default for IdentityRequirements {
    fn default() -> Self {
        Self {
            require_api_url: true,
            require_api_key: true,
            require_org_id: false,
            require_agent_id: false,
            require_run_id: false,
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct ManagedIdentity {
    api_url: String,
    api_key: String,
    org_id: Option<String>,
    agent_id: Option<String>,
    run_id: Option<String>,
}

impl fmt::Debug for ManagedIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ManagedIdentity")
            .field("api_url", &self.api_url)
            .field("api_key", &"<redacted>")
            .field("org_id", &self.org_id)
            .field("agent_id", &self.agent_id)
            .field("run_id", &self.run_id)
            .finish()
    }
}

impl ManagedIdentity {
    pub fn api_url(&self) -> &str {
        &self.api_url
    }

    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    pub fn org_id(&self) -> Option<&str> {
        self.org_id.as_deref()
    }

    pub fn agent_id(&self) -> Option<&str> {
        self.agent_id.as_deref()
    }

    pub fn run_id(&self) -> Option<&str> {
        self.run_id.as_deref()
    }
}

pub fn validate_managed_identity(
    environment: &BTreeMap<String, String>,
    requirements: IdentityRequirements,
) -> Result<ManagedIdentity, McpError> {
    let mut required = Vec::new();
    if requirements.require_api_url {
        required.push("RUDDER_API_URL");
    }
    if requirements.require_api_key {
        required.push("RUDDER_API_KEY");
    }
    if requirements.require_org_id {
        required.push("RUDDER_ORG_ID");
    }
    if requirements.require_agent_id {
        required.push("RUDDER_AGENT_ID");
    }
    if requirements.require_run_id {
        required.push("RUDDER_RUN_ID");
    }
    let missing = required
        .into_iter()
        .filter(|key| {
            environment
                .get(*key)
                .is_none_or(|value| value.trim().is_empty())
        })
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(McpError::with_missing(
            "rudder_mcp_missing_runtime_context",
            format!("missing managed runtime keys: {}", missing.join(", ")),
            missing,
        ));
    }
    let value = |key: &str| environment.get(key).map(|item| item.trim().to_owned());
    Ok(ManagedIdentity {
        api_url: value("RUDDER_API_URL").unwrap_or_default(),
        api_key: value("RUDDER_API_KEY").unwrap_or_default(),
        org_id: value("RUDDER_ORG_ID"),
        agent_id: value("RUDDER_AGENT_ID"),
        run_id: value("RUDDER_RUN_ID"),
    })
}

pub fn reject_model_identity_overrides(arguments: &Value) -> Result<(), McpError> {
    let Some(object) = arguments.as_object() else {
        return Ok(());
    };
    let mut reserved = object
        .keys()
        .filter(|key| {
            key.starts_with("RUDDER_")
                || matches!(
                    normalize_identity_key(key).as_str(),
                    "orgid"
                        | "companyid"
                        | "agentid"
                        | "runid"
                        | "apibase"
                        | "apikey"
                        | "authorization"
                )
        })
        .cloned()
        .collect::<Vec<_>>();
    reserved.sort();
    reserved.dedup();
    if reserved.is_empty() {
        Ok(())
    } else {
        Err(McpError::with_reserved(reserved))
    }
}

fn normalize_identity_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ResponseLimits {
    pub max_bytes: usize,
    pub inline_text_bytes: usize,
}

impl ResponseLimits {
    pub fn core() -> Self {
        Self {
            max_bytes: 1_000_000,
            inline_text_bytes: 32_000,
        }
    }
}

pub fn json_rpc_result(id: Value, structured_content: Value) -> Value {
    let text = serde_json::to_string(&structured_content).unwrap_or_else(|_| "{}".to_owned());
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "isError": false,
            "content": [{"type": "text", "text": text}],
            "structuredContent": structured_content,
        }
    })
}

pub fn bounded_json_rpc_result(
    id: Value,
    structured_content: Value,
    limits: ResponseLimits,
) -> Result<Value, McpError> {
    let response = json_rpc_result(id.clone(), structured_content);
    if serde_json::to_vec(&response)
        .map(|bytes| bytes.len() <= limits.max_bytes)
        .unwrap_or(false)
    {
        return Ok(response);
    }
    Ok(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "isError": true,
            "content": [{"type": "text", "text": "rudder_mcp_response_too_large"}],
            "structuredContent": {
                "status": "error",
                "code": "rudder_mcp_response_too_large",
                "message": "response exceeded the bounded MCP result size"
            }
        }
    }))
}

pub fn unsupported_method_response(id: Value, method: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32601, "message": format!("Unsupported JSON-RPC method: {method}") }
    })
}

pub fn invalid_request_response(id: Value, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32602, "message": message }
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FrameMode {
    Newline,
    ContentLength,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FrameLimits {
    pub max_frame_bytes: usize,
    pub max_header_bytes: usize,
}

impl Default for FrameLimits {
    fn default() -> Self {
        Self {
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            max_header_bytes: DEFAULT_MAX_HEADER_BYTES,
        }
    }
}

pub fn encode_frame(
    value: &Value,
    mode: FrameMode,
    limits: FrameLimits,
) -> Result<Vec<u8>, McpError> {
    if limits.max_frame_bytes == 0 || limits.max_header_bytes == 0 {
        return Err(McpError::invalid("frame limits must be positive"));
    }
    let body = serde_json::to_vec(value).map_err(|error| {
        McpError::invalid(format!("JSON-RPC response is not serializable: {error}"))
    })?;
    if body.len() > limits.max_frame_bytes {
        return Err(McpError::too_large(
            "JSON-RPC frame exceeds the configured byte limit",
        ));
    }
    let mut encoded = match mode {
        FrameMode::Newline => {
            let mut bytes = body;
            bytes.push(b'\n');
            bytes
        }
        FrameMode::ContentLength => {
            let header = format!("Content-Length: {}\r\n\r\n", body.len());
            if header.len() > limits.max_header_bytes {
                return Err(McpError::too_large(
                    "JSON-RPC frame header exceeds the configured byte limit",
                ));
            }
            let mut bytes = header.into_bytes();
            bytes.extend_from_slice(&body);
            bytes
        }
    };
    if encoded.len()
        > limits
            .max_frame_bytes
            .saturating_add(limits.max_header_bytes)
    {
        return Err(McpError::too_large("encoded JSON-RPC frame is too large"));
    }
    Ok(std::mem::take(&mut encoded))
}

#[derive(Clone)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
pub struct InputParser {
    buffer: Vec<u8>,
    mode: Option<FrameMode>,
    limits: FrameLimits,
    cancellation: CancellationToken,
}

impl InputParser {
    pub fn with_limits(limits: FrameLimits) -> Result<Self, McpError> {
        if limits.max_frame_bytes == 0 || limits.max_header_bytes == 0 {
            return Err(McpError::invalid("frame limits must be positive"));
        }
        Ok(Self {
            buffer: Vec::new(),
            mode: None,
            limits,
            cancellation: CancellationToken::new(),
        })
    }

    pub fn with_cancellation(
        limits: FrameLimits,
        cancellation: CancellationToken,
    ) -> Result<Self, McpError> {
        let mut parser = Self::with_limits(limits)?;
        parser.cancellation = cancellation;
        Ok(parser)
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Value>, McpError> {
        if self.cancellation.is_cancelled() {
            self.buffer.clear();
            return Err(McpError::new(
                "rudder_mcp_cancelled",
                "MCP input was cancelled",
            ));
        }
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len()
            > self
                .limits
                .max_frame_bytes
                .saturating_add(self.limits.max_header_bytes)
        {
            self.buffer.clear();
            return Err(McpError::too_large(
                "MCP input exceeded the configured frame limit",
            ));
        }
        if self.mode.is_none() {
            const CONTENT_LENGTH_PREFIX: &[u8] = b"Content-Length:";
            if CONTENT_LENGTH_PREFIX.starts_with(&self.buffer) {
                return Ok(Vec::new());
            }
            self.mode = Some(if self.buffer.starts_with(CONTENT_LENGTH_PREFIX) {
                FrameMode::ContentLength
            } else {
                FrameMode::Newline
            });
        }
        match self.mode.expect("parser mode is set above") {
            FrameMode::Newline => self.parse_newline(),
            FrameMode::ContentLength => self.parse_content_length(),
        }
    }

    pub fn finish(&mut self) -> Result<Vec<Value>, McpError> {
        if self.cancellation.is_cancelled() {
            self.buffer.clear();
            return Err(McpError::new(
                "rudder_mcp_cancelled",
                "MCP input was cancelled",
            ));
        }
        if self.buffer.is_empty() {
            Ok(Vec::new())
        } else {
            Err(McpError::invalid("MCP input ended with a partial frame"))
        }
    }

    fn parse_newline(&mut self) -> Result<Vec<Value>, McpError> {
        let mut messages = Vec::new();
        while let Some(position) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line = self.buffer.drain(..=position).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            if line.len() > self.limits.max_frame_bytes {
                self.buffer.clear();
                return Err(McpError::too_large("MCP newline frame is too large"));
            }
            messages.push(parse_json_message(&line)?);
        }
        if self.buffer.len() > self.limits.max_frame_bytes {
            self.buffer.clear();
            return Err(McpError::too_large("MCP newline frame is too large"));
        }
        if complete_value_has_trailing_data(&self.buffer) {
            self.buffer.clear();
            return Err(McpError::invalid(
                "newline-delimited input contains trailing frame data",
            ));
        }
        Ok(messages)
    }

    fn parse_content_length(&mut self) -> Result<Vec<Value>, McpError> {
        let mut messages = Vec::new();
        loop {
            let Some(header_end) = find_subslice(&self.buffer, b"\r\n\r\n") else {
                if self.buffer.len() > self.limits.max_header_bytes {
                    self.buffer.clear();
                    return Err(McpError::too_large("MCP header is too large"));
                }
                return Ok(messages);
            };
            let header_len = header_end + 4;
            if header_len > self.limits.max_header_bytes {
                self.buffer.clear();
                return Err(McpError::too_large("MCP header is too large"));
            }
            let header = String::from_utf8(self.buffer[..header_end].to_vec())
                .map_err(|_| McpError::invalid("MCP header is not UTF-8"))?;
            let content_length = header
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .ok_or_else(|| McpError::invalid("Content-Length header is required"))?;
            if content_length > self.limits.max_frame_bytes {
                self.buffer.clear();
                return Err(McpError::too_large("MCP content frame is too large"));
            }
            if self.buffer.len() < header_len + content_length {
                return Ok(messages);
            }
            let body = self.buffer[header_len..header_len + content_length].to_vec();
            self.buffer.drain(..header_len + content_length);
            messages.push(parse_json_message(&body)?);
            if self.buffer.is_empty() {
                return Ok(messages);
            }
        }
    }
}

fn parse_json_message(bytes: &[u8]) -> Result<Value, McpError> {
    serde_json::from_slice(bytes)
        .map_err(|error| McpError::invalid(format!("invalid JSON-RPC request: {error}")))
}

fn complete_value_has_trailing_data(bytes: &[u8]) -> bool {
    let mut values = serde_json::Deserializer::from_slice(bytes).into_iter::<Value>();
    matches!(values.next(), Some(Ok(_))) && values.next().is_some()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

pub fn is_supported_protocol_version(version: &str) -> bool {
    version == RUDDER_MCP_MODERN_PROTOCOL_VERSION
        || RUDDER_MCP_LEGACY_PROTOCOL_VERSIONS.contains(&version)
}

pub fn has_conflicting_protocol_versions(value: &Value) -> bool {
    let request = value.get("protocolVersion").and_then(Value::as_str);
    let metadata = value
        .get("_meta")
        .and_then(Value::as_object)
        .and_then(|object| object.get("io.modelcontextprotocol/protocolVersion"))
        .and_then(Value::as_str);
    matches!((request, metadata), (Some(left), Some(right)) if left != right)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn workspace_list_contract_is_read_only_and_host_scoped() {
        let contract = capability_by_id("workspace.list").expect("workspace.list contract");
        assert_eq!(contract.command, "workspace list");
        assert!(!contract.mutating);
        assert!(contract.host_scoped_root);
        assert_eq!(contract.mcp_name, "rudder_workspace_list");
        assert!(contract.read_only);
        assert!(!contract.requires_org_id);
        assert!(!contract.requires_agent_id);
        assert!(!contract.requires_run_id);
    }

    #[test]
    fn registry_exposes_only_the_read_only_contract_and_its_input_shape() {
        assert_eq!(capabilities().len(), 1);
        let registry = capability_registry();
        let contract = registry.get("workspace.list").unwrap();
        let schema = contract.input_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["properties"]["directory"]["type"], "string");
        assert_eq!(schema["properties"]["maxEntries"]["type"], "integer");
    }

    #[test]
    fn workspace_list_request_defaults_and_rejects_model_owned_root() {
        let request = WorkspaceListRequest::from_json(&json!({})).unwrap();
        assert_eq!(request.directory, "projects");
        assert_eq!(request.max_entries, DEFAULT_WORKSPACE_MAX_ENTRIES);
        assert_eq!(request.max_path_bytes, DEFAULT_WORKSPACE_MAX_PATH_BYTES);
        let error =
            WorkspaceListRequest::from_json(&json!({"root": "/tmp/workspace"})).unwrap_err();
        assert_eq!(error.code(), "rudder_mcp_invalid_request");
    }

    #[test]
    fn managed_identity_requires_server_context_and_redacts_its_key() {
        let mut env = BTreeMap::from([
            (
                "RUDDER_API_URL".to_owned(),
                "https://rudder.test/api".to_owned(),
            ),
            ("RUDDER_API_KEY".to_owned(), "secret-value".to_owned()),
            ("RUDDER_ORG_ID".to_owned(), "org-1".to_owned()),
            ("RUDDER_AGENT_ID".to_owned(), "agent-1".to_owned()),
            ("RUDDER_RUN_ID".to_owned(), "run-1".to_owned()),
        ]);
        let identity = validate_managed_identity(
            &env,
            IdentityRequirements {
                require_org_id: true,
                require_agent_id: true,
                require_run_id: true,
                ..IdentityRequirements::default()
            },
        )
        .unwrap();
        assert_eq!(identity.api_url(), "https://rudder.test/api");
        assert_eq!(identity.api_key(), "secret-value");
        assert_eq!(identity.org_id(), Some("org-1"));
        assert!(!format!("{identity:?}").contains("secret-value"));
        env.insert("RUDDER_API_KEY".to_owned(), "  ".to_owned());
        let error = validate_managed_identity(&env, IdentityRequirements::default()).unwrap_err();
        assert_eq!(error.code(), "rudder_mcp_missing_runtime_context");
        assert_eq!(error.missing_keys(), &["RUDDER_API_KEY"]);
    }

    #[test]
    fn model_cannot_override_managed_identity_using_aliases_or_rudder_keys() {
        let error = reject_model_identity_overrides(&json!({
            "agentID": "attacker-agent",
            "RUDDER_ORG_ID": "attacker-org",
            "authorization": "Bearer attacker",
        }))
        .unwrap_err();
        assert_eq!(error.code(), "rudder_mcp_reserved_identity_argument");
        assert_eq!(
            error.reserved_arguments(),
            &["RUDDER_ORG_ID", "agentID", "authorization"]
        );
    }

    #[test]
    fn json_rpc_responses_are_bounded_and_use_stable_oversized_error() {
        let response =
            bounded_json_rpc_result(json!(7), json!({"value": "ok"}), ResponseLimits::core())
                .unwrap();
        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["id"], 7);
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(response["result"]["structuredContent"]["value"], "ok");
        let oversized = bounded_json_rpc_result(
            json!(8),
            json!({"value": "x".repeat(4096)}),
            ResponseLimits {
                max_bytes: 1024,
                inline_text_bytes: 32,
            },
        )
        .unwrap();
        assert_eq!(oversized["result"]["isError"], true);
        assert_eq!(
            oversized["result"]["structuredContent"]["code"],
            "rudder_mcp_response_too_large"
        );
    }

    #[test]
    fn unsupported_and_invalid_json_rpc_errors_match_mcp_codes() {
        let unsupported = unsupported_method_response(json!(1), "not/a-method");
        assert_eq!(unsupported["error"]["code"], -32601);
        assert_eq!(
            unsupported["error"]["message"],
            "Unsupported JSON-RPC method: not/a-method"
        );
        let invalid = invalid_request_response(json!(2), "params must be an object");
        assert_eq!(invalid["error"]["code"], -32602);
        assert_eq!(invalid["error"]["message"], "params must be an object");
    }

    #[test]
    fn newline_and_content_length_framing_round_trip_utf8_by_bytes() {
        let response = json_rpc_result(json!("req-1"), json!({"text": "你好"}));
        let newline = encode_frame(&response, FrameMode::Newline, FrameLimits::default()).unwrap();
        assert!(newline.ends_with(b"\n"));
        let mut newline_parser = InputParser::default();
        let mut messages = Vec::new();
        for chunk in newline.chunks(2) {
            messages.extend(newline_parser.push(chunk).unwrap());
        }
        assert_eq!(messages, vec![response.clone()]);
        let framed =
            encode_frame(&response, FrameMode::ContentLength, FrameLimits::default()).unwrap();
        assert!(framed.starts_with(b"Content-Length: "));
        let mut framed_parser = InputParser::default();
        let mut framed_messages = Vec::new();
        for chunk in framed.chunks(3) {
            framed_messages.extend(framed_parser.push(chunk).unwrap());
        }
        assert_eq!(framed_messages, vec![response]);
    }

    #[test]
    fn parser_rejects_invalid_and_oversized_input_without_panicking() {
        let mut parser = InputParser::with_limits(FrameLimits {
            max_frame_bytes: 64,
            max_header_bytes: 64,
        })
        .unwrap();
        let error = parser.push(br#"{"method":"ping","id":1}\\n"#).unwrap_err();
        assert_eq!(error.code(), "rudder_mcp_invalid_request");
        let mut parser = InputParser::with_limits(FrameLimits {
            max_frame_bytes: 4,
            max_header_bytes: 64,
        })
        .unwrap();
        let error = parser.push(br#"{"method":"ping"}\n"#).unwrap_err();
        assert_eq!(error.code(), "rudder_mcp_response_too_large");
    }

    #[test]
    fn cancellation_discards_partial_input_and_stops_future_parsing() {
        let token = CancellationToken::new();
        let mut parser =
            InputParser::with_cancellation(FrameLimits::default(), token.clone()).unwrap();
        assert!(
            parser
                .push(br#"{"jsonrpc":"2.0","id":1,"method":"ping""#)
                .unwrap()
                .is_empty()
        );
        token.cancel();
        let error = parser.push(b"}\n").unwrap_err();
        assert_eq!(error.code(), "rudder_mcp_cancelled");
        assert!(parser.finish().is_err());
    }

    #[test]
    fn workspace_list_uses_the_scoped_manifest_reader_without_writes() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("projects")).unwrap();
        std::fs::write(root.path().join("projects/readme.md"), b"read me").unwrap();
        let request = WorkspaceListRequest::default();
        let result = list_workspace_directory(root.path(), &request).unwrap();
        assert_eq!(result.directory_path, "projects");
        assert_eq!(result.entries[0].path, "projects/readme.md");
        assert!(!root.path().join(".manifest.json").exists());
    }

    #[test]
    fn protocol_version_helpers_match_the_node_mcp_contract() {
        assert_eq!(RUDDER_MCP_CONTRACT_VERSION, "rudder.agent-mcp-tools/v1");
        assert_eq!(RUDDER_MCP_MODERN_PROTOCOL_VERSION, "2026-07-28");
        assert!(is_supported_protocol_version("2025-11-25"));
        assert!(!is_supported_protocol_version("2026-01-01"));
        assert!(has_conflicting_protocol_versions(&json!({
            "protocolVersion": "2025-11-25",
            "_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}
        })));
    }
}
