//! The existing Gateway protocols, restricted to one ephemeral title prompt.
//! No Rudder Agent/Run rows, tool continuation, or Node callbacks are involved.
mod hermes;
#[cfg(test)]
mod network_tests;
mod openclaw;
mod openclaw_crypto;

use super::{Error, Output, Request};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::atomic::Ordering, time::Duration};

pub(super) async fn execute(
    kind: &str,
    config: &Value,
    request: &Request,
) -> Result<Output, Error> {
    match kind {
        "hermes_gateway" => hermes::execute(config, request).await,
        "openclaw_gateway" => openclaw::execute(config, request).await,
        _ => Err(Error::Failed("Unknown Gateway runtime".into())),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_text_and_header_contracts() {
        assert_eq!(
            text(&json!({"content":[{"text":"One"},{"text":"Two"}]})).as_deref(),
            Some("One\nTwo")
        );
        assert_eq!(
            text(&json!({"output":{"summary":" Title "}})).as_deref(),
            Some("Title")
        );
        let values =
            headers(&json!({"headers":{"Authorization":"Bearer key","empty":" ","number":3}}));
        assert_eq!(header(&values, "authorization"), Some("Bearer key"));
        assert_eq!(values.len(), 1);
        assert_eq!(encoded("a/b? #"), "a%2Fb%3F%20%23");
    }
}
