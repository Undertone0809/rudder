use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn core_tools_are_available_through_the_rust_cli_stdio_entry() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rudder-cli"))
        .arg("mcp-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for request in [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"rust-cli-e2e","version":"1"}}}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"rudder_agent_capabilities","arguments":{}}}),
    ] {
        writeln!(input, "{request}").unwrap();
    }
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses.len(), 3);
    for response in &responses {
        assert!(response.get("error").is_none(), "{response}");
    }
    let tools = responses[1]["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 83);
    assert!(tools.iter().all(|tool| {
        !tool["name"]
            .as_str()
            .unwrap()
            .starts_with("rudder_browser_")
    }));
    assert_eq!(responses[2]["result"]["isError"], false);
    assert!(output.stderr.is_empty());
}

#[test]
fn unsupported_mcp_server_selection_fails_without_protocol_output() {
    let output = Command::new(env!("CARGO_BIN_EXE_rudder-cli"))
        .args(["mcp-server", "--server", "unsupported-fixture"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("Unsupported Rudder MCP server surface: unsupported-fixture")
    );
}

#[test]
fn desktop_surfaces_are_available_through_the_rust_cli_stdio_entry() {
    for (surface, flag, count) in [
        ("browser", "RUDDER_BROWSER_ENABLED", 25),
        ("computer", "RUDDER_COMPUTER_ENABLED", 13),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_rudder-cli"))
            .args(["mcp-server", "--server", surface])
            .env(flag, "true")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        for request in [
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"rust-desktop-cli-e2e","version":"1"}}}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        ] {
            writeln!(input, "{request}").unwrap();
        }
        drop(input);
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stderr.is_empty());
        let responses: Vec<Value> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(responses.len(), 2);
        assert_eq!(
            responses[0]["result"]["serverInfo"]["name"],
            format!("rudder-{surface}")
        );
        let tools = responses[1]["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), count);
        assert!(tools.iter().all(|tool| {
            tool["name"]
                .as_str()
                .unwrap()
                .starts_with(&format!("rudder_{surface}_"))
        }));
    }
}
