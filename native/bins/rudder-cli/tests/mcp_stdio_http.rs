use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[test]
fn stdio_mcp_tool_call_uses_the_mapped_loopback_http_request() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let server = thread::spawn(move || {
        let started = Instant::now();
        let (stream, _) = loop {
            match listener.accept() {
                Ok(accepted) => break accepted,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        started.elapsed() < Duration::from_secs(5),
                        "MCP tool did not make an HTTP request"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("HTTP fixture accept failed: {error}"),
            }
        };
        // Darwin can inherit O_NONBLOCK from the listening socket. The fixture
        // reads complete request lines with a deadline, so use blocking I/O.
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(stream);
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            let bytes = reader.read_line(&mut line).unwrap();
            assert!(bytes > 0, "HTTP request ended before its headers");
            if line == "\r\n" {
                break;
            }
            headers.push_str(&line);
        }
        let lower_headers = headers.to_ascii_lowercase();
        assert!(headers.starts_with("GET /api/orgs/org-stdio/projects HTTP/1.1\r\n"));
        assert!(lower_headers.contains("authorization: bearer stdio-token\r\n"));
        assert!(lower_headers.contains("accept: application/json\r\n"));

        let body = r#"{"projects":[{"id":"project-stdio"}]}"#;
        let mut stream = reader.into_inner();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        stream.flush().unwrap();
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_rudder-cli"))
        .arg("mcp-server")
        .env("RUDDER_API_URL", format!("http://{address}"))
        .env("RUDDER_API_KEY", "stdio-token")
        .env("RUDDER_ORG_ID", "org-stdio")
        .env("RUDDER_CLI_HTTP_TIMEOUT_MS", "5000")
        .env_remove("RUDDER_AGENT_ID")
        .env_remove("RUDDER_RUN_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for request in [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"stdio-http-test","version":"1"}}}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"rudder_project_list","arguments":{}}}),
    ] {
        writeln!(input, "{request}").unwrap();
    }
    drop(input);

    let output = child.wait_with_output().unwrap();
    server.join().unwrap();
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
    assert!(
        responses
            .iter()
            .all(|response| response.get("error").is_none())
    );
    let tools = responses[1]["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 83);
    assert_eq!(responses[2]["result"]["isError"], false);
    assert_eq!(
        responses[2]["result"]["structuredContent"],
        json!({"projects":[{"id":"project-stdio"}]})
    );
    assert!(output.stderr.is_empty());
}
