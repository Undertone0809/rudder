#![cfg(unix)]
//! Opt-in real external Rust host tests. Build rudder-process-host and pass its
//! absolute path in RUDDER_TEST_PROCESS_HOST; no provider or credentials used.
use rudder_codex_app_server::{OwnedTransport, ProcessLaunch, SessionObservation, TransportEvent};
use serde_json::json;
use std::{
    collections::BTreeMap,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn fake_host(script: &str) -> (tempfile::TempDir, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("host");
    std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    (root, path)
}

fn with_fake_host(root: &Path, host: &Path) -> OwnedTransport {
    let path = root.canonicalize().unwrap().to_string_lossy().into_owned();
    OwnedTransport::launch_external(
        ProcessLaunch {
            executable: "/bin/sleep".into(),
            argv: vec!["30".into()],
            cwd: path.clone(),
            env: BTreeMap::new(),
            request_id: "external-test".into(),
            owner_token: "external-test-owner".into(),
            runtime_root: path,
        },
        host,
    )
    .unwrap()
}

#[test]
fn invalid_handshake_cannot_receive_a_start_command() {
    let (root, host) = fake_host(
        r#"printf '%s\n' '{"muxVersion":1,"type":"lifecycle","event":{"type":"handshake","protocolVersion":{"major":999,"minor":0}}}'
if IFS= read -r line; then printf bad > "${0%/*}/unexpected-command"; fi"#,
    );
    let mut transport = with_fake_host(root.path(), &host);
    assert!(transport.receive(Duration::from_secs(3)).is_err());
    drop(transport);
    assert!(!root.path().join("unexpected-command").exists());
}

#[test]
fn silent_helper_cannot_block_transport_drop_indefinitely() {
    let (root, host) = fake_host("exec /bin/sleep 30");
    let transport = with_fake_host(root.path(), &host);
    let start = Instant::now();
    drop(transport);
    assert!(start.elapsed() < Duration::from_secs(14));
}

fn launch(root: &Path, script: &str) -> OwnedTransport {
    let host = std::env::var_os("RUDDER_TEST_PROCESS_HOST").expect("built host path");
    let path = root.canonicalize().unwrap().to_string_lossy().into_owned();
    OwnedTransport::launch_external(
        ProcessLaunch {
            executable: "/bin/sh".into(),
            argv: vec!["-c".into(), script.into()],
            cwd: path.clone(),
            env: BTreeMap::new(),
            request_id: "external-test".into(),
            owner_token: "external-test-owner".into(),
            runtime_root: path,
        },
        Path::new(&host),
    )
    .unwrap()
}

fn spawned(transport: &mut OwnedTransport) -> u32 {
    loop {
        if let TransportEvent::Lifecycle(event) =
            transport.receive(Duration::from_secs(10)).unwrap()
        {
            assert_ne!(event["type"], "terminal");
            if event["type"] == "spawned" {
                return event["pid"].as_u64().unwrap() as u32;
            }
        }
    }
}

#[test]
#[ignore = "requires built Rust process host; no provider calls"]
fn external_host_preserves_receipts_rpc_and_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let mut transport = launch(
        root.path(),
        "n=0; while IFS= read -r line; do printf '{\"id\":%s,\"result\":%s}\\n' \"$n\" \"$line\"; n=$((n+1)); done",
    );
    spawned(&mut transport);
    let text = "🧭".repeat(20000);
    let id = transport.request("echo", json!({"text":text})).unwrap();
    let (mut written, mut replied) = (false, false);
    while !(written && replied) {
        match transport.receive(Duration::from_secs(10)).unwrap() {
            TransportEvent::FrameWritten { request_id } => {
                assert_eq!(request_id, Some(id.clone()));
                written = true;
            }
            TransportEvent::Rpc(SessionObservation::Completed {
                id: observed,
                outcome,
                ..
            }) => {
                assert_eq!(observed, id);
                assert_eq!(outcome.unwrap()["params"]["text"], text);
                replied = true;
            }
            TransportEvent::Lifecycle(event) => assert_ne!(event["type"], "terminal"),
            _ => panic!("unexpected event"),
        }
    }
    transport.stop().unwrap();
    loop {
        if let TransportEvent::Lifecycle(event) =
            transport.receive(Duration::from_secs(10)).unwrap()
            && event["type"] == "terminal"
        {
            assert_eq!(event["cleanupProven"], true);
            break;
        }
    }
}

#[test]
#[ignore = "subprocess entry for caller SIGKILL test"]
fn external_owner_process() {
    let Some(root) = std::env::var_os("RUDDER_EXTERNAL_OWNER_FIXTURE") else {
        return;
    };
    let root = Path::new(&root);
    let mut transport = launch(root, "exec /bin/sleep 30");
    let pid = spawned(&mut transport);
    std::fs::write(root.join("provider.pid"), pid.to_string()).unwrap();
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[test]
#[ignore = "requires built Rust process host; kills only its own test caller"]
fn caller_sigkill_still_reaps_external_hosts_provider() {
    let root = tempfile::tempdir().unwrap();
    let mut caller = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "external_owner_process",
            "--ignored",
            "--nocapture",
        ])
        .env("RUDDER_EXTERNAL_OWNER_FIXTURE", root.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let pid_path = root.path().join("provider.pid");
    while !pid_path.exists() && Instant::now() < deadline {
        assert!(
            caller.try_wait().unwrap().is_none(),
            "caller exited before launch"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    if !pid_path.exists() {
        let _ = caller.kill();
        let _ = caller.wait();
        panic!("provider not launched");
    }
    let pid: u32 = std::fs::read_to_string(pid_path).unwrap().parse().unwrap();
    caller.kill().unwrap(); // SIGKILL of this exact unreaped Child, not a recovered PID.
    caller.wait().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let alive = Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        if !alive {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "provider survived its Rust caller death"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}
