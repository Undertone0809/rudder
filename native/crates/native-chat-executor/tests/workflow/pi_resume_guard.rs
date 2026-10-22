use crate::fixture::*;
use rudder_auth_core::VerifiedActor;
use rudder_d1_persistence::native_chat::execution;
use rudder_native_chat_executor::NativeExecutionObservation;
use rudder_pi_rpc::PiTurnStatus;
use serde_json::{Value, json};
use std::{fs, io::Write, path::PathBuf};
use tempfile::TempDir;

const PI_FIXTURE: &str = r#"
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const sessionId = 'pi-resume-guard-session';
const defaultSessionFile = path.join(sessionDir, 'timestamp_pi-resume-guard-session.jsonl');
const requestsFile = path.join(sessionDir, 'fixture-requests.txt');
let activeSessionFile = defaultSessionFile;

function log(type) { fs.appendFileSync(requestsFile, type + '\n'); }
function header() {
  return JSON.stringify({type:'session',version:3,id:sessionId,cwd:process.cwd()});
}
function ensureSession(file) {
  fs.mkdirSync(sessionDir, {recursive:true});
  if (!fs.existsSync(file)) fs.writeFileSync(file, header() + '\n');
}
function entries(file = activeSessionFile) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(1).map(JSON.parse);
}
function state() {
  return {sessionId,sessionFile:activeSessionFile,isStreaming:false,isCompacting:false,
    pendingMessageCount:0,messageCount:entries().length};
}
function response(request, success, data) {
  process.stdout.write(JSON.stringify({type:'response',id:request.id,
    command:request.type,success,data}) + '\n');
}
function appendPrompt(input) {
  ensureSession(activeSessionFile);
  const previous = entries();
  const parentId = previous.length ? previous[previous.length - 1].id : null;
  const suffix = String(previous.length + 1).padStart(8, '0');
  const user = {type:'message',id:suffix,parentId,
    message:{role:'user',content:input}};
  const assistant = {type:'message',id:String(previous.length + 2).padStart(8, '0'),parentId:user.id,
    message:{role:'assistant',content:[{type:'text',text:'synthetic answer'}],stopReason:'stop'}};
  fs.appendFileSync(activeSessionFile, JSON.stringify(user) + '\n' + JSON.stringify(assistant) + '\n');
}

const rl = readline.createInterface({input:process.stdin,crlfDelay:Infinity});
rl.on('line', raw => {
  const request = JSON.parse(raw);
  log(request.type);
  if (request.type === 'new_session') {
    activeSessionFile = defaultSessionFile;
    ensureSession(activeSessionFile);
    response(request, true, state());
  } else if (request.type === 'switch_session') {
    activeSessionFile = request.sessionPath;
    response(request, true, {});
  } else if (request.type === 'get_state') {
    response(request, true, state());
  } else if (request.type === 'prompt') {
    appendPrompt(request.message);
    response(request, true, {});
    process.stdout.write(JSON.stringify({type:'agent_start'}) + '\n');
    process.stdout.write(JSON.stringify({type:'agent_end'}) + '\n');
    process.stdout.write(JSON.stringify({type:'agent_settled'}) + '\n');
  } else {
    response(request, false, null);
  }
});
"#;

struct PiFixture {
    _profiles: TempDir,
    _entry_dir: TempDir,
    session_file: PathBuf,
    requests_file: PathBuf,
}

async fn setup_pi_admission() -> (
    Database,
    FixtureHost,
    VerifiedActor,
    String,
    String,
    PiFixture,
) {
    let database = Database::start().await;
    let mut host = FixtureHost::new("pi-resume-guard");
    let profiles = tempfile::tempdir().expect("create isolated Pi managed profile root");
    let entry_dir = tempfile::tempdir().expect("create isolated Pi CLI fixture");
    let profile_home = profiles.path().join(ORG).join(CEO).join("default");
    let agent_dir = profile_home.join(".pi/agent");
    let session_dir = profile_home.join(".pi/paperclips");
    fs::create_dir_all(&agent_dir).expect("create Pi profile agent directory");
    fs::create_dir_all(&session_dir).expect("create Pi profile session directory");
    let entry = entry_dir.path().join("fake-pi.js");
    fs::write(&entry, PI_FIXTURE).expect("write synthetic Pi RPC provider");
    let node = PathBuf::from(
        std::env::var_os("RUDDER_TEST_NODE_EXECUTABLE")
            .expect("set RUDDER_TEST_NODE_EXECUTABLE to an installed Node runtime"),
    )
    .canonicalize()
    .expect("canonical installed Node runtime");
    host.enable_pi_runtime(node, entry, profiles.path().to_path_buf());
    let (actor, run, attempt) = admitted_with_runtime(
        &database,
        &host,
        "pi_local",
        json!({"profileId":"default","model":"synthetic/resume-guard-model"}),
    )
    .await;
    (
        database,
        host,
        actor,
        run,
        attempt,
        PiFixture {
            _profiles: profiles,
            _entry_dir: entry_dir,
            session_file: session_dir.join("timestamp_pi-resume-guard-session.jsonl"),
            requests_file: session_dir.join("fixture-requests.txt"),
        },
    )
}

