use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Command, Output};
use std::thread;
use std::time::{Duration, Instant};

const BOARD_KEY: &str = "fixture-board-secret";

fn cli(home: &Path, base: &str, args: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rudder-cli"));
    command.env_clear();
    #[cfg(windows)]
    for name in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .env("RUDDER_HOME", home)
        .env("RUDDER_CLI_HTTP_TIMEOUT_MS", "2000")
        .args(args)
        .args(["--api-base", base, "--json"])
        .output()
        .expect("actual CLI exits")
}

fn store(home: &Path, base: &str, key: &str) {
    std::fs::write(
        home.join("auth.json"),
        json!({"version": 1, "futureField": 42,
        "credentials": {base: {"apiBase": base, "token": key, "userId": "user-1"},
        "https://other.invalid": {"token": "other-secret"}}})
        .to_string(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            home.join("auth.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
}

fn server(
    responses: Vec<(u16, Value)>,
    before_response: impl Fn(usize) + Send + 'static,
) -> (String, thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let worker = thread::spawn(move || {
        let mut requests = Vec::new();
        for (index, (status, body)) in responses.into_iter().enumerate() {
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "missing CLI request {index}");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("accept: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let count = stream.read(&mut chunk).unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                assert!(bytes.len() < 64 * 1024);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            requests.push(String::from_utf8(bytes).unwrap());
            before_response(index);
            let body = body.to_string();
            write!(stream, "HTTP/1.1 {status} Fixture\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        }
        requests
    });
    (base, worker)
}

fn result(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn login_polls_and_preserves_existing_store_without_printing_board_key() {
    let home = tempfile::tempdir().unwrap();
    // Approval URL is populated after binding via an origin-independent approvalPath.
    let (base, worker) = server(
        vec![
            (
                200,
                json!({"id":"challenge-1", "token":"poll-secret", "boardApiToken":BOARD_KEY,
            "pollPath":"/cli-auth/challenges/challenge-1", "approvalPath":"/cli-auth/challenge-1?token=poll-secret",
            "expiresAt":"2099-01-01T00:00:00Z", "suggestedPollIntervalMs":500}),
            ),
            (200, json!({"status":"pending"})),
            (200, json!({"status":"approved"})),
            (200, json!({"userId":"user-1"})),
        ],
        |_| {},
    );
    store(home.path(), &base, "previous-key");
    let output = cli(
        home.path(),
        &base,
        &["auth", "login", "--no-browser", "--instance-admin"],
    );
    assert_eq!(result(&output)["userId"], "user-1");
    let requests = worker.join().unwrap();
    assert!(requests[0].starts_with("POST /api/cli-auth/challenges "));
    assert!(!requests[0].to_ascii_lowercase().contains("authorization:"));
    assert!(requests[0].contains("instance_admin_required"));
    assert!(requests[1].starts_with("GET /api/cli-auth/challenges/challenge-1?token=poll-secret "));
    assert!(requests[3].contains(&format!("Bearer {BOARD_KEY}")));
    assert!(!String::from_utf8_lossy(&output.stdout).contains(BOARD_KEY));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(BOARD_KEY));
    let saved: Value =
        serde_json::from_slice(&std::fs::read(home.path().join("auth.json")).unwrap()).unwrap();
    assert_eq!(saved["credentials"][&base]["token"], BOARD_KEY);
    assert_eq!(
        saved["credentials"]["https://other.invalid"]["token"],
        "other-secret"
    );
    assert_eq!(saved["futureField"], 42);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(home.path().join("auth.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn whoami_reuses_legacy_store_and_redacts_echoed_secret() {
    let home = tempfile::tempdir().unwrap();
    let (base, worker) = server(
        vec![(200, json!({"userId":"user-1", "echo":BOARD_KEY}))],
        |_| {},
    );
    store(home.path(), &format!("{base}/"), BOARD_KEY);
    let output = cli(home.path(), &base, &["auth", "whoami"]);
    assert_eq!(result(&output)["echo"], "[REDACTED]");
    assert!(worker.join().unwrap()[0].contains(&format!("Bearer {BOARD_KEY}")));
}

#[test]
fn logout_reports_revoke_failure_and_removes_only_target_credential() {
    let home = tempfile::tempdir().unwrap();
    let (base, worker) = server(vec![(503, json!({"error":"unavailable"}))], |_| {});
    store(home.path(), &base, BOARD_KEY);
    let value = result(&cli(home.path(), &base, &["auth", "logout"]));
    assert_eq!(value["revoked"], false);
    assert_eq!(value["removedLocalCredential"], true);
    worker.join().unwrap();
    let saved: Value =
        serde_json::from_slice(&std::fs::read(home.path().join("auth.json")).unwrap()).unwrap();
    assert!(saved["credentials"].get(&base).is_none());
    assert_eq!(
        saved["credentials"]["https://other.invalid"]["token"],
        "other-secret"
    );
}

#[test]
fn logout_does_not_remove_a_credential_saved_during_revocation() {
    let home = tempfile::tempdir().unwrap();
    let store_path = home.path().join("auth.json");
    let (base, worker) = server(vec![(200, json!({"ok":true}))], move |_| {
        let mut value: Value =
            serde_json::from_slice(&std::fs::read(&store_path).unwrap()).unwrap();
        for credential in value["credentials"].as_object_mut().unwrap().values_mut() {
            if credential["token"] == BOARD_KEY {
                credential["token"] = json!("new-login-key");
            }
        }
        std::fs::write(&store_path, value.to_string()).unwrap();
    });
    store(home.path(), &base, BOARD_KEY);
    let value = result(&cli(home.path(), &base, &["auth", "logout"]));
    assert_eq!(value["revoked"], true);
    assert_eq!(value["removedLocalCredential"], false);
    worker.join().unwrap();
    assert!(
        std::fs::read_to_string(home.path().join("auth.json"))
            .unwrap()
            .contains("new-login-key")
    );
}

#[test]
fn untrusted_approval_origin_fails_before_polling_or_persisting() {
    let home = tempfile::tempdir().unwrap();
    let (base, worker) = server(
        vec![(
            200,
            json!({"id":"challenge", "token":"poll-secret", "boardApiToken":BOARD_KEY,
        "pollPath":"/cli-auth/challenges/challenge", "approvalUrl":"https://attacker.invalid/approve",
        "expiresAt":"2099-01-01T00:00:00Z"}),
        )],
        |_| {},
    );
    let output = cli(home.path(), &base, &["auth", "login", "--no-browser"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("configured API origin"));
    worker.join().unwrap();
    assert!(!home.path().join("auth.json").exists());
}

#[test]
fn cancelled_challenge_leaves_existing_credential_unchanged() {
    let home = tempfile::tempdir().unwrap();
    let (base, worker) = server(
        vec![
            (
                200,
                json!({"id":"challenge", "token":"poll-secret", "boardApiToken":BOARD_KEY,
            "pollPath":"/cli-auth/challenges/challenge", "approvalPath":"/approve", "expiresAt":"2099-01-01T00:00:00Z"}),
            ),
            (200, json!({"status":"cancelled"})),
        ],
        |_| {},
    );
    store(home.path(), &base, "old-key");
    let before = std::fs::read(home.path().join("auth.json")).unwrap();
    let output = cli(home.path(), &base, &["auth", "login", "--no-browser"]);
    assert!(!output.status.success());
    worker.join().unwrap();
    assert_eq!(
        before,
        std::fs::read(home.path().join("auth.json")).unwrap()
    );
}

#[test]
fn malformed_store_fails_before_network_access() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("auth.json"), "{broken").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            home.path().join("auth.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    let output = cli(
        home.path(),
        "http://127.0.0.1:1",
        &["auth", "login", "--no-browser"],
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("credential store JSON"));
}

#[test]
#[cfg(unix)]
fn permissive_existing_credentials_fail_before_network_access() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let base = "http://127.0.0.1:1";
    store(home.path(), base, BOARD_KEY);
    std::fs::set_permissions(
        home.path().join("auth.json"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    let output = cli(home.path(), base, &["auth", "whoami"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("mode 0600"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(BOARD_KEY));
}

#[test]
fn member_read_reuses_saved_board_credential() {
    let home = tempfile::tempdir().unwrap();
    let (base, worker) = server(
        vec![(
            200,
            json!({"total":0,"items":[],"hasMore":false,"nextCursor":null}),
        )],
        |_| {},
    );
    store(home.path(), &base, BOARD_KEY);
    let output = cli(home.path(), &base, &["org", "members", "--org-id", "org-1"]);
    assert_eq!(result(&output)["total"], 0);
    assert!(worker.join().unwrap()[0].contains(&format!("Bearer {BOARD_KEY}")));
}

#[test]
fn explicit_key_takes_precedence_over_malformed_store() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("auth.json"), "{broken").unwrap();
    let (base, worker) = server(vec![(200, json!({"userId":"explicit-user"}))], |_| {});
    assert_eq!(
        result(&cli(
            home.path(),
            &base,
            &["auth", "whoami", "--api-key", "explicit-key"]
        ))["userId"],
        "explicit-user"
    );
    assert!(worker.join().unwrap()[0].contains("Bearer explicit-key"));
}

#[test]
fn poll_errors_redact_challenge_secret_from_all_error_fields() {
    let home = tempfile::tempdir().unwrap();
    let (base, worker) = server(
        vec![
            (
                200,
                json!({"id":"challenge", "token":"poll-secret", "boardApiToken":BOARD_KEY,
            "pollPath":"/cli-auth/challenges/challenge", "approvalPath":"/approve", "expiresAt":"2099-01-01T00:00:00Z"}),
            ),
            (
                403,
                json!({"code":"poll-secret", "error":"poll-secret", "details":{"poll-secret":"poll-secret"}}),
            ),
        ],
        |_| {},
    );
    let output = cli(home.path(), &base, &["auth", "login", "--no-browser"]);
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("poll-secret"));
    worker.join().unwrap();
    assert!(!home.path().join("auth.json").exists());
}

#[test]
fn expired_creation_does_not_poll_or_save() {
    let home = tempfile::tempdir().unwrap();
    let (base, worker) = server(
        vec![(
            200,
            json!({"id":"challenge", "token":"poll-secret", "boardApiToken":BOARD_KEY,
        "pollPath":"/cli-auth/challenges/challenge", "approvalPath":"/approve", "expiresAt":"2000-01-01T00:00:00Z"}),
        )],
        |_| {},
    );
    let output = cli(home.path(), &base, &["auth", "login", "--no-browser"]);
    assert!(!output.status.success());
    worker.join().unwrap();
    assert!(!home.path().join("auth.json").exists());
}

#[test]
fn approved_key_is_revoked_when_identity_lookup_cannot_complete() {
    for (status, me) in [
        (503, json!({"error":"unavailable"})),
        (200, json!({"userId":null})),
        (200, json!({"userId":""})),
    ] {
        let home = tempfile::tempdir().unwrap();
        let (base, worker) = server(
            vec![
                (
                    200,
                    json!({"id":"challenge", "token":"poll-secret", "boardApiToken":BOARD_KEY,
                "pollPath":"/cli-auth/challenges/challenge", "approvalPath":"/approve", "expiresAt":"2099-01-01T00:00:00Z"}),
                ),
                (200, json!({"status":"approved"})),
                (status, me),
                (200, json!({"revoked":true})),
            ],
            |_| {},
        );
        let output = cli(home.path(), &base, &["auth", "login", "--no-browser"]);
        assert!(!output.status.success());
        let requests = worker.join().unwrap();
        assert!(requests[3].starts_with("POST /api/cli-auth/revoke-current "));
        assert!(requests[3].contains(&format!("Bearer {BOARD_KEY}")));
        assert!(!home.path().join("auth.json").exists());
    }
}

#[test]
fn failed_approved_key_cleanup_is_reported_without_secrets() {
    let home = tempfile::tempdir().unwrap();
    let (base, worker) = server(
        vec![
            (
                200,
                json!({"id":"challenge", "token":"poll-secret", "boardApiToken":BOARD_KEY,
            "pollPath":"/cli-auth/challenges/challenge", "approvalPath":"/approve", "expiresAt":"2099-01-01T00:00:00Z"}),
            ),
            (200, json!({"status":"approved"})),
            (503, json!({"error":"unavailable"})),
            (503, json!({"error":"unavailable"})),
        ],
        |_| {},
    );
    let output = cli(home.path(), &base, &["auth", "login", "--no-browser"]);
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("revocation could not be confirmed"));
    assert!(!error.contains(BOARD_KEY));
    worker.join().unwrap();
}

#[test]
fn concurrent_cli_logouts_preserve_other_origins_and_both_removals() {
    let home = tempfile::tempdir().unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let b = barrier.clone();
    let (first, first_server) = server(vec![(200, json!({"revoked":true}))], move |_| {
        b.wait();
    });
    let (second, second_server) = server(vec![(200, json!({"revoked":true}))], move |_| {
        barrier.wait();
    });
    store(home.path(), &first, BOARD_KEY);
    let path = home.path().join("auth.json");
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    saved["credentials"][&second] = json!({"apiBase":second,"token":"second-key"});
    std::fs::write(&path, saved.to_string()).unwrap();
    let first_home = home.path().to_path_buf();
    let second_home = first_home.clone();
    let a = thread::spawn(move || cli(&first_home, &first, &["auth", "logout"]));
    let b = thread::spawn(move || cli(&second_home, &second, &["auth", "logout"]));
    assert_eq!(result(&a.join().unwrap())["removedLocalCredential"], true);
    assert_eq!(result(&b.join().unwrap())["removedLocalCredential"], true);
    first_server.join().unwrap();
    second_server.join().unwrap();
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["credentials"].as_object().unwrap().len(), 1);
    assert_eq!(
        saved["credentials"]["https://other.invalid"]["token"],
        "other-secret"
    );
}
