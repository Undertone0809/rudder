#![cfg(unix)]

//! Synthetic process-host workflow for the Pi adapter. The provider process is
//! a task-owned Node fixture, while launch, stdin ownership, RPC framing,
//! SessionTree reading, settlement and cleanup all use the real Rust boundary.

use rudder_native_chat_executor::{PiExecution, PiExecutionPhase, PiUnknownReason};
use rudder_pi_rpc::{ConnectionLaunchPermit, PiProfileMode, ProcessLaunch};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

const FAKE_PI: &str = r#"
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const lazy = process.env.RUDDER_TEST_PI_LAZY === '1';
const suppressFlush = process.env.RUDDER_TEST_PI_SUPPRESS_FLUSH === '1';
const sessionFile = path.join(sessionDir, lazy ? 'timestamp_synthetic-session.jsonl' : 'synthetic-session.jsonl');
const cwd = process.cwd();
let active = false;
let nextTurn = 0;

function header() {
  return JSON.stringify({type:'session',version:3,id:'synthetic-session',cwd});
}
function ensureSession() {
  fs.mkdirSync(sessionDir, {recursive:true});
  if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, header() + '\n');
}
function entries() {
  if (!fs.existsSync(sessionFile)) return [];
  return fs.readFileSync(sessionFile, 'utf8').trim().split('\n').filter(Boolean).slice(1);
}
function state() {
  return {sessionId:'synthetic-session',sessionFile,isStreaming:active,isCompacting:false,
    steeringMode:'one-at-a-time',followUpMode:'one-at-a-time',pendingMessageCount:0,
    messageCount:entries().length};
}
function send(request, success, data) {
  process.stdout.write(JSON.stringify({type:'response',id:request.id,command:request.type,success,data}) + '\n');
}
function appendTurn(text) {
  ensureSession();
  const parent = nextTurn === 0 ? null : (nextTurn === 1 ? '22222222' : '44444444');
  const input = nextTurn === 0 ? '11111111' : '33333333';
  const assistant = nextTurn === 0 ? '22222222' : '44444444';
  const lines = [
    {type:'message',id:input,parentId:parent,message:{role:'user',content:text}},
    {type:'message',id:assistant,parentId:input,message:{role:'assistant',content:[{type:'text',text:'synthetic answer'}],stopReason:'stop'}},
  ];
  fs.appendFileSync(sessionFile, lines.map(JSON.stringify).join('\n') + '\n');
  nextTurn += 1;
}
const rl = readline.createInterface({input:process.stdin,crlfDelay:Infinity});
rl.on('line', raw => {
  const request = JSON.parse(raw);
  if (!lazy) ensureSession();
  if (request.type === 'get_state') return send(request, true, state());
  if (request.type === 'new_session' || request.type === 'switch_session') return send(request, true, state());
  if (request.type === 'prompt') {
    active = true;
    send(request, true, {});
    process.stdout.write(JSON.stringify({type:'agent_start'}) + '\n');
    if (!suppressFlush) appendTurn(request.message);
    active = false;
    process.stdout.write(JSON.stringify({type:'agent_end'}) + '\n');
    process.stdout.write(JSON.stringify({type:'agent_settled'}) + '\n');
    return;
  }
  if (request.type === 'abort') return send(request, true, {});
  send(request, false, null);
});
"#;

#[test]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST and RUDDER_TEST_NODE_EXECUTABLE"]
fn synthetic_pi_execution_runs_state_input_settled_receipt_and_cleanup() {
    synthetic_pi_execution(false, false);
}

#[test]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST and RUDDER_TEST_NODE_EXECUTABLE"]
fn synthetic_pi_new_session_waits_for_native_flush_before_terminal_receipt() {
    synthetic_pi_execution(true, false);
}

#[test]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST and RUDDER_TEST_NODE_EXECUTABLE"]
fn synthetic_pi_terminal_without_native_file_cannot_mint_a_turn_receipt() {
    synthetic_pi_execution(true, true);
}

