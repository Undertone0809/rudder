use rudder_cli_mcp_contract_core::{
    CancellationToken, FrameLimits, FrameMode, IdentityRequirements, InputParser, McpError,
    RUDDER_MCP_CONTRACT_VERSION, RUDDER_MCP_LEGACY_PROTOCOL_VERSIONS,
    RUDDER_MCP_MODERN_PROTOCOL_VERSION, ResponseLimits, WorkspaceListRequest,
    bounded_json_rpc_result, capability_by_id, encode_frame, has_conflicting_protocol_versions,
    invalid_request_response, is_supported_protocol_version, list_workspace_directory,
    reject_model_identity_overrides, unsupported_method_response, validate_managed_identity,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::env;
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

const SERVER_NAME: &str = "rudder-tools";
const PROTOCOL_VERSION_META_KEY: &str = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY: &str = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META_KEY: &str = "io.modelcontextprotocol/serverInfo";
const DEFAULT_LEGACY_PROTOCOL_VERSION: &str = "2025-11-25";
const MCP_MAX_FRAME_BYTES: usize = 1_000_000;
const MCP_MAX_HEADER_BYTES: usize = 64 * 1024;

#[cfg(unix)]
static SIGNAL_REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn record_signal(_signal: libc::c_int) {
    SIGNAL_REQUESTED.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[cfg(unix)]
fn install_signal_handlers() {
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = record_signal as *const () as libc::sighandler_t;
        let _ = libc::sigemptyset(&mut action.sa_mask);
        let _ = libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut());
        let _ = libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut());
    }
}

#[cfg(not(unix))]
fn install_signal_handlers() {}

#[cfg(unix)]
fn signal_requested() -> bool {
    SIGNAL_REQUESTED.load(std::sync::atomic::Ordering::SeqCst)
}

#[cfg(not(unix))]
fn signal_requested() -> bool {
    false
}

enum InputEvent {
    Bytes(Vec<u8>),
    Eof,
    Error(String),
}

fn main() {
    let mut arguments = env::args().skip(1);
    match arguments.next().as_deref() {
        Some("--version") if arguments.next().is_none() => {
            println!("rudder-mcp {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        None => {}
        _ => {
            eprintln!("usage: rudder-mcp [--version]");
            std::process::exit(2);
        }
    }
    if let Err(error) = run_stdio() {
        eprintln!("rudder-mcp: {error}");
        std::process::exit(1);
    }
}

fn run_stdio() -> io::Result<()> {
    install_signal_handlers();
    let cancellation = CancellationToken::new();
    let mut parser = InputParser::with_cancellation(
        FrameLimits {
            max_frame_bytes: MCP_MAX_FRAME_BYTES,
            max_header_bytes: MCP_MAX_HEADER_BYTES,
        },
        cancellation.clone(),
    )
    .map_err(mcp_error_to_io)?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || read_stdin(sender));

    let mut output = io::BufWriter::new(io::stdout().lock());
    loop {
        if signal_requested() {
            cancellation.cancel();
            return Ok(());
        }
        match receiver.recv_timeout(Duration::from_millis(25)) {
            Ok(InputEvent::Bytes(_)) if signal_requested() => {
                cancellation.cancel();
                return Ok(());
            }
            Ok(InputEvent::Bytes(bytes)) => match parser.push(&bytes) {
                Ok(messages) => {
                    let mode = parser.mode().unwrap_or(FrameMode::Newline);
                    write_messages(&mut output, mode, messages)?;
                }
                Err(error) => {
                    let mode = parser.mode().unwrap_or(FrameMode::Newline);
                    write_response(&mut output, mode, &parser_error_response(&error))?;
                    return Ok(());
                }
            },
            Ok(InputEvent::Eof) if signal_requested() => {
                cancellation.cancel();
                return Ok(());
            }
            Ok(InputEvent::Eof) => {
                match parser.finish() {
                    Ok(messages) => {
                        let mode = parser.mode().unwrap_or(FrameMode::Newline);
                        write_messages(&mut output, mode, messages)?;
                    }
                    Err(error) => {
                        let mode = parser.mode().unwrap_or(FrameMode::Newline);
                        write_response(&mut output, mode, &parser_error_response(&error))?;
                    }
                }
                return Ok(());
            }
            Ok(InputEvent::Error(error)) => return Err(io::Error::other(error)),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        }
    }
}

fn read_stdin(sender: mpsc::Sender<InputEvent>) {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        match input.read(&mut buffer) {
            Ok(0) => {
                let _ = sender.send(InputEvent::Eof);
                return;
            }
            Ok(length) => {
                if sender
                    .send(InputEvent::Bytes(buffer[..length].to_vec()))
                    .is_err()
                {
                    return;
                }
            }
            Err(error) => {
                let _ = sender.send(InputEvent::Error(error.to_string()));
                return;
            }
        }
    }
}

