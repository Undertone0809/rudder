//! Pinned, bounded Streamable HTTP MCP transport. No ambient proxy, redirect
//! credential forwarding, or second DNS lookup after policy validation.
use super::{
    d1::Error,
    security::{self, HttpOptions, Network},
};
use reqwest::{
    Method,
    header::{HeaderMap, HeaderValue},
};
use serde_json::{Value, json};
use std::time::Duration;
use url::Url;
const MAX_RESPONSE: usize = 10 * 1024 * 1024;
const MAX_REQUEST: usize = 2 * 1024 * 1024;
pub(super) struct Wire {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
    pub message: Option<Value>,
}
fn failed() -> Error {
    Error::Runtime("mcp_transport_failed")
}
fn sse_message(bytes: &[u8], id: &Value) -> Option<Value> {
    let text = std::str::from_utf8(bytes).ok()?;
    let normalized = text.replace("\r\n", "\n");
    let complete = normalized.rfind("\n\n")? + 2;
    normalized[..complete]
        .split("\n\n")
        .filter_map(|event| {
            let data = event
                .lines()
                .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
                .collect::<Vec<_>>()
                .join("\n");
            serde_json::from_str::<Value>(&data).ok()
        })
        .find(|message| {
            message.get("id") == Some(id)
                && (message.get("result").is_some() || message.get("error").is_some())
        })
}
pub(super) async fn request(
    network: &Network,
    url: &Url,
    method: Method,
    headers: HeaderMap,
    body: Option<Vec<u8>>,
    id: Option<&Value>,
    timeout: Duration,
) -> Result<Wire, Error> {
    if body.as_ref().is_some_and(|body| body.len() > MAX_REQUEST) {
        return Err(Error::Runtime("mcp_result_too_large"));
    }
    tokio::time::timeout(timeout.min(Duration::from_secs(90)), async {
        let origin = url.origin();
        let mut target = url.clone();
        let mut method = method;
        let mut body = body;
        let mut headers = headers;
        for redirect in 0..=3 {
            let address = security::pinned(&target, network).await?;
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .resolve(
                    target
                        .host_str()
                        .ok_or_else(failed)?
                        .trim_matches(['[', ']']),
                    address,
                )
                .build()
                .map_err(|_| failed())?;
            let mut send = client
                .request(method.clone(), target.clone())
                .headers(headers.clone());
            if let Some(body) = &body {
                send = send.body(body.clone());
            }
            let mut response = tokio::time::timeout(Duration::from_secs(15), send.send())
                .await
                .map_err(|_| Error::Runtime("mcp_request_timeout"))?
                .map_err(|error| {
                    if error.is_timeout() {
                        Error::Runtime("mcp_request_timeout")
                    } else {
                        failed()
                    }
                })?;
            let status = response.status().as_u16();
            let response_headers = response.headers().clone();
            if [301, 302, 303, 307, 308].contains(&status) {
                if let Some(location) = response
                    .headers()
                    .get("location")
                    .and_then(|value| value.to_str().ok())
                {
                    if redirect == 3 {
                        return Err(failed());
                    }
                    let next = target.join(location).map_err(|_| failed())?;
                    security::parse_url(next.as_str())?;
                    if next.origin() != origin {
                        return Err(failed());
                    }
                    if status == 303 || ([301, 302].contains(&status) && method == Method::POST) {
                        method = Method::GET;
                        body = None;
                        headers.remove("content-type");
                        headers.remove("content-length");
                    }
                    target = next;
                    continue;
                }
            }
            let event_stream = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| {
                    v.split(';')
                        .next()
                        .is_some_and(|v| v.trim() == "text/event-stream")
                });
            let (body, message) = tokio::time::timeout(Duration::from_secs(60), async {
                let mut bytes = Vec::new();
                loop {
                    let chunk = response.chunk().await.map_err(|_| failed())?;
                    let Some(chunk) = chunk else {
                        break;
                    };
                    if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE {
                        return Err(Error::Runtime("mcp_result_too_large"));
                    }
                    bytes.extend_from_slice(&chunk);
                    if event_stream {
                        if let Some(message) = id.and_then(|id| sse_message(&bytes, id)) {
                            return Ok((bytes, Some(message)));
                        }
                    }
                }
                let message = if event_stream {
                    id.and_then(|id| sse_message(&bytes, id))
                } else {
                    serde_json::from_slice(&bytes).ok()
                };
                Ok((bytes, message))
            })
            .await
            .map_err(|_| Error::Runtime("mcp_request_timeout"))??;
            return Ok(Wire {
                status,
                headers: response_headers,
                body,
                message,
            });
        }
        Err(failed())
    })
    .await
    .map_err(|_| Error::Runtime("mcp_request_timeout"))?
}
pub(super) fn envelope(method: &str, id: Option<u64>, mut params: Value, modern: bool) -> Value {
    if modern {
        params["_meta"] = json!({"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"rudder-managed-mcp","version":"1.0.0"}});
    }
    let mut message = json!({"jsonrpc":"2.0","method":method,"params":params});
    if let Some(id) = id {
        message["id"] = json!(id);
    }
    message
}
fn result(wire: Wire, id: u64) -> Result<Value, Error> {
    if !(200..300).contains(&wire.status) {
        return Err(failed());
    }
    let response = wire.message.ok_or_else(failed)?;
    if response["id"] != id || response.get("error").is_some() {
        return Err(Error::Runtime("mcp_tool_failed"));
    }
    response
        .get("result")
        .cloned()
        .filter(Value::is_object)
        .ok_or_else(failed)
}
async fn rpc(
    options: &HttpOptions,
    session: Option<&str>,
    version: &str,
    message: &Value,
    timeout: Duration,
) -> Result<Wire, Error> {
    let mut headers = options.headers.clone();
    headers.insert(
        "accept",
        HeaderValue::from_static("application/json, text/event-stream"),
    );
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers.insert(
        "mcp-protocol-version",
        HeaderValue::from_str(version).map_err(|_| failed())?,
    );
    if let Some(session) = session {
        headers.insert(
            "mcp-session-id",
            HeaderValue::from_str(session).map_err(|_| failed())?,
        );
    }
    let wire = request(
        &options.network,
        &options.url,
        Method::POST,
        headers,
        Some(serde_json::to_vec(message).map_err(|_| failed())?),
        message.get("id"),
        timeout,
    )
    .await?;
    match wire.status {
        401 => Err(Error::Runtime("mcp_upstream_unauthorized")),
        429 => Err(Error::Runtime("mcp_upstream_rate_limited")),
        _ => Ok(wire),
    }
}
pub(super) async fn call(
    options: &HttpOptions,
    name: &str,
    args: &Value,
    startup_ms: u64,
    tool_ms: u64,
) -> Result<Value, Error> {
    let startup = Duration::from_millis(startup_ms);
    let tool = Duration::from_millis(tool_ms);
    let mut session = None;
    let called=async{
        let probe=rpc(options,None,"2026-07-28",&envelope("server/discover",Some(1),json!({}),true),startup).await?;
        let modern=probe.message.as_ref().is_some_and(|m|m["result"]["supportedVersions"].as_array().is_some_and(|a|a.iter().any(|v|v=="2026-07-28")));
        let version=if modern{"2026-07-28".to_owned()}else{
            let initialized=rpc(options,None,"2025-11-25",&envelope("initialize",Some(2),json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"rudder-managed-mcp","version":"1.0.0"}}),false),startup).await?;
            session=initialized.headers.get("mcp-session-id").and_then(|value|value.to_str().ok()).map(str::to_owned);let result=result(initialized,2)?;let version=result["protocolVersion"].as_str().filter(|v|super::SUPPORTED.contains(v)).ok_or_else(failed)?.to_owned();
            let notification=rpc(options,session.as_deref(),&version,&envelope("notifications/initialized",None,json!({}),false),startup).await?;if !(200..300).contains(&notification.status){return Err(failed());}version
        };
        let called=rpc(options,session.as_deref(),&version,&envelope("tools/call",Some(3),json!({"name":name,"arguments":args}),modern),tool).await.map_err(|error|match error{Error::Runtime("mcp_request_timeout")=>Error::Runtime("mcp_tool_timeout"),other=>other})?;let result=result(called,3)?;
        if !result["content"].is_array(){return Err(Error::Runtime("mcp_result_invalid"));}Ok(result)
    }.await;
    if let Some(session) = session {
        let mut headers = options.headers.clone();
        headers.insert(
            "mcp-session-id",
            HeaderValue::from_str(&session).map_err(|_| failed())?,
        );
        headers.insert(
            "mcp-protocol-version",
            HeaderValue::from_static("2025-11-25"),
        );
        let closed = request(
            &options.network,
            &options.url,
            Method::DELETE,
            headers,
            None,
            None,
            startup,
        )
        .await;
        // The existing runtime ignores close errors after awaiting close.
        let _ = closed;
    }
    called.map_err(|error| match error {
        Error::Runtime("mcp_request_timeout") => Error::Runtime("mcp_startup_timeout"),
        other => other,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sse_correlates_id_and_ignores_notifications() {
        let data=b"data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"content\":[]}}\n\n";
        assert_eq!(
            sse_message(data, &json!(3)).unwrap()["result"]["content"],
            json!([])
        );
        assert!(sse_message(data, &json!(9)).is_none());
        assert!(sse_message(b"data: {\"id\":3,\"result\":{}}", &json!(3)).is_none());
    }
    fn read_request(socket: &mut std::net::TcpStream) -> (String, Value) {
        use std::io::Read;
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut byte = [0; 1];
        while !bytes.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
        }
        let headers = String::from_utf8(bytes).unwrap();
        let length = headers
            .lines()
            .find_map(|line| {
                line.split_once(':')
                    .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        let mut body = vec![0; length];
        socket.read_exact(&mut body).unwrap();
        (
            headers,
            serde_json::from_slice(&body).unwrap_or(Value::Null),
        )
    }
    #[tokio::test]
    async fn native_http_negotiates_and_reads_real_sse_tool_result() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let peer = std::thread::spawn(move || {
            for expected in ["server/discover", "tools/call"] {
                let (mut socket, _) = listener.accept().unwrap();
                let (headers, request) = read_request(&mut socket);
                assert!(
                    headers
                        .to_ascii_lowercase()
                        .contains("authorization: bearer synthetic-managed-mcp-fixture")
                );
                assert_eq!(request["method"], expected);
                assert_eq!(
                    request["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"],
                    "2026-07-28"
                );
                let body = if expected == "server/discover" {
                    json!({"jsonrpc":"2.0","id":request["id"],"result":{"supportedVersions":["2026-07-28"],"resultType":"complete","capabilities":{"tools":{}}}}).to_string()
                } else {
                    assert_eq!(request["params"]["name"], "fixture_read");
                    format!(
                        "data: {}\n\n",
                        json!({"jsonrpc":"2.0","id":request["id"],"result":{"content":[{"type":"text","text":"synthetic upstream result"}],"resultType":"complete"}})
                    )
                };
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",if expected=="server/discover"{"application/json"}else{"text/event-stream"},body.len(),body).unwrap();
            }
        });
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer synthetic-managed-mcp-fixture"),
        );
        let options = HttpOptions {
            url: Url::parse(&format!("{origin}/mcp")).unwrap(),
            headers,
            network: Network {
                allowed_origins: [origin].into_iter().collect(),
                curated_origin: None,
            },
        };
        let result = call(
            &options,
            "fixture_read",
            &json!({"query":"synthetic"}),
            3000,
            3000,
        )
        .await
        .unwrap();
        assert_eq!(result["content"][0]["text"], "synthetic upstream result");
        peer.join().unwrap();
    }
    #[tokio::test]
    async fn cross_origin_redirect_does_not_forward_credentials() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let origin = format!("http://127.0.0.1:{port}");
        let peer = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            read_request(&mut socket);
            write!(socket,"HTTP/1.1 302 Found\r\nLocation: http://localhost:{port}/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let network = Network {
            allowed_origins: [origin.clone(), format!("http://localhost:{port}")]
                .into_iter()
                .collect(),
            curated_origin: None,
        };
        let error = request(
            &network,
            &Url::parse(&origin).unwrap(),
            Method::GET,
            HeaderMap::new(),
            None,
            None,
            Duration::from_secs(3),
        )
        .await
        .err()
        .unwrap();
        assert!(matches!(error, Error::Runtime("mcp_transport_failed")));
        peer.join().unwrap();
    }
    #[tokio::test]
    async fn private_target_requires_exact_origin_allowlist() {
        let network = Network {
            allowed_origins: Default::default(),
            curated_origin: None,
        };
        assert!(
            security::pinned(&Url::parse("https://127.0.0.1/mcp").unwrap(), &network)
                .await
                .is_err()
        );
    }
}