async fn admit_continuation(
    database: &Database,
    host: &FixtureHost,
    actor: &VerifiedActor,
    previous_run: &str,
    session_id: &str,
    mutation_id: &str,
) -> (String, String) {
    let context_snapshot: Value = sqlx::query_scalar(
        "SELECT context_snapshot FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(previous_run)
    .fetch_one(&database.pool)
    .await
    .expect("read earlier Run binding association");
    let binding_id = context_snapshot["runtimeBindingId"]
        .as_str()
        .expect("RuntimeBinding id")
        .to_owned();
    let segment_id = context_snapshot["nativeSegmentId"]
        .as_str()
        .expect("NativeSegment id")
        .to_owned();

    // Reopen the exact Segment for a second admitted Run, matching the
    // production continuation fixture while retaining the Pi-native locator.
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin earlier-Run fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:admission', true)")
        .execute(&mut *tx)
        .await
        .expect("authorize fixture updates");
    sqlx::query(
        "UPDATE heartbeat_runs SET status='failed', finished_at=clock_timestamp(),
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(previous_run)
    .execute(&mut *tx)
    .await
    .expect("finish the earlier Run fixture");
    sqlx::query(
        "UPDATE chat_generations SET status='failed', completed_at=clock_timestamp(),
             updated_at=clock_timestamp()
         WHERE org_id=$1::uuid AND conversation_id=$2::uuid",
    )
    .bind(ORG)
    .bind(CHAT)
    .execute(&mut *tx)
    .await
    .expect("finish the earlier Generation fixture");
    sqlx::query(
        "UPDATE native_segments SET state='open', native_session_id=$1,
             updated_at=clock_timestamp()
         WHERE org_id=$2::uuid AND binding_id=$3::uuid AND id=$4::uuid",
    )
    .bind(session_id)
    .bind(ORG)
    .bind(&binding_id)
    .bind(&segment_id)
    .execute(&mut *tx)
    .await
    .expect("persist the exact open Pi session locator");
    tx.commit().await.expect("commit earlier-Run fixture");

    let request: AdmissionRequest = serde_json::from_value(json!({
        "operation":"submit_native_chat_turn",
        "conversationId": CHAT,
        "clientMutationId": mutation_id,
        "body":"Continue from the trusted Pi leaf: 雪🧭",
    }))
    .expect("typed exact-session continuation request");
    let receipt = admit(&database.pool, actor, ORG, &request, host.context())
        .await
        .expect("admit a turn against the existing Pi session");
    (
        receipt["runId"].as_str().expect("Run id").to_owned(),
        receipt["attemptId"]
            .as_str()
            .expect("Attempt id")
            .to_owned(),
    )
}

async fn execute_and_finalize_first_turn(
    database: &Database,
    host: FixtureHost,
    actor: VerifiedActor,
    run: String,
    attempt: String,
) -> (FixtureHost, String) {
    let (result, host) =
        execute_native_on_worker(database, host, actor.clone(), run, attempt).await;
    let NativeExecutionObservation::Pi(observed) = result.expect("synthetic Pi turn observation")
    else {
        panic!("Pi runtime returned a different native observation");
    };
    let turn = observed
        .observation
        .turn_receipt
        .as_ref()
        .expect("first Pi prompt has an exact terminal receipt");
    assert_eq!(turn.status(), PiTurnStatus::Completed);
    let session_id = turn.session_id().to_owned();
    execution::finalize_pi(
        &database.pool,
        &actor,
        &observed.fence,
        turn,
        observed
            .observation
            .cleanup_receipt
            .as_ref()
            .expect("first Pi process cleanup is proven"),
    )
    .await
    .expect("finalize the first exact Pi turn");
    (host, session_id)
}

fn append_metadata(file: &PathBuf) {
    fs::OpenOptions::new()
        .append(true)
        .open(file)
        .expect("open Pi session for metadata fixture")
        .write_all(
            concat!(
                r#"{"type":"model_change","id":"00000003","parentId":"00000002","provider":"synthetic","modelId":"model"}"#,
                "\n",
                r#"{"type":"thinking_level_change","id":"00000004","parentId":"00000003","thinkingLevel":"medium"}"#,
                "\n"
            )
            .as_bytes(),
        )
        .expect("append setup metadata records");
}

fn append_diverged_user(file: &PathBuf) {
    fs::OpenOptions::new()
        .append(true)
        .open(file)
        .expect("open Pi session for divergent-branch fixture")
        .write_all(
            concat!(
                r#"{"type":"message","id":"00000003","parentId":"00000002","message":{"role":"user","content":"uncheckpointed local input"}}"#,
                "\n"
            )
            .as_bytes(),
        )
        .expect("append divergent user branch");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST and RUDDER_TEST_NODE_EXECUTABLE; disposable PostgreSQL and synthetic Pi RPC provider only"]
async fn pi_resume_rejects_a_diverged_leaf_before_prompt_and_accepts_setup_metadata() {
    assert_ignored_external_dependencies();

    for allow_metadata in [false, true] {
        let (database, host, actor, run, attempt, fixture) = setup_pi_admission().await;
        let (host, session_id) =
            execute_and_finalize_first_turn(&database, host, actor.clone(), run.clone(), attempt)
                .await;
        if allow_metadata {
            append_metadata(&fixture.session_file);
        } else {
            append_diverged_user(&fixture.session_file);
        }

        let (resumed_run, resumed_attempt) = admit_continuation(
            &database,
            &host,
            &actor,
            &run,
            &session_id,
            if allow_metadata {
                "pi-resume-setup-metadata"
            } else {
                "pi-resume-diverged-leaf"
            },
        )
        .await;
        let (result, _host) = execute_native_on_worker(
            &database,
            host,
            actor.clone(),
            resumed_run.clone(),
            resumed_attempt.clone(),
        )
        .await;
        let request_types = fs::read_to_string(&fixture.requests_file)
            .expect("read synthetic Pi RPC command types");
        let prompt_count = request_types
            .lines()
            .filter(|line| *line == "prompt")
            .count();

        if allow_metadata {
            let NativeExecutionObservation::Pi(observed) = result.expect("metadata-only resume")
            else {
                panic!("Pi runtime returned a different native observation");
            };
            assert_eq!(prompt_count, 2);
            assert_eq!(
                request_types
                    .lines()
                    .filter(|line| *line == "switch_session")
                    .count(),
                1
            );
            let turn = observed
                .observation
                .turn_receipt
                .as_ref()
                .expect("metadata-only resume has an exact terminal receipt");
            assert_eq!(turn.status(), PiTurnStatus::Completed);
            assert_eq!(turn.prior_leaf_id(), Some("00000002"));
            assert_eq!(turn.input_entry_id(), "00000005");
            execution::finalize_pi(
                &database.pool,
                &actor,
                &observed.fence,
                turn,
                observed
                    .observation
                    .cleanup_receipt
                    .as_ref()
                    .expect("resumed Pi process cleanup is proven"),
            )
            .await
            .expect("finalize metadata-only resumed Pi turn");
        } else {
            let failure = match result {
                Err(failure) => failure,
                Ok(_) => panic!("diverged native leaf must be rejected before prompt"),
            };
            assert_eq!(failure.diagnostic_code(), "invalid_provider_observation");
            assert!(failure.process_quiescent());
            assert!(failure.pi_cleanup_receipt().is_some());
            assert_eq!(
                prompt_count, 1,
                "no prompt may follow a diverged active leaf"
            );
            assert_eq!(
                request_types
                    .lines()
                    .filter(|line| *line == "switch_session")
                    .count(),
                0,
                "reject the persisted branch before Pi loads it"
            );
            let phase: String = sqlx::query_scalar(
                "SELECT protocol_phase FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND run_id=$2::uuid AND id=$3::uuid",
            )
            .bind(ORG)
            .bind(&resumed_run)
            .bind(&resumed_attempt)
            .fetch_one(&database.pool)
            .await
            .expect("read resumed checkpoint after pre-dispatch rejection");
            assert_eq!(phase, "thread_known");
        }
    }
}
