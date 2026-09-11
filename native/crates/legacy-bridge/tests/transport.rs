#![cfg(unix)]

use rudder_authority_core::{
    ActorIdentity, AuthorityError, ComponentAuthority, LegacyBridgeRequestEnvelope, OwnerId,
};
use rudder_legacy_bridge::{
    BridgeAdmission, BridgeConfig, BridgeError, BridgeLimits, LegacyBridgeClient,
    LegacyBridgeRequest, LegacyBridgeServer, ReplayGuard,
};
use serde_json::{Value, json};
use std::fs;
use std::io::Write;
use std::os::unix::fs::symlink;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;
use tempfile::TempDir;

fn authority() -> ComponentAuthority {
    ComponentAuthority::new("issues", "legacy-v1", OwnerId::legacy()).expect("authority")
}

fn actor() -> ActorIdentity {
    ActorIdentity::new("user", "operator-1").expect("actor")
}

fn request(authority: &ComponentAuthority, request_id: &str, nonce: &str) -> LegacyBridgeRequest {
    let body = json!({"issueId": "issue-1", "operation": "read"});
    let body_bytes = serde_json::to_vec(&body).expect("body json");
    let envelope = LegacyBridgeRequestEnvelope::new(
        authority,
        actor(),
        "org-1",
        "issue.read",
        &body_bytes,
        request_id,
        nonce,
        900,
        1_200,
    )
    .expect("envelope");
    LegacyBridgeRequest::new(envelope, body)
}

fn admission(authority: &ComponentAuthority, request_id: &str) -> BridgeAdmission {
    BridgeAdmission::new(
        authority.clone(),
        actor(),
        "org-1",
        "issue.read",
        request_id,
        1_000,
    )
    .expect("admission")
}

fn config_with_limits(max_frame: usize, max_body: usize, timeout: Duration) -> BridgeConfig {
    let limits = BridgeLimits::new(max_frame, max_body).expect("limits");
    BridgeConfig::new(limits, timeout, timeout).expect("config")
}

fn spawn_dispatch(
    server: LegacyBridgeServer,
    admission: BridgeAdmission,
    replay: ReplayGuard,
    calls: Arc<AtomicUsize>,
) -> thread::JoinHandle<Result<(), BridgeError>> {
    thread::spawn(move || {
        server.dispatch_once(&admission, &replay, |request| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"status": "ok", "echo": request.body["issueId"]}))
        })
    })
}

fn write_frame(stream: &mut UnixStream, payload: &[u8]) {
    stream
        .write_all(&(payload.len() as u32).to_be_bytes())
        .expect("frame length");
    stream.write_all(payload).expect("frame payload");
    stream.flush().expect("frame flush");
}

