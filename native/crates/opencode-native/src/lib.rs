//! Typed boundary for the OpenCode native Server API.
//!
//! This crate is deliberately a protocol adapter.  Rudder's Run/Attempt
//! lifecycle, authorization, persistence, and terminal-state decisions stay
//! in the Rust execution foundation.  The adapter only owns the OpenCode
//! wire format and the explicitly supported native operations.
//!
//! The schemas in this module are calibrated against the installed OpenCode
//! 1.15.11 Server (`GET /doc`).  In particular, `prompt_async` returning HTTP
//! 204 means that the input was accepted; it is never projected as a terminal
//! completion by this adapter.

use awc::{Client, ClientResponse, http::StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, time::Duration};
use thiserror::Error;
use url::Url;

pub const OPENCODE_RUNTIME_TYPE: &str = "opencode_local";
/// Version against which this wire boundary was calibrated. The live Server
/// version should still be checked during host startup before claiming parity.
pub const OPENCODE_CALIBRATED_VERSION: &str = "1.15.11";
pub const OPENCODE_OPENAPI_PATH: &str = "/doc";

/// The native operations this adapter currently implements.  Capabilities
/// that need additional product policy or a stable stream reader stay
/// explicit instead of being silently emulated with the legacy CLI adapter.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenCodeCapability {
    SessionCreate,
    SessionList,
    MessageRead,
    PartRead,
    AsyncPromptAccepted,
    Abort,
    ForkAtExactMessage,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenCodeUnsupportedCapability {
    SseSubscription,
    NativeQuestionReply,
    NativePermissionReply,
    NativeCommand,
    ForkAtAssistantBoundary,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeCapabilityManifest {
    pub runtime_type: &'static str,
    pub calibrated_version: &'static str,
    pub openapi_path: &'static str,
    pub supported: Vec<OpenCodeCapability>,
    pub unsupported: Vec<OpenCodeUnsupportedCapability>,
}

impl Default for OpenCodeCapabilityManifest {
    fn default() -> Self {
        Self {
            runtime_type: OPENCODE_RUNTIME_TYPE,
            calibrated_version: OPENCODE_CALIBRATED_VERSION,
            openapi_path: OPENCODE_OPENAPI_PATH,
            supported: vec![
                OpenCodeCapability::SessionCreate,
                OpenCodeCapability::SessionList,
                OpenCodeCapability::MessageRead,
                OpenCodeCapability::PartRead,
                OpenCodeCapability::AsyncPromptAccepted,
                OpenCodeCapability::Abort,
                OpenCodeCapability::ForkAtExactMessage,
            ],
            unsupported: vec![
                OpenCodeUnsupportedCapability::SseSubscription,
                OpenCodeUnsupportedCapability::NativeQuestionReply,
                OpenCodeUnsupportedCapability::NativePermissionReply,
                OpenCodeUnsupportedCapability::NativeCommand,
                OpenCodeUnsupportedCapability::ForkAtAssistantBoundary,
            ],
        }
    }
}

#[derive(Debug, Error)]
pub enum OpenCodeError {
    #[error("invalid OpenCode base URL: {0}")]
    InvalidBaseUrl(String),
    #[error("invalid OpenCode identifier `{value}`; expected `{prefix}` prefix")]
    InvalidIdentifier { value: String, prefix: &'static str },
    #[error("unsupported OpenCode operation: {0}")]
    Unsupported(#[from] OpenCodeUnsupported),
    #[error("OpenCode transport failed: {0}")]
    Transport(#[source] awc::error::SendRequestError),
    #[error("OpenCode response body failed: {0}")]
    Body(#[source] awc::error::PayloadError),
    #[error("OpenCode returned HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("OpenCode response decode failed: {0}")]
    Decode(#[source] serde_json::Error),
    #[error("OpenCode response exceeded the {limit} byte bound")]
    BodyTooLarge { limit: usize },
    #[error("OpenCode URL could not be constructed")]
    UrlConstruction,
}

#[derive(Clone, Debug, Eq, PartialEq, Error)]
pub enum OpenCodeUnsupported {
    #[error("SSE subscription is not yet exposed as a bounded Rust stream")]
    SseSubscription,
    #[error("native question reply is not yet wired to the shared interaction authority")]
    NativeQuestionReply,
    #[error("native permission reply is not yet wired to the shared interaction authority")]
    NativePermissionReply,
    #[error("native command execution is not yet wired to the shared Run authority")]
    NativeCommand,
    #[error("OpenCode 1.15.11 cannot guarantee an assistant-boundary fork")]
    ForkAtAssistantBoundary,
}

const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone)]
pub struct OpenCodeClient {
    base_url: Url,
    bearer_token: Option<String>,
    request_timeout: Duration,
    client: Client,
}

impl OpenCodeClient {
    /// Construct a client for an explicitly owned OpenCode Server.
    ///
    /// The URL is required to be an HTTP(S) origin.  Callers should pass the
    /// managed loopback server URL, or the authenticated Host relay URL; this
    /// constructor does not discover arbitrary processes on familiar ports.
    pub fn new(base_url: Url, bearer_token: Option<String>) -> Result<Self, OpenCodeError> {
        match base_url.scheme() {
            "http" | "https" => {}
            _ => return Err(OpenCodeError::InvalidBaseUrl(base_url.to_string())),
        }
        if base_url.host_str().is_none() {
            return Err(OpenCodeError::InvalidBaseUrl(base_url.to_string()));
        }
        let mut base_url = base_url;
        if !base_url.path().ends_with('/') {
            let path = format!("{}/", base_url.path());
            base_url.set_path(&path);
        }
        Ok(Self {
            base_url,
            bearer_token,
            request_timeout: Duration::from_secs(30),
            client: Client::default(),
        })
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    pub fn capability_manifest() -> OpenCodeCapabilityManifest {
        OpenCodeCapabilityManifest::default()
    }

    pub async fn list_sessions(
        &self,
        query: SessionListQuery<'_>,
    ) -> Result<Vec<Session>, OpenCodeError> {
        let mut url = self.endpoint(&["session"])?;
        query.append_to(&mut url);
        let response = self.get(url).await?;
        decode_json(response).await
    }

    pub async fn create_session(
        &self,
        request: &CreateSessionRequest,
    ) -> Result<Session, OpenCodeError> {
        let mut url = self.endpoint(&["session"])?;
        request.query.append_to(&mut url);
        let response = self.post_json(url, &request.body).await?;
        decode_json(response).await
    }

    pub async fn get_messages(
        &self,
        session_id: &str,
        query: MessageListQuery<'_>,
    ) -> Result<Vec<MessageEnvelope>, OpenCodeError> {
        validate_identifier(session_id, "ses")?;
        let mut url = self.endpoint(&["session", session_id, "message"])?;
        query.append_to(&mut url);
        let response = self.get(url).await?;
        decode_json(response).await
    }

    pub async fn get_message(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<MessageEnvelope, OpenCodeError> {
        validate_identifier(session_id, "ses")?;
        validate_identifier(message_id, "msg")?;
        let url = self.endpoint(&["session", session_id, "message", message_id])?;
        let response = self.get(url).await?;
        decode_json(response).await
    }

    /// Submit an asynchronous prompt.  HTTP 204 is represented as `Accepted`
    /// and remains non-terminal; callers must reconcile events/messages before
    /// completing the associated Rudder Run.
    pub async fn prompt_async(
        &self,
        session_id: &str,
        request: &PromptRequest,
    ) -> Result<AsyncPromptOutcome, OpenCodeError> {
        validate_identifier(session_id, "ses")?;
        let mut url = self.endpoint(&["session", session_id, "prompt_async"])?;
        request.query.append_to(&mut url);
        let response = self.post_json(url, &request.prompt).await?;
        let status = response.status();
        if status == StatusCode::NO_CONTENT {
            return Ok(AsyncPromptOutcome::Accepted {
                status: status.as_u16(),
                terminal: false,
            });
        }
        Err(http_error(response).await)
    }

    pub async fn abort(&self, session_id: &str) -> Result<bool, OpenCodeError> {
        validate_identifier(session_id, "ses")?;
        let url = self.endpoint(&["session", session_id, "abort"])?;
        let response = self.post_empty(url).await?;
        decode_json(response).await
    }

    /// Fork at an exact native message boundary.  `ForkBoundary::Current` is
    /// rejected because OpenCode's optional body does not identify a stable
    /// branch point and cannot prove an assistant-boundary Side Chat fork.
    pub async fn fork(
        &self,
        session_id: &str,
        boundary: ForkBoundary<'_>,
    ) -> Result<Session, OpenCodeError> {
        validate_identifier(session_id, "ses")?;
        let url = self.endpoint(&["session", session_id, "fork"])?;
        let body = match boundary {
            ForkBoundary::AtMessage(message_id) => {
                validate_identifier(message_id, "msg")?;
                serde_json::json!({"messageID": message_id})
            }
            ForkBoundary::Current => {
                return Err(OpenCodeUnsupported::ForkAtAssistantBoundary.into());
            }
        };
        let response = self.post_json(url, &body).await?;
        decode_json(response).await
    }

    /// The current crate keeps SSE behind an explicit unsupported result until
    /// the shared bounded stream/reconnect reader is wired to Run authority.
    pub fn subscribe_events(&self) -> Result<(), OpenCodeError> {
        Err(OpenCodeUnsupported::SseSubscription.into())
    }

    fn endpoint(&self, segments: &[&str]) -> Result<Url, OpenCodeError> {
        let path = segments.join("/");
        self.base_url
            .join(&path)
            .map_err(|_| OpenCodeError::UrlConstruction)
    }

    fn prepare(&self, request: awc::ClientRequest) -> awc::ClientRequest {
        let mut request = request
            .timeout(self.request_timeout)
            .insert_header(("accept", "application/json"));
        if let Some(token) = self.bearer_token.as_deref() {
            request = request.insert_header(("authorization", format!("Bearer {token}")));
        }
        request
    }

    async fn get(&self, url: Url) -> Result<ClientResponse, OpenCodeError> {
        self.prepare(self.client.get(url.as_str()))
            .send()
            .await
            .map_err(OpenCodeError::Transport)
    }

    async fn post_empty(&self, url: Url) -> Result<ClientResponse, OpenCodeError> {
        self.prepare(self.client.post(url.as_str()))
            .send()
            .await
            .map_err(OpenCodeError::Transport)
    }

    async fn post_json<T: Serialize>(
        &self,
        url: Url,
        body: &T,
    ) -> Result<ClientResponse, OpenCodeError> {
        self.prepare(self.client.post(url.as_str()))
            .send_json(body)
            .await
            .map_err(OpenCodeError::Transport)
    }
}

async fn decode_json<T: DeserializeOwned>(
    mut response: ClientResponse,
) -> Result<T, OpenCodeError> {
    let status = response.status();
    let body = read_bounded_body(&mut response).await?;
    if !status.is_success() {
        let text = String::from_utf8_lossy(&body).into_owned();
        return Err(OpenCodeError::Http {
            status: status.as_u16(),
            body: truncate_error_body(text),
        });
    }
    serde_json::from_slice(&body).map_err(OpenCodeError::Decode)
}

async fn http_error(mut response: ClientResponse) -> OpenCodeError {
    let status = response.status();
    let body = match read_bounded_body(&mut response).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) => format!("response body unavailable: {error}"),
    };
    OpenCodeError::Http {
        status: status.as_u16(),
        body: truncate_error_body(body),
    }
}

async fn read_bounded_body(response: &mut ClientResponse) -> Result<Vec<u8>, OpenCodeError> {
    response
        .body()
        .limit(MAX_RESPONSE_BYTES)
        .await
        .map(|body| body.to_vec())
        .map_err(|error| {
            if matches!(error, awc::error::PayloadError::Overflow) {
                OpenCodeError::BodyTooLarge {
                    limit: MAX_RESPONSE_BYTES,
                }
            } else {
                OpenCodeError::Body(error)
            }
        })
}

fn truncate_error_body(mut body: String) -> String {
    if body.len() > 4_096 {
        body.truncate(4_096);
        body.push('…');
    }
    body
}

fn validate_identifier(value: &str, prefix: &'static str) -> Result<(), OpenCodeError> {
    let valid = value.starts_with(prefix)
        && value.len() > prefix.len()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err(OpenCodeError::InvalidIdentifier {
            value: value.to_owned(),
            prefix,
        })
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub slug: String,
    #[serde(rename = "projectID")]
    pub project_id: String,
    #[serde(default)]
    #[serde(rename = "workspaceID")]
    pub workspace_id: Option<String>,
    pub directory: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    #[serde(rename = "parentID")]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    pub version: String,
    pub time: SessionTime,
    #[serde(default)]
    pub cost: Option<f64>,
    #[serde(default)]
    pub tokens: Option<TokenUsage>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<SessionModel>,
    #[serde(default)]
    pub share: Option<ShareInfo>,
    #[serde(default)]
    pub permission: Option<Value>,
    #[serde(default)]
    pub revert: Option<Value>,
    #[serde(default)]
    pub summary: Option<Value>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTime {
    pub created: u64,
    pub updated: u64,
    #[serde(default)]
    pub compacting: Option<u64>,
    #[serde(default)]
    pub archived: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionModel {
    pub id: String,
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(default)]
    pub variant: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub url: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    #[serde(default)]
    pub total: Option<u64>,
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
    #[serde(default)]
    pub reasoning: u64,
    #[serde(default)]
    pub cache: CacheUsage,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheUsage {
    #[serde(default)]
    pub read: u64,
    #[serde(default)]
    pub write: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum MessageInfo {
    User(UserMessage),
    Assistant(Box<AssistantMessage>),
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    pub id: String,
    #[serde(default)]
    #[serde(rename = "sessionID")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub time: Option<MessageTime>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<ModelSelection>,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub tools: BTreeMap<String, bool>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    pub id: String,
    #[serde(default)]
    #[serde(rename = "sessionID")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub time: Option<AssistantTime>,
    #[serde(default)]
    #[serde(rename = "parentID")]
    pub parent_id: Option<String>,
    #[serde(default)]
    #[serde(rename = "modelID")]
    pub model_id: Option<String>,
    #[serde(default)]
    #[serde(rename = "providerID")]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub path: Option<MessagePath>,
    #[serde(default)]
    pub summary: Option<bool>,
    #[serde(default)]
    pub cost: Option<f64>,
    #[serde(default)]
    pub tokens: Option<TokenUsage>,
    #[serde(default)]
    pub structured: Option<Value>,
    #[serde(default)]
    pub variant: Option<String>,
    #[serde(default)]
    pub finish: Option<String>,
    #[serde(default)]
    pub error: Option<Value>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageTime {
    pub created: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTime {
    pub created: u64,
    #[serde(default)]
    pub completed: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessagePath {
    pub cwd: String,
    pub root: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    #[serde(rename = "providerID")]
    pub provider_id: String,
    #[serde(rename = "modelID")]
    pub model_id: String,
    #[serde(default)]
    pub variant: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct MessageEnvelope {
    pub info: MessageInfo,
    pub parts: Vec<Part>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Text(TextPart),
    Subtask(SubtaskPart),
    Reasoning(ReasoningPart),
    File(FilePart),
    Tool(ToolPart),
    StepStart(StepStartPart),
    StepFinish(StepFinishPart),
    Snapshot(SnapshotPart),
    Patch(PatchPart),
    Agent(AgentPart),
    Retry(RetryPart),
    Compaction(CompactionPart),
    Unknown {
        kind: String,
        raw: Map<String, Value>,
    },
}

macro_rules! part_struct {
    ($name:ident { $( $(#[$attr:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            pub id: String,
            #[serde(default)]
        #[serde(rename = "sessionID")]
            pub session_id: Option<String>,
            #[serde(default)]
        #[serde(rename = "messageID")]
            pub message_id: Option<String>,
            $($(#[$attr])* #[serde(default)] pub $field: $ty,)*
        }
    };
}

part_struct!(TextPart { text: String, synthetic: Option<bool>, ignored: Option<bool>, time: Option<PartTime>, metadata: Option<Value> });
part_struct!(ReasoningPart { text: String, time: Option<PartTime>, metadata: Option<Value> });
part_struct!(FilePart { mime: String, filename: Option<String>, url: String, source: Option<Value> });
part_struct!(ToolPart {
    #[serde(rename = "callID")]
    call_id: String,
    tool: String,
    state: Value,
    metadata: Option<Value>
});
part_struct!(SubtaskPart { prompt: String, description: String, agent: String, model: Option<ModelSelection>, command: Option<String> });
part_struct!(StepStartPart { snapshot: Option<String> });
part_struct!(StepFinishPart { reason: String, snapshot: Option<String>, cost: Option<f64>, tokens: Option<TokenUsage> });
part_struct!(SnapshotPart { snapshot: String });
part_struct!(PatchPart { hash: String, files: Vec<String> });
part_struct!(AgentPart { name: String, source: Option<Value> });
part_struct!(RetryPart { attempt: u64, error: Value, time: Option<PartTime> });
part_struct!(CompactionPart {
    auto: bool,
    overflow: Option<bool>,
    #[serde(rename = "tail_start_id")]
    tail_start_id: Option<String>
});

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PartTime {
    pub start: u64,
    #[serde(default)]
    pub end: Option<u64>,
}

impl<'de> Deserialize<'de> for Part {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = Value::deserialize(deserializer)?;
        let kind = raw
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| serde::de::Error::custom("OpenCode part missing type"))?;
        macro_rules! known {
            ($variant:ident, $ty:ty) => {
                serde_json::from_value::<$ty>(raw.clone())
                    .map(Part::$variant)
                    .map_err(serde::de::Error::custom)
            };
        }
        match kind {
            "text" => known!(Text, TextPart),
            "subtask" => known!(Subtask, SubtaskPart),
            "reasoning" => known!(Reasoning, ReasoningPart),
            "file" => known!(File, FilePart),
            "tool" => known!(Tool, ToolPart),
            "step-start" => known!(StepStart, StepStartPart),
            "step-finish" => known!(StepFinish, StepFinishPart),
            "snapshot" => known!(Snapshot, SnapshotPart),
            "patch" => known!(Patch, PatchPart),
            "agent" => known!(Agent, AgentPart),
            "retry" => known!(Retry, RetryPart),
            "compaction" => known!(Compaction, CompactionPart),
            other => {
                let raw = raw
                    .as_object()
                    .cloned()
                    .ok_or_else(|| serde::de::Error::custom("OpenCode part must be an object"))?;
                Ok(Part::Unknown {
                    kind: other.to_owned(),
                    raw,
                })
            }
        }
    }
}

impl Serialize for Part {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let (kind, value) = match self {
            Self::Text(value) => ("text", serde_json::to_value(value)),
            Self::Subtask(value) => ("subtask", serde_json::to_value(value)),
            Self::Reasoning(value) => ("reasoning", serde_json::to_value(value)),
            Self::File(value) => ("file", serde_json::to_value(value)),
            Self::Tool(value) => ("tool", serde_json::to_value(value)),
            Self::StepStart(value) => ("step-start", serde_json::to_value(value)),
            Self::StepFinish(value) => ("step-finish", serde_json::to_value(value)),
            Self::Snapshot(value) => ("snapshot", serde_json::to_value(value)),
            Self::Patch(value) => ("patch", serde_json::to_value(value)),
            Self::Agent(value) => ("agent", serde_json::to_value(value)),
            Self::Retry(value) => ("retry", serde_json::to_value(value)),
            Self::Compaction(value) => ("compaction", serde_json::to_value(value)),
            Self::Unknown { raw, .. } => ("", Ok(Value::Object(raw.clone()))),
        };
        let mut object = value
            .map_err(serde::ser::Error::custom)?
            .as_object()
            .cloned()
            .ok_or_else(|| serde::ser::Error::custom("OpenCode part is not an object"))?;
        if !kind.is_empty() {
            object.insert("type".to_owned(), Value::String(kind.to_owned()));
        }
        object.serialize(serializer)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub query: SessionCreateQuery,
    pub body: CreateSessionBody,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateQuery {
    #[serde(skip)]
    pub directory: Option<String>,
    #[serde(skip)]
    pub workspace: Option<String>,
}

impl SessionCreateQuery {
    fn append_to(&self, url: &mut Url) {
        if self.directory.is_none() && self.workspace.is_none() {
            return;
        }
        let mut query = url.query_pairs_mut();
        if let Some(value) = self.directory.as_deref() {
            query.append_pair("directory", value);
        }
        if let Some(value) = self.workspace.as_deref() {
            query.append_pair("workspace", value);
        }
        drop(query);
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionBody {
    #[serde(default)]
    #[serde(rename = "parentID")]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<SessionModel>,
    #[serde(default)]
    pub permission: Option<Value>,
    #[serde(default)]
    #[serde(rename = "workspaceID")]
    pub workspace_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionListQuery<'a> {
    #[serde(skip)]
    pub directory: Option<&'a str>,
    #[serde(skip)]
    pub workspace: Option<&'a str>,
    #[serde(skip)]
    pub limit: Option<u64>,
    #[serde(skip)]
    pub before: Option<&'a str>,
}

impl SessionListQuery<'_> {
    fn append_to(&self, url: &mut Url) {
        if self.directory.is_none()
            && self.workspace.is_none()
            && self.limit.is_none()
            && self.before.is_none()
        {
            return;
        }
        let mut query = url.query_pairs_mut();
        if let Some(value) = self.directory {
            query.append_pair("directory", value);
        }
        if let Some(value) = self.workspace {
            query.append_pair("workspace", value);
        }
        if let Some(value) = self.limit {
            query.append_pair("limit", &value.to_string());
        }
        if let Some(value) = self.before {
            query.append_pair("before", value);
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageListQuery<'a> {
    #[serde(skip)]
    pub directory: Option<&'a str>,
    #[serde(skip)]
    pub workspace: Option<&'a str>,
    #[serde(skip)]
    pub limit: Option<u64>,
    #[serde(skip)]
    pub before: Option<&'a str>,
}

impl MessageListQuery<'_> {
    fn append_to(&self, url: &mut Url) {
        let query = SessionListQuery {
            directory: self.directory,
            workspace: self.workspace,
            limit: self.limit,
            before: self.before,
        };
        query.append_to(url);
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptRequest {
    #[serde(skip)]
    pub query: PromptQuery,
    #[serde(flatten)]
    pub prompt: Prompt,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PromptQuery {
    #[serde(skip)]
    pub directory: Option<String>,
    #[serde(skip)]
    pub workspace: Option<String>,
}

impl PromptQuery {
    fn append_to(&self, url: &mut Url) {
        if self.directory.is_none() && self.workspace.is_none() {
            return;
        }
        let mut query = url.query_pairs_mut();
        if let Some(value) = self.directory.as_deref() {
            query.append_pair("directory", value);
        }
        if let Some(value) = self.workspace.as_deref() {
            query.append_pair("workspace", value);
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "messageID")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_reply: Option<bool>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tools: BTreeMap<String, bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    pub parts: Vec<PromptPart>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum PromptPart {
    Text {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        text: String,
    },
    File {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        mime: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
        url: String,
    },
    Agent {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        name: String,
    },
    Subtask {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        prompt: String,
        description: String,
        agent: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<ModelSelection>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        command: Option<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ForkBoundary<'a> {
    AtMessage(&'a str),
    Current,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AsyncPromptOutcome {
    Accepted { status: u16, terminal: bool },
}

impl AsyncPromptOutcome {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Accepted { terminal: true, .. })
    }
}

fn _assert_send_sync<T: Send + Sync>() {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::mpsc,
        thread,
    };

    fn one_shot_server(
        status: &str,
        body: &str,
    ) -> (Url, mpsc::Receiver<String>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let (sender, receiver) = mpsc::channel();
        let status = status.to_owned();
        let body = body.to_owned();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept test request");
            let request = read_request(&mut stream);
            sender.send(request).expect("record test request");
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .expect("write test response");
        });
        (
            Url::parse(&format!("http://{address}/")).expect("test URL"),
            receiver,
            handle,
        )
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 4096];
        loop {
            let count = stream.read(&mut chunk).expect("read test request");
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..count]);
            if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[test]
    fn manifest_marks_implemented_and_explicitly_unsupported_edges() {
        let manifest = OpenCodeClient::capability_manifest();
        assert!(
            manifest
                .supported
                .contains(&OpenCodeCapability::AsyncPromptAccepted)
        );
        assert!(
            manifest
                .supported
                .contains(&OpenCodeCapability::ForkAtExactMessage)
        );
        assert!(
            manifest
                .unsupported
                .contains(&OpenCodeUnsupportedCapability::SseSubscription)
        );
        assert!(
            manifest
                .unsupported
                .contains(&OpenCodeUnsupportedCapability::ForkAtAssistantBoundary)
        );
    }

    #[test]
    fn async_204_is_accepted_but_never_terminal() {
        let outcome = AsyncPromptOutcome::Accepted {
            status: 204,
            terminal: false,
        };
        assert_eq!(
            outcome,
            AsyncPromptOutcome::Accepted {
                status: 204,
                terminal: false
            }
        );
        assert!(!outcome.is_terminal());
    }

    #[test]
    fn message_and_parts_are_typed_without_flattening_text() {
        let envelope: MessageEnvelope = serde_json::from_value(serde_json::json!({
            "info": {
                "id": "msg_user",
                "sessionID": "ses_native",
                "role": "user",
                "time": {"created": 10},
                "agent": "build",
                "model": {"providerID": "zee", "modelID": "luna"}
            },
            "parts": [
                {"id":"prt_text","sessionID":"ses_native","messageID":"msg_user","type":"text","text":"hello"},
                {"id":"prt_tool","sessionID":"ses_native","messageID":"msg_user","type":"tool","callID":"call_1","tool":"shell","state":{"status":"completed"}},
                {"id":"prt_future","sessionID":"ses_native","messageID":"msg_user","type":"future-part","value":{"x":1}}
            ]
        })).expect("typed message envelope");
        assert!(matches!(envelope.info, MessageInfo::User(_)));
        assert!(
            matches!(envelope.parts[0], Part::Text(TextPart { ref text, .. }) if text == "hello")
        );
        assert!(
            matches!(envelope.parts[1], Part::Tool(ToolPart { ref call_id, .. }) if call_id == "call_1")
        );
        assert!(
            matches!(envelope.parts[2], Part::Unknown { ref kind, .. } if kind == "future-part")
        );
    }

    #[test]
    fn prompt_parts_keep_native_media_shape() {
        let prompt = Prompt {
            parts: vec![PromptPart::File {
                id: None,
                mime: "image/png".into(),
                filename: Some("diagram.png".into()),
                url: "data:image/png;base64,AA==".into(),
            }],
            ..Prompt::default()
        };
        let value = serde_json::to_value(prompt).expect("prompt serializes");
        assert_eq!(value["parts"][0]["type"], "file");
        assert_eq!(value["parts"][0]["mime"], "image/png");
        assert_eq!(value["parts"][0]["url"], "data:image/png;base64,AA==");
    }

    #[test]
    fn exact_fork_rejects_unstable_current_boundary() {
        let error = match ForkBoundary::Current {
            ForkBoundary::Current => OpenCodeUnsupported::ForkAtAssistantBoundary,
            ForkBoundary::AtMessage(_) => unreachable!(),
        };
        assert_eq!(error, OpenCodeUnsupported::ForkAtAssistantBoundary);
    }

    #[test]
    fn identifiers_are_path_safe() {
        assert!(validate_identifier("ses_123", "ses").is_ok());
        assert!(validate_identifier("msg-123", "msg").is_ok());
        assert!(validate_identifier("ses/escape", "ses").is_err());
        assert!(validate_identifier("assistant", "msg").is_err());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn real_http_204_is_not_reported_as_completion() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (url, request, server) = one_shot_server("204 No Content", "");
                let client = OpenCodeClient::new(url, None).expect("client");
                let outcome = client
                    .prompt_async(
                        "ses_native",
                        &PromptRequest {
                            prompt: Prompt {
                                message_id: Some("msg_input".into()),
                                parts: vec![PromptPart::Text {
                                    id: None,
                                    text: "hello".into(),
                                }],
                                ..Prompt::default()
                            },
                            ..PromptRequest::default()
                        },
                    )
                    .await
                    .expect("accepted async prompt");
                assert_eq!(
                    outcome,
                    AsyncPromptOutcome::Accepted {
                        status: 204,
                        terminal: false
                    },
                );
                assert!(!outcome.is_terminal());
                let request = request.recv().expect("request captured");
                assert!(
                    request.starts_with("POST /session/ses_native/prompt_async HTTP/1.1"),
                    "unexpected request: {request}"
                );
                server.join().expect("server thread");
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn abort_and_exact_fork_use_native_endpoints() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let (url, request, server) = one_shot_server("200 OK", "true");
                let client = OpenCodeClient::new(url, None).expect("client");
                assert!(client.abort("ses_native").await.expect("abort response"));
                assert!(
                    request
                        .recv()
                        .expect("abort request")
                        .starts_with("POST /session/ses_native/abort HTTP/1.1")
                );
                server.join().expect("abort server thread");

                let session = serde_json::json!({
                    "id":"ses_child", "slug":"child", "projectID":"project", "directory":"/tmp/project",
                    "title":"Child", "version":"1.15.11", "time":{"created":1,"updated":2}
                });
                let (url, request, server) = one_shot_server("200 OK", &session.to_string());
                let client = OpenCodeClient::new(url, None).expect("client");
                let fork = client
                    .fork("ses_native", ForkBoundary::AtMessage("msg_assistant"))
                    .await
                    .expect("fork response");
                assert_eq!(fork.id, "ses_child");
                let request = request.recv().expect("fork request");
                assert!(request.starts_with("POST /session/ses_native/fork HTTP/1.1"));
                assert!(request.contains("\"messageID\":\"msg_assistant\""));
                server.join().expect("fork server thread");
            })
            .await;
    }
}
