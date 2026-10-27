use super::openclaw_crypto::{Identity, platform};
use super::*;
use actix_codec::Framed;
use actix_http::ws::Item;
use awc::{
    BoxedSocket,
    ws::{Codec, Frame, Message},
};
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::time::Instant;
use uuid::Uuid;

const MAX_PAYLOAD: usize = 25 * 1024 * 1024; // Existing Node GatewayWsClient limit.
type Socket = Framed<BoxedSocket, Codec>;
struct Client {
    socket: Socket,
    continuation: Vec<u8>,
    runs: HashSet<String>,
    assistant: String,
    lifecycle_error: Option<String>,
}
#[derive(Debug)]
struct RpcError {
    message: String,
    details: Value,
}
impl From<Error> for RpcError {
    fn from(error: Error) -> Self {
        Self {
            message: error.to_string(),
            details: Value::Null,
        }
    }
}
impl Client {
    async fn open(
        url: &url::Url,
        headers: &BTreeMap<String, String>,
        request: &Request,
        timeout: Duration,
    ) -> Result<Self, Error> {
        let client = awc::Client::builder().disable_redirects().finish();
        let mut connect = client.ws(url.as_str()).max_frame_size(MAX_PAYLOAD);
        for (key, value) in headers {
            connect = connect.set_header(key.as_str(), value.as_str());
        }
        let (_, socket) = tokio::time::timeout(timeout, connect.connect())
            .await
            .map_err(|_| Error::Timeout)?
            .map_err(|error| match error {
                awc::error::WsClientError::InvalidResponseStatus(status) => {
                    Error::Failed(format!("OpenClaw Gateway HTTP {}", status.as_u16()))
                }
                awc::error::WsClientError::SendRequest(error) => {
                    Error::Failed(format!("OpenClaw Gateway connection failed: {error}"))
                }
                _ => Error::Failed("Malformed OpenClaw Gateway handshake".into()),
            })?;
        Ok(Self {
            socket,
            continuation: Vec::new(),
            runs: HashSet::from([request.run_id.clone()]),
            assistant: String::new(),
            lifecycle_error: None,
        })
    }
    async fn next_json(
        &mut self,
        request: &Request,
        deadline: Option<Instant>,
        watch_cancel: bool,
    ) -> Result<Value, Error> {
        loop {
            if watch_cancel && cancelled(request) {
                return Err(Error::Cancelled);
            }
            if deadline.is_some_and(|at| Instant::now() >= at) {
                return Err(Error::Timeout);
            }
            let frame =
                match tokio::time::timeout(Duration::from_millis(100), self.socket.next()).await {
                    Err(_) => continue,
                    Ok(Some(Ok(frame))) => frame,
                    _ => return Err(Error::Failed("OpenClaw Gateway connection closed".into())),
                };
            let bytes = match frame {
                Frame::Text(bytes) | Frame::Binary(bytes) => bytes.to_vec(),
                Frame::Ping(bytes) => {
                    self.socket
                        .send(Message::Pong(bytes))
                        .await
                        .map_err(|_| Error::Failed("OpenClaw Gateway connection closed".into()))?;
                    continue;
                }
                Frame::Pong(_) => continue,
                Frame::Close(_) => {
                    return Err(Error::Failed("OpenClaw Gateway connection closed".into()));
                }
                Frame::Continuation(Item::FirstText(bytes) | Item::FirstBinary(bytes)) => {
                    self.continuation = bytes.to_vec();
                    continue;
                }
                Frame::Continuation(Item::Continue(bytes)) => {
                    if self.continuation.len() + bytes.len() > MAX_PAYLOAD {
                        return Err(Error::Failed(
                            "OpenClaw Gateway message exceeds its existing payload limit".into(),
                        ));
                    }
                    self.continuation.extend_from_slice(&bytes);
                    continue;
                }
                Frame::Continuation(Item::Last(bytes)) => {
                    if self.continuation.len() + bytes.len() > MAX_PAYLOAD {
                        return Err(Error::Failed(
                            "OpenClaw Gateway message exceeds its existing payload limit".into(),
                        ));
                    }
                    self.continuation.extend_from_slice(&bytes);
                    std::mem::take(&mut self.continuation)
                }
            };
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                return Ok(value);
            }
        }
    }
    fn event(&mut self, value: &Value) {
        if value["event"] != "agent" {
            return;
        }
        let payload = &value["payload"];
        if !nonempty(&payload["runId"]).is_some_and(|id| self.runs.contains(id)) {
            return;
        }
        let data = &payload["data"];
        match payload["stream"].as_str().unwrap_or("") {
            "assistant" => {
                if let Some(delta) = data["delta"].as_str().filter(|s| !s.trim().is_empty()) {
                    self.assistant.push_str(delta);
                } else if let Some(text) = nonempty(&data["text"]) {
                    self.assistant.push_str(text);
                }
            }
            "error" => self.lifecycle_error = text(data),
            "lifecycle"
                if matches!(
                    data["phase"].as_str(),
                    Some("error" | "failed" | "cancelled")
                ) =>
            {
                self.lifecycle_error = text(data)
            }
            _ => {}
        }
    }
    async fn request(
        &mut self,
        method: &str,
        params: Value,
        request: &Request,
        timeout: Duration,
        watch_cancel: bool,
    ) -> Result<Value, RpcError> {
        let id = Uuid::new_v4().to_string();
        let deadline = (!timeout.is_zero()).then(|| Instant::now() + timeout);
        tokio::time::timeout(
            timeout,
            self.socket.send(Message::Text(
                json!({"type":"req","id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            )),
        )
        .await
        .map_err(|_| RpcError::from(Error::Timeout))?
        .map_err(|_| RpcError::from(Error::Failed("OpenClaw Gateway connection closed".into())))?;
        loop {
            let value = self.next_json(request, deadline, watch_cancel).await?;
            if value["type"] == "event" {
                self.event(&value);
                continue;
            }
            if value["type"] != "res" || value["id"] != id {
                continue;
            }
            if value["ok"] == true {
                return Ok(value.get("payload").cloned().unwrap_or(Value::Null));
            }
            return Err(RpcError {
                message: nonempty(&value["error"]["message"])
                    .or_else(|| nonempty(&value["error"]["code"]))
                    .unwrap_or("Gateway request failed")
                    .into(),
                details: value["error"]["details"].clone(),
            });
        }
    }
    async fn connect(
        &mut self,
        params: &Connect<'_>,
        request: &Request,
        timeout: Duration,
        pairing: bool,
    ) -> Result<Value, RpcError> {
        let deadline = Some(Instant::now() + timeout);
        let nonce = loop {
            let value = self.next_json(request, deadline, true).await?;
            if value["type"] == "event"
                && value["event"] == "connect.challenge"
                && let Some(nonce) = nonempty(&value["payload"]["nonce"])
            {
                break nonce.to_owned();
            }
            self.event(&value);
        };
        let mut scopes = params.scopes.clone();
        if pairing && !scopes.iter().any(|s| s == "operator.pairing") {
            scopes.push("operator.pairing".into());
        }
        let mut connect = json!({"minProtocol":4,"maxProtocol":4,"client":{
            "id":configured(params.config,"clientId","gateway-client"),"version":configured(params.config,"clientVersion","rudder"),
            "platform":platform(),"mode":configured(params.config,"clientMode","backend")},
            "role":configured(params.config,"role","operator"),"scopes":scopes});
        if let Some(family) = nonempty(&params.config["deviceFamily"]) {
            connect["client"]["deviceFamily"] = json!(family);
        }
        let mut auth = serde_json::Map::new();
        for (key, value) in [
            ("token", params.token.as_deref()),
            ("password", nonempty(&params.config["password"])),
            ("deviceToken", nonempty(&params.config["deviceToken"])),
        ] {
            if let Some(value) = value {
                auth.insert(key.into(), json!(value));
            }
        }
        if !auth.is_empty() {
            connect["auth"] = Value::Object(auth);
        }
        if !pairing && let Some(device) = params.identity {
            let signed_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            connect["device"] = device.device(
                params.config,
                &scopes,
                params.token.as_deref(),
                &nonce,
                signed_at,
            );
        }
        self.request("connect", connect, request, timeout, true)
            .await
    }
    async fn abort(
        &mut self,
        request: &Request,
        run: &str,
        session: &str,
        timeout: Duration,
    ) -> bool {
        self.request(
            "sessions.abort",
            json!({"runId":run}),
            request,
            timeout,
            false,
        )
        .await
        .is_ok()
            || self
                .request(
                    "chat.abort",
                    json!({"sessionKey":session,"runId":run}),
                    request,
                    timeout,
                    false,
                )
                .await
                .is_ok()
    }
    async fn close(&mut self) {
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            self.socket.send(Message::Close(Some(awc::ws::CloseReason {
                code: awc::ws::CloseCode::Normal,
                description: Some("rudder-complete".into()),
            }))),
        )
        .await;
    }
}

struct Connect<'a> {
    config: &'a Value,
    scopes: Vec<String>,
    token: Option<String>,
    identity: Option<&'a Identity>,
}
fn scopes(config: &Value) -> Vec<String> {
    let values: Vec<_> = match &config["scopes"] {
        Value::Array(values) => values
            .iter()
            .filter_map(nonempty)
            .map(str::to_owned)
            .collect(),
        Value::String(value) => value
            .split(|c: char| c == ',' || c.is_whitespace())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => vec![],
    };
    if values.is_empty() {
        vec!["operator.read".into(), "operator.write".into()]
    } else {
        values
    }
}
fn auth_token(config: &Value, headers: &BTreeMap<String, String>) -> Option<String> {
    if let Some(token) = nonempty(&config["authToken"]).or_else(|| nonempty(&config["token"])) {
        return Some(token.into());
    }
    if let Some(token) = header(headers, "x-openclaw-token")
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        return Some(token.into());
    }
    let raw = header(headers, "x-openclaw-auth")
        .or_else(|| header(headers, "authorization"))?
        .trim();
    let token = if raw.to_ascii_lowercase().starts_with("bearer ") {
        raw[7..].trim()
    } else {
        raw
    };
    (!token.is_empty()).then(|| token.into())
}
fn session(config: &Value, request: &Request) -> String {
    let key = configured(config, "sessionKey", "rudder");
    let key = match configured(config, "sessionKeyStrategy", "issue")
        .to_ascii_lowercase()
        .as_str()
    {
        "run" => format!("rudder:run:{}", request.run_id),
        _ => key,
    };
    match nonempty(&config["agentId"]) {
        Some(agent) if agent != "main" && !key.starts_with(&format!("agent:{agent}:")) => {
            format!("agent:{agent}:{key}")
        }
        _ => key,
    }
}
fn result_text(value: &Value) -> Option<String> {
    let parts: Vec<_> = value["payloads"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| nonempty(&part["text"]))
        .collect();
    if parts.is_empty() {
        nonempty(&value["text"])
            .or_else(|| nonempty(&value["summary"]))
            .map(str::to_owned)
    } else {
        Some(parts.join("\n\n"))
    }
}
fn positive_integer(value: &Value, default: u64) -> u64 {
    let parsed = value
        .as_f64()
        .or_else(|| {
            value.as_str().and_then(|raw| {
                let prefix: String = raw
                    .trim()
                    .chars()
                    .enumerate()
                    .take_while(|(index, c)| {
                        c.is_ascii_digit() || (*index == 0 && matches!(c, '+' | '-'))
                    })
                    .map(|(_, c)| c)
                    .collect();
                prefix.parse::<f64>().ok()
            })
        })
        .unwrap_or(default as f64);
    if parsed.is_finite() {
        parsed.floor().max(1.0) as u64
    } else {
        default
    }
}

