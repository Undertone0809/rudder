use rudder_agent_cli_core::MAX_RESPONSE_BYTES;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Output};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const TOKEN: &str = "fixture-bearer-secret";

struct ResponseSpec {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    delay: Duration,
    content_length: bool,
}

impl ResponseSpec {
    fn json(status: u16, value: serde_json::Value) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".to_owned(), "application/json".to_owned())],
            body: serde_json::to_vec(&value).expect("fixture response serializes"),
            delay: Duration::ZERO,
            content_length: true,
        }
    }
}

fn start_server(spec: ResponseSpec) -> (String, JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("fixture binds");
    let address = listener.local_addr().expect("fixture address");
    let worker = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("fixture accepts client");
        let request = read_request(&mut stream);
        if !spec.delay.is_zero() {
            thread::sleep(spec.delay);
        }
        let mut response = format!("HTTP/1.1 {} Fixture\r\nConnection: close\r\n", spec.status);
        for (name, value) in &spec.headers {
            response.push_str(&format!("{name}: {value}\r\n"));
        }
        if spec.content_length {
            response.push_str(&format!("Content-Length: {}\r\n", spec.body.len()));
        }
        response.push_str("\r\n");
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.write_all(&spec.body);
        request
    });
    (format!("http://{address}"), worker)
}

fn read_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("set fixture read timeout");
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let count = stream.read(&mut chunk).expect("read fixture request");
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        assert!(bytes.len() < 64 * 1024, "request headers are bounded");
    }
    String::from_utf8(bytes).expect("request headers are UTF-8")
}

fn run_cli(base: &str, arguments: &[&str], timeout_ms: Option<u64>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rudder-cli"));
    command
        .env_clear()
        .env("HOME", "/tmp/rudder-cli-test-home")
        .args(["org", "members", "--api-base", base, "--api-key", TOKEN]);
    command.args(arguments);
    if let Some(timeout_ms) = timeout_ms {
        command.env("RUDDER_CLI_HTTP_TIMEOUT_MS", timeout_ms.to_string());
    }
    command.output().expect("run actual rudder-cli executable")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).expect("CLI output is UTF-8")
}

fn header<'a>(request: &'a str, name: &str) -> Option<&'a str> {
    request.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then_some(value.trim())
    })
}

#[test]
fn executable_sends_scoped_bearer_and_opaque_pagination_and_returns_json_page() {
    let expected = serde_json::json!({
        "total": 2,
        "items": [
            { "name": "Ada Lovelace", "type": "human", "role": "operator", "ref": "11111111-1111-4111-8111-111111111111" }
        ],
        "nextCursor": "next/page?2",
        "hasMore": true
    });
    let (base, server) = start_server(ResponseSpec::json(200, expected.clone()));
    let output = run_cli(
        &base,
        &[
            "--org-id",
            "org-1",
            "--query",
            "  Ada !'()*~+ x  ",
            "--type",
            "human",
            "--limit",
            "2",
            "--cursor",
            "next/page?2",
            "--json",
            "--full-ids",
        ],
        None,
    );
    let request = server.join().expect("fixture server completes");
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert_eq!(
        header(&request, "authorization"),
        Some("Bearer fixture-bearer-secret")
    );
    assert!(request.starts_with(
        "GET /api/orgs/org-1/members/directory?query=Ada+%21%27%28%29*%7E%2B+x&type=human&limit=2&cursor=next%2Fpage%3F2&fullIds=true HTTP/1.1"
    ));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&text(&output.stdout)).unwrap(),
        expected
    );
    assert!(!text(&output.stderr).contains(TOKEN));
}

#[test]
fn executable_uses_contract_defaults_and_human_member_format() {
    let page = serde_json::json!({
        "total": 1,
        "items": [{ "name": "Ada Lovelace", "type": "human", "role": "operator", "ref": "usr_14ff96a7" }],
        "nextCursor": "opaque-next",
        "hasMore": true
    });
    let (base, server) = start_server(ResponseSpec::json(200, page));
    let output = run_cli(&base, &["--org-id", "org-1"], None);
    let request = server.join().expect("fixture server completes");
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert!(
        request.starts_with("GET /api/orgs/org-1/members/directory?type=all&limit=50 HTTP/1.1")
    );
    assert_eq!(
        text(&output.stdout),
        "total=1\nname=Ada Lovelace type=human role=operator ref=usr_14ff96a7\nnextCursor=opaque-next\n"
    );
}

