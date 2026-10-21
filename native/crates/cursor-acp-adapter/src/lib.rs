//! Cursor ACP protocol boundary for native chat.
//!
//! This crate is intentionally a protocol and state boundary.  It does not
//! launch Cursor, read a private IDE database, write Rudder persistence, or
//! decide a Run's terminal state.  A Host adapter owns transport and a Rust
//! worker owns admission, attribution, persistence, and terminal effects.
//!
//! Cursor ACP has several extensions whose exact availability is version and
//! account dependent.  Unknown messages and capabilities are retained as
//! explicit values so a caller cannot accidentally turn a partial probe into
//! a full-native claim.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fmt;
use thiserror::Error;
use uuid::Uuid;

mod rules;
mod transport;

pub use rules::{CursorManagedInstructionRule, MANAGED_INSTRUCTION_RULES_SUPPORTED};
pub use transport::{
    CursorAcpHome, CursorAcpProcessLaunch, CursorAcpTransport, CursorAcpTransportError,
};

pub const ACP_PROTOCOL_VERSION: &str = "1.0";
pub const MAX_ID_BYTES: usize = 256;
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_RAW_MESSAGE_BYTES: usize = 512 * 1024;
pub const MAX_SUPPLEMENT_BYTES: usize = 256 * 1024;
pub const MAX_UPDATE_COUNT: usize = 100_000;

