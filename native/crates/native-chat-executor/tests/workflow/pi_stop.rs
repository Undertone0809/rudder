use crate::fixture::*;
use rudder_auth_core::VerifiedActor;
use rudder_d1_persistence::native_chat::{
    control::{StopOutcome, StopRequest, request_stop as control_request_stop},
    execution,
};
use rudder_native_chat_executor::NativeExecutionObservation;
use rudder_pi_rpc::PiTurnStatus;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tempfile::TempDir;

const PI_FIXTURE: &str = r#"
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const sessionFile = path.join(sessionDir, 'timestamp_pi-stop-session.jsonl');
const requestsFile = path.join(sessionDir, 'fixture-requests.txt');
const pendingFile = path.join(sessionDir, 'fixture-pending.txt');
const releaseFile = path.join(sessionDir, 'fixture-release.txt');
const blockNewSession = __BLOCK_NEW_SESSION__;
const sessionId = 'pi-stop-session';
let active = false;
let pendingInput = null;

function log(type) { fs.appendFileSync(requestsFile, type + '\n'); }
function header() {
  return JSON.stringify({type:'session',version:3,id:sessionId,cwd:process.cwd()});
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
  return {sessionId,sessionFile,isStreaming:active,isCompacting:false,
    pendingMessageCount:0,messageCount:entries().length};
}
function response(request, success, data) {
  process.stdout.write(JSON.stringify({type:'response',id:request.id,
    command:request.type,success,data}) + '\n');
}
function appendInterruptedTurn(input) {
  ensureSession();
  const user = {type:'message',id:'aaaa0001',parentId:null,
    message:{role:'user',content:input}};
  const assistant = {type:'message',id:'bbbb0002',parentId:user.id,
    message:{role:'assistant',content:[],stopReason:'aborted'}};
  fs.appendFileSync(sessionFile, JSON.stringify(user) + '\n' +
    JSON.stringify(assistant) + '\n');
}

const rl = readline.createInterface({input:process.stdin,crlfDelay:Infinity});
rl.on('line', raw => {
  const request = JSON.parse(raw);
  log(request.type);
  if (request.type === 'new_session') {
    if (blockNewSession) {
      fs.writeFileSync(pendingFile, 'starting');
      while (!fs.existsSync(releaseFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    }
    ensureSession();
    response(request, true, state());
    return;
  }
  if (request.type === 'get_state') {
    response(request, true, state());
    return;
  }
  if (request.type === 'prompt') {
    active = true;
    pendingInput = request.message;
    response(request, true, {});
    process.stdout.write(JSON.stringify({type:'agent_start'}) + '\n');
    fs.writeFileSync(pendingFile, 'prompt');
    return;
  }
  if (request.type === 'abort') {
    if (!active || typeof pendingInput !== 'string') {
      response(request, false, null);
      return;
    }
    response(request, true, {});
    fs.writeFileSync(path.join(sessionDir, 'fixture-abort-ack.txt'), 'ack');
    const terminalTimer = setInterval(() => {
      if (!fs.existsSync(releaseFile)) return;
      clearInterval(terminalTimer);
      appendInterruptedTurn(pendingInput);
      active = false;
      process.stdout.write(JSON.stringify({type:'agent_end'}) + '\n');
      process.stdout.write(JSON.stringify({type:'agent_settled'}) + '\n');
    }, 10);
    return;
  }
  response(request, false, null);
});
"#;

struct PiFixture {
    _profiles: TempDir,
    _entry_dir: TempDir,
    session_dir: PathBuf,
}

async fn database_and_pi_admission(
    block_new_session: bool,
) -> (
    Database,
    FixtureHost,
    VerifiedActor,
    String,
    String,
    PiFixture,
) {
    database_and_pi_admission_with_node(
        block_new_session,
        required_path("RUDDER_TEST_NODE_EXECUTABLE"),
    )
    .await
}

async fn database_and_pi_admission_with_node(
    block_new_session: bool,
    node: PathBuf,
) -> (
    Database,
    FixtureHost,
    VerifiedActor,
    String,
    String,
    PiFixture,
) {
    let database = Database::start().await;
    let mut host = FixtureHost::new("pi-stop");
    let profiles = tempfile::tempdir().expect("create isolated Pi managed profile root");
    let entry_dir = tempfile::tempdir().expect("create isolated Pi CLI fixture");
    let profile_home = profiles.path().join(ORG).join(CEO).join("default");
    let agent_dir = profile_home.join(".pi/agent");
    let session_dir = profile_home.join(".pi/paperclips");
    fs::create_dir_all(&agent_dir).expect("create Pi profile agent directory");
    fs::create_dir_all(&session_dir).expect("create Pi profile session directory");
    let entry = entry_dir.path().join("fake-pi.js");
    fs::write(
        &entry,
        PI_FIXTURE.replace(
            "__BLOCK_NEW_SESSION__",
            if block_new_session { "true" } else { "false" },
        ),
    )
    .expect("write synthetic Pi RPC provider");
    host.enable_pi_runtime(node, entry, profiles.path().to_path_buf());
    let config = json!({
        "profileId":"default",
        "model":"synthetic/native-stop-model",
    });
    let (actor, run, attempt) = admitted_with_runtime(&database, &host, "pi_local", config).await;
    (
        database,
        host,
        actor,
        run,
        attempt,
        PiFixture {
            _profiles: profiles,
            _entry_dir: entry_dir,
            session_dir,
        },
    )
}

fn required_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("set {name}")))
        .canonicalize()
        .unwrap_or_else(|_| panic!("{name} must be an existing absolute path"))
}