#[test]
fn executable_escapes_terminal_controls_in_human_page_and_preserves_json_values() {
    let page = serde_json::json!({
        "total": 1,
        "items": [{
            "name": "Ada\u{1b}[2J",
            "type": "human",
            "role": "operator\u{9b}31m",
            "ref": "usr_14ff96a7",
            "note\u{1b}]8;;https://evil.invalid\u{7}": "safe\u{0}text"
        }],
        "nextCursor": "opaque\u{1b}]0;spoof\u{7}\npage",
        "hasMore": true
    });

    let (base, server) = start_server(ResponseSpec::json(200, page.clone()));
    let output = run_cli(&base, &["--org-id", "org-1"], None);
    let _ = server.join().expect("fixture server completes");
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert_eq!(
        text(&output.stdout),
        concat!(
            "total=1\n",
            "name=Ada\\u{1b}[2J type=human role=operator\\u{9b}31m ",
            "ref=usr_14ff96a7 note\\u{1b}]8;;https://evil.invalid\\u{7}=safe\\u{0}text\n",
            "nextCursor=opaque\\u{1b}]0;spoof\\u{7}\\u{a}page\n"
        )
    );
    assert!(
        text(&output.stdout)
            .chars()
            .all(|ch| !ch.is_control() || ch == '\n')
    );

    let (base, server) = start_server(ResponseSpec::json(200, page.clone()));
    let output = run_cli(&base, &["--org-id", "org-1", "--json"], None);
    let _ = server.join().expect("fixture server completes");
    assert!(output.status.success(), "{}", text(&output.stderr));
    let returned: serde_json::Value =
        serde_json::from_str(&text(&output.stdout)).expect("JSON page remains valid");
    assert_eq!(returned, page);
}

#[test]
fn executable_escapes_terminal_controls_in_human_api_error_and_preserves_json_error() {
    let body = serde_json::json!({
        "error": "denied\u{1b}[2J\u{9b}31m\nsecond line",
        "code": "org\u{1b}]0;spoof\u{7}",
        "details": { "reason": "policy\u{85}violation" }
    });

    let (base, server) = start_server(ResponseSpec::json(403, body.clone()));
    let output = run_cli(&base, &["--org-id", "org-1"], None);
    let _ = server.join().expect("fixture server completes");
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        text(&output.stderr),
        concat!(
            "API error 403: ",
            "denied\\u{1b}[2J\\u{9b}31m\\u{a}second line ",
            "details={\"reason\":\"policy\\u{85}violation\"}\n"
        )
    );
    assert!(
        text(&output.stderr)
            .chars()
            .all(|ch| !ch.is_control() || ch == '\n')
    );

    let (base, server) = start_server(ResponseSpec::json(403, body.clone()));
    let output = run_cli(&base, &["--org-id", "org-1", "--json"], None);
    let _ = server.join().expect("fixture server completes");
    assert_eq!(output.status.code(), Some(1));
    let returned: serde_json::Value =
        serde_json::from_str(&text(&output.stderr)).expect("JSON error envelope remains valid");
    assert_eq!(returned["error"], body["error"]);
    assert_eq!(returned["code"], body["code"]);
    assert_eq!(returned["details"], body["details"]);
}

#[test]
fn executable_uses_context_profile_for_api_org_and_environment_token() {
    let directory = tempfile::tempdir().expect("temporary context directory");
    let context_path = directory.path().join("context.json");
    let page = serde_json::json!({
        "total": 0,
        "items": [],
        "nextCursor": null,
        "hasMore": false
    });
    let (base, server) = start_server(ResponseSpec::json(200, page));
    std::fs::write(
        &context_path,
        serde_json::json!({
            "version": 1,
            "currentProfile": "work",
            "profiles": {
                "work": {
                    "apiBase": base,
                    "orgId": "org-context",
                    "apiKeyEnvVarName": "PROFILE_TOKEN"
                }
            }
        })
        .to_string(),
    )
    .expect("write temporary context");
    let mut command = Command::new(env!("CARGO_BIN_EXE_rudder-cli"));
    let output = command
        .env_clear()
        .env("HOME", directory.path())
        .env("PROFILE_TOKEN", TOKEN)
        .args([
            "org",
            "members",
            "--context",
            context_path.to_str().unwrap(),
            "--json",
        ])
        .output()
        .expect("run actual rudder-cli executable");
    let request = server.join().expect("fixture server completes");
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert!(request.starts_with("GET /api/orgs/org-context/members/directory?type=all&limit=50 "));
    assert_eq!(
        header(&request, "authorization"),
        Some("Bearer fixture-bearer-secret")
    );
}

#[test]
fn executable_reports_foreign_organization_api_error_without_echoing_credentials() {
    let (base, server) = start_server(ResponseSpec::json(
        403,
        serde_json::json!({
            "error": "organization_forbidden",
            "code": "organization_forbidden",
            "details": { "orgId": "org-foreign", "authorization": TOKEN }
        }),
    ));
    let output = run_cli(&base, &["--org-id", "org-foreign", "--json"], None);
    let request = server.join().expect("fixture server completes");
    let stderr = text(&output.stderr);
    assert_eq!(output.status.code(), Some(1));
    assert!(request.starts_with("GET /api/orgs/org-foreign/members/directory?type=all&limit=50 "));
    assert_eq!(
        header(&request, "authorization"),
        Some("Bearer fixture-bearer-secret")
    );
    let error: serde_json::Value = serde_json::from_str(&stderr).expect("JSON error envelope");
    assert_eq!(error["status"], 403);
    assert_eq!(error["code"], "organization_forbidden");
    assert_eq!(error["error"], "organization_forbidden");
    assert_eq!(error["details"]["authorization"], "[REDACTED]");
    assert!(!stderr.contains(TOKEN));
    assert!(!text(&output.stdout).contains(TOKEN));
}

