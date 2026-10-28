//! Browser/Computer MCP provider transport. Protocol/framing and authenticated
//! HTTP execution are shared with the existing native core MCP server. Action
//! normalization is the same pure contract used by native public ingress.
use crate::mcp_server::{self, McpSurface};
use rudder_agent_contract_core::contract;
use rudder_agent_request_planner::{
    DirectRequest, HttpMethod, RequiredContext,
    desktop_contract::{self, DesktopSurface},
};
use rudder_cli_mcp_contract_core::reject_model_identity_overrides;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
};
const DESKTOP_TOOL_LIMIT: usize = 16_000_000;

pub fn tool_descriptors(surface: DesktopSurface) -> Vec<Value> {
    match surface {
        DesktopSurface::Computer=>serde_json::from_str(include_str!("computer-tools.generated.json")).expect("captured Computer MCP tools"),
        DesktopSurface::Browser=>contract()["capabilities"].as_array().into_iter().flatten()
            .filter(|entry|entry["id"].as_str().is_some_and(|id|id.starts_with("browser."))&&entry["mcp"].is_object())
            .map(|entry|json!({"name":entry["mcp"]["name"],"description":entry["mcp"]["description"],"inputSchema":entry["mcp"]["inputSchema"],"annotations":entry["mcp"]["annotations"]})).collect(),
    }
}
fn enabled(surface: DesktopSurface, env: &BTreeMap<String, String>) -> bool {
    match surface {
        DesktopSurface::Browser => env
            .get("RUDDER_BROWSER_ENABLED")
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("true")),
        DesktopSurface::Computer => env
            .get("RUDDER_COMPUTER_ENABLED")
            .is_some_and(|v| v == "true"),
    }
}
fn server_info(surface: DesktopSurface) -> Value {
    json!({"name":format!("rudder-{}",surface.prefix()),"version":env!("CARGO_PKG_VERSION")})
}
fn browser_hash() -> String {
    let semantic=tool_descriptors(DesktopSurface::Browser).into_iter().map(|tool|json!({"name":tool["name"],"description":tool["description"],"inputSchema":tool["inputSchema"]})).collect::<Vec<_>>();
    Sha256::digest(serde_json::to_vec(&semantic).expect("native Browser tool descriptors"))
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect()
}

pub fn run<R: Read, W: Write>(
    input: R,
    output: W,
    environment: &BTreeMap<String, String>,
    surface: DesktopSurface,
) -> Result<(), String> {
    let invoke = |params: &Value, env: &BTreeMap<String, String>| call_tool(surface, params, env);
    let descriptor = McpSurface {
        server_info: server_info(surface),
        tools: if enabled(surface, environment) {
            tool_descriptors(surface)
        } else {
            Vec::new()
        },
        invoke: &invoke,
        // Preserve the current Computer outer RPC budget; Browser owns its
        // larger screenshot budget. Neither widens the default core surface.
        response_limit: if surface == DesktopSurface::Browser {
            DESKTOP_TOOL_LIMIT
        } else {
            1_000_000
        },
        browser_contract_hash: Some(browser_hash()),
    };
    mcp_server::run_with_surface(input, output, environment, Some(&descriptor))
}

fn call_tool(surface: DesktopSurface, params: &Value, env: &BTreeMap<String, String>) -> Value {
    if !enabled(surface, env) {
        return mcp_server::tool_error(
            &format!("{}_disabled", surface.prefix()),
            &format!(
                "Rudder {} is disabled or unavailable for this Run.",
                surface.title()
            ),
            Value::Null,
        );
    }
    let Some(name) = params["name"].as_str().filter(|v| !v.is_empty()) else {
        return mcp_server::tool_error(
            "rudder_mcp_invalid_request",
            "MCP tool name is required",
            Value::Null,
        );
    };
    if !tool_descriptors(surface)
        .iter()
        .any(|tool| tool["name"] == name)
    {
        return mcp_server::tool_error(
            "rudder_mcp_tool_not_available",
            &format!(
                "Rudder {} MCP tool is not available: {name}",
                surface.title()
            ),
            Value::Null,
        );
    }
    let arguments = params
        .get("arguments")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !arguments.is_object() {
        return mcp_server::tool_error(
            "rudder_mcp_invalid_argument",
            "MCP tool arguments must be an object",
            Value::Null,
        );
    }
    if let Err(error) = reject_model_identity_overrides(&arguments) {
        return mcp_server::tool_error(
            error.code(),
            &error.to_string(),
            json!({"reservedArguments":error.reserved_arguments()}),
        );
    }
    let prefix = format!("rudder_{}_", surface.prefix());
    let Some(action) = name
        .strip_prefix(&prefix)
        .filter(|action| desktop_contract::known_action(surface, action))
    else {
        return mcp_server::tool_error(
            "rudder_mcp_tool_not_available",
            "Unknown native desktop action",
            Value::Null,
        );
    };
    let normalized = match desktop_contract::normalize(surface, action, &arguments) {
        Ok(value) => value,
        Err(_) => {
            return mcp_server::tool_error(
                &format!("{}_invalid_argument", surface.prefix()),
                &format!("Invalid arguments for {name}."),
                Value::Null,
            );
        }
    };
    let request = DirectRequest {
        capability_id: format!("{}.{}", surface.prefix(), action),
        method: HttpMethod::Post,
        path: format!("/api/{}/{action}", surface.prefix()),
        query: Vec::new(),
        headers: Vec::new(),
        body: Some(normalized),
        context: RequiredContext {
            organization: true,
            agent: true,
            run: true,
        },
        response_limit: surface.max_response(),
    };
    match mcp_server::execute_direct_request(&request, env) {
        Ok(value) => success_with_images(value),
        Err(error) => mcp_server::cli_error_result(error),
    }
}

