use serde_json::Value;
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;
use tempfile::tempdir;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_rudder-mcp")
}

fn command() -> Command {
    let mut command = Command::new(binary());
    for key in [
        "RUDDER_API_URL",
        "RUDDER_API_KEY",
        "RUDDER_ORG_ID",
        "RUDDER_AGENT_ID",
        "RUDDER_RUN_ID",
        "RUDDER_PROJECT_LIBRARY_PATH",
    ] {
        command.env_remove(key);
    }
    command
}

fn runtime_command(root: &std::path::Path) -> Command {
    let mut command = command();
    command
        .env("RUDDER_API_URL", "http://127.0.0.1:3100")
        .env("RUDDER_API_KEY", "test-key")
        .env("RUDDER_PROJECT_LIBRARY_PATH", root);
    command
}

fn run_to_eof(mut command: Command, input: &[u8]) -> (std::process::ExitStatus, Vec<u8>, Vec<u8>) {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    child.stdin.as_mut().unwrap().write_all(input).unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    (output.status, output.stdout, output.stderr)
}

fn framed_body(output: &[u8]) -> Value {
    assert!(output.starts_with(b"Content-Length:"));
    let separator = output
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap();
    let header = std::str::from_utf8(&output[..separator]).unwrap();
    let length: usize = header.split_once(':').unwrap().1.trim().parse().unwrap();
    let body = &output[separator + 4..];
    assert_eq!(body.len(), length);
    serde_json::from_slice(body).unwrap()
}

#[test]
fn serves_initialize_tools_list_and_workspace_call_over_newline_stdio() {
    let root = tempdir().unwrap();
    std::fs::create_dir(root.path().join("projects")).unwrap();
    std::fs::write(root.path().join("projects/readme.md"), b"read me").unwrap();
    let messages = [
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        serde_json::json!({
            "jsonrpc":"2.0","id":3,"method":"tools/call",
            "params":{"name":"rudder_workspace_list","arguments":{"directory":"projects"}}
        }),
    ];
    let input = messages
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let (status, stdout, stderr) = run_to_eof(runtime_command(root.path()), input.as_bytes());
    assert!(status.success(), "{}", String::from_utf8_lossy(&stderr));
    assert!(stderr.is_empty());
    let responses = stdout
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 3);
    assert_eq!(responses[0]["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(responses[0]["result"]["serverInfo"]["name"], "rudder-tools");
    assert_eq!(
        responses[1]["result"]["tools"][0]["name"],
        "rudder_workspace_list"
    );
    assert_eq!(
        responses[1]["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["rudder_workspace_list", "rudder_workspace_read_file"]
    );
    let read_tool = &responses[1]["result"]["tools"][1];
    assert_eq!(read_tool["inputSchema"]["additionalProperties"], false);
    assert_eq!(
        read_tool["inputSchema"]["required"],
        serde_json::json!(["path"])
    );
    assert_eq!(read_tool["annotations"]["readOnlyHint"], true);
    assert_eq!(responses[2]["result"]["isError"], false);
    assert_eq!(
        responses[2]["result"]["structuredContent"]["directoryPath"],
        "projects"
    );
    assert_eq!(
        responses[2]["result"]["structuredContent"]["entries"][0]["path"],
        "projects/readme.md"
    );
}

#[test]
fn serves_workspace_read_file_with_utf8_content_over_newline_stdio() {
    let root = tempdir().unwrap();
    std::fs::create_dir(root.path().join("projects")).unwrap();
    std::fs::write(root.path().join("projects/readme.md"), "read 世界").unwrap();
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "read-file",
        "method": "tools/call",
        "params": {
            "name": "rudder_workspace_read_file",
            "arguments": {"path": "projects/readme.md", "maxBytes": 128}
        }
    });
    let input = format!("{request}\n");

    let (status, stdout, stderr) = run_to_eof(runtime_command(root.path()), input.as_bytes());

    assert!(status.success(), "{}", String::from_utf8_lossy(&stderr));
    assert!(stderr.is_empty());
    let response: Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(response["result"]["isError"], false);
    assert_eq!(
        response["result"]["structuredContent"],
        serde_json::json!({
            "path": "projects/readme.md",
            "content": "read 世界",
            "byteSize": "read 世界".len(),
        })
    );
}