fn write_messages(
    output: &mut impl Write,
    mode: FrameMode,
    messages: Vec<Value>,
) -> io::Result<()> {
    for message in messages {
        if let Some(response) = handle_message(&message) {
            write_response(output, mode, &response)?;
        }
    }
    output.flush()
}

fn write_response(output: &mut impl Write, mode: FrameMode, response: &Value) -> io::Result<()> {
    let frame = encode_frame(
        response,
        mode,
        FrameLimits {
            max_frame_bytes: MCP_MAX_FRAME_BYTES,
            max_header_bytes: MCP_MAX_HEADER_BYTES,
        },
    )
    .map_err(mcp_error_to_io)?;
    output.write_all(&frame)
}

fn handle_message(message: &Value) -> Option<Value> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let notification = message
        .as_object()
        .is_some_and(|object| !object.contains_key("id"));
    let Some(object) = message.as_object() else {
        return Some(invalid_request_response(
            Value::Null,
            "JSON-RPC request must be an object",
        ));
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return respond_or_none(
            notification,
            invalid_request_response(id, "jsonrpc must be \"2.0\""),
        );
    }
    let Some(method) = object.get("method").and_then(Value::as_str) else {
        return respond_or_none(
            notification,
            invalid_request_response(id, "method is required"),
        );
    };
    let params = object.get("params").cloned().unwrap_or_else(|| json!({}));
    if has_conflicting_protocol_versions(&params) {
        return respond_or_none(
            notification,
            invalid_request_response(id, "Conflicting MCP protocol versions"),
        );
    }
    if requested_protocol_version(&params).is_some_and(|protocol| {
        protocol == RUDDER_MCP_MODERN_PROTOCOL_VERSION
            && method != "server/discover"
            && !has_modern_request_envelope(&params)
    }) {
        return respond_or_none(
            notification,
            invalid_request_with_data(
                id,
                format!(
                    "Invalid _meta envelope for protocol revision {RUDDER_MCP_MODERN_PROTOCOL_VERSION}"
                ),
                json!({
                    "required": [PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY]
                }),
            ),
        );
    }

    let response = match method {
        "initialize" => initialize_response(id, &params),
        "notifications/initialized" => raw_json_rpc_result(id, json!({})),
        "server/discover" => discover_response(id, &params),
        "tools/list" => tools_list_response(id, &params),
        "tools/call" => tools_call_response(id, &params),
        "ping" => ping_response(id, &params),
        _ => unsupported_method_response(id, method),
    };
    respond_or_none(notification, response)
}

fn respond_or_none(notification: bool, response: Value) -> Option<Value> {
    (!notification).then_some(response)
}

fn initialize_response(id: Value, params: &Value) -> Value {
    let requested = requested_protocol_version(params).unwrap_or(DEFAULT_LEGACY_PROTOCOL_VERSION);
    if !is_supported_protocol_version(requested) || requested == RUDDER_MCP_MODERN_PROTOCOL_VERSION
    {
        return protocol_version_error(id, requested, RUDDER_MCP_LEGACY_PROTOCOL_VERSIONS);
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocolVersion": requested,
            "capabilities": {
                "tools": {},
                "experimental": {
                    "rudder": {"contractVersion": RUDDER_MCP_CONTRACT_VERSION}
                }
            },
            "serverInfo": server_info(),
        }
    })
}

