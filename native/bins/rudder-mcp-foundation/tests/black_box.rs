use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

fn request(body: &str) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rudder-mcp-foundation"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(body.as_bytes())
        .unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_owned()
}

fn node_command() -> Command {
    let mut command = Command::new("pnpm");
    command.current_dir(repo_root()).args([
        "--filter",
        "@rudderhq/cli",
        "exec",
        "tsx",
        "src/index.ts",
        "mcp-server",
        "--server",
        "core",
    ]);
    command
}

fn collect_lines(mut command: Command, body: &str, env: &BTreeMap<&str, &str>) -> Vec<Value> {
    clear_runtime_env(&mut command);
    command
        .envs(env.iter().map(|(key, value)| (*key, *value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(body.as_bytes())
        .unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn validation_projection(response: &Value) -> Value {
    serde_json::json!({
        "hasContent": response["result"]["content"].is_array(),
        "hasStructuredContent": response["result"]["structuredContent"].is_object(),
        "isError": response["result"]["isError"],
        "code": response["result"]["structuredContent"]["code"],
    })
}

fn request_without_eof(mut command: Command, body: &str, env: &BTreeMap<&str, &str>) -> Value {
    clear_runtime_env(&mut command);
    command
        .envs(env.iter().map(|(key, value)| (*key, *value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(body.as_bytes())
        .unwrap();
    child.stdin.as_mut().unwrap().flush().unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let _ = child.kill();
    let output = child.wait_with_output().unwrap();
    assert!(
        !line.trim().is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_str(&line).unwrap()
}

fn clear_runtime_env(command: &mut Command) {
    for key in [
        "RUDDER_API_URL",
        "RUDDER_API_KEY",
        "RUDDER_ORG_ID",
        "RUDDER_AGENT_ID",
        "RUDDER_RUN_ID",
        "RUDDER_NODE_CLI_BIN",
    ] {
        command.env_remove(key);
    }
}

#[test]
fn serves_initialize_and_tool_manifest_over_stdio() {
    let initialized =
        request("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n");
    assert_eq!(initialized["result"]["serverInfo"]["name"], "rudder-tools");
    assert_eq!(
        initialized["result"]["capabilities"]["experimental"]["rudder"]["coreContractHash"]
            .as_str()
            .unwrap()
            .len(),
        64
    );

    let tools = request("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}\n");
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 82);
}

#[test]
fn node_and_rust_distinguish_notifications_from_explicit_null_ids() {
    let empty_env = BTreeMap::new();
    let cases = [
        ("initialize", serde_json::json!({})),
        ("tools/list", serde_json::json!({})),
        (
            "tools/call",
            serde_json::json!({
                "name": "rudder_issue_get",
                "arguments": { "issue": "R6Z-1" }
            }),
        ),
    ];
    for (method, params) in cases {
        let missing = format!(
            "{}\n",
            serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params })
        );
        let missing_node = collect_lines(node_command(), &missing, &empty_env);
        let missing_rust = collect_lines(
            Command::new(env!("CARGO_BIN_EXE_rudder-mcp-foundation")),
            &missing,
            &empty_env,
        );
        assert_eq!(missing_node.len(), 1, "Node omitted-id {method}");
        assert_eq!(missing_rust.len(), 1, "Rust omitted-id {method}");
        assert_eq!(missing_node[0]["id"], Value::Null);
        assert_eq!(missing_rust[0]["id"], Value::Null);
        if method == "tools/call" {
            assert_eq!(
                validation_projection(&missing_rust[0]),
                validation_projection(&missing_node[0])
            );
        } else {
            assert_eq!(missing_rust[0]["result"], missing_node[0]["result"]);
        }

        let explicit_null = format!(
            "{}\n",
            serde_json::json!({ "jsonrpc": "2.0", "id": null, "method": method, "params": params })
        );
        let node = collect_lines(node_command(), &explicit_null, &empty_env);
        let rust = collect_lines(
            Command::new(env!("CARGO_BIN_EXE_rudder-mcp-foundation")),
            &explicit_null,
            &empty_env,
        );
        assert_eq!(node.len(), 1, "Node {method}");
        assert_eq!(rust.len(), 1, "Rust {method}");
        assert_eq!(node[0]["id"], Value::Null);
        assert_eq!(rust[0]["id"], Value::Null);
        if method == "tools/call" {
            assert_eq!(
                validation_projection(&rust[0]),
                validation_projection(&node[0])
            );
        } else {
            assert_eq!(rust[0]["result"], node[0]["result"]);
        }
    }

    let missing_unknown = "{\"jsonrpc\":\"2.0\",\"method\":\"unknown\"}\n";
    assert!(collect_lines(node_command(), missing_unknown, &empty_env).is_empty());
    assert!(
        collect_lines(
            Command::new(env!("CARGO_BIN_EXE_rudder-mcp-foundation")),
            missing_unknown,
            &empty_env,
        )
        .is_empty()
    );
    let null_unknown = "{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"unknown\"}\n";
    let node = collect_lines(node_command(), null_unknown, &empty_env);
    let rust = collect_lines(
        Command::new(env!("CARGO_BIN_EXE_rudder-mcp-foundation")),
        null_unknown,
        &empty_env,
    );
    assert_eq!(node.len(), 1);
    assert_eq!(rust.len(), 1);
    assert_eq!(rust[0]["error"]["code"], node[0]["error"]["code"]);
}

#[test]
fn accepts_content_length_prefix_split_across_process_writes() {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 10,
        "method": "initialize",
        "params": { "protocolVersion": "2025-06-18" },
    })
    .to_string();
    let frame = format!("Content-Length: {}\r\n\r\n{body}", body.len());
    let mut child = Command::new(env!("CARGO_BIN_EXE_rudder-mcp-foundation"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.as_mut().unwrap();
    stdin.write_all(b"Content-Len").unwrap();
    stdin.flush().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
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
    assert!(output.stdout.starts_with(b"Content-Length:"));
    let separator = output
        .stdout
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap();
    let response: Value = serde_json::from_slice(&output.stdout[separator + 4..]).unwrap();
    assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
}

#[test]
fn rejects_runtime_identity_before_node_dispatch() {
    let response = request(
        "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"rudder_agent_me\",\"arguments\":{\"api_key\":\"secret\"}}}\n",
    );
    assert_eq!(
        response["result"]["structuredContent"]["code"],
        "rudder_mcp_reserved_identity_argument"
    );
    assert_eq!(response["result"]["isError"], true);
}

#[test]
fn node_and_rust_processes_match_protocol_and_validation_envelopes() {
    let messages = [
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}),
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"rudder_issue_get","arguments":{}}}),
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"rudder_issue_get","arguments":{"issue":123}}}),
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"rudder_issue_get","arguments":{"issue":"x".repeat(201)}}}),
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"rudder_issue_review","arguments":{"issue":"R6Z-1","decision":"maybe","comment":"review"}}}),
        serde_json::json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"rudder_goal_checkpoint","arguments":{"goal":"gol_1","summary":"checkpoint","evidenceRefs":[],"expectedPlanRevision":1,"continuation":{"kind":"wait","summary":"wait","wakeCondition":42},"idempotencyKey":"key"}}}),
        serde_json::json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"rudder_agent_me","arguments":{"apiKey":"secret"}}}),
    ];
    let stream = messages
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let env = BTreeMap::from([
        ("RUDDER_API_URL", "http://127.0.0.1:1"),
        ("RUDDER_API_KEY", "test-key"),
        ("RUDDER_ORG_ID", "test-org"),
        ("RUDDER_AGENT_ID", "test-agent"),
        ("RUDDER_RUN_ID", "test-run"),
    ]);
    let node = collect_lines(node_command(), &stream, &env);
    let rust_command = Command::new(env!("CARGO_BIN_EXE_rudder-mcp-foundation"));
    let rust = collect_lines(rust_command, &stream, &env);
    assert_eq!(node.len(), messages.len());
    assert_eq!(rust.len(), messages.len());
    assert_eq!(node[0]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(rust[0]["result"]["protocolVersion"], "2025-06-18");
    for index in 1..messages.len() {
        assert_eq!(
            validation_projection(&rust[index]),
            validation_projection(&node[index]),
            "message {}",
            index + 1
        );
    }
    let missing_messages = [
        serde_json::json!({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"rudder_issue_get","arguments":{"issue":"R6Z-1"}}}),
        serde_json::json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"rudder_issue_get","arguments":{"issue":123}}}),
        serde_json::json!({"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"rudder_goal_checkpoint","arguments":{"goal":"gol_1","summary":"checkpoint","evidenceRefs":["artifact://checkpoint"],"expectedPlanRevision":1,"continuation":{"kind":"wait","summary":"wait","wakeCondition":null},"idempotencyKey":"key"}}}),
        serde_json::json!({"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"rudder_goal_change_propose","arguments":{"goal":"gol_1","contractRevision":1,"afterContract":{"actionDeadline":null},"rationale":"clear action deadline","idempotencyKey":"key"}}}),
        serde_json::json!({"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"rudder_goal_change_propose","arguments":{"goal":"gol_1","contractRevision":1,"afterContract":{"evaluationDeadline":null},"rationale":"clear evaluation deadline","idempotencyKey":"key"}}}),
    ];
    let missing_stream = missing_messages
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let empty_env = BTreeMap::new();
    let node = collect_lines(node_command(), &missing_stream, &empty_env);
    let rust = collect_lines(
        Command::new(env!("CARGO_BIN_EXE_rudder-mcp-foundation")),
        &missing_stream,
        &empty_env,
    );
    assert_eq!(
        validation_projection(&rust[0]),
        validation_projection(&node[0])
    );
    assert_eq!(
        rust[0]["result"]["structuredContent"]["code"],
        "rudder_mcp_missing_runtime_context"
    );
    assert_eq!(
        validation_projection(&rust[1]),
        validation_projection(&node[1])
    );
    assert_eq!(
        rust[1]["result"]["structuredContent"]["code"],
        "rudder_mcp_invalid_arguments"
    );
    for index in 2..missing_messages.len() {
        assert_eq!(
            validation_projection(&rust[index]),
            validation_projection(&node[index]),
            "nullable message {}",
            index + 1
        );
        assert_eq!(
            rust[index]["result"]["structuredContent"]["code"],
            "rudder_mcp_missing_runtime_context",
            "nullable message {}",
            index + 1
        );
    }
}

#[test]
fn node_and_rust_normalize_legacy_aliases_before_validation() {
    let messages = [
        serde_json::json!({"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"rudder_agent_skills_enable","arguments":{"selections":["skill-ref"]}}}),
        serde_json::json!({"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"rudder_goal_context","arguments":{"goalId":"gol_1"}}}),
        serde_json::json!({"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"rudder_issue_get","arguments":{"issueId":"R6Z-1"}}}),
        serde_json::json!({"jsonrpc":"2.0","id":24,"method":"tools/call","params":{"name":"rudder_project_get","arguments":{"projectId":"prj_1"}}}),
        serde_json::json!({"jsonrpc":"2.0","id":25,"method":"tools/call","params":{"name":"rudder_approval_get","arguments":{"approvalId":"apr_1"}}}),
        serde_json::json!({"jsonrpc":"2.0","id":26,"method":"tools/call","params":{"name":"rudder_skill_get","arguments":{"skillId":"skl_1"}}}),
        serde_json::json!({"jsonrpc":"2.0","id":27,"method":"tools/call","params":{"name":"rudder_automation_get","arguments":{"automationId":"aut_1"}}}),
        serde_json::json!({"jsonrpc":"2.0","id":28,"method":"tools/call","params":{"name":"rudder_runs_transcript","arguments":{"run":"run_1","maxOutputChars":500}}}),
        serde_json::json!({"jsonrpc":"2.0","id":29,"method":"tools/call","params":{"name":"rudder_chat_get","arguments":{"chatId":"cht_1"}}}),
        serde_json::json!({"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"name":"rudder_issue_get","arguments":{"issue":"R6Z-1","issueId":123}}}),
    ];
    let stream = messages
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let empty_env = BTreeMap::new();
    let node = collect_lines(node_command(), &stream, &empty_env);
    let rust = collect_lines(
        Command::new(env!("CARGO_BIN_EXE_rudder-mcp-foundation")),
        &stream,
        &empty_env,
    );
    assert_eq!(node.len(), messages.len());
    assert_eq!(rust.len(), messages.len());
    for index in 0..messages.len() {
        assert_eq!(
            validation_projection(&rust[index]),
            validation_projection(&node[index]),
            "message {}",
            index + 1
        );
        assert_eq!(
            rust[index]["result"]["structuredContent"]["code"],
            "rudder_mcp_missing_runtime_context",
            "message {}",
            index + 1
        );
    }
}

#[test]
fn rejects_empty_object_for_live_min_properties_constraint() {
    let message = format!(
        "{}\n",
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 31,
            "method": "tools/call",
            "params": {
                "name": "rudder_goal_change_propose",
                "arguments": {
                    "goal": "gol_1",
                    "contractRevision": 1,
                    "afterContract": {},
                    "rationale": "evidence changed",
                    "idempotencyKey": "key"
                }
            }
        })
    );
    let empty_env = BTreeMap::new();
    let node = collect_lines(node_command(), &message, &empty_env);
    let rust = collect_lines(
        Command::new(env!("CARGO_BIN_EXE_rudder-mcp-foundation")),
        &message,
        &empty_env,
    );
    assert_eq!(node.len(), 1);
    assert_eq!(rust.len(), 1);
    assert_eq!(
        validation_projection(&rust[0]),
        validation_projection(&node[0])
    );
    assert_eq!(
        rust[0]["result"]["structuredContent"]["code"],
        "rudder_mcp_invalid_arguments"
    );
}

#[test]
fn node_and_rust_count_astral_unicode_schema_lengths_equally() {
    let issue = "\u{1f642}".repeat(101);
    let message = format!(
        "{}\n",
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 32,
            "method": "tools/call",
            "params": {
                "name": "rudder_issue_get",
                "arguments": { "issue": issue }
            }
        })
    );
    let empty_env = BTreeMap::new();
    let node = collect_lines(node_command(), &message, &empty_env);
    let rust = collect_lines(
        Command::new(env!("CARGO_BIN_EXE_rudder-mcp-foundation")),
        &message,
        &empty_env,
    );

    assert_eq!(node.len(), 1);
    assert_eq!(rust.len(), 1);
    assert_eq!(
        validation_projection(&rust[0]),
        validation_projection(&node[0])
    );
    assert_eq!(
        rust[0]["result"]["structuredContent"]["code"],
        "rudder_mcp_missing_runtime_context"
    );
}

#[test]
fn oversized_whitespace_prefix_fails_at_the_process_boundary() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rudder-mcp-foundation"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&vec![
            b' ';
            rudder_agent_tools_foundation::MAX_REQUEST_BYTES + 1
        ])
        .unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("MCP message exceeds the bounded byte limit")
    );
}

#[cfg(unix)]
#[test]
fn rust_node_compatibility_adapter_preserves_node_failure_envelope() {
    use std::os::unix::fs::PermissionsExt;

    let wrapper = std::env::temp_dir().join(format!(
        "rudder-r6z-133-node-wrapper-{}",
        std::process::id()
    ));
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\ncd '{}' || exit 1\nexec pnpm --filter @rudderhq/cli exec tsx src/index.ts \"$@\"\n",
            repo_root().display()
        ),
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&wrapper).unwrap().permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(&wrapper, permissions).unwrap();

    let message = "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"tools/call\",\"params\":{\"name\":\"rudder_issue_get\",\"arguments\":{\"issue\":\"R6Z-1\"}}}\n";
    let mut env = BTreeMap::from([
        ("RUDDER_API_URL", "http://127.0.0.1:1"),
        ("RUDDER_API_KEY", "test-key"),
        ("RUDDER_ORG_ID", "test-org"),
        ("RUDDER_AGENT_ID", "test-agent"),
        ("RUDDER_RUN_ID", "test-run"),
    ]);
    let node = request_without_eof(node_command(), message, &env);
    env.insert("RUDDER_NODE_CLI_BIN", wrapper.to_str().unwrap());
    let rust = request_without_eof(
        Command::new(env!("CARGO_BIN_EXE_rudder-mcp-foundation")),
        message,
        &env,
    );
    let _ = std::fs::remove_file(&wrapper);
    assert_eq!(rust["result"], node["result"]);
}
