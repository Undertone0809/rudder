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
use futures_util::StreamExt;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};
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
    SseSubscription,
    NativeQuestionReply,
    NativePermissionReply,
    NativeCommand,
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
                OpenCodeCapability::SseSubscription,
                OpenCodeCapability::NativeQuestionReply,
                OpenCodeCapability::NativePermissionReply,
                OpenCodeCapability::NativeCommand,
            ],
            unsupported: vec![OpenCodeUnsupportedCapability::ForkAtAssistantBoundary],
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
    #[error("OpenCode response body was not valid UTF-8")]
    InvalidBodyUtf8,
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

/// Provider-native identity for a persisted OpenCode Session.  This type is
/// intentionally separate from Codex Thread/Turn identifiers; callers that
/// persist it must keep it in an OpenCode-specific checkpoint field.
#[derive(Clone, Eq, PartialEq)]
pub struct OpenCodeSessionSelector(String);

impl OpenCodeSessionSelector {
    pub fn from_persisted(value: &str) -> Result<Self, OpenCodeError> {
        validate_identifier(value, "ses")?;
        if value.len() > 4096 {
            return Err(OpenCodeError::InvalidIdentifier {
                value: value.to_owned(),
                prefix: "ses",
            });
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for OpenCodeSessionSelector {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OpenCodeSessionSelector")
            .field("present", &true)
            .finish()
    }
}

/// A completed assistant message selected from the exact OpenCode Session.
/// A 204 response only proves input acceptance; this receipt is produced only
/// after the corresponding completed assistant message is read back.
#[derive(Clone, Debug, PartialEq)]
pub struct OpenCodeTurnReceipt {
    pub session_id: String,
    pub user_message_id: Option<String>,
    pub assistant_message_id: String,
    pub final_text: String,
    pub tokens: Option<TokenUsage>,
    pub cost: Option<f64>,
}

/// Exact assistant terminal for one client-assigned input. Provider errors
/// carry only native identity, never the provider's arbitrary error payload.
#[derive(Clone, Debug, PartialEq)]
pub enum OpenCodeInputTerminal {
    Completed(OpenCodeTurnReceipt),
    Failed(OpenCodeProviderErrorTerminal),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenCodeProviderErrorTerminal {
    pub session_id: String,
    pub user_message_id: String,
    pub assistant_message_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum OpenCodeInputProgress {
    Pending,
    Terminal(OpenCodeInputTerminal),
}

#[derive(Debug, Error)]
pub enum OpenCodeWaitError {
    #[error("OpenCode input message identifier is invalid")]
    InvalidInputMessageId,
    #[error("OpenCode wait deadline expired before an assistant terminal message")]
    Deadline,
    #[error("OpenCode assistant message reported a provider error: {0}")]
    Provider(String),
    #[error("OpenCode returned no assistant message for the submitted input")]
    MissingAssistant,
}

const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone)]
pub struct OpenCodeClient {
    base_url: Url,
    bearer_token: Option<String>,
    request_timeout: Duration,
    client: Client,
}

/// One OpenCode Server-sent event. OpenCode currently sends JSON in the SSE
/// `data` field and may add an event name; preserve both so newer event kinds
/// remain observable without flattening provider payloads.
#[derive(Clone, Debug, PartialEq)]
pub struct OpenCodeEvent {
    pub name: Option<String>,
    pub data: Value,
}

pub struct OpenCodeEventStream {
    response: ClientResponse,
    buffer: String,
    event_name: Option<String>,
    event_data: Vec<String>,
    event_data_bytes: usize,
}

impl OpenCodeEventStream {
    pub async fn next_event(&mut self) -> Result<Option<OpenCodeEvent>, OpenCodeError> {
        loop {
            if let Some(event) = self.take_event()? {
                return Ok(Some(event));
            }
            if let Some(index) = self.buffer.find('\n') {
                let line = self.buffer.drain(..=index).collect::<String>();
                self.consume_line(line.trim_end_matches(['\r', '\n']))?;
                continue;
            }
            let Some(chunk) = self.response.next().await else {
                if self.event_data.is_empty() {
                    return Ok(None);
                }
                if !self.buffer.is_empty() {
                    let line = std::mem::take(&mut self.buffer);
                    self.consume_line(line.trim_end_matches(['\r', '\n']))?;
                }
                return self.take_event();
            };
            let chunk = chunk.map_err(OpenCodeError::Body)?;
            if self.buffer.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(OpenCodeError::BodyTooLarge {
                    limit: MAX_RESPONSE_BYTES,
                });
            }
            self.buffer
                .push_str(std::str::from_utf8(&chunk).map_err(|_| OpenCodeError::InvalidBodyUtf8)?);
        }
    }

    fn consume_line(&mut self, line: &str) -> Result<(), OpenCodeError> {
        if line.is_empty() {
            return Ok(());
        }
        if let Some(name) = line.strip_prefix("event:") {
            self.event_name = Some(name.trim().to_owned());
        } else if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim_start();
            self.event_data_bytes = self.event_data_bytes.checked_add(data.len()).ok_or(
                OpenCodeError::BodyTooLarge {
                    limit: MAX_RESPONSE_BYTES,
                },
            )?;
            if self.event_data_bytes > MAX_RESPONSE_BYTES {
                return Err(OpenCodeError::BodyTooLarge {
                    limit: MAX_RESPONSE_BYTES,
                });
            }
            self.event_data.push(data.to_owned());
        }
        Ok(())
    }