fn request_for_stop(control_action_id: &str, generation: String, version: i32) -> StopRequest {
    StopRequest {
        conversation_id: CHAT.into(),
        generation_id: generation,
        control_action_id: control_action_id.into(),
        expected_attempt_epoch: 1,
        expected_control_version: version,
        requested_render_seq: 0,
        requested_body_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            .into(),
    }
}

async fn wait_for_file(path: &Path) {
    for _ in 0..500 {
        if path.is_file() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "Pi fixture did not reach the expected RPC boundary: {}",
        path.display()
    );
}

async fn wait_phase(pool: &sqlx::PgPool, attempt: &str, phase: &str) -> bool {
    for _ in 0..500 {
        let actual: Option<String> = sqlx::query_scalar(
            "SELECT protocol_phase FROM heartbeat_run_attempts WHERE id=$1::uuid",
        )
        .bind(attempt)
        .fetch_one(pool)
        .await
        .unwrap();
        if actual.as_deref() == Some(phase) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

async fn request_stop_for_run(
    database: &Database,
    actor: &VerifiedActor,
    run: &str,
    control_action_id: &str,
) -> rudder_d1_persistence::native_chat::control::StopReceipt {
    let (generation, version): (String, i32) = sqlx::query_as(
        "SELECT g.id::text,g.control_version FROM chat_generations g
         JOIN heartbeat_runs r ON r.chat_generation_id=g.id WHERE r.id=$1::uuid",
    )
    .bind(run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    control_request_stop(
        &database.pool,
        actor,
        &request_for_stop(control_action_id, generation, version),
    )
    .await
    .unwrap()
}

async fn assert_cancelled_without_hold(database: &Database, run: &str) {
    let (status, generation, hold): (String, String, bool) = sqlx::query_as(
        "SELECT r.status,g.status,r.native_admission_hold FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.id=$1::uuid",
    )
    .bind(run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        (status.as_str(), generation.as_str(), hold),
        ("cancelled", "stopped", false)
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST and RUDDER_TEST_NODE_EXECUTABLE; disposable PostgreSQL and synthetic Pi RPC provider"]
async fn pi_stop_sends_one_abort_and_finalizes_only_the_exact_interrupted_tree() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run, attempt, fixture) = database_and_pi_admission(false).await;
    let pending = fixture.session_dir.join("fixture-pending.txt");
    let requests = fixture.session_dir.join("fixture-requests.txt");
    let handle =
        spawn_native_executor_worker(&database, host, actor.clone(), run.clone(), attempt.clone());
    if !wait_phase(&database.pool, &attempt, "input_indeterminate").await {
        let (result, _) = handle.await.unwrap();
        panic!("Pi did not reach input phase: {:?}", result.err());
    }
    wait_for_file(&pending).await;
    let stop = request_stop_for_run(
        &database,
        &actor,
        &run,
        "72000000-0000-4000-8000-000000000021",
    )
    .await;
    assert_eq!(stop.outcome, StopOutcome::StopIntentRecorded);
    wait_for_file(&fixture.session_dir.join("fixture-abort-ack.txt")).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(
        !handle.is_finished(),
        "Pi Abort ACK must not be a terminal observation"
    );
    let still_held: (String, bool) = sqlx::query_as("SELECT status,native_admission_hold FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG).bind(&run).fetch_one(&database.pool).await.unwrap();
    assert_eq!(still_held, ("running".into(), true));
    fs::write(fixture.session_dir.join("fixture-release.txt"), "release")
        .expect("release the exact terminal Pi tree after ACK-only assertion");

    let (result, _host) = handle.await.unwrap();
    let NativeExecutionObservation::Pi(observed) = result.expect("exact Pi stop observation")
    else {
        panic!("Pi runtime returned a different native observation");
    };
    let turn = observed
        .observation
        .turn_receipt
        .as_ref()
        .expect("Stop requires the exact terminal Pi tree");
    assert_eq!(turn.status(), PiTurnStatus::Interrupted);
    let stop = observed.stop.as_ref().expect("durable Stop was observed");
    let cleanup = observed
        .observation
        .cleanup_receipt
        .as_ref()
        .expect("owned process cleanup was proven");
    assert!(cleanup.proves_quiescence_for(turn));

    let request_types = fs::read_to_string(&requests).expect("read synthetic RPC request types");
    assert_eq!(
        request_types
            .lines()
            .filter(|line| *line == "prompt")
            .count(),
        1
    );
    assert_eq!(
        request_types
            .lines()
            .filter(|line| *line == "abort")
            .count(),
        1
    );

    execution::finalize_pi_stopped(&database.pool, &actor, &observed.fence, turn, cleanup, stop)
        .await
        .expect("finalize the exact interrupted Pi turn");
    assert_cancelled_without_hold(&database, &run).await;
    let assistant_rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND run_id=$2::uuid AND role='assistant'",
    )
    .bind(ORG)
    .bind(&run)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(
        assistant_rows, 0,
        "an empty interrupted turn must not fabricate output"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST and RUDDER_TEST_NODE_EXECUTABLE; disposable PostgreSQL and synthetic Pi RPC provider"]
async fn pi_stop_before_prompt_uses_no_submission_finalizer() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run, attempt, fixture) = database_and_pi_admission(true).await;
    let pending = fixture.session_dir.join("fixture-pending.txt");
    let release = fixture.session_dir.join("fixture-release.txt");
    let requests = fixture.session_dir.join("fixture-requests.txt");
    let handle =
        spawn_native_executor_worker(&database, host, actor.clone(), run.clone(), attempt.clone());
    if !wait_phase(&database.pool, &attempt, "thread_start_indeterminate").await {
        let (result, _) = handle.await.unwrap();
        panic!("Pi did not reach session phase: {:?}", result.err());
    }
    wait_for_file(&pending).await;
    let stop = request_stop_for_run(
        &database,
        &actor,
        &run,
        "72000000-0000-4000-8000-000000000022",
    )
    .await;
    assert_eq!(stop.outcome, StopOutcome::StopIntentRecorded);
    fs::write(&release, "release").expect("release the pre-input session RPC");

    let (result, _host) = handle.await.unwrap();
    let NativeExecutionObservation::Pi(observed) = result.expect("pre-input Pi Stop observation")
    else {
        panic!("Pi runtime returned a different native observation");
    };
    assert!(observed.stop.is_some());
    assert!(observed.observation.turn_receipt.is_none());
    let cleanup = observed
        .observation
        .cleanup_receipt
        .as_ref()
        .expect("owned process cleanup was proven");
    let stop = observed.stop.as_ref().expect("durable Stop was observed");
    let request_types = fs::read_to_string(&requests).expect("read synthetic RPC request types");
    assert_eq!(
        request_types
            .lines()
            .filter(|line| *line == "prompt")
            .count(),
        0
    );
    assert_eq!(
        request_types
            .lines()
            .filter(|line| *line == "abort")
            .count(),
        0
    );

    execution::finalize_pi_stopped_before_submission(
        &database.pool,
        &actor,
        &observed.fence,
        cleanup,
        stop,
    )
    .await
    .expect("finalize Stop only after proving no prompt was sent");
    assert_cancelled_without_hold(&database, &run).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; disposable PostgreSQL and a synthetic Pi process-host launch failure"]
async fn pi_process_host_preflight_failure_retains_cleanup_for_a_fenced_preinput_stop() {
    assert_ignored_external_dependencies();
    let unlaunchable = tempfile::tempdir().expect("create disposable unlaunchable Node fixture");
    let node = unlaunchable.path().join("node-not-executable");
    fs::write(&node, "#!/bin/sh\nexit 0\n").expect("write Node fixture file");
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&node, fs::Permissions::from_mode(0o600))
        .expect("keep Node fixture non-executable");

    let (database, host, actor, run, attempt, fixture) =
        database_and_pi_admission_with_node(false, node).await;
    let (result, _host) =
        execute_native_on_worker(&database, host, actor.clone(), run.clone(), attempt).await;
    let failure = match result {
        Err(failure) => failure,
        Ok(_) => panic!("the owned process host should report the spawn failure"),
    };
    assert_eq!(failure.diagnostic_code(), "pi_process_host_failure");
    assert_eq!(
        failure.process_disposition(),
        rudder_native_chat_executor::ProcessDisposition::CleanupProven
    );
    assert!(failure.pi_cleanup_receipt().is_some());
    assert!(!failure.is_definitive_failure());

    let requests = fixture.session_dir.join("fixture-requests.txt");
    assert!(
        !requests.exists(),
        "provider process must not receive any RPC request after launch preflight fails"
    );

    let stop = request_stop_for_run(
        &database,
        &actor,
        &run,
        "72000000-0000-4000-8000-000000000023",
    )
    .await;
    assert_eq!(stop.outcome, StopOutcome::StopIntentRecorded);
    let execution_actor = failure
        .execution_principal()
        .expect("post-claim failure retains its execution principal");
    let fence = failure
        .fence()
        .expect("post-claim failure retains its execution fence");
    let stop = execution::observe_stop(&database.pool, execution_actor, fence)
        .await
        .unwrap()
        .expect("read the durable Stop on this exact claim");
    execution::finalize_pi_stopped_before_submission(
        &database.pool,
        execution_actor,
        fence,
        failure
            .pi_cleanup_receipt()
            .expect("matching owned-host cleanup receipt survives launch failure"),
        &stop,
    )
    .await
    .expect("pre-submission Stop uses the exact process-host cleanup receipt");
    assert_cancelled_without_hold(&database, &run).await;
}