fn success_with_images(mut value: Value) -> Value {
    let image = |entry: &Value| {
        entry["mimeType"]
            .as_str()
            .filter(|mime| ["image/png", "image/jpeg"].contains(mime))
            .zip(entry["base64"].as_str().filter(|data| !data.is_empty()))
            .map(|(mime, data)| json!({"type":"image","mimeType":mime,"data":data}))
    };
    if let Some(content) = image(&value) {
        if let Some(object) = value.as_object_mut() {
            object.remove("base64");
        }
        return json!({"content":[content],"structuredContent":value,"isError":false});
    }
    let images = value["images"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(image)
        .collect::<Vec<_>>();
    if images.is_empty() {
        return mcp_server::success_tool_result(value);
    }
    if let Some(object) = value.as_object_mut() {
        object.remove("images");
    }
    let mut result = mcp_server::success_tool_result(value);
    if let Some(content) = result["content"].as_array_mut() {
        content.extend(images);
    }
    if serde_json::to_vec(&result).is_ok_and(|bytes| bytes.len() <= DESKTOP_TOOL_LIMIT) {
        result
    } else {
        mcp_server::tool_error(
            "rudder_mcp_response_too_large",
            "Rudder MCP response exceeded the bounded tool-result budget.",
            json!({"maxBytes":DESKTOP_TOOL_LIMIT}),
        )
    }
}

/// Browser-only CLI liveness transport. Main owns the revocation callback;
/// the default core MCP server never starts a monitor.
pub struct BrowserLivenessGuard {
    stopped: std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
}
impl Drop for BrowserLivenessGuard {
    fn drop(&mut self) {
        let (stopped, changed) = &*self.stopped;
        if let Ok(mut stopped) = stopped.lock() {
            *stopped = true;
            changed.notify_all();
        }
    }
}
pub fn start_browser_liveness(
    environment: &BTreeMap<String, String>,
    on_revoked: fn(&str),
) -> BrowserLivenessGuard {
    start_liveness(environment, on_revoked, std::time::Duration::from_secs(5))
}
fn start_liveness(
    environment: &BTreeMap<String, String>,
    on_revoked: fn(&str),
    interval: std::time::Duration,
) -> BrowserLivenessGuard {
    let stopped = std::sync::Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
    let control = stopped.clone();
    let env = environment.clone();
    std::thread::spawn(move || {
        let request = DirectRequest {
            capability_id: "browser.liveness".into(),
            method: HttpMethod::Post,
            path: "/api/browser/liveness".into(),
            query: Vec::new(),
            headers: Vec::new(),
            body: Some(json!({})),
            context: RequiredContext {
                organization: true,
                agent: true,
                run: true,
            },
            response_limit: 1_000_000,
        };
        loop {
            let (state, changed) = &*control;
            let Ok(state) = state.lock() else {
                return;
            };
            let Ok((state, _)) = changed.wait_timeout_while(state, interval, |stopped| !*stopped)
            else {
                return;
            };
            if *state {
                return;
            }
            drop(state);
            let result = mcp_server::execute_direct_request(&request, &env);
            if control.0.lock().map_or(true, |stopped| *stopped) {
                return;
            }
            if let Err(error) = result
                && matches!(
                    error.code.as_str(),
                    "browser_disabled"
                        | "browser_runtime_unsupported"
                        | "browser_run_inactive"
                        | "browser_run_forbidden"
                )
            {
                on_revoked(&error.code);
                return;
            }
        }
    });
    BrowserLivenessGuard { stopped }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_desktop_surfaces_have_exact_inventory_and_shared_contract_refinements() {
        assert_eq!(tool_descriptors(DesktopSurface::Browser).len(), 25);
        assert_eq!(tool_descriptors(DesktopSurface::Computer).len(), 13);
        let env = BTreeMap::from([("RUDDER_COMPUTER_ENABLED".into(), "true".into())]);
        let result = call_tool(
            DesktopSurface::Computer,
            &json!({"name":"rudder_computer_launch_app","arguments":{}}),
            &env,
        );
        assert_eq!(
            result["structuredContent"]["code"],
            "computer_invalid_argument"
        );
        let result = call_tool(
            DesktopSurface::Computer,
            &json!({"name":"rudder_computer_list_apps","arguments":{"runId":"other"}}),
            &env,
        );
        assert_eq!(
            result["structuredContent"]["code"],
            "rudder_mcp_reserved_identity_argument"
        );
    }
    #[test]
    fn desktop_protocol_uses_shared_framing_and_capability_gating() {
        for surface in [DesktopSurface::Browser, DesktopSurface::Computer] {
            let input=b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\"}}\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n";
            let mut output = Vec::new();
            run(input.as_slice(), &mut output, &BTreeMap::new(), surface).unwrap();
            let results = String::from_utf8(output)
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(results[0]["result"]["serverInfo"], server_info(surface));
            assert_eq!(results[1]["result"]["tools"], json!([]));
        }
    }
    #[test]
    fn browser_mcp_call_uses_existing_native_http_transport_and_managed_run_headers() {
        use std::{net::TcpListener, time::Duration};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 4096];
            let (header_end, length) = loop {
                let count = stream.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(at) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..at]).to_ascii_lowercase();
                    let length = header
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    break (at + 4, length);
                }
            };
            while bytes.len() < header_end + length {
                let count = stream.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
            }
            let header = String::from_utf8_lossy(&bytes[..header_end]).to_ascii_lowercase();
            assert!(header.starts_with("post /api/browser/open "));
            assert!(header.contains("x-rudder-agent-id: 20000000-0000-4000-8000-000000000001"));
            assert!(header.contains("x-rudder-run-id: 30000000-0000-4000-8000-000000000001"));
            assert!(header.contains("authorization: bearer synthetic-desktop-key"));
            let body: Value =
                serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
            assert_eq!(body["url"], "https://fixture.invalid/page");
            let response = r#"{"tabId":"opaque-tab","url":"https://fixture.invalid/page"}"#;
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",response.len(),response).unwrap();
        });
        let env = BTreeMap::from([
            ("RUDDER_BROWSER_ENABLED".into(), "true".into()),
            ("RUDDER_API_URL".into(), format!("http://{address}")),
            ("RUDDER_API_KEY".into(), "synthetic-desktop-key".into()),
            (
                "RUDDER_ORG_ID".into(),
                "10000000-0000-4000-8000-000000000001".into(),
            ),
            (
                "RUDDER_AGENT_ID".into(),
                "20000000-0000-4000-8000-000000000001".into(),
            ),
            (
                "RUDDER_RUN_ID".into(),
                "30000000-0000-4000-8000-000000000001".into(),
            ),
        ]);
        let result = call_tool(
            DesktopSurface::Browser,
            &json!({"name":"rudder_browser_open","arguments":{"url":"https://fixture.invalid/page"}}),
            &env,
        );
        assert_eq!(result["isError"], false, "{result}");
        assert_eq!(result["structuredContent"]["tabId"], "opaque-tab");
        server.join().unwrap();
    }
    #[test]
    fn screenshot_projection_emits_native_images_with_opaque_metadata() {
        let result = success_with_images(
            json!({"tabId":"opaque-tab","mimeType":"image/png","base64":"synthetic-image"}),
        );
        assert_eq!(result["content"][0]["type"], "image");
        assert_eq!(result["structuredContent"]["tabId"], "opaque-tab");
        assert!(result["structuredContent"].get("base64").is_none());
        let result = success_with_images(
            json!({"pid":77,"images":[{"mimeType":"image/jpeg","base64":"fixture"}]}),
        );
        assert_eq!(result["content"][1]["type"], "image");
        assert!(result["structuredContent"].get("images").is_none());
    }
}