fn discover_response(id: Value, params: &Value) -> Value {
    let requested = requested_protocol_version(params);
    if let Some(requested) = requested
        && requested != RUDDER_MCP_MODERN_PROTOCOL_VERSION
    {
        return protocol_version_error(id, requested, &[RUDDER_MCP_MODERN_PROTOCOL_VERSION]);
    }
    if !has_modern_request_envelope(params) {
        return invalid_request_with_data(
            id,
            format!(
                "Invalid _meta envelope for protocol revision {RUDDER_MCP_MODERN_PROTOCOL_VERSION}"
            ),
            json!({
                "required": [PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY]
            }),
        );
    }
    raw_json_rpc_result(
        id,
        modern_result(
            json!({
                "supportedVersions": [RUDDER_MCP_MODERN_PROTOCOL_VERSION],
                "capabilities": {
                    "tools": {"listChanged": false},
                    "experimental": {
                        "rudder": {"contractVersion": RUDDER_MCP_CONTRACT_VERSION}
                    },
                },
            }),
            true,
        ),
    )
}

fn tools_list_response(id: Value, params: &Value) -> Value {
    if !params.is_object() {
        return invalid_request_response(id, "tools/list params must be an object");
    }
    let modern = is_modern_request(params);
    if modern
        && params
            .get("cursor")
            .is_some_and(|cursor| cursor.as_str().is_none_or(|value| !value.is_empty()))
    {
        return invalid_request_response(id, "Invalid tools/list cursor");
    }
    let result = json!({"tools": [workspace_tool()]});
    raw_json_rpc_result(
        id,
        if modern {
            modern_result(result, true)
        } else {
            result
        },
    )
}

fn tools_call_response(id: Value, params: &Value) -> Value {
    if !params.is_object() {
        return tool_error_response(
            id,
            "rudder_mcp_invalid_request",
            "tools/call params must be an object",
            Value::Null,
            is_modern_request(params),
        );
    }
    let modern = is_modern_request(params);
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return tool_error_response(
            id,
            "rudder_mcp_invalid_arguments",
            "tools/call requires a tool name",
            Value::Null,
            modern,
        );
    };
    let Some(capability) = capability_by_id("workspace.list") else {
        return tool_error_response(
            id,
            "rudder_mcp_tool_not_available",
            "workspace.list capability is unavailable",
            Value::Null,
            modern,
        );
    };
    if name != capability.mcp_name {
        return tool_error_response(
            id,
            "rudder_mcp_tool_not_available",
            format!("Rudder MCP tool is not exposed: {name}"),
            Value::Null,
            modern,
        );
    }
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !arguments.is_object() {
        return tool_error_response(
            id,
            "rudder_mcp_invalid_arguments",
            "workspace.list arguments must be an object",
            Value::Null,
            modern,
        );
    }
    if let Err(error) = reject_model_identity_overrides(&arguments) {
        return tool_error_from_mcp(id, error, modern);
    }
    let environment = env_map();
    let requirements = IdentityRequirements {
        require_org_id: capability.requires_org_id,
        require_agent_id: capability.requires_agent_id,
        require_run_id: capability.requires_run_id,
        ..IdentityRequirements::default()
    };
    if let Err(error) = validate_managed_identity(&environment, requirements) {
        return tool_error_from_mcp(id, error, modern);
    }
    let Some(root) = nonempty_environment_value(&environment, "RUDDER_PROJECT_LIBRARY_PATH") else {
        return tool_error_response(
            id,
            "rudder_mcp_missing_runtime_context",
            "missing managed runtime key: RUDDER_PROJECT_LIBRARY_PATH",
            json!({"missingKeys": ["RUDDER_PROJECT_LIBRARY_PATH"]}),
            modern,
        );
    };
    if !Path::new(&root).is_absolute() {
        return tool_error_response(
            id,
            "rudder_mcp_invalid_request",
            "managed workspace root must be an absolute path",
            Value::Null,
            modern,
        );
    }
    let request = match WorkspaceListRequest::from_json(&arguments) {
        Ok(request) => request,
        Err(error) => return tool_error_from_mcp(id, error, modern),
    };
    let result = match list_workspace_directory(Path::new(&root), &request) {
        Ok(result) => result,
        Err(error) => return tool_error_from_mcp(id, error, modern),
    };
    let structured = serde_json::to_value(result).unwrap_or_else(|_| json!({}));
    match bounded_json_rpc_result(id, structured, ResponseLimits::core()) {
        Ok(mut response) => {
            if modern {
                add_modern_result_metadata(&mut response, server_info());
            }
            response
        }
        Err(error) => tool_error_from_mcp(Value::Null, error, modern),
    }
}

fn ping_response(id: Value, params: &Value) -> Value {
    let result = json!({});
    raw_json_rpc_result(
        id,
        if is_modern_request(params) {
            modern_result(result, false)
        } else {
            result
        },
    )
}

