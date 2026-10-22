#![cfg(unix)]

//! Optional installed Pi process smoke. It opens RPC state only and never
//! submits a prompt, invokes a model, or reads the operator's profile.
use rudder_pi_rpc::{
    ConnectionLaunchPermit, PiCommand, PiProfileMode, PiRpcMessage, PiRpcTransport, ProcessLaunch,
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[test]
#[ignore = "requires explicit installed Pi and Rust process host; no prompt/model calls"]
fn installed_pi_get_state_uses_owned_host_and_proves_cleanup() {
    installed_pi_get_state(false);
}

#[test]
#[ignore = "requires explicit installed Pi and Rust process host; synthetic operator layout, no prompt/model calls"]
fn installed_pi_operator_layout_keeps_sessions_outside_profile_and_proves_cleanup() {
    installed_pi_get_state(true);
}

fn installed_pi_get_state(operator_layout: bool) {
    let node = required_path("RUDDER_TEST_NODE_EXECUTABLE");
    let cli = required_path("RUDDER_TEST_PI_CLI_ENTRY");
    let host = required_path("RUDDER_TEST_PROCESS_HOST");
    let version = std::env::var("RUDDER_TEST_PI_VERSION").expect("installed Pi version");
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let agent_dir = home.join(".pi/agent");
    let sessions = if operator_layout {
        root.path().join("owned-sessions")
    } else {
        home.join(".pi/paperclips")
    };
    let cwd = root.path().join("workspace");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    let instruction_file = operator_layout.then(|| {
        let path = cwd.join("AGENTS.md");
        std::fs::write(&path, "Use the explicit test instructions.\n").unwrap();
        path
    });

    let mut transport = PiRpcTransport::launch(
        ProcessLaunch {
            node_executable: node,
            pi_cli_entry: cli,
            process_host: host,
            runtime_root: root.path().to_path_buf(),
            isolated_home: home,
            session_dir: sessions.clone(),
            profile_mode: if operator_layout {
                PiProfileMode::OperatorNative {
                    session_root: sessions,
                    instruction_file: instruction_file.clone(),
                }
            } else {
                PiProfileMode::Managed
            },
            resume_session_file: None,
            system_prompt_file: instruction_file,
            cwd,
            provider: "openai".into(),
            model: "gpt-5.5".into(),
            thinking: Some("medium".into()),
            run_id: "pi-rpc-smoke-run".into(),
            attempt_id: "pi-rpc-smoke-attempt".into(),
            owner_token: "pi-rpc-smoke-owner".into(),
            env: BTreeMap::new(),
        },
        ConnectionLaunchPermit::from_claim(
            "pi-rpc-smoke-run".into(),
            "pi-rpc-smoke-attempt".into(),
            "pi-rpc-smoke-owner".into(),
            1,
            format!("pi-rpc-smoke-claim-{version}"),
        ),
    )
    .unwrap();
    transport.wait_spawned(Duration::from_secs(30)).unwrap();
    let request_id = transport.request(PiCommand::GetState).unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut got_state = false;
    while Instant::now() < deadline && !got_state {
        match transport
            .receive(deadline.saturating_duration_since(Instant::now()))
            .unwrap()
        {
            PiRpcMessage::Event(_) => {}
            PiRpcMessage::Response(response) => {
                assert_eq!(response.id(), request_id);
                assert_eq!(response.command(), "get_state");
                assert!(response.success());
                assert!(response.data().is_some_and(serde_json::Value::is_object));
                got_state = true;
            }
        }
    }
    assert!(got_state, "Pi did not answer get_state");

    transport
        .stop_with_grace(Duration::from_secs(1), Duration::from_secs(15))
        .expect("owned host must stop Pi and observe the terminal receipt");
    let proof = transport
        .take_cleanup_proof()
        .expect("terminal host event must mint the owned cleanup proof");
    assert!(proof.matches_execution(
        "pi-rpc-smoke-run",
        "pi-rpc-smoke-attempt",
        "pi-rpc-smoke-owner"
    ));
    transport.close();
}

fn required_path(name: &str) -> PathBuf {
    let value = std::env::var_os(name).unwrap_or_else(|| panic!("missing {name}"));
    let path = Path::new(&value).to_path_buf();
    assert!(path.is_absolute(), "{name} must be absolute");
    path
}
