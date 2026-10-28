mod hermes;
mod hermes_approval;
mod openclaw;
mod openclaw_crypto;

use super::{
    AgentRunApprovalChoice, AgentRunExecutionObservation, AgentRunExecutionState, AgentRunOutput,
    AgentRunRequest, projection,
};
use serde_json::{Value, json};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64},
};
use std::{collections::BTreeMap, sync::atomic::Ordering, time::Duration};

/// Agent-specific request/context around the existing Gateway wire protocols.
/// Unlike ephemeral title execution it carries persisted provider sessions and
/// returns raw terminal artifacts, usage and continuity observations.
#[derive(Clone)]
struct Request {
    run_id: String,
    prompt: String,
    context: Value,
    session: Option<String>,
    observed_session: Arc<Mutex<Option<String>>>,
    cancelled: Arc<AtomicBool>,
    output: Option<tokio::sync::mpsc::Sender<AgentRunOutput>>,
    output_sequence: Arc<AtomicU64>,
    observed_approval: Arc<Mutex<Value>>,
}
#[derive(Debug, thiserror::Error)]
enum Error {
    #[error("{0}")]
    Failed(String),
    #[error("Agent Gateway request cancelled")]
    Cancelled,
    #[error("Agent Gateway request timed out")]
    Timeout,
    #[error("Gateway remote cancellation could not be verified")]
    Cleanup,
}
struct Output {
    text: String,
    success: bool,
    auth_failure: bool,
    suspended: bool,
    session_id: Option<String>,
    result: Value,
    usage: Value,
    events: Vec<Value>,
    provider: Option<String>,
    model: Option<String>,
}
impl Output {
    fn success(text: String) -> Self {
        Self {
            text,
            success: true,
            auth_failure: false,
            suspended: false,
            session_id: None,
            result: Value::Null,
            usage: Value::Null,
            events: Vec::new(),
            provider: None,
            model: None,
        }
    }
    fn failed(text: String) -> Self {
        Self {
            success: false,
            ..Self::success(text)
        }
    }
}
pub(super) async fn execute(
    claim: &super::RuntimeTransportTarget,
    input: &AgentRunRequest,
) -> AgentRunExecutionObservation {
    let previous_session = claim
        .session_params
        .as_ref()
        .and_then(|v| super::session::normalize_agent_session(&claim.runtime_type, v))
        .and_then(|v| v["sessionId"].as_str().map(str::to_owned))
        .or_else(|| claim.session_id.clone());
    let request = Request {
        run_id: claim.run_id.clone(),
        prompt: input.prompt.clone(),
        context: input.context.clone(),
        session: previous_session.clone(),
        observed_session: Arc::new(Mutex::new(previous_session)),
        cancelled: Arc::clone(&input.cancelled),
        output: input.output.clone(),
        output_sequence: Arc::new(AtomicU64::new(0)),
        observed_approval: Arc::new(Mutex::new(
            json!({"pending":false,"resolved":false,"decision":null,"rudderApprovalId":null,"error":null}),
        )),
    };
    let runtime = claim.runtime_type.clone();
    let config = input.config.clone();
    let owned_request = request.clone();
    // awc owns !Send connection state. Keep it on this one owned LocalSet and
    // await the blocking owner through socket close/remote stop reconciliation.
    // The caller's request-settlement future must never outlive this task.
    let result = tokio::task::spawn_blocking(move || {
        let runtime_handle = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| Error::Failed("Gateway I/O runtime is unavailable".into()))?;
        tokio::task::LocalSet::new().block_on(&runtime_handle, async {
            match runtime.as_str() {
                "hermes_gateway" => hermes::execute(&config, &owned_request).await,
                "openclaw_gateway" => openclaw::execute(&config, &owned_request).await,
                _ => Err(Error::Failed("Unknown Gateway runtime".into())),
            }
        })
    })
    .await
    .unwrap_or_else(|_| Err(Error::Failed("Gateway owner worker was interrupted".into())));
    match result {
        Ok(output) => {
            let session_id = output.session_id.or_else(|| {
                request
                    .observed_session
                    .lock()
                    .ok()
                    .and_then(|value| value.clone())
            });
            let session_params = session_id.as_ref().map(|id| {
                if claim.runtime_type == "hermes_gateway" {
                    json!({"sessionId":id,"hermesSessionId":id})
                } else {
                    json!({"sessionId":id})
                }
            });
            let mut observation = AgentRunExecutionObservation {
                state: if output.success {
                    AgentRunExecutionState::Succeeded
                } else if output.suspended {
                    AgentRunExecutionState::Suspended
                } else {
                    AgentRunExecutionState::Failed
                },
                error_code: if output.auth_failure {
                    Some("runtime_auth_required".into())
                } else if output.success {
                    None
                } else {
                    Some("gateway_run_failed".into())
                },
                error: (!output.success).then(|| output.text.clone()),
                exit_code: Some(if output.success { 0 } else { 1 }),
                signal: None,
                usage: normalize_usage(&output.usage),
                result: json!({"summary":output.text,"providerResult":output.result,"sessionId":session_id,"sessionParamsAfter":session_params,
                    "provider":output.provider.as_deref().unwrap_or(if claim.runtime_type=="hermes_gateway" {"hermes"}else{"openclaw"}),"model":output.model.as_deref().or_else(||input.config["model"].as_str()).unwrap_or("unknown")}),
                session_id,
                session_params,
                clear_session: false,
                stdout: output.text,
                stderr: String::new(),
                events: output.events,
                cleanup_proof: None,
            };
            observation.result["requestOutcome"] = json!("provider_terminal");
            if let Ok(approval) = request.observed_approval.lock() {
                observation.result["approval"] = approval.clone();
            }
            if !output.success
                && !output.auth_failure
                && let Some(network) = projection::network_suspension(
                    observation.error.as_deref().unwrap_or(""),
                    &claim.runtime_type,
                    input.config["model"].as_str().unwrap_or(""),
                    observation.session_id.as_deref(),
                    observation.session_params.as_ref(),
                    false,
                    false,
                )
            {
                observation.state = AgentRunExecutionState::Suspended;
                observation.result["networkSuspension"] = network;
                observation.error_code = Some("provider_transport_unavailable".into());
            }
            observation
        }
        Err(error) => {
            let state = if error.to_string().starts_with("Run output persistence") {
                AgentRunExecutionState::Unresolved
            } else {
                match error {
                    Error::Cancelled => AgentRunExecutionState::Cancelled,
                    Error::Timeout => AgentRunExecutionState::TimedOut,
                    _ => AgentRunExecutionState::Failed,
                }
            };
            let code = if state == AgentRunExecutionState::Unresolved {
                "run_output_persistence_failed"
            } else {
                match error {
                    Error::Cancelled => "cancelled",
                    Error::Timeout => "timeout",
                    Error::Cleanup => "gateway_cancel_unverified",
                    _ => "gateway_invoke_failed",
                }
            };
            let mut observation =
                AgentRunExecutionObservation::failure(state, code, error.to_string());
            observation.session_id = request
                .observed_session
                .lock()
                .ok()
                .and_then(|value| value.clone());
            observation.session_params = observation.session_id.as_ref().map(|id| {
                if claim.runtime_type == "hermes_gateway" {
                    json!({"sessionId":id,"hermesSessionId":id})
                } else {
                    json!({"sessionId":id})
                }
            });
            observation.result = json!({"remoteCancellationAccepted":matches!(error,Error::Cancelled|Error::Timeout),
                "remoteCancellationVerified":claim.runtime_type=="hermes_gateway" && matches!(error,Error::Cancelled|Error::Timeout),
                "sessionId":observation.session_id,"sessionParamsAfter":observation.session_params});
            if let Ok(approval) = request.observed_approval.lock() {
                observation.result["approval"] = approval.clone();
                if state != AgentRunExecutionState::Unresolved
                    && approval["pending"] == true
                    && approval["resolved"] != true
                    && !matches!(error, Error::Cancelled | Error::Timeout)
                {
                    observation.error_code = Some("hermes_gateway_approval_unresolved".into());
                }
            }
            observation
        }
    }
}

