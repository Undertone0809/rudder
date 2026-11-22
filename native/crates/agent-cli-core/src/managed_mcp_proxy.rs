//! Stdio-to-native-HTTP transport for managed MCP bindings. Policy, credentials,
//! OAuth and audit decisions remain in the verified native server endpoint.
use reqwest::blocking::Client;
use rudder_cli_mcp_contract_core::{FrameLimits, FrameMode, InputParser, encode_frame};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    time::Duration,
};

const MAX_BYTES: usize = 10 * 1024 * 1024;
fn limits() -> FrameLimits {
    FrameLimits {
        max_frame_bytes: MAX_BYTES,
        max_header_bytes: 64 * 1024,
    }
}
fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}
fn mode(probe: &[u8]) -> Option<FrameMode> {
    let start = probe.iter().position(|b| !b.is_ascii_whitespace())?;
    let bytes = &probe[start..];
    let prefix = b"Content-Length:";
    let common = bytes.len().min(prefix.len());
    if bytes[..common].eq_ignore_ascii_case(&prefix[..common]) {
        (bytes.len() >= prefix.len()).then_some(FrameMode::ContentLength)
    } else {
        Some(FrameMode::Newline)
    }
}
/// The command dispatcher supplies one persisted binding UUID, never a URL or
/// upstream credential. Agent JWT/run identity comes from the managed runtime.
pub fn run<R: Read, W: Write>(
    mut input: R,
    mut output: W,
    environment: &BTreeMap<String, String>,
    binding_id: &str,
) -> Result<(), String> {
    if binding_id.len() != 36
        || binding_id.bytes().enumerate().any(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b != b'-'
            } else {
                !b.is_ascii_hexdigit()
            }
        })
    {
        return Err("Managed MCP binding ID must be a UUID".into());
    }
    let base = environment
        .get("RUDDER_API_URL")
        .ok_or("RUDDER_API_URL is required")?;
    let token = environment
        .get("RUDDER_API_KEY")
        .filter(|token| !token.is_empty())
        .ok_or("RUDDER_API_KEY is required")?;
    let endpoint =
        super::build_request_url(base, &format!("/api/mcp/runtime/bindings/{binding_id}"), "")
            .map_err(|_| "Managed MCP API URL is invalid")?;
    let timeout = environment
        .get("RUDDER_MCP_REQUEST_TIMEOUT_MS")
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(120000);
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(timeout))
        .build()
        .map_err(|_| "Managed MCP HTTP client could not be initialized")?;
    let mut parser = InputParser::with_limits(limits())
        .map_err(|_| "Managed MCP parser could not be initialized")?;
    let mut frame_mode = None;
    let mut probe = Vec::new();
    let mut bytes = [0; 8192];
    loop {
        let count = input
            .read(&mut bytes)
            .map_err(|_| "Managed MCP input could not be read")?;
        if count == 0 {
            parser
                .finish()
                .map_err(|_| "Managed MCP input frame was incomplete")?;
            return Ok(());
        }
        if frame_mode.is_none() {
            probe.extend_from_slice(&bytes[..count]);
            frame_mode = mode(&probe);
        }
        let messages = parser
            .push(&bytes[..count])
            .map_err(|_| "Managed MCP input frame is invalid or too large")?;
        let Some(mode) = frame_mode else {
            continue;
        };
        for message in messages {
            let id = message.get("id").cloned().unwrap_or(Value::Null);
            let mut request = client
                .post(endpoint.clone())
                .bearer_auth(token)
                .header("accept", "application/json")
                .json(&message);
            if let Some(version) =
                message["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"]
                    .as_str()
                    .or_else(|| message["params"]["protocolVersion"].as_str())
            {
                request = request.header("MCP-Protocol-Version", version);
            }
            if let Some(run) = environment.get("RUDDER_RUN_ID") {
                request = request.header("X-Rudder-Run-Id", run);
            }
            let reply = match request.send() {
                Ok(response) if response.status().as_u16() == 202 => None,
                Ok(response) => {
                    let status = response.status().as_u16();
                    let mut body = Vec::new();
                    let read = response.take((MAX_BYTES + 1) as u64).read_to_end(&mut body);
                    Some(if read.is_err() || body.len() > MAX_BYTES {
                        error(
                            id,
                            -32002,
                            "Managed MCP response could not be read within the output limit",
                        )
                    } else if status == 401 || status == 403 {
                        error(id, -32001, "Managed MCP request is not authorized")
                    } else if !(200..300).contains(&status) {
                        error(id, -32002, "Managed MCP native endpoint failed")
                    } else {
                        serde_json::from_slice(&body).unwrap_or_else(|_| {
                            error(
                                id,
                                -32603,
                                "Managed MCP native endpoint returned invalid JSON",
                            )
                        })
                    })
                }
                Err(_) => Some(error(
                    id,
                    -32002,
                    "Managed MCP native endpoint is unavailable",
                )),
            };
            if let Some(reply) = reply {
                let frame = encode_frame(&reply, mode, limits())
                    .map_err(|_| "Managed MCP output frame is too large")?;
                output
                    .write_all(&frame)
                    .and_then(|_| output.flush())
                    .map_err(|_| "Managed MCP response could not be written")?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_fragmented_header() {
        assert!(mode(b"Content-L").is_none());
        assert!(matches!(
            mode(b"Content-Length: 10\r\n"),
            Some(FrameMode::ContentLength)
        ));
        assert!(matches!(mode(b" {\"jsonrpc\":"), Some(FrameMode::Newline)));
    }
}