fn workspace_tool() -> Value {
    json!({
        "name": "rudder_workspace_list",
        "description": "List entries in a bounded managed workspace directory without modifying it.",
        "inputSchema": capability_by_id("workspace.list")
            .expect("workspace.list capability is registered")
            .input_schema(),
        "annotations": {
            "title": "List a managed workspace directory",
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": false,
        },
    })
}

fn tool_error_from_mcp(id: Value, error: McpError, modern: bool) -> Value {
    let mut details = serde_json::Map::new();
    if !error.missing_keys().is_empty() {
        details.insert("missingKeys".to_owned(), json!(error.missing_keys()));
    }
    if !error.reserved_arguments().is_empty() {
        details.insert(
            "reservedArguments".to_owned(),
            json!(error.reserved_arguments()),
        );
    }
    tool_error_response(
        id,
        error.code(),
        error.message(),
        Value::Object(details),
        modern,
    )
}

fn tool_error_response(
    id: Value,
    code: &str,
    message: impl Into<String>,
    details: Value,
    modern: bool,
) -> Value {
    let payload = json!({
        "status": "error",
        "code": code,
        "message": message.into(),
        "details": details,
    });
    let mut result = json!({
        "isError": true,
        "content": [{"type": "text", "text": payload.to_string()}],
        "structuredContent": payload,
    });
    if modern {
        result["resultType"] = json!("complete");
        result["_meta"] = json!({SERVER_INFO_META_KEY: server_info()});
    }
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn parser_error_response(error: &McpError) -> Value {
    invalid_request_with_data(Value::Null, error.message(), json!({"code": error.code()}))
}

fn invalid_request_with_data(id: Value, message: impl Into<String>, data: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": -32602, "message": message.into(), "data": data},
    })
}

fn protocol_version_error(id: Value, requested: &str, supported: &[&str]) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32022,
            "message": format!("Unsupported protocol version: {requested}"),
            "data": {"supported": supported, "requested": requested},
        },
    })
}

fn server_info() -> Value {
    json!({"name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION")})
}

fn raw_json_rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn modern_result(mut result: Value, cacheable: bool) -> Value {
    if let Some(object) = result.as_object_mut() {
        object.insert("resultType".to_owned(), json!("complete"));
        if cacheable {
            object.insert("ttlMs".to_owned(), json!(300_000));
            object.insert("cacheScope".to_owned(), json!("public"));
        }
        let metadata = object.entry("_meta").or_insert_with(|| json!({}));
        if let Some(metadata) = metadata.as_object_mut() {
            metadata.insert(SERVER_INFO_META_KEY.to_owned(), server_info());
        }
    }
    result
}

fn add_modern_result_metadata(response: &mut Value, info: Value) {
    if let Some(result) = response.get_mut("result").and_then(Value::as_object_mut) {
        result.insert("resultType".to_owned(), json!("complete"));
        result.insert("_meta".to_owned(), json!({SERVER_INFO_META_KEY: info}));
    }
}

fn requested_protocol_version(params: &Value) -> Option<&str> {
    let object = params.as_object()?;
    let metadata = object.get("_meta").and_then(Value::as_object);
    metadata
        .and_then(|meta| meta.get(PROTOCOL_VERSION_META_KEY))
        .and_then(Value::as_str)
        .or_else(|| object.get("protocolVersion").and_then(Value::as_str))
}

fn has_modern_request_envelope(params: &Value) -> bool {
    let Some(metadata) = params.get("_meta").and_then(Value::as_object) else {
        return false;
    };
    metadata
        .get(PROTOCOL_VERSION_META_KEY)
        .and_then(Value::as_str)
        == Some(RUDDER_MCP_MODERN_PROTOCOL_VERSION)
        && metadata
            .get(CLIENT_CAPABILITIES_META_KEY)
            .is_some_and(Value::is_object)
}

fn is_modern_request(params: &Value) -> bool {
    requested_protocol_version(params) == Some(RUDDER_MCP_MODERN_PROTOCOL_VERSION)
}

fn env_map() -> BTreeMap<String, String> {
    env::vars().collect()
}

fn nonempty_environment_value(environment: &BTreeMap<String, String>, key: &str) -> Option<String> {
    environment
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn mcp_error_to_io(error: McpError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, error.to_string())
}
