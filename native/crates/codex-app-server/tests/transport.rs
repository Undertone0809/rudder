#![cfg(unix)]
//! Real owned processes exercise the production transport, without a provider.
use rudder_codex_app_server::{
    Message, OwnedTransport, ProcessLaunch, SessionObservation, TransportError, TransportEvent,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(10);

fn launch(script: &str) -> (OwnedTransport, tempfile::TempDir) {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let transport = OwnedTransport::launch(ProcessLaunch {
        executable: "/bin/sh".into(),
        argv: vec!["-c".into(), script.into()],
        cwd: path.clone(),
        env: BTreeMap::new(),
        request_id: "transport-test".into(),
        owner_token: "owned-transport-test".into(),
        runtime_root: path,
    })
    .unwrap();
    (transport, root)
}

fn spawned(transport: &mut OwnedTransport) -> u32 {
    loop {
        if let TransportEvent::Lifecycle(value) = transport.receive(WAIT).unwrap() {
            if value["type"] == "spawned" {
                return value["pid"].as_u64().unwrap() as u32;
            }
            assert_ne!(value["type"], "terminal");
        }
    }
}

fn completed(transport: &mut OwnedTransport) -> Value {
    let mut written = false;
    let mut result = None;
    while !written || result.is_none() {
        match transport.receive(WAIT).unwrap() {
            TransportEvent::FrameWritten { request_id } => {
                assert!(request_id.is_some());
                written = true;
            }
            TransportEvent::Rpc(SessionObservation::Completed { outcome, .. }) => {
                result = Some(outcome.unwrap())
            }
            TransportEvent::Lifecycle(value) => assert_ne!(value["type"], "terminal"),
            _ => panic!("unexpected RPC observation"),
        }
    }
    result.unwrap()
}

fn stopped(transport: &mut OwnedTransport) {
    transport.stop().unwrap();
    loop {
        if let TransportEvent::Lifecycle(value) = transport.receive(WAIT).unwrap()
            && value["type"] == "terminal"
        {
            assert_eq!(value["cleanupProven"], true);
            break;
        }
    }
    assert!(matches!(
        transport.request("test", json!({})),
        Err(TransportError::Closed)
    ));
}

#[test]
fn sends_large_utf8_frame_in_receipted_chunks_and_preserves_next_input() {
    let script = "n=0; while IFS= read -r line; do printf '{\"id\":%s,\"result\":%s}\\n' \"$n\" \"$line\"; n=$((n+1)); done";
    let (mut transport, _root) = launch(script);
    spawned(&mut transport);
    let text = "🧭".repeat(20_000);
    let first = transport
        .request("turn/start", json!({"input":text}))
        .unwrap();
    assert!(matches!(
        transport.request("duplicate", json!({})),
        Err(TransportError::Busy)
    ));
    let result = completed(&mut transport);
    assert_eq!(result["params"]["input"], text);
    assert_eq!(result["id"], serde_json::to_value(first).unwrap());
    transport
        .request("turn/start", json!({"input":"only new input"}))
        .unwrap();
    assert_eq!(
        completed(&mut transport)["params"],
        json!({"input":"only new input"})
    );
    stopped(&mut transport);
}

#[test]
fn forwards_server_requests_without_synthesizing_approval() {
    let script = "IFS= read -r line; printf '{\"id\":\"approval\",\"method\":\"item/commandExecution/requestApproval\",\"params\":{}}\\n'; IFS= read -r second; exit 9";
    let (mut transport, _root) = launch(script);
    spawned(&mut transport);
    transport.notify("initialized", json!({})).unwrap();
    loop {
        match transport.receive(WAIT).unwrap() {
            TransportEvent::Rpc(SessionObservation::Incoming(Message::Request {
                method, ..
            })) => {
                assert_eq!(method, "item/commandExecution/requestApproval");
                break;
            }
            TransportEvent::FrameWritten { request_id } => assert!(request_id.is_none()),
            TransportEvent::Lifecycle(value) => assert_ne!(value["type"], "terminal"),
            _ => panic!("unexpected observation"),
        }
    }
    // No automatic response was written; the child still waits for its second line.
    stopped(&mut transport);
}

#[test]
fn an_unmatched_response_closes_transport_and_drop_reaps_child() {
    let (mut transport, _root) =
        launch("IFS= read -r line; printf '{\"id\":99,\"result\":{}}\\n'; /bin/sleep 60");
    let pid = spawned(&mut transport);
    transport.request("initialize", json!({})).unwrap();
    loop {
        match transport.receive(WAIT) {
            Ok(_) => {}
            Err(TransportError::Session(_)) => break,
            Err(error) => panic!("unexpected error: {error}"),
        }
    }
    assert!(matches!(
        transport.request("initialize", json!({})),
        Err(TransportError::Closed)
    ));
    drop(transport);
    assert!(
        !std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    );
}

#[test]
fn stop_never_dispatches_the_remaining_chunks_of_a_partial_input() {
    let (mut transport, root) = launch("/bin/cat > received");
    spawned(&mut transport);
    transport
        .request("turn/start", json!({"input":"🧭".repeat(20_000)}))
        .unwrap();
    transport.stop().unwrap();
    loop {
        match transport.receive(WAIT) {
            Err(_) => break,
            Ok(TransportEvent::Lifecycle(value)) if value["type"] == "terminal" => break,
            _ => {}
        }
    }
    drop(transport);
    let bytes = std::fs::read(root.path().join("received")).unwrap_or_default();
    assert!(bytes.len() <= 64 * 1024);
    assert!(!bytes.ends_with(b"\n"));
}

#[test]
#[ignore = "requires explicit installed Codex; no model or auth calls"]
fn production_transport_initializes_installed_codex_in_an_empty_profile() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let profile = root.path().join("profile");
    std::fs::create_dir(&profile).unwrap();
    let mut env = BTreeMap::from([
        ("HOME".into(), path.clone()),
        ("CODEX_HOME".into(), profile.to_string_lossy().into_owned()),
    ]);
    if let Ok(path) = std::env::var("PATH") {
        env.insert("PATH".into(), path);
    }
    let mut transport = OwnedTransport::launch(ProcessLaunch {
        executable: std::env::var("RUDDER_CODEX_PROTOCOL_TEST_EXECUTABLE").unwrap(),
        argv: vec!["app-server".into()],
        cwd: path.clone(),
        env,
        request_id: "installed-transport".into(),
        owner_token: "installed-transport-owner".into(),
        runtime_root: path,
    })
    .unwrap();
    spawned(&mut transport);
    transport
        .request(
            "initialize",
            json!({
                "clientInfo":{"name":"rudder-transport-test","version":"0.0.0"},
                "capabilities":{"experimentalApi":true}
            }),
        )
        .unwrap();
    completed(&mut transport);
    transport.notify("initialized", json!({})).unwrap();
    while !matches!(
        transport.receive(WAIT).unwrap(),
        TransportEvent::FrameWritten { request_id: None }
    ) {}
    transport
        .request(
            "thread/read",
            json!({"threadId":"00000000-0000-4000-8000-000000000000","includeTurns":false}),
        )
        .unwrap();
    let mut written = false;
    let mut failed = false;
    while !written || !failed {
        match transport.receive(WAIT).unwrap() {
            TransportEvent::FrameWritten { .. } => written = true,
            TransportEvent::Rpc(SessionObservation::Completed {
                method,
                outcome: Err(_),
                ..
            }) => {
                assert_eq!(method, "thread/read");
                failed = true;
            }
            TransportEvent::Lifecycle(value) => assert_ne!(value["type"], "terminal"),
            TransportEvent::Rpc(SessionObservation::Incoming(Message::Notification { .. })) => {}
            _ => panic!("unexpected installed Codex observation"),
        }
    }
    stopped(&mut transport);
}