pub(super) async fn execute(config: &Value, request: &Request) -> Result<Output, Error> {
    let url = url::Url::parse(&configured(config, "url", ""))
        .map_err(|_| Error::Failed("OpenClaw gateway URL is missing or invalid".into()))?;
    if !matches!(url.scheme(), "ws" | "wss") {
        return Ok(failed("Unsupported OpenClaw Gateway URL protocol", false));
    }
    let seconds = number(&config["timeoutSec"], 120.0).floor().max(0.0) as u64;
    let connect_timeout = if seconds == 0 {
        Duration::from_secs(10)
    } else {
        Duration::from_secs(seconds.min(15))
    };
    let wait_ms = positive_integer(
        &config["waitTimeoutMs"],
        if seconds > 0 { seconds * 1000 } else { 30_000 },
    );
    let wait_timeout = Duration::from_millis(wait_ms);
    let mut headers: BTreeMap<String, String> = config["headers"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_owned())))
        .collect();
    let token = auth_token(config, &headers);
    if header(&headers, "authorization").is_none()
        && let Some(token) = &token
    {
        headers.insert("authorization".into(), bearer(token));
    }
    // Keep one generated key for the request, including an allowed pairing retry.
    let identity = Identity::new(config)?;
    let connect = Connect {
        config,
        scopes: scopes(config),
        token,
        identity: identity.as_ref(),
    };
    let mut client = Client::open(&url, &headers, request, connect_timeout).await?;
    if let Err(first) = client
        .connect(&connect, request, connect_timeout, false)
        .await
    {
        client.close().await;
        let can_pair = first
            .message
            .to_ascii_lowercase()
            .contains("pairing required")
            && identity.is_some()
            && boolean(&config["autoPairOnFirstConnect"], true)
            && (connect.token.is_some() || nonempty(&config["password"]).is_some());
        if !can_pair {
            return Ok(failed(first.message, false));
        }
        pair(
            &url,
            &headers,
            &connect,
            request,
            connect_timeout,
            &first.details,
        )
        .await?;
        client = Client::open(&url, &headers, request, connect_timeout).await?;
        if let Err(error) = client
            .connect(&connect, request, connect_timeout, false)
            .await
        {
            client.close().await;
            return Ok(failed(error.message, false));
        }
    }
    let session = session(config, request);
    let mut params = config["payloadTemplate"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let prefix = params
        .get("message")
        .and_then(nonempty)
        .or_else(|| params.get("text").and_then(nonempty))
        .map(str::to_owned);
    // Product Intelligence must send its real prompt; the legacy generic wake
    // path ignored promptTemplate for this feature.
    params.insert(
        "message".into(),
        json!(prefix.map_or_else(
            || request.prompt.clone(),
            |prefix| format!("{prefix}\n\n{}", request.prompt)
        )),
    );
    params.remove("text");
    params.insert("sessionKey".into(), json!(session));
    params.insert("idempotencyKey".into(), json!(request.run_id));
    let can_override = configured(config, "role", "operator") == "admin"
        || connect.scopes.iter().any(|s| s == "operator.admin");
    if can_override {
        if params.get("model").and_then(nonempty).is_none()
            && let Some(model) = nonempty(&config["model"])
        {
            params.insert("model".into(), json!(model));
        }
    } else {
        params.remove("model");
        params.remove("provider");
    }
    if params.get("agentId").and_then(nonempty).is_none()
        && let Some(agent) = nonempty(&config["agentId"])
    {
        params.insert("agentId".into(), json!(agent));
    }
    if !params.get("timeout").is_some_and(Value::is_number) {
        params.insert("timeout".into(), json!(wait_ms));
    }
    let accepted = match client
        .request(
            "agent",
            Value::Object(params),
            request,
            connect_timeout,
            true,
        )
        .await
    {
        Ok(value) => value,
        Err(error) => {
            client.close().await;
            return Ok(failed(error.message, false));
        }
    };
    let run = nonempty(&accepted["runId"])
        .unwrap_or(&request.run_id)
        .to_owned();
    client.runs.insert(run.clone());
    let mut latest = accepted.clone();
    if !matches!(nonempty(&accepted["status"]), Some("ok" | "error")) {
        match client
            .request(
                "agent.wait",
                json!({"runId":run,"timeoutMs":wait_ms}),
                request,
                wait_timeout + connect_timeout,
                true,
            )
            .await
        {
            Ok(value) => latest = value,
            Err(error) => {
                let stopped = client.abort(request, &run, &session, connect_timeout).await;
                client.close().await;
                if !stopped {
                    return Err(Error::Cleanup);
                }
                if cancelled(request) {
                    return Err(Error::Cancelled);
                }
                return Ok(failed(error.message, false));
            }
        }
    }
    if cancelled(request) || latest["status"] == "timeout" {
        let stopped = client.abort(request, &run, &session, connect_timeout).await;
        client.close().await;
        if !stopped {
            return Err(Error::Cleanup);
        }
        return if cancelled(request) {
            Err(Error::Cancelled)
        } else {
            Err(Error::Timeout)
        };
    }
    client.close().await;
    let status = nonempty(&latest["status"]).unwrap_or("");
    if status == "error" || (!status.is_empty() && status != "ok") {
        return Ok(failed(
            text(&latest["error"])
                .or(client.lifecycle_error)
                .unwrap_or_else(|| format!("OpenClaw Gateway run failed: {status}")),
            false,
        ));
    }
    let output = if !client.assistant.trim().is_empty() {
        client.assistant.trim().into()
    } else {
        result_text(&accepted["result"])
            .or_else(|| result_text(&accepted))
            .or_else(|| result_text(&latest))
            .unwrap_or_default()
    };
    Ok(Output::success(output))
}