fn normalize_usage(raw: &Value) -> Value {
    if !raw.is_object() {
        return Value::Null;
    }
    let tokens = |keys: &[&str]| {
        projection::token_count(
            keys.iter()
                .find_map(|key| raw[*key].as_f64())
                .unwrap_or_default(),
        )
    };
    let input = tokens(&["input_tokens", "inputTokens", "input"]);
    let cached = tokens(&[
        "cached_input_tokens",
        "cachedInputTokens",
        "cache_read_input_tokens",
        "cacheRead",
    ]);
    let output = tokens(&["output_tokens", "outputTokens", "output"]);
    let mut usage = json!({"inputTokens":input,"cachedInputTokens":cached,"outputTokens":output,"rawInputTokens":input,"rawCachedInputTokens":cached,"rawOutputTokens":output,"rawUsage":raw,"billingType":"unknown"});
    if let Some(cost) = raw["costUsd"].as_f64().filter(|value| value.is_finite()) {
        usage["costUsd"] = json!(cost);
    }
    usage
}

async fn emit_event(request: &Request, event: &Value) -> Result<(), Error> {
    let Some(output) = &request.output else {
        return Ok(());
    };
    tokio::time::timeout(
        Duration::from_secs(5),
        output.send(AgentRunOutput::Event {
            offset: request.output_sequence.fetch_add(1, Ordering::AcqRel),
            event: event.clone(),
        }),
    )
    .await
    .map_err(|_| Error::Failed("Run output persistence timed out".into()))?
    .map_err(|_| Error::Failed("Run output persistence channel closed".into()))
}