#[test]
fn executable_decodes_versioned_native_api_errors_without_weakening_legacy_errors() {
    for (status, reason) in [
        (403, "native_bearer_forbidden"),
        (401, "native_bearer_unauthorized"),
        (400, "member_directory_invalid_cursor"),
    ] {
        let body = serde_json::json!({
            "schema": "rudder.native.server.error.v1",
            "status": "error",
            "reason": reason
        });
        let (base, server) = start_server(ResponseSpec::json(status, body.clone()));
        let output = run_cli(&base, &["--org-id", "org-1", "--json"], None);
        let _ = server.join().expect("fixture server completes");
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
        let error: serde_json::Value = serde_json::from_str(&text(&output.stderr)).unwrap();
        assert_eq!(error["status"], status);
        assert_eq!(error["code"], reason);
        assert_eq!(error["error"], reason);

        let (base, server) = start_server(ResponseSpec::json(status, body));
        let output = run_cli(&base, &["--org-id", "org-1"], None);
        let _ = server.join().expect("fixture server completes");
        assert_eq!(output.status.code(), Some(1));
        assert_eq!(
            text(&output.stderr),
            format!("API error {status}: {reason}\n")
        );
    }

    // A random or future response must not acquire the native schema's meaning.
    let (base, server) = start_server(ResponseSpec::json(
        403,
        serde_json::json!({"schema": "unknown", "reason": "untrusted_reason"}),
    ));
    let output = run_cli(&base, &["--org-id", "org-1", "--json"], None);
    let _ = server.join().expect("fixture server completes");
    let error: serde_json::Value = serde_json::from_str(&text(&output.stderr)).unwrap();
    assert_eq!(error["code"], "api_request_error");
    assert_eq!(error["error"], "Request failed with status 403");
}

#[test]
fn executable_times_out_and_emits_a_bounded_json_error() {
    let mut spec = ResponseSpec::json(
        200,
        serde_json::json!({ "total": 0, "items": [], "nextCursor": null, "hasMore": false }),
    );
    spec.delay = Duration::from_millis(350);
    let (base, server) = start_server(spec);
    let output = run_cli(&base, &["--org-id", "org-1", "--json"], Some(75));
    let _ = server.join().expect("fixture server completes");
    assert_eq!(output.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_str(&text(&output.stderr)).unwrap();
    assert_eq!(error["code"], "request_timeout");
    assert_eq!(error["status"], serde_json::Value::Null);
    assert!(!text(&output.stderr).contains(TOKEN));
}

#[test]
fn executable_rejects_streamed_responses_over_the_shared_contract_limit() {
    let spec = ResponseSpec {
        status: 200,
        headers: vec![("Content-Type".to_owned(), "application/json".to_owned())],
        body: vec![b'x'; MAX_RESPONSE_BYTES + 64],
        delay: Duration::ZERO,
        content_length: false,
    };
    let (base, server) = start_server(spec);
    let output = run_cli(&base, &["--org-id", "org-1", "--json"], None);
    let _ = server.join().expect("fixture server completes");
    assert_eq!(output.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_str(&text(&output.stderr)).unwrap();
    assert_eq!(error["code"], "response_too_large");
    assert!(!text(&output.stderr).contains(TOKEN));
}

#[test]
fn executable_does_not_forward_bearer_to_redirect_target() {
    let redirect_target = TcpListener::bind("127.0.0.1:0").expect("redirect target binds");
    redirect_target
        .set_nonblocking(true)
        .expect("redirect target becomes nonblocking");
    let target_address = redirect_target.local_addr().expect("redirect address");
    let spec = ResponseSpec {
        status: 302,
        headers: vec![(
            "Location".to_owned(),
            format!("http://{target_address}/capture"),
        )],
        body: Vec::new(),
        delay: Duration::ZERO,
        content_length: true,
    };
    let (base, server) = start_server(spec);
    let output = run_cli(&base, &["--org-id", "org-1", "--json"], None);
    let request = server.join().expect("redirect fixture completes");
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        header(&request, "authorization"),
        Some("Bearer fixture-bearer-secret")
    );
    assert!(request.starts_with("GET /api/orgs/org-1/members/directory?type=all&limit=50 "));
    match redirect_target.accept() {
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
        Ok((mut stream, _)) => {
            let leaked = read_request(&mut stream);
            panic!("redirect target received a request: {leaked}");
        }
        Err(error) => panic!("redirect target accept failed: {error}"),
    }
}

#[test]
fn executable_refuses_to_send_bearer_to_non_loopback_plain_http() {
    let output = run_cli(
        "http://example.invalid",
        &["--org-id", "org-1", "--json"],
        None,
    );
    assert_eq!(output.status.code(), Some(1));
    let error: serde_json::Value = serde_json::from_str(&text(&output.stderr)).unwrap();
    assert_eq!(error["code"], "cli_error");
    assert!(
        error["error"]
            .as_str()
            .unwrap()
            .contains("unencrypted HTTP")
    );
    assert!(!text(&output.stderr).contains(TOKEN));
}