fn synthetic_pi_execution(lazy: bool, missing_terminal_file: bool) {
    let process_host = required_path("RUDDER_TEST_PROCESS_HOST");
    let node = required_path("RUDDER_TEST_NODE_EXECUTABLE");
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let agent_dir = home.join(".pi/agent");
    let sessions = home.join(".pi/paperclips");
    let cwd = root.path().join("workspace");
    fs::create_dir_all(&agent_dir).unwrap();
    fs::create_dir_all(&sessions).unwrap();
    fs::create_dir_all(&cwd).unwrap();
    let script = root.path().join("fake-pi.js");
    fs::write(&script, FAKE_PI).unwrap();
    let mut permissions = fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&script, permissions).unwrap();

    let mut execution = PiExecution::launch(
        ProcessLaunch {
            node_executable: node,
            pi_cli_entry: script,
            process_host,
            runtime_root: root.path().to_path_buf(),
            isolated_home: home,
            session_dir: sessions,
            profile_mode: PiProfileMode::Managed,
            resume_session_file: None,
            system_prompt_file: None,
            cwd,
            provider: "synthetic".into(),
            model: "synthetic-model".into(),
            thinking: None,
            run_id: "pi-adapter-run".into(),
            attempt_id: "pi-adapter-attempt".into(),
            owner_token: "pi-adapter-owner".into(),
            env: {
                let mut env = BTreeMap::new();
                if lazy {
                    env.insert("RUDDER_TEST_PI_LAZY".into(), "1".into());
                }
                if missing_terminal_file {
                    env.insert("RUDDER_TEST_PI_SUPPRESS_FLUSH".into(), "1".into());
                }
                env
            },
        },
        ConnectionLaunchPermit::from_claim(
            "pi-adapter-run".into(),
            "pi-adapter-attempt".into(),
            "pi-adapter-owner".into(),
            1,
            "pi-adapter-claim".into(),
        ),
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(execution.phase(), PiExecutionPhase::Spawned);
    assert_eq!(
        if lazy {
            execution.new_session(Duration::from_secs(5)).unwrap()
        } else {
            execution.get_state(Duration::from_secs(5)).unwrap()
        },
        PiExecutionPhase::SessionReady
    );
    let session_file = execution.state().unwrap().session_file().to_owned();
    if lazy {
        assert!(!execution.state().unwrap().session_file_persisted());
        assert!(!session_file.exists());
        assert!(
            execution
                .resume_session(&session_file, Duration::from_secs(5))
                .is_err()
        );
    } else {
        assert_eq!(
            execution
                .resume_session(&session_file, Duration::from_secs(5))
                .unwrap(),
            PiExecutionPhase::SessionReady
        );
    }
    assert_eq!(
        execution
            .submit_input("hello", Duration::from_secs(5))
            .unwrap(),
        PiExecutionPhase::InputAccepted
    );
    assert_eq!(
        execution
            .wait_until_settled(Duration::from_secs(5))
            .unwrap(),
        if missing_terminal_file {
            PiExecutionPhase::Unknown
        } else {
            PiExecutionPhase::Settled
        }
    );
    if missing_terminal_file {
        assert!(execution.take_turn_receipt(None, "hello").is_err());
        assert!(!session_file.exists());
    } else {
        execution.take_turn_receipt(None, "hello").unwrap();
        assert!(execution.state().unwrap().session_file_persisted());
    }
    assert_eq!(
        execution.cleanup(Duration::from_secs(5)).unwrap(),
        PiExecutionPhase::Cleaned
    );
    let observation = execution.into_observation();
    assert_eq!(observation.phase, PiExecutionPhase::Cleaned);
    assert_eq!(observation.turn_receipt.is_some(), !missing_terminal_file);
    assert!(observation.cleanup_receipt.is_some());
    assert_eq!(
        observation.unknown_reason,
        missing_terminal_file.then_some(PiUnknownReason::SessionPathUnavailable)
    );
}

#[test]
fn unknown_phase_is_not_terminal() {
    assert!(PiExecutionPhase::Unknown.is_unknown());
    assert!(!PiExecutionPhase::Unknown.is_provider_terminal());
    assert_eq!(
        PiUnknownReason::AgentEndedWithoutSettlement,
        PiUnknownReason::AgentEndedWithoutSettlement
    );
}

fn required_path(name: &str) -> PathBuf {
    let path = std::env::var_os(name).unwrap_or_else(|| panic!("missing {name}"));
    let path = Path::new(&path).to_path_buf();
    assert!(path.is_absolute(), "{name} must be absolute");
    path
}