type RequestTamper = Box<dyn FnOnce(&mut LegacyBridgeRequest)>;
type ErrorMatcher = Box<dyn Fn(&BridgeError) -> bool>;
type TamperCase = (&'static str, RequestTamper, ErrorMatcher);

#[test]
fn valid_private_socket_round_trip_dispatches_once() {
    let temp = TempDir::new().expect("temp dir");
    let socket = temp.path().join("legacy-bridge.sock");
    let config = BridgeConfig::for_test();
    let server = LegacyBridgeServer::bind(&socket, config.clone()).expect("bind bridge");
    let authority = authority();
    let request = request(&authority, "request-1", "nonce-1");
    let admission = admission(&authority, "request-1");
    let replay = ReplayGuard::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let server_thread = spawn_dispatch(server, admission, replay.clone(), calls.clone());

    let mut client = LegacyBridgeClient::connect(&socket, config).expect("connect bridge");
    let response = client.request(&request).expect("round trip");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(response.ok);
    assert_eq!(
        response.body,
        Some(json!({"status": "ok", "echo": "issue-1"}))
    );
    assert_eq!(response.request_id, "request-1");
    assert_eq!(response.nonce, "nonce-1");
    server_thread
        .join()
        .expect("server thread")
        .expect("server dispatch");
    assert_eq!(replay.len(), 1);
}

#[test]
fn tampered_bindings_are_rejected_before_dispatch() {
    let cases: Vec<TamperCase> = vec![
        (
            "actor",
            Box::new(|request| request.envelope.actor.id = "other-actor".into()),
            Box::new(|error| {
                matches!(error, BridgeError::Authority(AuthorityError::ActorMismatch))
            }),
        ),
        (
            "organization",
            Box::new(|request| request.envelope.organization_id = "other-org".into()),
            Box::new(|error| {
                matches!(
                    error,
                    BridgeError::Authority(AuthorityError::OrganizationMismatch)
                )
            }),
        ),
        (
            "action",
            Box::new(|request| request.envelope.action = "issue.write".into()),
            Box::new(|error| {
                matches!(
                    error,
                    BridgeError::Authority(AuthorityError::ActionMismatch)
                )
            }),
        ),
        (
            "body hash",
            Box::new(|request| request.body = json!({"issueId": "tampered"})),
            Box::new(|error| {
                matches!(
                    error,
                    BridgeError::Authority(AuthorityError::BodyHashMismatch)
                )
            }),
        ),
        (
            "request id",
            Box::new(|request| request.envelope.request_id = "other-request".into()),
            Box::new(|error| {
                matches!(
                    error,
                    BridgeError::Authority(AuthorityError::RequestIdMismatch)
                )
            }),
        ),
        (
            "epoch",
            Box::new(|request| request.envelope.authority_epoch += 1),
            Box::new(|error| {
                matches!(
                    error,
                    BridgeError::Authority(AuthorityError::FutureEpoch { .. })
                )
            }),
        ),
        (
            "fence",
            Box::new(|request| request.envelope.fencing_token = "tampered-fence".into()),
            Box::new(|error| {
                matches!(
                    error,
                    BridgeError::Authority(AuthorityError::FencingTokenMismatch)
                )
            }),
        ),
    ];

    for (label, tamper, matches_error) in cases {
        let temp = TempDir::new().expect("temp dir");
        let socket = temp.path().join("legacy-bridge.sock");
        let config = BridgeConfig::for_test();
        let authority = authority();
        let mut request = request(&authority, "request-1", "nonce-1");
        tamper(&mut request);
        let server = LegacyBridgeServer::bind(&socket, config.clone()).expect("bind bridge");
        let calls = Arc::new(AtomicUsize::new(0));
        let server_thread = spawn_dispatch(
            server,
            admission(&authority, "request-1"),
            ReplayGuard::new(),
            calls.clone(),
        );
        let mut client = LegacyBridgeClient::connect(&socket, config).expect("connect bridge");
        let client_result = client.request(&request);
        let server_error = server_thread
            .join()
            .expect("server thread")
            .expect_err("tamper must fail closed");
        assert!(
            client_result.is_err(),
            "{label} must close the response path"
        );
        assert!(matches_error(&server_error), "{label}: {server_error:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "{label} dispatched");
    }
}

#[test]
fn replayed_nonce_is_rejected_without_a_second_dispatch() {
    let temp = TempDir::new().expect("temp dir");
    let socket = temp.path().join("legacy-bridge.sock");
    let config = BridgeConfig::for_test();
    let server = LegacyBridgeServer::bind(&socket, config.clone()).expect("bind bridge");
    let authority = authority();
    let request = request(&authority, "request-1", "nonce-1");
    let replay = ReplayGuard::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let server_socket = socket.clone();
    let server_config = config.clone();
    let server_authority = authority.clone();
    let server_replay = replay.clone();
    let server_calls = calls.clone();
    let (second_ready_tx, second_ready_rx) = channel();
    let server_thread = thread::spawn(move || {
        let first = server.dispatch_once(
            &admission(&server_authority, "request-1"),
            &server_replay,
            |request| {
                server_calls.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"echo": request.body["issueId"]}))
            },
        );
        drop(server);
        let second_server = LegacyBridgeServer::bind(&server_socket, server_config.clone())?;
        second_ready_tx.send(()).expect("second listener readiness");
        let second = second_server.dispatch_once(
            &admission(&server_authority, "request-1"),
            &server_replay,
            |request| {
                server_calls.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"echo": request.body["issueId"]}))
            },
        );
        Ok::<_, BridgeError>((first, second))
    });

    let mut client = LegacyBridgeClient::connect(&socket, config.clone()).expect("first connect");
    client.request(&request).expect("first request");
    drop(client);
    second_ready_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("second listener ready");
    let mut second_client = LegacyBridgeClient::connect(&socket, config).expect("second connect");
    let second_result = second_client.request(&request);
    assert!(second_result.is_err(), "replay response must be closed");
    let (first, second) = server_thread
        .join()
        .expect("server thread")
        .expect("server setup");
    first.expect("first request dispatch");
    assert!(matches!(
        second,
        Err(BridgeError::Authority(AuthorityError::Replay))
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(replay.len(), 1);
}

#[test]
fn malformed_json_is_rejected_before_dispatch() {
    let temp = TempDir::new().expect("temp dir");
    let socket = temp.path().join("legacy-bridge.sock");
    let config = BridgeConfig::for_test();
    let authority = authority();
    let server = LegacyBridgeServer::bind(&socket, config).expect("bind bridge");
    let calls = Arc::new(AtomicUsize::new(0));
    let server_thread = spawn_dispatch(
        server,
        admission(&authority, "request-1"),
        ReplayGuard::new(),
        calls.clone(),
    );
    let mut stream = UnixStream::connect(&socket).expect("connect raw peer");
    write_frame(&mut stream, br#"{"schema":"not-json"}"#);
    let error = server_thread
        .join()
        .expect("server thread")
        .expect_err("malformed request");
    assert!(matches!(error, BridgeError::MalformedJson(_)));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn oversized_frame_is_rejected_without_allocating_the_payload() {
    let temp = TempDir::new().expect("temp dir");
    let socket = temp.path().join("legacy-bridge.sock");
    let config = config_with_limits(128, 64, Duration::from_millis(250));
    let authority = authority();
    let server = LegacyBridgeServer::bind(&socket, config).expect("bind bridge");
    let calls = Arc::new(AtomicUsize::new(0));
    let server_thread = spawn_dispatch(
        server,
        admission(&authority, "request-1"),
        ReplayGuard::new(),
        calls.clone(),
    );
    let mut stream = UnixStream::connect(&socket).expect("connect raw peer");
    stream
        .write_all(&(129_u32.to_be_bytes()))
        .expect("oversized length");
    stream.flush().expect("length flush");
    let error = server_thread
        .join()
        .expect("server thread")
        .expect_err("oversized frame");
    assert!(matches!(
        error,
        BridgeError::FrameTooLarge {
            length: 129,
            max: 128
        }
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn oversized_body_is_rejected_by_the_client_codec() {
    let temp = TempDir::new().expect("temp dir");
    let socket = temp.path().join("legacy-bridge.sock");
    let config = config_with_limits(512, 64, Duration::from_millis(250));
    let server = LegacyBridgeServer::bind(&socket, config.clone()).expect("bind bridge");
    let authority = authority();
    let body = Value::String("x".repeat(100));
    let request = LegacyBridgeRequest::from_parts(
        &authority,
        actor(),
        "org-1",
        "issue.read",
        body,
        "request-large",
        "nonce-large",
        900,
        1_200,
    )
    .expect("request");
    let mut client = LegacyBridgeClient::connect(&socket, config).expect("connect bridge");
    let error = client.request(&request).expect_err("body size");
    assert!(matches!(error, BridgeError::BodyTooLarge { .. }));
    drop(server);
}

#[test]
fn partial_frame_times_out_with_a_bounded_deadline() {
    let temp = TempDir::new().expect("temp dir");
    let socket = temp.path().join("legacy-bridge.sock");
    let config = config_with_limits(4_096, 1_024, Duration::from_millis(40));
    let authority = authority();
    let server = LegacyBridgeServer::bind(&socket, config).expect("bind bridge");
    let server_thread = thread::spawn(move || {
        server.dispatch_once(
            &admission(&authority, "request-1"),
            &ReplayGuard::new(),
            |_| Ok(json!({"unreachable": true})),
        )
    });
    let mut stream = UnixStream::connect(&socket).expect("connect raw peer");
    stream.write_all(&[0, 0]).expect("partial length");
    stream.flush().expect("partial flush");
    let error = server_thread
        .join()
        .expect("server thread")
        .expect_err("partial frame must time out");
    assert!(error.is_timeout(), "{error:?}");
}

#[test]
fn unknown_peer_uid_is_rejected_before_reading_a_request() {
    let temp = TempDir::new().expect("temp dir");
    let socket = temp.path().join("legacy-bridge.sock");
    let client_config = BridgeConfig::for_test();
    let actual_uid = client_config.expected_peer_uid().expect("local uid");
    let wrong_uid = if actual_uid == u32::MAX {
        0
    } else {
        actual_uid + 1
    };
    let server_config = client_config.clone().with_expected_peer_uid(wrong_uid);
    let authority = authority();
    let server = LegacyBridgeServer::bind(&socket, server_config).expect("bind bridge");
    let server_thread = thread::spawn(move || {
        server.dispatch_once(
            &admission(&authority, "request-1"),
            &ReplayGuard::new(),
            |_| Ok(json!({"unreachable": true})),
        )
    });
    let client = LegacyBridgeClient::connect(&socket, client_config).expect("connect socket");
    drop(client);
    let error = server_thread
        .join()
        .expect("server thread")
        .expect_err("unknown peer must fail closed");
    assert!(matches!(error, BridgeError::UnknownPeer { .. }));
}

#[test]
fn unknown_or_public_paths_are_rejected() {
    let temp = TempDir::new().expect("temp dir");
    let config = BridgeConfig::for_test();
    let regular_file = temp.path().join("not-a-socket");
    fs::write(&regular_file, b"not a listener").expect("regular file");
    let error = LegacyBridgeClient::connect(&regular_file, config.clone())
        .expect_err("regular file must not be treated as a socket");
    assert!(matches!(error, BridgeError::NotUnixSocket { .. }));

    let real_socket = temp.path().join("real.sock");
    let alias = temp.path().join("alias.sock");
    let server = LegacyBridgeServer::bind(&real_socket, config.clone()).expect("bind bridge");
    symlink(&real_socket, &alias).expect("socket alias");
    let error = LegacyBridgeClient::connect(&alias, config)
        .expect_err("symlinked unknown path must be rejected");
    assert!(matches!(error, BridgeError::InsecureSocketPath { .. }));
    drop(server);
}

#[test]
fn relative_and_untrusted_socket_roots_are_rejected() {
    let config = BridgeConfig::for_test();
    let error =
        LegacyBridgeServer::bind("relative.sock", config.clone()).expect_err("relative path");
    assert!(matches!(error, BridgeError::InvalidSocketPath { .. }));

    let temp = TempDir::new().expect("temp dir");
    let allowed = temp.path().join("allowed");
    fs::create_dir(&allowed).expect("allowed directory");
    let outside = temp.path().join("outside.sock");
    let restricted = config.with_socket_dir(allowed);
    let error = LegacyBridgeServer::bind(outside, restricted).expect_err("unknown socket root");
    assert!(matches!(error, BridgeError::InsecureSocketPath { .. }));
}