const SESSION_NEW: &str = "session/new";
const SESSION_LOAD: &str = "session/load";
const SESSION_PROMPT: &str = "session/prompt";
const SESSION_UPDATE: &str = "session/update";
const SESSION_CANCEL: &str = "session/cancel";
const SESSION_REQUEST_PERMISSION: &str = "session/request_permission";
const AUTHENTICATE: &str = "authenticate";
const CURSOR_ASK_QUESTION: &str = "cursor/ask_question";
const CURSOR_CREATE_PLAN: &str = "cursor/create_plan";
const CURSOR_UPDATE_TODOS: &str = "cursor/update_todos";
const CURSOR_TASK: &str = "cursor/task";
const CURSOR_GENERATE_IMAGE: &str = "cursor/generate_image";

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum CursorAcpError {
    #[error("invalid {field}")]
    InvalidField { field: &'static str },
    #[error("{field} exceeds {limit} bytes")]
    TooLarge { field: &'static str, limit: usize },
    #[error("invalid JSON-RPC message: {0}")]
    InvalidMessage(String),
    #[error("unsupported ACP capability: {0}")]
    UnsupportedCapability(&'static str),
    #[error("invalid session transition: {0}")]
    InvalidTransition(&'static str),
    #[error("unknown response id {0}")]
    UnknownResponseId(String),
}

fn bounded(
    value: impl Into<String>,
    field: &'static str,
    limit: usize,
) -> Result<String, CursorAcpError> {
    let value = value.into();
    if value.trim().is_empty() {
        return Err(CursorAcpError::InvalidField { field });
    }
    if value.len() > limit {
        return Err(CursorAcpError::TooLarge { field, limit });
    }
    Ok(value)
}

fn bounded_optional(
    value: Option<String>,
    field: &'static str,
    limit: usize,
) -> Result<Option<String>, CursorAcpError> {
    value.map(|value| bounded(value, field, limit)).transpose()
}

/// Opaque ACP session identifier.  Never derive identity from an array index,
/// timestamp, or a private Cursor file path.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct SessionId(String);

impl SessionId {
    pub fn new(value: impl Into<String>) -> Result<Self, CursorAcpError> {
        Ok(Self(bounded(value, "sessionId", MAX_ID_BYTES)?))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(u64),
    String(String),
}

impl RequestId {
    pub fn new_string(value: impl Into<String>) -> Result<Self, CursorAcpError> {
        Ok(Self::String(bounded(value, "requestId", MAX_ID_BYTES)?))
    }

    pub fn generated(sequence: u64) -> Self {
        Self::String(format!("rudder-cursor-{sequence}"))
    }

    /// Return the bounded provider request identity in a stable form for
    /// durable Native Chat evidence. Numeric ACP ids are represented in base
    /// ten; string ids are returned unchanged. This does not create or infer
    /// a Codex Thread/Turn identity.
    pub fn as_string(&self) -> String {
        match self {
            Self::Number(value) => value.to_string(),
            Self::String(value) => value.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityStatus {
    Unknown,
    Documented,
    Observed,
    Verified,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    SessionNew,
    SessionLoad,
    SessionPrompt,
    SessionUpdate,
    SessionCancel,
    PermissionRequest,
    AskQuestion,
    CreatePlan,
    Notifications,
    PreciseFork,
    Steer,
    CompleteHistory,
    ProjectMcp,
    UserMcp,
    TeamMcp,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityObservation {
    pub status: CapabilityStatus,
    pub evidence: String,
}

impl CapabilityObservation {
    pub fn new(
        status: CapabilityStatus,
        evidence: impl Into<String>,
    ) -> Result<Self, CursorAcpError> {
        Ok(Self {
            status,
            evidence: bounded(evidence, "evidence", MAX_TEXT_BYTES)?,
        })
    }
}

/// Capability evidence is intentionally persisted as a report rather than a
/// set of booleans.  `Verified` requires an independent real-environment
/// acceptance; a protocol document or parser fixture is only `Documented` or
/// `Observed`.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityReport {
    pub protocol_version: String,
    pub capabilities: BTreeMap<Capability, CapabilityObservation>,
}

impl CapabilityReport {
    pub fn new(protocol_version: impl Into<String>) -> Result<Self, CursorAcpError> {
        Ok(Self {
            protocol_version: bounded(protocol_version, "protocolVersion", 32)?,
            capabilities: BTreeMap::new(),
        })
    }

    pub fn record(&mut self, capability: Capability, observation: CapabilityObservation) {
        self.capabilities.insert(capability, observation);
    }

    pub fn status(&self, capability: Capability) -> CapabilityStatus {
        self.capabilities
            .get(&capability)
            .map(|observation| observation.status)
            .unwrap_or(CapabilityStatus::Unknown)
    }

    pub fn verified(&self, capability: Capability) -> bool {
        self.status(capability) == CapabilityStatus::Verified
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: u16,
    pub client_capabilities: ClientCapabilities,
    pub client_info: ClientInfo,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    #[serde(default)]
    pub fs: FileSystemCapabilities,
    #[serde(default)]
    pub terminal: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSystemCapabilities {
    #[serde(default)]
    pub read_text_file: bool,
    #[serde(default)]
    pub write_text_file: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

impl InitializeParams {
    pub fn new(
        client_name: impl Into<String>,
        client_version: Option<String>,
    ) -> Result<Self, CursorAcpError> {
        Ok(Self {
            protocol_version: 1,
            client_capabilities: ClientCapabilities::default(),
            client_info: ClientInfo {
                name: bounded(client_name, "clientInfo.name", 128)?,
                version: bounded_optional(client_version, "clientInfo.version", 64)?,
            },
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateParams {
    pub method_id: String,
}

impl AuthenticateParams {
    pub fn cursor_login() -> Self {
        Self {
            method_id: "cursor_login".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNewParams {
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default)]
    pub mcp_servers: Vec<Value>,
}

impl SessionNewParams {
    pub fn new(cwd: impl Into<String>) -> Result<Self, CursorAcpError> {
        Ok(Self {
            cwd: bounded(cwd, "cwd", MAX_ID_BYTES * 16)?,
            mode: None,
            mcp_servers: Vec::new(),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLoadParams {
    pub session_id: SessionId,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

impl SessionLoadParams {
    pub fn new(session_id: SessionId, cwd: impl Into<String>) -> Result<Self, CursorAcpError> {
        Ok(Self {
            session_id,
            cwd: bounded(cwd, "cwd", MAX_ID_BYTES * 16)?,
            mode: None,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptParams {
    pub session_id: SessionId,
    pub prompt: Vec<PromptContent>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PromptContent {
    Text { text: String },
}

impl SessionPromptParams {
    pub fn new(session_id: SessionId, prompt: impl Into<String>) -> Result<Self, CursorAcpError> {
        Ok(Self {
            session_id,
            prompt: vec![PromptContent::Text {
                text: bounded(prompt, "prompt", MAX_TEXT_BYTES)?,
            }],
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCancelParams {
    pub session_id: SessionId,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CursorAcpCommand {
    Initialize { params: InitializeParams },
    Authenticate { params: AuthenticateParams },
    SessionNew { params: SessionNewParams },
    SessionLoad { params: SessionLoadParams },
    SessionPrompt { params: SessionPromptParams },
    SessionCancel { params: SessionCancelParams },
}

impl CursorAcpCommand {
    pub fn request(self, id: RequestId) -> Result<JsonRpcRequest, CursorAcpError> {
        let (method, params) = match self {
            Self::Initialize { params } => ("initialize", serde_json::to_value(params)),
            Self::Authenticate { params } => (AUTHENTICATE, serde_json::to_value(params)),
            Self::SessionNew { params } => (SESSION_NEW, serde_json::to_value(params)),
            Self::SessionLoad { params } => (SESSION_LOAD, serde_json::to_value(params)),
            Self::SessionPrompt { params } => (SESSION_PROMPT, serde_json::to_value(params)),
            Self::SessionCancel { params } => (SESSION_CANCEL, serde_json::to_value(params)),
        };
        Ok(JsonRpcRequest {
            jsonrpc: "2.0".to_owned(),
            id,
            method: method.to_owned(),
            params: params.map_err(|error| CursorAcpError::InvalidMessage(error.to_string()))?,
        })
    }

    pub fn precise_fork(&self) -> Result<(), CursorAcpError> {
        Err(CursorAcpError::UnsupportedCapability("precise_fork"))
    }

    pub fn steer(&self) -> Result<(), CursorAcpError> {
        Err(CursorAcpError::UnsupportedCapability("steer"))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    pub params: Value,
}

impl JsonRpcRequest {
    pub fn validate(&self) -> Result<(), CursorAcpError> {
        if self.jsonrpc != "2.0" {
            return Err(CursorAcpError::InvalidMessage(
                "jsonrpc must be 2.0".to_owned(),
            ));
        }
        bounded(self.method.clone(), "method", 128)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: RequestId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcResponse {
    pub fn success(id: RequestId, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_owned(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: RequestId, code: i64, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".to_owned(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<Value>,
    #[serde(default)]
    pub options: Vec<PermissionOption>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRequest {
    pub tool_call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub questions: Vec<QuestionItem>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItem {
    pub id: String,
    pub prompt: String,
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub allow_multiple: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequest {
    pub tool_call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overview: Option<String>,
    pub plan: String,
    pub todos: Vec<PlanEntry>,
    #[serde(default)]
    pub is_project: bool,
    #[serde(default)]
    pub phases: Vec<PlanPhase>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanPhase {
    pub name: String,
    pub todos: Vec<PlanEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponse {
    pub outcome: PermissionOutcome,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum PermissionOutcome {
    Selected { option_id: String },
    Rejected { reason: Option<String> },
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResponse {
    pub outcome: QuestionOutcome,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum QuestionOutcome {
    Answered { answers: Vec<QuestionAnswer> },
    Skipped { reason: Option<String> },
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAnswer {
    pub question_id: String,
    pub selected_option_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanResponse {
    pub outcome: PlanOutcome,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum PlanOutcome {
    Accepted { plan_uri: Option<String> },
    Rejected { reason: Option<String> },
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CursorAcpRequest {
    Permission {
        id: RequestId,
        params: PermissionRequest,
    },
    Question {
        id: RequestId,
        params: QuestionRequest,
    },
    Plan {
        id: RequestId,
        params: PlanRequest,
    },
    Unknown {
        id: Option<RequestId>,
        method: String,
        params: Value,
    },
}

impl CursorAcpRequest {
    pub fn id(&self) -> Option<&RequestId> {
        match self {
            Self::Permission { id, .. } | Self::Question { id, .. } | Self::Plan { id, .. } => {
                Some(id)
            }
            Self::Unknown { id, .. } => id.as_ref(),
        }
    }

    pub fn response(&self, result: Value) -> Result<JsonRpcResponse, CursorAcpError> {
        let Some(id) = self.id().cloned() else {
            return Err(CursorAcpError::UnknownResponseId("notification".to_owned()));
        };
        Ok(JsonRpcResponse::success(id, result))
    }

    pub fn permission_response(
        &self,
        outcome: PermissionOutcome,
    ) -> Result<JsonRpcResponse, CursorAcpError> {
        self.response(
            serde_json::to_value(PermissionResponse { outcome })
                .map_err(|error| CursorAcpError::InvalidMessage(error.to_string()))?,
        )
    }

    pub fn question_response(
        &self,
        outcome: QuestionOutcome,
    ) -> Result<JsonRpcResponse, CursorAcpError> {
        self.response(
            serde_json::to_value(QuestionResponse { outcome })
                .map_err(|error| CursorAcpError::InvalidMessage(error.to_string()))?,
        )
    }

    pub fn plan_response(&self, outcome: PlanOutcome) -> Result<JsonRpcResponse, CursorAcpError> {
        self.response(
            serde_json::to_value(PlanResponse { outcome })
                .map_err(|error| CursorAcpError::InvalidMessage(error.to_string()))?,
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionUpdateKind {
    AgentMessageChunk,
    UserMessageChunk,
    ToolCall,
    ToolCallUpdate,
    Plan,
    CurrentModeUpdate,
    AvailableCommandsUpdate,
    ConfigOptionUpdate,
    Task,
    Todo,
    Image,
    Unknown,
}

impl SessionUpdateKind {
    fn from_name(name: &str) -> Self {
        match name {
            "agent_message_chunk" => Self::AgentMessageChunk,
            "user_message_chunk" => Self::UserMessageChunk,
            "tool_call" => Self::ToolCall,
            "tool_call_update" => Self::ToolCallUpdate,
            "plan" => Self::Plan,
            "current_mode_update" => Self::CurrentModeUpdate,
            "available_commands_update" => Self::AvailableCommandsUpdate,
            "config_option_update" => Self::ConfigOptionUpdate,
            "task" => Self::Task,
            "todo" | "todos" => Self::Todo,
            "image" => Self::Image,
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionUpdate {
    pub session_id: SessionId,
    pub kind: SessionUpdateKind,
    pub name: String,
    pub raw: Value,
}

impl SessionUpdate {
    fn parse(params: Value) -> Result<Self, CursorAcpError> {
        let object = params.as_object().ok_or_else(|| {
            CursorAcpError::InvalidMessage("session/update params must be an object".to_owned())
        })?;
        let session_id = get_string(object, "sessionId", "session_id")?;
        let fallback_update = Value::Object(object.clone());
        let update = object.get("update").unwrap_or(&fallback_update);
        let update_object = update.as_object().ok_or_else(|| {
            CursorAcpError::InvalidMessage("session/update update must be an object".to_owned())
        })?;
        let name = get_string(update_object, "sessionUpdate", "session_update")?;
        Ok(Self {
            session_id: SessionId::new(session_id)?,
            kind: SessionUpdateKind::from_name(&name),
            name,
            raw: Value::Object(update_object.clone()),
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoNotification {
    pub tool_call_id: String,
    pub todos: Vec<PlanEntry>,
    pub merge: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskNotification {
    pub tool_call_id: String,
    pub description: String,
    pub prompt: String,
    pub subagent_type: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateImageNotification {
    pub tool_call_id: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default)]
    pub reference_image_paths: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CursorAcpNotification {
    SessionUpdate(SessionUpdate),
    UpdateTodos(TodoNotification),
    Task(TaskNotification),
    GenerateImage(GenerateImageNotification),
    Unknown { method: String, params: Value },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CursorAcpMessage {
    Request(CursorAcpRequest),
    Notification(CursorAcpNotification),
    Response(JsonRpcResponse),
}

pub fn parse_message(bytes: &[u8]) -> Result<CursorAcpMessage, CursorAcpError> {
    if bytes.len() > MAX_RAW_MESSAGE_BYTES {
        return Err(CursorAcpError::TooLarge {
            field: "message",
            limit: MAX_RAW_MESSAGE_BYTES,
        });
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| CursorAcpError::InvalidMessage(error.to_string()))?;
    parse_value(value)
}

pub fn parse_value(value: Value) -> Result<CursorAcpMessage, CursorAcpError> {
    let object = value.as_object().ok_or_else(|| {
        CursorAcpError::InvalidMessage("JSON-RPC message must be an object".to_owned())
    })?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(CursorAcpError::InvalidMessage(
            "jsonrpc must be 2.0".to_owned(),
        ));
    }
    if object.contains_key("method") {
        let method = object
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| CursorAcpError::InvalidMessage("method must be a string".to_owned()))?
            .to_owned();
        let params = object
            .get("params")
            .cloned()
            .unwrap_or(Value::Object(Map::new()));
        if let Some(id_value) = object.get("id") {
            let id = parse_request_id(id_value.clone())?;
            let parsed = match method.as_str() {
                SESSION_REQUEST_PERMISSION => CursorAcpRequest::Permission {
                    id,
                    params: parse_params(params)?,
                },
                CURSOR_ASK_QUESTION => CursorAcpRequest::Question {
                    id,
                    params: parse_params(params)?,
                },
                CURSOR_CREATE_PLAN => CursorAcpRequest::Plan {
                    id,
                    params: parse_params(params)?,
                },
                _ => CursorAcpRequest::Unknown {
                    id: Some(id),
                    method,
                    params,
                },
            };
            return Ok(CursorAcpMessage::Request(parsed));
        }
        let notification = match method.as_str() {
            SESSION_UPDATE => CursorAcpNotification::SessionUpdate(SessionUpdate::parse(params)?),
            CURSOR_UPDATE_TODOS => CursorAcpNotification::UpdateTodos(parse_params(params)?),
            CURSOR_TASK => CursorAcpNotification::Task(parse_params(params)?),
            CURSOR_GENERATE_IMAGE => CursorAcpNotification::GenerateImage(parse_params(params)?),
            _ => CursorAcpNotification::Unknown { method, params },
        };
        return Ok(CursorAcpMessage::Notification(notification));
    }
    let response: JsonRpcResponse = from_value(object.clone())?;
    Ok(CursorAcpMessage::Response(response))
}

fn parse_request_id(value: Value) -> Result<RequestId, CursorAcpError> {
    match value {
        Value::Number(number) => number.as_u64().map(RequestId::Number).ok_or_else(|| {
            CursorAcpError::InvalidMessage("request id must be a non-negative integer".to_owned())
        }),
        Value::String(value) => RequestId::new_string(value),
        _ => Err(CursorAcpError::InvalidMessage(
            "request id must be a string or integer".to_owned(),
        )),
    }
}

fn from_value<T: DeserializeOwned>(value: impl serde::Serialize) -> Result<T, CursorAcpError> {
    let value = serde_json::to_value(value)
        .map_err(|error| CursorAcpError::InvalidMessage(error.to_string()))?;
    serde_json::from_value(value).map_err(|error| CursorAcpError::InvalidMessage(error.to_string()))
}

fn parse_params<T: DeserializeOwned>(value: Value) -> Result<T, CursorAcpError> {
    serde_json::from_value(value).map_err(|error| CursorAcpError::InvalidMessage(error.to_string()))
}

fn get_string(
    object: &Map<String, Value>,
    primary: &'static str,
    alias: &'static str,
) -> Result<String, CursorAcpError> {
    object
        .get(primary)
        .or_else(|| object.get(alias))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or(CursorAcpError::InvalidField { field: primary })
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SupplementReason {
    MissingStableUpdateId,
    PartialSessionLoad,
    UnsupportedCompleteHistory,
    UnsupportedPreciseFork,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectSupplement {
    pub occurrence_id: String,
    pub run_id: String,
    pub session_id: SessionId,
    pub sequence: u64,
    pub captured_at_millis: u64,
    pub update_name: String,
    pub reason: SupplementReason,
    pub payload: Value,
}

impl ObjectSupplement {
    pub fn new(
        occurrence_id: impl Into<String>,
        run_id: impl Into<String>,
        session_id: SessionId,
        sequence: u64,
        captured_at_millis: u64,
        update: &SessionUpdate,
        reason: SupplementReason,
    ) -> Result<Self, CursorAcpError> {
        let occurrence_id = bounded(occurrence_id, "occurrenceId", MAX_ID_BYTES)?;
        let run_id = bounded(run_id, "runId", MAX_ID_BYTES)?;
        if session_id != update.session_id {
            return Err(CursorAcpError::InvalidTransition(
                "supplement session does not match update session",
            ));
        }
        let payload = serde_json::to_vec(&update.raw)
            .map_err(|error| CursorAcpError::InvalidMessage(error.to_string()))?;
        if payload.len() > MAX_SUPPLEMENT_BYTES {
            return Err(CursorAcpError::TooLarge {
                field: "supplement",
                limit: MAX_SUPPLEMENT_BYTES,
            });
        }
        Ok(Self {
            occurrence_id,
            run_id,
            session_id: update.session_id.clone(),
            sequence,
            captured_at_millis,
            update_name: update.name.clone(),
            reason,
            payload: update.raw.clone(),
        })
    }

    pub fn generated_occurrence_id(run_id: &str, sequence: u64) -> Result<String, CursorAcpError> {
        let run_id = bounded(run_id.to_owned(), "runId", MAX_ID_BYTES)?;
        Ok(format!("{run_id}:acp:{sequence}:{}", Uuid::new_v4()))
    }
}

/// Source of user-visible history.  `ObjectSupplement` is explicit and
/// bounded; it is never promoted to a claim that Cursor's native history is
/// complete or lossless.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HistorySource {
    NativeSessionLoad,
    ObjectSupplement,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryCompleteness {
    Complete,
    Partial,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryReadResult {
    pub source: HistorySource,
    pub completeness: HistoryCompleteness,
    pub items: Vec<ObjectSupplement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limitation: Option<String>,
}

impl HistoryReadResult {
    pub fn unavailable(reason: impl Into<String>) -> Result<Self, CursorAcpError> {
        Ok(Self {
            source: HistorySource::Unavailable,
            completeness: HistoryCompleteness::Unknown,
            items: Vec::new(),
            next_cursor: None,
            limitation: Some(bounded(reason, "limitation", MAX_TEXT_BYTES)?),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SideChatPlan {
    ContextHandoff {
        source_session_id: SessionId,
        visible_context: String,
        reason: &'static str,
    },
}

impl SideChatPlan {
    pub fn from_missing_precise_fork(
        session_id: SessionId,
        visible_context: impl Into<String>,
    ) -> Result<Self, CursorAcpError> {
        Ok(Self::ContextHandoff {
            source_session_id: session_id,
            visible_context: bounded(visible_context, "visibleContext", MAX_TEXT_BYTES)?,
            reason: "cursor_acp_precise_fork_unverified",
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SessionPhase {
    New,
    Loaded,
    Prompting,
    Cancelling,
}

/// A transport-neutral session reducer.  The Host supplies real process I/O;
/// this reducer only checks the legal ACP command order and tracks bounded
/// update sequence for object supplements.
#[derive(Clone, Debug)]
pub struct CursorAcpSession {
    session_id: Option<SessionId>,
    phase: SessionPhase,
    next_request: u64,
    next_update_sequence: u64,
}

impl Default for CursorAcpSession {
    fn default() -> Self {
        Self {
            session_id: None,
            phase: SessionPhase::New,
            next_request: 1,
            next_update_sequence: 0,
        }
    }
}

impl CursorAcpSession {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn new_request(&mut self) -> RequestId {
        let id = RequestId::generated(self.next_request);
        self.next_request = self.next_request.saturating_add(1);
        id
    }

    pub fn observe_session_new(&mut self, session_id: SessionId) -> Result<(), CursorAcpError> {
        if self.phase != SessionPhase::New {
            return Err(CursorAcpError::InvalidTransition(
                "session/new after a session was selected",
            ));
        }
        self.session_id = Some(session_id);
        self.phase = SessionPhase::Loaded;
        Ok(())
    }

    pub fn observe_session_load(&mut self, session_id: SessionId) -> Result<(), CursorAcpError> {
        if self.phase != SessionPhase::New {
            return Err(CursorAcpError::InvalidTransition(
                "session/load after a session was selected",
            ));
        }
        self.session_id = Some(session_id);
        self.phase = SessionPhase::Loaded;
        Ok(())
    }

    pub fn prompt(&mut self, prompt: impl Into<String>) -> Result<JsonRpcRequest, CursorAcpError> {
        let session_id = self
            .session_id
            .clone()
            .ok_or(CursorAcpError::InvalidTransition(
                "session/prompt before session/new or session/load",
            ))?;
        if !matches!(self.phase, SessionPhase::Loaded) {
            return Err(CursorAcpError::InvalidTransition(
                "session/prompt while another prompt is active",
            ));
        }
        self.phase = SessionPhase::Prompting;
        CursorAcpCommand::SessionPrompt {
            params: SessionPromptParams::new(session_id, prompt)?,
        }
        .request(self.new_request())
    }

    pub fn cancel(&mut self) -> Result<JsonRpcRequest, CursorAcpError> {
        let session_id = self
            .session_id
            .clone()
            .ok_or(CursorAcpError::InvalidTransition(
                "session/cancel before session/new or session/load",
            ))?;
        if !matches!(self.phase, SessionPhase::Prompting) {
            return Err(CursorAcpError::InvalidTransition(
                "session/cancel without an active prompt",
            ));
        }
        self.phase = SessionPhase::Cancelling;
        CursorAcpCommand::SessionCancel {
            params: SessionCancelParams { session_id },
        }
        .request(self.new_request())
    }

    pub fn observe_update(&mut self, update: &SessionUpdate) -> Result<u64, CursorAcpError> {
        let current = self
            .session_id
            .as_ref()
            .ok_or(CursorAcpError::InvalidTransition(
                "session/update before session selection",
            ))?;
        if current != &update.session_id {
            return Err(CursorAcpError::InvalidTransition(
                "session/update belongs to another session",
            ));
        }
        if self.next_update_sequence == MAX_UPDATE_COUNT as u64 {
            return Err(CursorAcpError::TooLarge {
                field: "updateCount",
                limit: MAX_UPDATE_COUNT,
            });
        }
        self.next_update_sequence += 1;
        Ok(self.next_update_sequence)
    }

    pub fn mark_prompt_settled(&mut self) -> Result<(), CursorAcpError> {
        if !matches!(
            self.phase,
            SessionPhase::Prompting | SessionPhase::Cancelling
        ) {
            return Err(CursorAcpError::InvalidTransition(
                "session settled without an active prompt",
            ));
        }
        self.phase = SessionPhase::Loaded;
        Ok(())
    }

    pub fn session_id(&self) -> Option<&SessionId> {
        self.session_id.as_ref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session() -> SessionId {
        SessionId::new("cursor-session-1").unwrap()
    }

    fn update(name: &str) -> SessionUpdate {
        SessionUpdate::parse(json!({
            "sessionId": "cursor-session-1",
            "sessionUpdate": name,
            "content": {"type": "text", "text": "same payload"}
        }))
        .unwrap()
    }

    #[test]
    fn emits_typed_session_load_and_prompt_requests() {
        let id = session();
        let load = CursorAcpCommand::SessionLoad {
            params: SessionLoadParams::new(id.clone(), "/tmp/project").unwrap(),
        }
        .request(RequestId::generated(1))
        .unwrap();
        assert_eq!(load.method, SESSION_LOAD);
        assert_eq!(load.params["sessionId"], "cursor-session-1");

        let prompt = CursorAcpCommand::SessionPrompt {
            params: SessionPromptParams::new(id, "hello").unwrap(),
        }
        .request(RequestId::generated(2))
        .unwrap();
        assert_eq!(prompt.method, SESSION_PROMPT);
        assert_eq!(prompt.params["prompt"][0]["type"], "text");
        assert_eq!(prompt.params["prompt"][0]["text"], "hello");
    }

    #[test]
    fn parses_permission_plan_question_and_preserves_unknown_requests() {
        let permission = parse_message(
            br#"{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"sessionId":"s","options":[{"optionId":"allow","name":"Allow"}]}}"#,
        )
        .unwrap();
        assert!(matches!(
            permission,
            CursorAcpMessage::Request(CursorAcpRequest::Permission { .. })
        ));

        let question = parse_message(
            br#"{"jsonrpc":"2.0","id":"q1","method":"cursor/ask_question","params":{"toolCallId":"call-1","questions":[{"id":"q1","prompt":"Continue?","options":[{"id":"yes","label":"Yes"}]}]}}"#,
        )
        .unwrap();
        assert!(matches!(
            question,
            CursorAcpMessage::Request(CursorAcpRequest::Question { .. })
        ));

        let plan = parse_message(
            br#"{"jsonrpc":"2.0","id":"p1","method":"cursor/create_plan","params":{"toolCallId":"call-2","plan":"Inspect","todos":[{"id":"todo-1","content":"Inspect","status":"pending"}]}}"#,
        )
        .unwrap();
        assert!(matches!(
            plan,
            CursorAcpMessage::Request(CursorAcpRequest::Plan { .. })
        ));

        let unknown = parse_message(
            br#"{"jsonrpc":"2.0","id":8,"method":"cursor/private_extension","params":{"x":1}}"#,
        )
        .unwrap();
        assert!(matches!(
            unknown,
            CursorAcpMessage::Request(CursorAcpRequest::Unknown { .. })
        ));
    }

    #[test]
    fn parses_updates_and_unknown_notifications_without_dropping_payload() {
        let message = parse_message(
            br#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"plan","entries":[{"title":"Build"}]}}}"#,
        )
        .unwrap();
        match message {
            CursorAcpMessage::Notification(CursorAcpNotification::SessionUpdate(update)) => {
                assert_eq!(update.kind, SessionUpdateKind::Plan);
                assert_eq!(update.raw["entries"][0]["title"], "Build");
            }
            other => panic!("unexpected message: {other:?}"),
        }

        let unknown = parse_message(
            br#"{"jsonrpc":"2.0","method":"session/unknown","params":{"sessionId":"s","payload":42}}"#,
        )
        .unwrap();
        assert!(matches!(
            unknown,
            CursorAcpMessage::Notification(CursorAcpNotification::Unknown { .. })
        ));
    }

    #[test]
    fn identical_updates_get_distinct_object_supplement_occurrences() {
        let first = update("agent_message_chunk");
        let second = update("agent_message_chunk");
        let a = ObjectSupplement::new(
            "run:acp:1:a",
            "run",
            session(),
            1,
            10,
            &first,
            SupplementReason::MissingStableUpdateId,
        )
        .unwrap();
        let b = ObjectSupplement::new(
            "run:acp:2:b",
            "run",
            session(),
            2,
            11,
            &second,
            SupplementReason::MissingStableUpdateId,
        )
        .unwrap();
        assert_ne!(a.occurrence_id, b.occurrence_id);
        assert_eq!(a.payload, b.payload);
        assert_eq!(a.reason, SupplementReason::MissingStableUpdateId);
    }

    #[test]
    fn side_chat_uses_explicit_context_handoff_and_fork_is_fail_closed() {
        let command = CursorAcpCommand::SessionNew {
            params: SessionNewParams::new("/tmp/project").unwrap(),
        };
        assert_eq!(
            command.precise_fork().unwrap_err(),
            CursorAcpError::UnsupportedCapability("precise_fork")
        );
        let plan = SideChatPlan::from_missing_precise_fork(session(), "visible context").unwrap();
        assert!(matches!(plan, SideChatPlan::ContextHandoff { .. }));
    }

    #[test]
    fn reducer_enforces_session_order_and_update_identity() {
        let mut reducer = CursorAcpSession::new();
        assert!(matches!(
            reducer.prompt("before load").unwrap_err(),
            CursorAcpError::InvalidTransition(_)
        ));
        reducer.observe_session_new(session()).unwrap();
        let prompt = reducer.prompt("hello").unwrap();
        assert_eq!(prompt.method, SESSION_PROMPT);
        let update = update("tool_call");
        assert_eq!(reducer.observe_update(&update).unwrap(), 1);
        reducer.mark_prompt_settled().unwrap();
        assert!(reducer.cancel().is_err());
    }

    #[test]
    fn capability_report_does_not_treat_documented_as_verified() {
        let mut report = CapabilityReport::new(ACP_PROTOCOL_VERSION).unwrap();
        report.record(
            Capability::SessionLoad,
            CapabilityObservation::new(CapabilityStatus::Documented, "official ACP docs").unwrap(),
        );
        assert!(!report.verified(Capability::SessionLoad));
        assert_eq!(
            report.status(Capability::PreciseFork),
            CapabilityStatus::Unknown
        );
    }

    #[test]
    fn raw_message_is_bounded() {
        let oversized = vec![b' '; MAX_RAW_MESSAGE_BYTES + 1];
        assert!(matches!(
            parse_message(&oversized).unwrap_err(),
            CursorAcpError::TooLarge {
                field: "message",
                ..
            }
        ));
    }
}