    fn take_event(&mut self) -> Result<Option<OpenCodeEvent>, OpenCodeError> {
        if self.event_data.is_empty() {
            return Ok(None);
        }
        let data = self.event_data.join("\n");
        self.event_data.clear();
        self.event_data_bytes = 0;
        let name = self.event_name.take();
        let data = serde_json::from_str(&data).map_err(OpenCodeError::Decode)?;
        Ok(Some(OpenCodeEvent { name, data }))
    }
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

    /// Probe the provider-native OpenCode Server document endpoint. A
    /// successful response proves that the managed listener is serving the
    /// calibrated API; it is not a turn or cleanup receipt.
    pub async fn probe(&self) -> Result<(), OpenCodeError> {
        let url = self.endpoint(&["doc"])?;
        let _: Value = decode_json(self.get(url).await?).await?;
        Ok(())
    }

    pub async fn subscribe_events(
        &self,
        query: EventQuery<'_>,
    ) -> Result<OpenCodeEventStream, OpenCodeError> {
        let mut url = self.endpoint(&["event"])?;
        query.append_to(&mut url);
        let response = self
            .prepare(self.client.get(url.as_str()))
            .insert_header(("accept", "text/event-stream"))
            .send()
            .await
            .map_err(OpenCodeError::Transport)?;
        if response.status() != StatusCode::OK {
            return Err(http_error(response).await);
        }
        Ok(OpenCodeEventStream {
            response,
            buffer: String::new(),
            event_name: None,
            event_data: Vec::new(),
            event_data_bytes: 0,
        })
    }

    pub async fn list_questions(&self, query: EventQuery<'_>) -> Result<Vec<Value>, OpenCodeError> {
        let mut url = self.endpoint(&["question"])?;
        query.append_to(&mut url);
        decode_json(self.get(url).await?).await
    }

    pub async fn reply_question(
        &self,
        request_id: &str,
        answers: Vec<Vec<String>>,
        query: EventQuery<'_>,
    ) -> Result<bool, OpenCodeError> {
        validate_identifier(request_id, "que")?;
        let mut url = self.endpoint(&["question", request_id, "reply"])?;
        query.append_to(&mut url);
        decode_json(
            self.post_json(url, &serde_json::json!({ "answers": answers }))
                .await?,
        )
        .await
    }

    pub async fn reject_question(
        &self,
        request_id: &str,
        query: EventQuery<'_>,
    ) -> Result<bool, OpenCodeError> {
        validate_identifier(request_id, "que")?;
        let mut url = self.endpoint(&["question", request_id, "reject"])?;
        query.append_to(&mut url);
        decode_json(self.post_empty(url).await?).await
    }

    pub async fn list_permissions(
        &self,
        query: EventQuery<'_>,
    ) -> Result<Vec<Value>, OpenCodeError> {
        let mut url = self.endpoint(&["permission"])?;
        query.append_to(&mut url);
        decode_json(self.get(url).await?).await
    }