fn nonempty(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}
fn configured(config: &Value, key: &str, default: &str) -> String {
    nonempty(&config[key]).unwrap_or(default).to_owned()
}
fn number(value: &Value, default: f64) -> f64 {
    value.as_f64().filter(|v| v.is_finite()).unwrap_or(default)
}
fn boolean(value: &Value, default: bool) -> bool {
    value.as_bool().unwrap_or_else(|| {
        match nonempty(value).map(str::to_ascii_lowercase).as_deref() {
            Some("true" | "1") => true,
            Some("false" | "0") => false,
            _ => default,
        }
    })
}
fn headers(config: &Value) -> BTreeMap<String, String> {
    config["headers"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| {
            nonempty(value).map(|_| (key.clone(), value.as_str().unwrap().to_owned()))
        })
        .collect()
}
fn header<'a>(headers: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_str())
}
fn bearer(token: &str) -> String {
    if token.to_ascii_lowercase().starts_with("bearer ") {
        token.to_owned()
    } else {
        format!("Bearer {token}")
    }
}
fn text(value: &Value) -> Option<String> {
    if let Some(s) = nonempty(value) {
        return Some(s.to_owned());
    }
    for key in ["output", "content", "text", "message", "summary", "delta"] {
        if let Some(found) = value.get(key).and_then(text) {
            return Some(found);
        }
    }
    let parts: Vec<_> = value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(text)
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}
fn failed(message: impl Into<String>, auth: bool) -> Output {
    Output {
        auth_failure: auth,
        ..Output::failed(message.into())
    }
}
fn cancelled(request: &Request) -> bool {
    request.cancelled.load(Ordering::Acquire)
}
fn endpoint(base: &url::Url, path: &str) -> url::Url {
    let mut result = base.clone();
    result.set_path(&format!(
        "{}/{}",
        base.path().trim_end_matches('/'),
        path.trim_start_matches('/')
    ));
    result.set_query(None);
    result.set_fragment(None);
    result
}
fn encoded(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

struct HttpReply {
    status: u16,
    body: Value,
}
async fn json_request(
    client: &awc::Client,
    method: awc::http::Method,
    url: &url::Url,
    headers: &BTreeMap<String, String>,
    body: Option<&Value>,
    timeout: Duration,
) -> Result<HttpReply, Error> {
    let started = tokio::time::Instant::now();
    let mut outgoing = client.request(method, url.as_str()).timeout(timeout);
    for (key, value) in headers {
        outgoing = outgoing.insert_header((key.as_str(), value.as_str()));
    }
    let mut response = match body {
        Some(body) => outgoing.send_json(body).await,
        None => outgoing.send().await,
    }
    .map_err(|error| match error {
        awc::error::SendRequestError::Timeout => Error::Timeout,
        awc::error::SendRequestError::Connect(error) => {
            Error::Failed(format!("Gateway connection failed: {error}"))
        }
        awc::error::SendRequestError::Http(error) => {
            Error::Failed(format!("Invalid Gateway request: {error}"))
        }
        error => Error::Failed(format!("Gateway request failed: {error}")),
    })?;
    let status = response.status().as_u16();
    // Same existing Hermes response limit. Never log request headers/config.
    let bytes = tokio::time::timeout(
        timeout.saturating_sub(started.elapsed()),
        response.body().limit(4 * 1024 * 1024),
    )
    .await
    .map_err(|_| Error::Timeout)?
    .map_err(|_| Error::Failed("Gateway connection closed while reading response".into()))?;
    let body = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({"text":String::from_utf8_lossy(&bytes)}));
    Ok(HttpReply { status, body })
}