async fn pair(
    url: &url::Url,
    headers: &BTreeMap<String, String>,
    params: &Connect<'_>,
    request: &Request,
    timeout: Duration,
    details: &Value,
) -> Result<(), Error> {
    let mut client = Client::open(url, headers, request, timeout).await?;
    let result = async {
        client
            .connect(params, request, timeout, true)
            .await
            .map_err(|e| Error::Failed(e.message))?;
        let id = if let Some(id) = nonempty(&details["requestId"]) {
            id.to_owned()
        } else {
            let listing = client
                .request("device.pair.list", json!({}), request, timeout, true)
                .await
                .map_err(|e| Error::Failed(e.message))?;
            let pending = listing["pending"].as_array().cloned().unwrap_or_default();
            let record = pending
                .iter()
                .find(|entry| params.identity.is_some_and(|id| entry["deviceId"] == id.id))
                .or_else(|| pending.last());
            record
                .and_then(|entry| nonempty(&entry["requestId"]))
                .ok_or_else(|| {
                    Error::Failed("No pending OpenClaw device pairing request found".into())
                })?
                .to_owned()
        };
        client
            .request(
                "device.pair.approve",
                json!({"requestId":id}),
                request,
                timeout,
                true,
            )
            .await
            .map_err(|e| Error::Failed(e.message))?;
        Ok(())
    }
    .await;
    client.close().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_and_result_contracts() {
        assert_eq!(scopes(&json!({})), vec!["operator.read", "operator.write"]);
        assert_eq!(
            scopes(&json!({"scopes":[" operator.admin "," "]})),
            vec!["operator.admin"]
        );
        assert_eq!(
            result_text(&json!({"payloads":[{"text":"One"},{"text":"Two"}]})).as_deref(),
            Some("One\n\nTwo")
        );
        assert_eq!(
            auth_token(
                &json!({}),
                &BTreeMap::from([("Authorization".into(), "Bearer token".into())])
            )
            .as_deref(),
            Some("token")
        );
    }
}
