use super::*;
use awc::http::Method;
use futures_util::StreamExt;
use tokio::time::{Instant, sleep};

fn terminal(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "failed" | "cancelled" | "stopped" | "error"
    )
}
fn status(value: &Value) -> &str {
    value["status"].as_str().unwrap_or("")
}
fn loopback(host: &str) -> bool {
    matches!(
        host.trim_matches(['[', ']']).to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}
async fn base(config: &Value) -> Result<url::Url, Error> {
    let base = url::Url::parse(&configured(config, "url", ""))
        .map_err(|_| Error::Failed("Hermes API Server URL is missing or invalid.".into()))?;
    if !matches!(base.scheme(), "http" | "https")
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
        || !base.host_str().is_some_and(loopback)
    {
        return Err(Error::Failed(
            "Hermes endpoint must be loopback-only without userinfo, query or fragment.".into(),
        ));
    }
    if base.host_str() == Some("localhost") {
        let hosts =
            tokio::net::lookup_host(("localhost", base.port_or_known_default().unwrap_or(80)))
                .await
                .map_err(|_| {
                    Error::Failed("Hermes localhost endpoint could not be resolved.".into())
                })?;
        let addresses: Vec<_> = hosts.collect();
        if addresses.is_empty() || addresses.iter().any(|address| !address.ip().is_loopback()) {
            return Err(Error::Failed(
                "Hermes localhost endpoint did not resolve exclusively to loopback addresses."
                    .into(),
            ));
        }
    }
    Ok(base)
}
fn positive_ms(value: &Value, fallback: f64) -> Duration {
    let n = number(value, fallback);
    Duration::from_millis(if n > 0.0 {
        n.floor().max(1.0) as u64
    } else {
        fallback as u64
    })
}
fn session_key(config: &Value, request: &Request) -> String {
    let key = configured(config, "sessionKey", "");
    match configured(config, "sessionKeyStrategy", "issue")
        .to_ascii_lowercase()
        .as_str()
    {
        "run" => format!("rudder:run:{}", request.run_id),
        "fixed" if !key.is_empty() => key,
        _ => nonempty(&request.context["issueId"])
            .or_else(|| nonempty(&request.context["taskId"]))
            .map(|id| format!("rudder:issue:{id}"))
            .unwrap_or_else(|| {
                if key.is_empty() {
                    format!("rudder:run:{}", request.run_id)
                } else {
                    key
                }
            }),
    }
}

pub(super) async fn execute(config: &Value, request: &Request) -> Result<Output, Error> {
    let base = base(config).await?;
    let mut headers = headers(config);
    if header(&headers, "accept").is_none() {
        headers.insert("accept".into(), "application/json".into());
    }
    if header(&headers, "authorization").is_none() {
        let token = ["apiKey", "authToken", "token"]
            .into_iter()
            .find_map(|key| nonempty(&config[key]));
        if let Some(token) = token {
            headers.insert("authorization".into(), bearer(token));
        }
    }
    if !header(&headers, "authorization").is_some_and(|v| {
        v.to_ascii_lowercase().starts_with("bearer ") && v.split_whitespace().count() == 2
    }) {
        return Ok(failed(
            "Hermes API Server requires an explicit Bearer API key.",
            true,
        ));
    }
    let timeout = positive_ms(
        &config["timeoutMs"],
        number(&config["timeoutSec"], 120.0) * 1000.0,
    );
    let request_timeout = timeout.min(Duration::from_secs(15));
    let client = awc::Client::builder().disable_redirects().finish();
    let mut session_body = json!({"source":"rudder"});
    if let Some(model) = nonempty(&config["model"]) {
        session_body["model"] = json!(model);
    }
    let session = if let Some(session) = &request.session {
        let existing = json_request(
            &client,
            Method::GET,
            &endpoint(&base, &format!("/api/sessions/{}", encoded(session))),
            &headers,
            None,
            request_timeout,
        )
        .await?;
        let returned = nonempty(&existing.body["session"]["id"])
            .or_else(|| nonempty(&existing.body["id"]))
            .or_else(|| nonempty(&existing.body["session_id"]));
        if !(200..300).contains(&existing.status) || returned != Some(session.as_str()) {
            return Ok(failed(
                "Hermes session mapping returned a missing or conflicting provider ID.",
                matches!(existing.status, 401 | 403),
            ));
        }
        session.clone()
    } else {
        let created = json_request(
            &client,
            Method::POST,
            &endpoint(&base, "/api/sessions"),
            &headers,
            Some(&session_body),
            request_timeout,
        )
        .await?;
        if !(200..300).contains(&created.status) {
            return Ok(failed(
                text(&created.body).unwrap_or_else(|| {
                    format!("Hermes session creation returned HTTP {}", created.status)
                }),
                matches!(created.status, 401 | 403),
            ));
        }
        nonempty(&created.body["session"]["id"])
            .or_else(|| nonempty(&created.body["id"]))
            .or_else(|| nonempty(&created.body["session_id"]))
            .ok_or_else(|| {
                Error::Failed(
                    "Hermes session creation did not return a provider session ID.".into(),
                )
            })?
            .to_owned()
    };
    let messages = json_request(
        &client,
        Method::GET,
        &endpoint(
            &base,
            &format!("/api/sessions/{}/messages", encoded(&session)),
        ),
        &headers,
        None,
        request_timeout,
    )
    .await?;
    if let Ok(mut observed) = request.observed_session.lock() {
        *observed = Some(session.clone());
    }
    if !(200..300).contains(&messages.status)
        || nonempty(&messages.body["session_id"]).is_some_and(|id| id != session)
    {
        return Ok(failed(
            "Hermes session messages could not be verified.",
            matches!(messages.status, 401 | 403),
        ));
    }
    if cancelled(request) {
        return Err(Error::Cancelled);
    }
    let mut body = config["payloadTemplate"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let input = if let Some(projection) = config
        .get("rudderToolContextProjection")
        .filter(|value| value.is_object())
    {
        let mut projection = projection.clone();
        projection["sessionId"] = json!(session);
        format!(
            "{}\n\nRUDDER_TOOL_CONTEXT_V1\n{}",
            request.prompt, projection
        )
    } else {
        request.prompt.clone()
    };
    body.insert("input".into(), json!(input));
    body.insert("session_id".into(), json!(session));
    body.insert("idempotency_key".into(), json!(request.run_id));
    body.remove("message");
    if let Some(model) = nonempty(&config["model"]) {
        body.insert("model".into(), json!(model));
    }
    let mut submit_headers = headers.clone();
    submit_headers.insert("x-hermes-session-key".into(), session_key(config, request));
    let started = json_request(
        &client,
        Method::POST,
        &endpoint(&base, "/v1/runs"),
        &submit_headers,
        Some(&Value::Object(body)),
        request_timeout,
    )
    .await?;
    if !(200..300).contains(&started.status) {
        return Ok(failed(
            text(&started.body).unwrap_or_else(|| {
                format!("Hermes run submission returned HTTP {}", started.status)
            }),
            matches!(started.status, 401 | 403),
        ));
    }
    let run_id = nonempty(&started.body["run_id"])
        .or_else(|| nonempty(&started.body["id"]))
        .ok_or_else(|| Error::Failed("Hermes API Server did not return a run_id.".into()))?
        .to_owned();
    let result = observe(
        &client,
        &base,
        &headers,
        &run_id,
        started.body,
        request,
        timeout,
    )
    .await;
    let result = result.map(|mut output| {
        output.session_id = Some(session.clone());
        if !output.result.is_object() {
            output.result = json!({});
        }
        output.result["sessionMapping"] =
            json!({"mode":"hermes_sessions_api_v1","verified":true,"providerSessionId":session});
        output
    });
    match result {
        Err(_) => {
            let stopped = stop(&client, &base, &headers, &run_id, request_timeout).await;
            if !stopped {
                if let Err(error) = &result
                    && error.to_string().starts_with("Run output persistence")
                {
                    return Err(Error::Failed(format!(
                        "{error}; remote stop was not verified"
                    )));
                }
                return Err(Error::Cleanup);
            }
            result
        }
        _ => result,
    }
}

async fn observe(
    client: &awc::Client,
    base: &url::Url,
    headers: &BTreeMap<String, String>,
    run: &str,
    mut latest: Value,
    request: &Request,
    timeout: Duration,
) -> Result<Output, Error> {
    let request_timeout = timeout.min(Duration::from_secs(15));
    let deadline = Instant::now() + timeout;
    let mut assistant = String::new();
    let mut events = Vec::new();
    let mut response = client
        .get(endpoint(base, &format!("/v1/runs/{}/events", encoded(run))).as_str())
        .timeout(request_timeout);
    for (key, value) in headers {
        response = response.insert_header((key.as_str(), value.as_str()));
    }
    if let Ok(mut stream) = response.send().await
        && stream.status().is_success()
    {
        let mut pending = Vec::new();
        'stream: while !terminal(status(&latest)) {
            if cancelled(request) {
                return Err(Error::Cancelled);
            }
            if Instant::now() >= deadline {
                break;
            }
            match tokio::time::timeout(Duration::from_millis(100), stream.next()).await {
                Err(_) => continue,
                Ok(Some(Ok(chunk))) => pending.extend_from_slice(&chunk),
                _ => break,
            }
            while let Some(index) = pending.iter().position(|c| *c == b'\n') {
                let line: Vec<_> = pending.drain(..=index).collect();
                let line = String::from_utf8_lossy(&line);
                let Some(raw) = line.trim().strip_prefix("data:") else {
                    continue;
                };
                let Ok(event) = serde_json::from_str::<Value>(raw.trim()) else {
                    continue;
                };
                emit_event(request, &event).await?;
                events.push(event.clone());
                let event_kind = event["event"].as_str().unwrap_or("");
                if event_kind == "message.delta" {
                    if let Some(part) = event["delta"].as_str() {
                        assistant.push_str(part);
                    } else if let Some(part) = text(&event) {
                        assistant.push_str(&part);
                    }
                }
                if event_kind == "approval.request" {
                    let session = request
                        .observed_session
                        .lock()
                        .ok()
                        .and_then(|session| session.clone())
                        .ok_or_else(|| {
                            Error::Failed(
                                "Hermes provider session mapping was lost before approval.".into(),
                            )
                        })?;
                    super::hermes_approval::resolve(
                        client, base, headers, run, &session, request, &event, timeout,
                    )
                    .await?;
                }
                let terminal_status = match event_kind {
                    "run.completed" => "completed",
                    "run.failed" => "failed",
                    "run.cancelled" => "cancelled",
                    _ => continue,
                };
                latest = event;
                latest["status"] = json!(terminal_status);
                break 'stream;
            }
        }
    }
    while !terminal(status(&latest)) {
        if cancelled(request) {
            return Err(Error::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(Error::Timeout);
        }
        sleep(Duration::from_millis(250)).await;
        if let Ok(polled) = json_request(
            client,
            Method::GET,
            &endpoint(base, &format!("/v1/runs/{}", encoded(run))),
            headers,
            None,
            request_timeout.min(Duration::from_secs(5)),
        )
        .await
            && (200..300).contains(&polled.status)
        {
            latest = polled.body;
        }
    }
    let output = if assistant.trim().is_empty() {
        text(&latest).unwrap_or_default()
    } else {
        assistant.trim().to_owned()
    };
    let mut result = if status(&latest).eq_ignore_ascii_case("completed") {
        Output::success(output)
    } else {
        failed(
            text(&latest["error"]).unwrap_or_else(|| format!("Hermes run {}", status(&latest))),
            false,
        )
    };
    result.usage = latest["usage"].clone();
    result.provider = Some("hermes".into());
    result.model = nonempty(&latest["model"]).map(str::to_owned);
    result.result = latest;
    result.events = events;
    Ok(result)
}

async fn stop(
    client: &awc::Client,
    base: &url::Url,
    headers: &BTreeMap<String, String>,
    run: &str,
    timeout: Duration,
) -> bool {
    let Ok(reply) = json_request(
        client,
        Method::POST,
        &endpoint(base, &format!("/v1/runs/{}/stop", encoded(run))),
        headers,
        Some(&json!({"reason":"rudder_abort"})),
        timeout,
    )
    .await
    else {
        return false;
    };
    if !(200..300).contains(&reply.status) {
        return false;
    }
    let until = Instant::now() + Duration::from_millis(1500);
    let mut latest = reply.body;
    loop {
        if terminal(status(&latest)) {
            return matches!(status(&latest), "cancelled" | "stopped");
        }
        if Instant::now() >= until {
            return false;
        }
        sleep(Duration::from_millis(250)).await;
        if let Ok(reply) = json_request(
            client,
            Method::GET,
            &endpoint(base, &format!("/v1/runs/{}", encoded(run))),
            headers,
            None,
            timeout.min(Duration::from_secs(1)),
        )
        .await
        {
            latest = reply.body;
        }
    }
}
