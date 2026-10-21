#![cfg(unix)]

//! Installed Pi state-only check: a real new session is not persisted until
//! its first assistant message. This test never sends a prompt or loads auth.
use rudder_native_chat_executor::{PiExecution, PiExecutionPhase};
use rudder_pi_rpc::{ConnectionLaunchPermit, PiProfileMode, ProcessLaunch};
use std::{collections::BTreeMap, path::PathBuf, time::Duration};

#[test]
#[ignore = "requires explicit installed Pi, Node and Rust host; no model calls"]
fn installed_pi_new_session_reports_native_unflushed_identity_and_proves_cleanup() {
    let required = |name| PathBuf::from(std::env::var_os(name).expect(name));
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let home = root.join("home");
    let sessions = home.join("sessions");
    let cwd = root.join("workspace");
    for directory in [&home.join(".pi/agent"), &sessions, &cwd] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let mut execution = PiExecution::launch(
        ProcessLaunch {
            node_executable: required("RUDDER_TEST_NODE_EXECUTABLE"),
            pi_cli_entry: required("RUDDER_TEST_PI_CLI_ENTRY"),
            process_host: required("RUDDER_TEST_PROCESS_HOST"),
            runtime_root: root,
            isolated_home: home,
            session_dir: sessions.clone(),
            profile_mode: PiProfileMode::Managed,
            resume_session_file: None,
            system_prompt_file: None,
            cwd,
            provider: "openai".into(),
            model: "gpt-5.6-luna".into(),
            thinking: None,
            run_id: "installed-pi-new-session".into(),
            attempt_id: "installed-pi-new-session-attempt".into(),
            owner_token: "installed-pi-new-session-owner".into(),
            env: BTreeMap::new(),
        },
        ConnectionLaunchPermit::from_claim(
            "installed-pi-new-session".into(),
            "installed-pi-new-session-attempt".into(),
            "installed-pi-new-session-owner".into(),
            1,
            "installed-pi-new-session-claim".into(),
        ),
        Duration::from_secs(30),
    )
    .unwrap();
    assert_eq!(
        execution.new_session(Duration::from_secs(15)).unwrap(),
        PiExecutionPhase::SessionReady
    );
    let state = execution.state().unwrap();
    assert!(!state.session_id().is_empty());
    assert_eq!(state.session_file().parent(), Some(sessions.as_path()));
    assert!(!state.session_file_persisted());
    assert!(!state.session_file().exists());
    let session_file = state.session_file().to_path_buf();
    assert!(
        execution
            .resume_session(&session_file, Duration::from_secs(5))
            .is_err()
    );
    assert_eq!(
        execution.cleanup(Duration::from_secs(5)).unwrap(),
        PiExecutionPhase::Cleaned
    );
    let observation = execution.into_observation();
    assert!(observation.cleanup_receipt.is_some());
    assert!(observation.turn_receipt.is_none());
}