#[cfg(unix)]
#[test]
fn returns_bounded_errors_for_workspace_read_file_edge_cases_and_identity_overrides() {
    let outer = tempdir().unwrap();
    let root = outer.path().join("workspace");
    let outside = outer.path().join("outside");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&outside).unwrap();
    std::fs::create_dir(root.join("projects")).unwrap();
    std::fs::create_dir(root.join("projects/directory")).unwrap();
    std::fs::write(root.join("projects/binary"), [0xff, 0xfe]).unwrap();
    std::fs::write(root.join("projects/large"), b"12345").unwrap();
    std::fs::write(outside.join("secret"), b"secret").unwrap();
    std::os::unix::fs::symlink(outside.join("secret"), root.join("projects/link")).unwrap();

    let requests = [
        serde_json::json!({
            "jsonrpc":"2.0","id":"traversal","method":"tools/call",
            "params":{"name":"rudder_workspace_read_file","arguments":{"path":"../outside/secret"}}
        }),
        serde_json::json!({
            "jsonrpc":"2.0","id":"missing","method":"tools/call",
            "params":{"name":"rudder_workspace_read_file","arguments":{"path":"projects/missing"}}
        }),
        serde_json::json!({
            "jsonrpc":"2.0","id":"directory","method":"tools/call",
            "params":{"name":"rudder_workspace_read_file","arguments":{"path":"projects/directory"}}
        }),
        serde_json::json!({
            "jsonrpc":"2.0","id":"binary","method":"tools/call",
            "params":{"name":"rudder_workspace_read_file","arguments":{"path":"projects/binary"}}
        }),
        serde_json::json!({
            "jsonrpc":"2.0","id":"large","method":"tools/call",
            "params":{"name":"rudder_workspace_read_file","arguments":{"path":"projects/large","maxBytes":4}}
        }),
        serde_json::json!({
            "jsonrpc":"2.0","id":"symlink","method":"tools/call",
            "params":{"name":"rudder_workspace_read_file","arguments":{"path":"projects/link"}}
        }),
        serde_json::json!({
            "jsonrpc":"2.0","id":"root","method":"tools/call",
            "params":{"name":"rudder_workspace_read_file","arguments":{"path":"projects/binary","root":"/tmp/attacker"}}
        }),
        serde_json::json!({
            "jsonrpc":"2.0","id":"identity","method":"tools/call",
            "params":{"name":"rudder_workspace_read_file","arguments":{"path":"projects/binary","RUDDER_PROJECT_LIBRARY_PATH":"/tmp/attacker"}}
        }),
    ];
    let input = requests
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let (status, stdout, stderr) = run_to_eof(runtime_command(&root), input.as_bytes());
    assert!(status.success(), "{}", String::from_utf8_lossy(&stderr));
    assert!(stderr.is_empty());
    let responses = stdout
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), requests.len());
    let codes = responses
        .iter()
        .map(|response| {
            response["result"]["structuredContent"]["code"]
                .as_str()
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        codes,
        [
            "rudder_mcp_workspace_path_escape",
            "rudder_mcp_workspace_file_not_found",
            "rudder_mcp_workspace_not_regular_file",
            "rudder_mcp_workspace_file_not_utf8",
            "rudder_mcp_workspace_file_too_large",
            "rudder_mcp_workspace_symlink_rejected",
            "rudder_mcp_invalid_request",
            "rudder_mcp_reserved_identity_argument",
        ]
    );
    assert!(
        responses
            .iter()
            .all(|response| response["result"]["isError"] == true)
    );
}

#[test]
fn serves_content_length_framed_json_rpc_and_modern_discovery() {
    let root = tempdir().unwrap();
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": "discover",
        "method": "server/discover",
        "params": {"_meta": {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {}
        }}
    })
    .to_string();
    let frame = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
    let mut child = runtime_command(root.path());
    child
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = child.spawn().unwrap();
    let stdin = child.stdin.as_mut().unwrap();
    stdin.write_all(b"Content-Len").unwrap();
    stdin.flush().unwrap();
    thread::sleep(Duration::from_millis(10));
    stdin
        .write_all(&frame.as_bytes()["Content-Len".len()..])
        .unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response = framed_body(&output.stdout);
    assert_eq!(response["result"]["resultType"], "complete");
    assert_eq!(response["result"]["supportedVersions"][0], "2026-07-28");
    assert_eq!(
        response["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
        "rudder-tools"
    );
}

#[test]
fn returns_stable_json_rpc_errors_for_invalid_and_oversized_input() {
    let (status, stdout, stderr) = run_to_eof(
        command(),
        br#"{"jsonrpc":"2.0","id":7,"method":"tools/list"BROKEN}
"#,
    );
    assert!(status.success(), "{}", String::from_utf8_lossy(&stderr));
    let response: Value =
        serde_json::from_slice(stdout.split(|byte| *byte == b'\n').next().unwrap()).unwrap();
    assert_eq!(response["error"]["code"], -32602);
    assert_eq!(response["id"], Value::Null);

    let oversized = format!("Content-Length: {}\r\n\r\n", 1_000_001);
    let (status, stdout, stderr) = run_to_eof(command(), oversized.as_bytes());
    assert!(status.success(), "{}", String::from_utf8_lossy(&stderr));
    let response = framed_body(&stdout);
    assert_eq!(response["error"]["code"], -32602);
    assert_eq!(
        response["error"]["data"]["code"],
        "rudder_mcp_response_too_large"
    );
}

#[test]
fn closing_stdin_cancels_a_partial_request_with_a_bounded_error() {
    let mut child: Child = {
        let mut command = command();
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.spawn().unwrap()
    };
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(br#"{"jsonrpc":"2.0","id":9,"method":"initialize"#)
        .unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["error"]["code"], -32602);
    assert_eq!(
        response["error"]["data"]["code"],
        "rudder_mcp_invalid_request"
    );
}

#[cfg(unix)]
#[test]
fn sigterm_cancels_the_stdio_process_without_dispatching_a_partial_request() {
    let mut command = command();
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":10")
        .unwrap();
    thread::sleep(Duration::from_millis(500));
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "status={:?}; {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stdout.is_empty(),
        "unexpected stdout: {:?}",
        output.stdout
    );
}