    pub async fn reply_permission(
        &self,
        request_id: &str,
        reply: &str,
        message: Option<&str>,
        query: EventQuery<'_>,
    ) -> Result<bool, OpenCodeError> {
        validate_identifier(request_id, "per")?;
        if !matches!(reply, "once" | "always" | "reject") {
            return Err(OpenCodeError::Http {
                status: 400,
                body: "invalid permission reply".into(),
            });
        }
        let mut url = self.endpoint(&["permission", request_id, "reply"])?;
        query.append_to(&mut url);
        decode_json(
            self.post_json(
                url,
                &serde_json::json!({ "reply": reply, "message": message }),
            )
            .await?,
        )
        .await
    }

    pub async fn send_command(
        &self,
        session_id: &str,
        request: &CommandRequest<'_>,
    ) -> Result<MessageEnvelope, OpenCodeError> {
        validate_identifier(session_id, "ses")?;
        let mut url = self.endpoint(&["session", session_id, "command"])?;
        request.query.append_to(&mut url);
        decode_json(self.post_json(url, &request.body).await?).await
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

    /// Poll the Session's message history until a newly produced assistant
    /// message has a terminal marker. This is a bounded compatibility path
    /// for hosts that have not enabled the native SSE reader yet; it never
    /// treats `prompt_async`'s 204 as completion and never returns a message
    /// already present in `known_assistant_ids`.
    pub async fn wait_for_completed_assistant(
        &self,
        session_id: &str,
        known_assistant_ids: &[&str],
        deadline: Instant,
        poll_interval: Duration,
    ) -> Result<OpenCodeTurnReceipt, OpenCodeWaitError> {
        self.wait_for_completed_assistant_inner(
            session_id,
            known_assistant_ids,
            None,
            deadline,
            poll_interval,
        )
        .await
    }

    /// Wait for a terminal assistant message whose `parentID` names the exact
    /// client-assigned user message submitted for this turn. Unlike the legacy
    /// compatibility reader above, this method never falls back to whichever
    /// user message happens to be newest in the Session.
    pub async fn wait_for_completed_assistant_for_input(
        &self,
        session_id: &str,
        known_assistant_ids: &[&str],
        input_message_id: &str,
        deadline: Instant,
        poll_interval: Duration,
    ) -> Result<OpenCodeTurnReceipt, OpenCodeWaitError> {
        if validate_identifier(input_message_id, "msg").is_err() {
            return Err(OpenCodeWaitError::InvalidInputMessageId);
        }
        self.wait_for_completed_assistant_inner(
            session_id,
            known_assistant_ids,
            Some(input_message_id),
            deadline,
            poll_interval,
        )
        .await
    }

    /// Inspect one bounded message-history page for the exact terminal
    /// assistant message correlated to a client-assigned input. Returning
    /// `None` means the prompt is still pending; an HTTP prompt acceptance or
    /// abort acknowledgment is never substituted for a terminal message.
    pub async fn poll_completed_assistant_for_input(
        &self,
        session_id: &str,
        known_assistant_ids: &[&str],
        input_message_id: &str,
    ) -> Result<Option<OpenCodeTurnReceipt>, OpenCodeWaitError> {
        if validate_identifier(input_message_id, "msg").is_err() {
            return Err(OpenCodeWaitError::InvalidInputMessageId);
        }
        self.poll_completed_assistant_inner(session_id, known_assistant_ids, Some(input_message_id))
            .await
    }

    /// Poll one bounded history page for the exact input's terminal status.
    /// An error is terminal only when it is on an assistant message for this
    /// Session, its `parentID` is the client-assigned input ID, and the native
    /// message carries a completion marker. No provider error text is copied
    /// into the typed receipt.
    pub async fn poll_input_terminal(
        &self,
        session_id: &str,
        known_assistant_ids: &[&str],
        input_message_id: &str,
    ) -> Result<OpenCodeInputProgress, OpenCodeWaitError> {
        if validate_identifier(input_message_id, "msg").is_err() {
            return Err(OpenCodeWaitError::InvalidInputMessageId);
        }
        let messages = self
            .get_messages(
                session_id,
                MessageListQuery {
                    directory: None,
                    workspace: None,
                    limit: Some(256),
                    before: None,
                },
            )
            .await
            .map_err(|error| OpenCodeWaitError::Provider(error.to_string()))?;
        Ok(poll_input_terminal_from_messages(
            &messages,
            session_id,
            known_assistant_ids,
            input_message_id,
        ))
    }

    async fn poll_completed_assistant_inner(
        &self,
        session_id: &str,
        known_assistant_ids: &[&str],
        expected_input_message_id: Option<&str>,
    ) -> Result<Option<OpenCodeTurnReceipt>, OpenCodeWaitError> {
        let messages = self
            .get_messages(
                session_id,
                MessageListQuery {
                    directory: None,
                    workspace: None,
                    limit: Some(256),
                    before: None,
                },
            )
            .await
            .map_err(|error| OpenCodeWaitError::Provider(error.to_string()))?;
        completed_assistant_from_messages(
            &messages,
            session_id,
            known_assistant_ids,
            expected_input_message_id,
        )
    }

    async fn wait_for_completed_assistant_inner(
        &self,
        session_id: &str,
        known_assistant_ids: &[&str],
        expected_input_message_id: Option<&str>,
        deadline: Instant,
        poll_interval: Duration,
    ) -> Result<OpenCodeTurnReceipt, OpenCodeWaitError> {
        loop {
            if Instant::now() >= deadline {
                return Err(OpenCodeWaitError::Deadline);
            }
            if let Some(receipt) = self
                .poll_completed_assistant_inner(
                    session_id,
                    known_assistant_ids,
                    expected_input_message_id,
                )
                .await?
            {
                return Ok(receipt);
            }
            tokio::time::sleep(
                poll_interval.min(deadline.saturating_duration_since(Instant::now())),
            )
            .await;
        }
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

fn message_sort_key(message: &AssistantMessage) -> u64 {
    message
        .time
        .as_ref()
        .map(|time| time.completed.unwrap_or(time.created))
        .unwrap_or_default()
}

fn completed_assistant_from_messages(
    messages: &[MessageEnvelope],
    session_id: &str,
    known_assistant_ids: &[&str],
    expected_input_message_id: Option<&str>,
) -> Result<Option<OpenCodeTurnReceipt>, OpenCodeWaitError> {
    let mut first_error = None;
    let mut latest: Option<(&AssistantMessage, Option<String>)> = None;
    for message in messages {
        let MessageInfo::Assistant(assistant) = &message.info else {
            continue;
        };
        if known_assistant_ids
            .iter()
            .any(|known| *known == assistant.id)
            || expected_input_message_id.is_some_and(|expected| {
                assistant.session_id.as_deref() != Some(session_id)
                    || assistant.parent_id.as_deref() != Some(expected)
            })
        {
            continue;
        }
        if let Some(error) = assistant.error.as_ref() {
            first_error.get_or_insert_with(|| error.to_string());
            continue;
        }
        let terminal = assistant
            .time
            .as_ref()
            .and_then(|time| time.completed)
            .is_some()
            || assistant.finish.is_some();
        if !terminal {
            continue;
        }
        let user_id = match expected_input_message_id {
            Some(expected) => Some(expected.to_owned()),
            None => assistant
                .parent_id
                .clone()
                .or_else(|| latest_user_message_id(messages)),
        };
        if latest
            .as_ref()
            .is_none_or(|(current, _)| message_sort_key(assistant) >= message_sort_key(current))
        {
            latest = Some((assistant.as_ref(), user_id));
        }
    }
    if let Some((assistant, user_message_id)) = latest {
        let assistant_message_id = assistant.id.clone();
        return Ok(Some(OpenCodeTurnReceipt {
            session_id: session_id.to_owned(),
            user_message_id,
            assistant_message_id: assistant_message_id.clone(),
            final_text: assistant_text(messages, &assistant_message_id),
            tokens: assistant.tokens.clone(),
            cost: assistant.cost,
        }));
    }
    if let Some(error) = first_error {
        return Err(OpenCodeWaitError::Provider(error));
    }
    Ok(None)
}

fn poll_input_terminal_from_messages(
    messages: &[MessageEnvelope],
    session_id: &str,
    known_assistant_ids: &[&str],
    input_message_id: &str,
) -> OpenCodeInputProgress {
    let mut latest: Option<(&AssistantMessage, bool)> = None;
    for message in messages {
        let MessageInfo::Assistant(assistant) = &message.info else {
            continue;
        };
        if known_assistant_ids
            .iter()
            .any(|known| *known == assistant.id)
            || assistant.session_id.as_deref() != Some(session_id)
            || assistant.parent_id.as_deref() != Some(input_message_id)
            || validate_identifier(&assistant.id, "msg").is_err()
        {
            continue;
        }
        let is_error = assistant.error.is_some();
        // OpenCode stores one assistant message per model step. The native
        // session loop treats `tool-calls` and `unknown` as nonterminal; keep
        // that distinction when resolving this exact input's final outcome.
        let terminal = assistant
            .time
            .as_ref()
            .and_then(|time| time.completed)
            .is_some()
            && assistant
                .finish
                .as_deref()
                .is_some_and(|finish| !matches!(finish, "tool-calls" | "unknown"));
        if !terminal {
            continue;
        }
        if latest
            .as_ref()
            .is_none_or(|(current, _)| message_sort_key(assistant) >= message_sort_key(current))
        {
            latest = Some((assistant.as_ref(), is_error));
        }
    }
    match latest {
        Some((assistant, true)) => OpenCodeInputProgress::Terminal(OpenCodeInputTerminal::Failed(
            OpenCodeProviderErrorTerminal {
                session_id: session_id.to_owned(),
                user_message_id: input_message_id.to_owned(),
                assistant_message_id: assistant.id.clone(),
            },
        )),
        Some((assistant, false)) => {
            let assistant_message_id = assistant.id.clone();
            OpenCodeInputProgress::Terminal(OpenCodeInputTerminal::Completed(OpenCodeTurnReceipt {
                session_id: session_id.to_owned(),
                user_message_id: Some(input_message_id.to_owned()),
                assistant_message_id: assistant_message_id.clone(),
                final_text: assistant_text(messages, &assistant_message_id),
                tokens: assistant.tokens.clone(),
                cost: assistant.cost,
            }))
        }
        None => OpenCodeInputProgress::Pending,
    }
}

fn latest_user_message_id(messages: &[MessageEnvelope]) -> Option<String> {
    messages
        .iter()
        .filter_map(|message| match &message.info {
            MessageInfo::User(user) => Some((
                user.time
                    .as_ref()
                    .map(|time| time.created)
                    .unwrap_or_default(),
                user.id.clone(),
            )),
            MessageInfo::Assistant(_) => None,
        })
        .max_by_key(|(created, _)| *created)
        .map(|(_, id)| id)
}

fn assistant_text(messages: &[MessageEnvelope], assistant_id: &str) -> String {
    messages
        .iter()
        .find(|message| match &message.info {
            MessageInfo::Assistant(assistant) => assistant.id == assistant_id,
            MessageInfo::User(_) => false,
        })
        .map(|message| {
            message
                .parts
                .iter()
                .filter_map(|part| match part {
                    Part::Text(text) if !text.ignored.unwrap_or(false) => Some(text.text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
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
pub struct EventQuery<'a> {
    #[serde(skip)]
    pub directory: Option<&'a str>,
    #[serde(skip)]
    pub workspace: Option<&'a str>,
}

impl EventQuery<'_> {
    fn append_to(&self, url: &mut Url) {
        if self.directory.is_none() && self.workspace.is_none() {
            return;
        }
        let mut query = url.query_pairs_mut();
        if let Some(value) = self.directory {
            query.append_pair("directory", value);
        }
        if let Some(value) = self.workspace {
            query.append_pair("workspace", value);
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandRequest<'a> {
    #[serde(skip)]
    pub query: EventQuery<'a>,
    pub body: CommandBody,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandBody {
    pub arguments: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "messageID")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<CommandPart>,
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
    /// The calibrated Server accepts native Agent instructions separately
    /// from the submitted user-message parts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum CommandPart {
    File {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        mime: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filename: Option<String>,
        url: String,
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

    fn sequence_server(bodies: &[&str]) -> (Url, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let bodies = bodies
            .iter()
            .map(|body| (*body).to_owned())
            .collect::<Vec<_>>();
        let handle = thread::spawn(move || {
            for body in bodies {
                let (mut stream, _) = listener.accept().expect("accept test request");
                let _request = read_request(&mut stream);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write test response");
            }
        });
        (
            Url::parse(&format!("http://{address}/")).expect("test URL"),
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
                .supported
                .contains(&OpenCodeCapability::SseSubscription)
        );
        assert!(
            manifest
                .supported
                .contains(&OpenCodeCapability::NativeQuestionReply)
        );
        assert!(
            manifest
                .supported
                .contains(&OpenCodeCapability::NativePermissionReply)
        );
        assert!(
            manifest
                .supported
                .contains(&OpenCodeCapability::NativeCommand)
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

    fn assistant_message(
        id: &str,
        session_id: &str,
        parent_id: &str,
        completed: Option<u64>,
        finish: Option<&str>,
        error: Option<Value>,
        text: Option<&str>,
    ) -> MessageEnvelope {
        serde_json::from_value(serde_json::json!({
            "info": {
                "id": id,
                "sessionID": session_id,
                "role": "assistant",
                "time": {"created": 20, "completed": completed},
                "parentID": parent_id,
                "modelID": "synthetic-model",
                "providerID": "synthetic-provider",
                "finish": finish,
                "error": error
            },
            "parts": text.map(|text| vec![serde_json::json!({
                "id": "prt_terminal",
                "sessionID": session_id,
                "messageID": id,
                "type": "text",
                "text": text
            })]).unwrap_or_default()
        }))
        .expect("typed assistant fixture")
    }

    #[test]
    fn stop_terminal_error_requires_exact_session_parent_and_completion_marker() {
        let messages = vec![
            assistant_message(
                "msg_wrong_parent",
                "ses_native",
                "msg_other_input",
                Some(21),
                Some("error"),
                Some(serde_json::json!({"message": "private provider error"})),
                None,
            ),
            assistant_message(
                "msg_wrong_session",
                "ses_other",
                "msg_exact_input",
                Some(22),
                Some("error"),
                Some(serde_json::json!({"message": "private provider error"})),
                None,
            ),
            assistant_message(
                "msg_exact_error",
                "ses_native",
                "msg_exact_input",
                Some(23),
                Some("error"),
                Some(serde_json::json!({"message": "private provider error"})),
                None,
            ),
        ];

        let OpenCodeInputProgress::Terminal(OpenCodeInputTerminal::Failed(receipt)) =
            poll_input_terminal_from_messages(&messages, "ses_native", &[], "msg_exact_input")
        else {
            panic!("exact completed provider error is a typed terminal");
        };
        assert_eq!(receipt.session_id, "ses_native");
        assert_eq!(receipt.user_message_id, "msg_exact_input");
        assert_eq!(receipt.assistant_message_id, "msg_exact_error");
        assert!(!format!("{receipt:?}").contains("private provider error"));
    }

    #[test]
    fn stop_terminal_error_without_completion_marker_remains_pending() {
        let messages = vec![assistant_message(
            "msg_incomplete_error",
            "ses_native",
            "msg_exact_input",
            None,
            None,
            Some(serde_json::json!({"message": "private provider error"})),
            None,
        )];

        assert_eq!(
            poll_input_terminal_from_messages(&messages, "ses_native", &[], "msg_exact_input",),
            OpenCodeInputProgress::Pending,
            "an error payload alone does not prove provider terminal"
        );
    }

    #[test]
    fn stop_terminal_completed_response_is_correlated_to_exact_input() {
        let messages = vec![assistant_message(
            "msg_exact_done",
            "ses_native",
            "msg_exact_input",
            Some(24),
            Some("stop"),
            None,
            Some("completed response"),
        )];

        let OpenCodeInputProgress::Terminal(OpenCodeInputTerminal::Completed(receipt)) =
            poll_input_terminal_from_messages(&messages, "ses_native", &[], "msg_exact_input")
        else {
            panic!("exact completed assistant is a typed terminal");
        };
        assert_eq!(receipt.session_id, "ses_native");
        assert_eq!(receipt.user_message_id.as_deref(), Some("msg_exact_input"));
        assert_eq!(receipt.assistant_message_id, "msg_exact_done");
        assert_eq!(receipt.final_text, "completed response");
    }

    #[test]
    fn completed_tool_call_step_stays_pending_until_later_final_response() {
        let mut tool_step = assistant_message(
            "msg_tool_step",
            "ses_native",
            "msg_exact_input",
            Some(21),
            Some("tool-calls"),
            None,
            None,
        );
        tool_step.parts.push(Part::Tool(ToolPart {
            id: "prt_tool".to_owned(),
            session_id: Some("ses_native".to_owned()),
            message_id: Some("msg_tool_step".to_owned()),
            call_id: "call_1".to_owned(),
            tool: "read".to_owned(),
            state: serde_json::json!({
                "status": "completed",
                "input": {"filePath": "README.md"},
                "output": "contents",
                "title": "read README",
                "metadata": {},
                "time": {"start": 20, "end": 21}
            }),
            metadata: None,
        }));

        assert_eq!(
            poll_input_terminal_from_messages(
                std::slice::from_ref(&tool_step),
                "ses_native",
                &[],
                "msg_exact_input",
            ),
            OpenCodeInputProgress::Pending,
            "a completed tool-call step is not the input's turn terminal"
        );

        let final_response = assistant_message(
            "msg_final",
            "ses_native",
            "msg_exact_input",
            Some(22),
            Some("stop"),
            None,
            Some("finished after the tool call"),
        );
        let messages = [tool_step, final_response];
        let OpenCodeInputProgress::Terminal(OpenCodeInputTerminal::Completed(receipt)) =
            poll_input_terminal_from_messages(&messages, "ses_native", &[], "msg_exact_input")
        else {
            panic!("the later exact-input final response is terminal");
        };
        assert_eq!(receipt.assistant_message_id, "msg_final");
        assert_eq!(receipt.final_text, "finished after the tool call");
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
            system: Some("Saved Agent instructions\nUse the selected workspace.".into()),
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
        assert_eq!(
            value["system"],
            "Saved Agent instructions\nUse the selected workspace."
        );
        assert!(
            serde_json::to_value(Prompt::default())
                .unwrap()
                .get("system")
                .is_none()
        );
    }

    #[test]
    fn command_body_matches_installed_server_contract() {
        let value = serde_json::to_value(CommandBody {
            arguments: "--verbose".into(),
            command: "diagnose".into(),
            message_id: Some("msg_previous".into()),
            agent: Some("build".into()),
            model: None,
            variant: Some("fast".into()),
            parts: vec![CommandPart::File {
                id: None,
                mime: "text/plain".into(),
                filename: Some("notes.txt".into()),
                url: "data:text/plain;base64,SGk=".into(),
            }],
        })
        .expect("command body serializes");
        assert_eq!(value["messageID"], "msg_previous");
        assert!(value.get("messageId").is_none());
        assert_eq!(value["variant"], "fast");
        assert_eq!(value["parts"][0]["type"], "file");
        assert_eq!(value["parts"][0]["filename"], "notes.txt");
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
                                system: Some(
                                    "Native instructions\nKeep user input separate.".into(),
                                ),
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
                let body: serde_json::Value =
                    serde_json::from_str(request.split_once("\r\n\r\n").expect("HTTP body").1)
                        .unwrap();
                assert_eq!(
                    body["system"],
                    "Native instructions\nKeep user input separate."
                );
                assert_eq!(body["messageID"], "msg_input");
                assert_eq!(body["parts"][0]["text"], "hello");
                server.join().expect("server thread");
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn sse_stream_decodes_named_and_unnamed_json_events() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let body = "event: session.updated\ndata: {\"type\":\"session.updated\"}\n\ndata: {\"type\":\"message.updated\"}\n\n";
                let (url, request, server) = one_shot_server("200 OK", body);
                let client = OpenCodeClient::new(url, None).expect("client");
                let mut stream = client
                    .subscribe_events(EventQuery {
                        directory: Some("/tmp/workspace"),
                        workspace: Some("workspace-1"),
                    })
                    .await
                    .expect("event stream");
                let first = stream.next_event().await.expect("first event").expect("first");
                assert_eq!(first.name.as_deref(), Some("session.updated"));
                assert_eq!(first.data["type"], "session.updated");
                let second = stream.next_event().await.expect("second event").expect("second");
                assert_eq!(second.name, None);
                assert_eq!(second.data["type"], "message.updated");
                let request = request.recv().expect("request captured");
                assert!(request.starts_with("GET /event?directory=%2Ftmp%2Fworkspace&workspace=workspace-1 HTTP/1.1"));
                server.join().expect("server joined");
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn polling_waits_for_a_new_completed_assistant_message() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let completed = serde_json::json!([{
                    "info": {
                        "id": "msg_assistant",
                        "sessionID": "ses_native",
                        "role": "assistant",
                        "time": {"created": 10, "completed": 11},
                        "parentID": "msg_user",
                        "modelID": "model",
                        "providerID": "provider",
                        "finish": "stop"
                    },
                    "parts": [{
                        "id": "part_text",
                        "sessionID": "ses_native",
                        "messageID": "msg_assistant",
                        "type": "text",
                        "text": "done"
                    }]
                }])
                .to_string();
                let (url, server) = sequence_server(&["[]", &completed]);
                let client = OpenCodeClient::new(url, None).expect("client");
                let receipt = client
                    .wait_for_completed_assistant(
                        "ses_native",
                        &["msg_old"],
                        Instant::now() + Duration::from_secs(1),
                        Duration::from_millis(1),
                    )
                    .await
                    .expect("completed assistant");
                assert_eq!(receipt.session_id, "ses_native");
                assert_eq!(receipt.user_message_id.as_deref(), Some("msg_user"));
                assert_eq!(receipt.assistant_message_id, "msg_assistant");
                assert_eq!(receipt.final_text, "done");
                server.join().expect("server thread");
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn correlated_wait_ignores_other_terminal_messages_in_the_session() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let messages = serde_json::json!([
                    {
                        "info": {
                            "id": "msg_other_assistant",
                            "sessionID": "ses_native",
                            "role": "assistant",
                            "time": {"created": 100, "completed": 101},
                            "parentID": "msg_other_input",
                            "modelID": "model",
                            "providerID": "provider",
                            "finish": "stop"
                        },
                        "parts": [{
                            "id": "part_other",
                            "sessionID": "ses_native",
                            "messageID": "msg_other_assistant",
                            "type": "text",
                            "text": "unrelated newer turn"
                        }]
                    },
                    {
                        "info": {
                            "id": "msg_expected_assistant",
                            "sessionID": "ses_native",
                            "role": "assistant",
                            "time": {"created": 10, "completed": 11},
                            "parentID": "msg_expected_input",
                            "modelID": "model",
                            "providerID": "provider",
                            "finish": "stop"
                        },
                        "parts": [{
                            "id": "part_expected",
                            "sessionID": "ses_native",
                            "messageID": "msg_expected_assistant",
                            "type": "text",
                            "text": "the submitted turn"
                        }]
                    }
                ])
                .to_string();
                let (url, server) = sequence_server(&[&messages]);
                let client = OpenCodeClient::new(url, None).expect("client");
                let receipt = client
                    .wait_for_completed_assistant_for_input(
                        "ses_native",
                        &["msg_known_assistant"],
                        "msg_expected_input",
                        Instant::now() + Duration::from_secs(1),
                        Duration::from_millis(1),
                    )
                    .await
                    .expect("assistant correlated to exact input");
                assert_eq!(
                    receipt.user_message_id.as_deref(),
                    Some("msg_expected_input")
                );
                assert_eq!(receipt.assistant_message_id, "msg_expected_assistant");
                assert_eq!(receipt.final_text, "the submitted turn");
                server.join().expect("server thread");
            })
            .await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn correlated_wait_rejects_an_invalid_input_id_before_polling() {
        let client =
            OpenCodeClient::new(Url::parse("http://127.0.0.1:1/").unwrap(), None).expect("client");
        let error = client
            .wait_for_completed_assistant_for_input(
                "ses_native",
                &[],
                "not-a-message-id",
                Instant::now() + Duration::from_secs(1),
                Duration::from_millis(1),
            )
            .await
            .expect_err("invalid input ID rejected before network I/O");
        assert!(matches!(error, OpenCodeWaitError::InvalidInputMessageId));
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
