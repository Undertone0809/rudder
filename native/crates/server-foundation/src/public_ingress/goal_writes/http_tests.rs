#![cfg(unix)]

use super::*;
use crate::native_chat_test_fixture as fixture;
use crate::native_chat_test_fixture::support::{GOAL, OTHER};
use actix_web::{App, HttpServer, web};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

const IDENTITY_KEY: &str = "goal-preview-http-identity-assertion-key-0001";
const JWT_SECRET: &str = "goal-preview-http-agent-jwt-secret";
const BROWSER_SESSION_SECRET: &str = "goal-start-http-browser-session-secret-0001";
const ALLOWED_ORIGIN: &str = "http://goal-start-http.invalid";
const SAMPLE_OWNER: &str = "55555555-5555-4555-8555-555555555555";
const FOREIGN_OWNER: &str = "55555555-5555-4555-8555-555555555556";
const CLAUDE_MODEL: &str = "vendor/goal-start-http-fixture";

struct RunningIngress {
    base: String,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

async fn start_ingress(
    database: &fixture::Database,
    node_upstream: &str,
    identity_auth: bool,
) -> RunningIngress {
    start_ingress_with_runtime(database, node_upstream, identity_auth, None).await
}

async fn start_ingress_with_runtime(
    database: &fixture::Database,
    node_upstream: &str,
    identity_auth: bool,
    native_runtime: Option<crate::NativeChatPublicRuntime>,
) -> RunningIngress {
    let database_url = format!(
        "postgresql://postgres@127.0.0.1:{}/postgres",
        database.pool.connect_options().get_port()
    );
    let foundation = Arc::new(
        crate::AppState::new(crate::ServerConfig {
            database_url: Some(database_url),
            actor_envelope_key: Some(
                rudder_auth_core::SigningKey::new(b"goal-preview-http-envelope-key").unwrap(),
            ),
            workers: 1,
            ..crate::ServerConfig::default()
        })
        .unwrap(),
    );
    let mut config = crate::PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        node_upstream,
        "goal-preview-http-forwarding-key",
    )
    .unwrap();
    if identity_auth {
        config.identity_auth = Some(
            crate::public_ingress_config::NativeIdentityAuthConfig::new(
                IDENTITY_KEY,
                JWT_SECRET,
                "rudder-test",
                "rudder-api",
                false,
            )
            .unwrap(),
        );
    }
    if let Some(native_runtime) = native_runtime {
        let browser_auth = crate::browser_auth::BrowserAuthConfig::required(
            BROWSER_SESSION_SECRET.as_bytes(),
            false,
            crate::browser_auth::SessionPolicy::BetterAuth,
        )
        .unwrap();
        let mutation_policy =
            crate::browser_auth::BrowserMutationPolicy::new(&[ALLOWED_ORIGIN.to_owned()]).unwrap();
        config = config
            .with_browser_auth(browser_auth)
            .unwrap()
            .with_native_chat_mutation_policy(mutation_policy);
        config = config.with_native_chat_runtime(native_runtime);
    }
    let runtime = PublicIngressRuntime::bind(config, foundation).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    RunningIngress {
        base,
        task: actix_web::rt::spawn(runtime.run()),
    }
}

async fn start_ingress_without_database(
    node_upstream: &str,
    native_runtime: crate::NativeChatPublicRuntime,
) -> RunningIngress {
    let foundation = Arc::new(
        crate::AppState::new(crate::ServerConfig {
            actor_envelope_key: Some(
                rudder_auth_core::SigningKey::new(b"goal-start-http-envelope-key").unwrap(),
            ),
            workers: 1,
            ..crate::ServerConfig::default()
        })
        .unwrap(),
    );
    let mut config = crate::PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        node_upstream,
        "goal-start-http-forwarding-key-0001",
    )
    .unwrap();
    config.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            IDENTITY_KEY,
            JWT_SECRET,
            "rudder-test",
            "rudder-api",
            true,
        )
        .unwrap(),
    );
    let browser_auth = crate::browser_auth::BrowserAuthConfig::required(
        BROWSER_SESSION_SECRET.as_bytes(),
        false,
        crate::browser_auth::SessionPolicy::BetterAuth,
    )
    .unwrap();
    let mutation_policy =
        crate::browser_auth::BrowserMutationPolicy::new(&[ALLOWED_ORIGIN.to_owned()]).unwrap();
    config = config
        .with_browser_auth(browser_auth)
        .unwrap()
        .with_native_chat_mutation_policy(mutation_policy)
        .with_native_chat_runtime(native_runtime);
    let runtime = PublicIngressRuntime::bind(config, foundation).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    RunningIngress {
        base,
        task: actix_web::rt::spawn(runtime.run()),
    }
}

fn python_executable() -> std::path::PathBuf {
    let output = Command::new("python3")
        .args(["-c", "import sys; print(sys.executable)"])
        .output()
        .expect("locate Python for the synthetic Claude fixture");
    assert!(output.status.success(), "python3 must be available");
    std::path::PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
        .canonicalize()
        .expect("canonical Python interpreter")
}

fn install_goal_start_claude(host: &mut fixture::FixtureHost) {
    let executable = host.probe_path("bin/claude-fixture");
    let profiles = host.probe_path("claude-profiles");
    fs::create_dir_all(profiles.join(".claude")).expect("create isolated Claude profile");
    let root = serde_json::to_string(&host.probe_path(".").to_string_lossy())
        .expect("encode fixture root for Python");
    let source = format!(
        r#"import json, pathlib, select, sys, time
root = pathlib.Path({root})
ready = root / "goal-claude-input-pending"
ack = root / "goal-claude-interrupt-acknowledged"
success = root / "release-goal-claude-success"
success_seen = root / "goal-claude-success-seen"
success_emitted = root / "goal-claude-success-emitted"
events = root / "goal-claude-events.jsonl"
release = root / "release-goal-claude-terminal"
session = sys.argv[sys.argv.index("--session-id") + 1]

def emit(value):
    line = json.dumps(value, separators=(",", ":"))
    sys.stdout.write(line + "\n")
    sys.stdout.flush()
    with events.open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")

emit({{"type":"system","subtype":"init","session_id":session,"model":"fixture"}})
raw = sys.stdin.readline()
if not raw or json.loads(raw).get("type") != "user":
    raise SystemExit(21)
ready.write_text("ready", encoding="utf-8")
deadline = time.monotonic() + 20
interrupt = None
while time.monotonic() < deadline:
    if success.exists():
        success_seen.write_text("seen", encoding="utf-8")
        emit({{"type":"result","subtype":"success","is_error":False,"result":"Synthetic Goal work completed.","session_id":session,"uuid":"655b28ae-cd7d-41cf-be0e-5208bfa02066","usage":{{"input_tokens":12,"output_tokens":4}}}})
        success_emitted.write_text("emitted", encoding="utf-8")
        raise SystemExit(0)
    readable, _, _ = select.select([sys.stdin], [], [], 0.05)
    if readable:
        raw = sys.stdin.readline()
        if not raw:
            raise SystemExit(22)
        request = json.loads(raw)
        if request.get("type") == "control_request" and request.get("request") == {{"subtype":"interrupt"}}:
            interrupt = request
            break
        if request.get("type") != "user":
            raise SystemExit(23)
if interrupt is None:
    raise SystemExit(24)
request_id = interrupt.get("request_id")
if not isinstance(request_id, str) or not request_id:
    raise SystemExit(25)
emit({{"type":"control_response","response":{{"subtype":"success","request_id":request_id,"response":{{"still_queued":[]}}}}}})
ack.write_text("ack", encoding="utf-8")
deadline = time.monotonic() + 20
while not release.exists() and time.monotonic() < deadline:
    time.sleep(0.02)
emit({{"type":"result","subtype":"error_during_execution","is_error":True,"session_id":session,"uuid":"655b28ae-cd7d-41cf-be0e-5208bfa02066"}})
"#,
    );
    let script = format!("#!{}\n{}", python_executable().display(), source);
    fs::create_dir_all(executable.parent().expect("Claude fixture parent"))
        .expect("create Claude fixture directory");
    fs::write(&executable, script).expect("write synthetic Claude stream-json provider");
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
        .expect("make synthetic Claude executable");
    host.enable_claude_runtime(executable.clone(), profiles.clone());
}

async fn wait_for_path(path: &Path) -> bool {
    for _ in 0..1000 {
        if path.exists() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

async fn wait_for_goal_wakeup_status(
    database: &fixture::Database,
    wakeup_id: &str,
    status: &str,
    error: Option<&str>,
) -> Value {
    let mut last = Value::Null;
    for _ in 0..2500 {
        let row: Option<Value> = sqlx::query_scalar(
            "SELECT jsonb_build_object('status',status,'error',error,'runId',run_id::text,
               'authority',execution_authority,'claimedAt',claimed_at IS NOT NULL,
               'finishedAt',finished_at IS NOT NULL)
             FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(fixture::ORG)
        .bind(wakeup_id)
        .fetch_optional(&database.pool)
        .await
        .unwrap();
        if let Some(row) = row {
            if row["status"] == status && row["error"].as_str() == error {
                return row;
            }
            last = row;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("Goal wakeup did not reach {status}/{error:?}: {last}");
}

fn assert_process_pid_exited(pid: i64) {
    assert!(pid > 1, "process PID must be a positive owned child: {pid}");
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    assert_eq!(result, -1, "owned provider process {pid} is still present");
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH),
        "process existence probe must fail only because the owned child exited"
    );
}

async fn wait_for_goal_run_terminal(
    database: &fixture::Database,
    run_id: &str,
    provider_events: &Path,
) -> Value {
    for _ in 0..2500 {
        let row: Option<Value> = sqlx::query_scalar(
            "SELECT jsonb_build_object('status',status,'errorCode',error_code,'error',error,
                    'result',result_json,'usage',usage_json,'processPid',process_pid,
                    'exitCode',exit_code,'signal',signal,
                    'processExited',process_exited_at IS NOT NULL,
                    'terminalEffectsPending',terminal_effects_pending)
             FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(fixture::ORG)
        .bind(run_id)
        .fetch_optional(&database.pool)
        .await
        .unwrap();
        if let Some(snapshot) = row
            && snapshot["processExited"] == true
            && snapshot["terminalEffectsPending"] == false
        {
            return snapshot;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let diagnostic: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('status',status,'errorCode',error_code,'error',error,
           'result',result_json,'usage',usage_json,'processExited',process_exited_at IS NOT NULL,
           'processPid',process_pid,'exitCode',exit_code,'signal',signal,
           'terminalEffectsPending',terminal_effects_pending)
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    panic!(
        "native Goal Run did not finish process cleanup and terminal effects: {run_id}: {diagnostic}; provider events: {}",
        fs::read_to_string(provider_events).unwrap_or_else(|error| format!("unavailable: {error}"))
    );
}

async fn seed_goal_start_owner(database: &fixture::Database) {
    sqlx::query(
        "INSERT INTO agents(id,org_id,name,role,status,capabilities,workspace_key,agent_runtime_type,agent_runtime_config)
         VALUES($1::uuid,$2::uuid,'HTTP Goal owner','engineer','idle',
                'Plan and execute end-to-end software releases with verifiable evidence.',
                'codex-agent','claude_local',$3::jsonb)",
    )
    .bind(SAMPLE_OWNER)
    .bind(fixture::ORG)
    .bind(json!({
        "profileId":"default",
        "command":"claude",
        "model":CLAUDE_MODEL,
        "instructionsBundleMode":"managed"
    }))
    .execute(&database.pool)
    .await
    .unwrap();
}

fn public_goal_start_body(request_key: &str) -> Value {
    let preview: Value = serde_json::from_str(include_str!(
        "../../../../d1-persistence/tests/fixtures/goal-start-preview-typescript.json"
    ))
    .unwrap();
    json!({
        "requestKey": request_key,
        "packetHash": preview["packetHash"],
        "packet": preview["packet"],
        "allowCapabilityMismatch": true
    })
}

async fn start_node_sentinel() -> (
    String,
    Arc<AtomicUsize>,
    Arc<Mutex<Vec<(String, Vec<u8>)>>>,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let hits = Arc::new(AtomicUsize::new(0));
    let requests = Arc::new(Mutex::new(Vec::<(String, Vec<u8>)>::new()));
    let server = HttpServer::new({
        let hits = hits.clone();
        let requests = requests.clone();
        move || {
            let hits = hits.clone();
            let requests = requests.clone();
            App::new().default_service(web::to(
                move |request: actix_web::HttpRequest, body: web::Bytes| {
                    let hits = hits.clone();
                    let requests = requests.clone();
                    async move {
                        hits.fetch_add(1, Ordering::SeqCst);
                        requests
                            .lock()
                            .unwrap()
                            .push((request.uri().to_string(), body.to_vec()));
                        HttpResponse::Ok().json(json!({"proxied":true}))
                    }
                },
            ))
        }
    })
    .bind(("127.0.0.1", 0))
    .unwrap();
    let address = server.addrs()[0];
    (
        format!("http://{address}"),
        hits,
        requests,
        actix_web::rt::spawn(server.run()),
    )
}

async fn board_key(database: &fixture::Database, organization_id: &str, revoked: bool) -> String {
    let user_id = format!("goal-preview-board-{}", uuid::Uuid::new_v4());
    let token = format!("pcp_board_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at)
         VALUES($1,'Goal preview Board fixture',$2,now(),now())",
    )
    .bind(&user_id)
    .bind(format!("{user_id}@goal-preview.invalid"))
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status)
         VALUES($1::uuid,'user',$2,'member','active')",
    )
    .bind(organization_id)
    .bind(&user_id)
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO board_api_keys(user_id,name,key_hash,revoked_at)
         VALUES($1,'Goal preview HTTP fixture',$2,CASE WHEN $3 THEN clock_timestamp() ELSE NULL END)",
    )
    .bind(&user_id)
    .bind(crate::native_bearer_auth::hash_token(&token))
    .bind(revoked)
    .execute(&database.pool)
    .await
    .unwrap();
    token
}

async fn agent_key(database: &fixture::Database) -> String {
    let token = format!("pcp_agent_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO agent_api_keys(agent_id,org_id,name,key_hash)
         VALUES($1::uuid,$2::uuid,'Goal preview HTTP fixture',$3)",
    )
    .bind(fixture::CEO)
    .bind(fixture::ORG)
    .bind(crate::native_bearer_auth::hash_token(&token))
    .execute(&database.pool)
    .await
    .unwrap();
    token
}

async fn post(base: &str, path: &str, token: Option<&str>, body: Value) -> (StatusCode, Value) {
    let client = awc::Client::default();
    let mut request = client
        .post(format!("{base}{path}"))
        .insert_header((header::CONTENT_TYPE, "application/json"));
    if let Some(token) = token {
        request = request.insert_header((header::AUTHORIZATION, format!("Bearer {token}")));
    }
    let mut response = request
        .send_body(serde_json::to_vec(&body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = response.body().await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

fn preview_body(owner_agent_id: Value, context: Value, target_time: Value) -> Value {
    json!({
        "title":"Publish a verified Goal Workspace release candidate",
        "context":context,
        "ownerAgentId":owner_agent_id,
        "targetTime":target_time
    })
}

async fn seed_preview_owners(database: &fixture::Database) {
    sqlx::query(
        "INSERT INTO agents(id,org_id,name,role,status,capabilities)
         VALUES($1::uuid,$2::uuid,'Goal preview owner','engineer','idle','Goal Workspace release')",
    )
    .bind(SAMPLE_OWNER)
    .bind(fixture::ORG)
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO agents(id,org_id,name,role,status,capabilities)
         VALUES($1::uuid,$2::uuid,'Foreign Goal preview owner','engineer','idle','Goal Workspace release')",
    )
    .bind(FOREIGN_OWNER)
    .bind(OTHER)
    .execute(&database.pool)
    .await
    .unwrap();
}

async fn preview_side_effect_snapshot(database: &fixture::Database) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'goals',(SELECT count(*) FROM goals),
           'goalStartRequests',(SELECT count(*) FROM goal_start_requests),
           'agentWakeupRequests',(SELECT count(*) FROM agent_wakeup_requests),
           'heartbeatRuns',(SELECT count(*) FROM heartbeat_runs),
           'activityLog',(SELECT count(*) FROM activity_log),
           'agentStatuses',(SELECT COALESCE(jsonb_object_agg(id::text,status ORDER BY id),'{}'::jsonb) FROM agents)
         )",
    )
    .fetch_one(&database.pool)
    .await
    .unwrap()
}

#[actix_web::test]
async fn public_goal_start_preview_is_board_scoped_strict_and_never_falls_back_to_node() {
    let database = fixture::Database::start().await;
    seed_preview_owners(&database).await;
    let board = board_key(&database, fixture::ORG, false).await;
    let foreign_board = board_key(&database, OTHER, false).await;
    let revoked_board = board_key(&database, fixture::ORG, true).await;
    let agent = agent_key(&database).await;
    let (node_url, node_hits, node_requests, node_task) = start_node_sentinel().await;
    let ingress = start_ingress(&database, &node_url, true).await;
    let side_effects_before = preview_side_effect_snapshot(&database).await;
    let path = format!("/API/ORGS/{}/GOALS/START-PREVIEW/", fixture::ORG);
    let input = preview_body(
        json!(SAMPLE_OWNER),
        json!("Keep the result inspectable."),
        json!("2026-08-20T10:00:00.000Z"),
    );
    let expected: Value = serde_json::from_str(include_str!(
        "../../../../d1-persistence/tests/fixtures/goal-start-preview-typescript.json"
    ))
    .unwrap();

    let (status, response) = post(&ingress.base, &path, Some(&board), input.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response, expected);

    let (status, response) = post(
        &ingress.base,
        &path,
        Some(&board),
        preview_body(Value::Null, Value::Null, Value::Null),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["valid"], false);
    assert_eq!(response["blockers"][0]["code"], "owner_required");

    let (status, response) = post(
        &ingress.base,
        &path,
        Some(&board),
        preview_body(
            json!(FOREIGN_OWNER),
            json!("Keep the result inspectable."),
            json!(null),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["valid"], false);
    assert_eq!(response["blockers"][0]["code"], "owner_required");

    let mut malformed = vec![
        json!({"title":"A result", "ownerAgentId":null, "context":null, "targetTime":null, "extra":true}),
        json!({"title":"A result", "ownerAgentId":null, "context":null}),
        json!({"title":"   ", "ownerAgentId":null, "context":null, "targetTime":null}),
        json!({"title":"A result", "ownerAgentId":null, "context":7, "targetTime":null}),
        json!({"title":"A result", "ownerAgentId":"not-a-uuid", "context":null, "targetTime":null}),
        json!({"title":"A result", "ownerAgentId":null, "context":null, "targetTime":{}}),
    ];
    for body in malformed.drain(..) {
        let (status, response) = post(&ingress.base, &path, Some(&board), body).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        assert_eq!(response["error"], "Validation error");
    }

    let (status, response) = post(&ingress.base, &path, Some(&foreign_board), input.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        response["error"],
        "User does not have access to this organization"
    );
    let (status, _) = post(&ingress.base, &path, Some(&revoked_board), input.clone()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, response) = post(&ingress.base, &path, Some(&agent), input).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(response["error"], "Board access required");
    assert_eq!(node_hits.load(Ordering::SeqCst), 0);
    assert!(node_requests.lock().unwrap().is_empty());
    assert_eq!(
        preview_side_effect_snapshot(&database).await,
        side_effects_before,
        "preview requests must not create Goals, start requests, wakeups, runs, activity, or activate Agents"
    );

    ingress.task.abort();
    node_task.abort();
}

#[actix_web::test]
async fn public_goal_start_preview_fails_closed_when_native_identity_is_unavailable() {
    let database = fixture::Database::start().await;
    let (node_url, node_hits, _node_requests, node_task) = start_node_sentinel().await;
    let ingress = start_ingress(&database, &node_url, false).await;
    let input = preview_body(Value::Null, Value::Null, Value::Null);
    let (status, response) = post(
        &ingress.base,
        &format!("/api/orgs/{}/goals/start-preview", fixture::ORG),
        None,
        input,
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response["reason"], "native_identity_unavailable");
    assert_eq!(node_hits.load(Ordering::SeqCst), 0);
    ingress.task.abort();
    node_task.abort();
}

#[actix_web::test]
async fn public_goal_start_preserves_legacy_forwarding_when_native_identity_is_unavailable() {
    let database = fixture::Database::start().await;
    let (node_url, node_hits, node_requests, node_task) = start_node_sentinel().await;
    let ingress = start_ingress(&database, &node_url, false).await;
    let body = public_goal_start_body("identity-unavailable-legacy-start");
    let expected_body = serde_json::to_vec(&body).unwrap();
    let path = format!("/api/orgs/{}/goals/start", fixture::ORG);
    let (status, response) = post(&ingress.base, &path, None, body).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["proxied"], true);
    assert_eq!(node_hits.load(Ordering::SeqCst), 1);
    let requests = node_requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, path);
    assert_eq!(requests[0].1, expected_body);
    ingress.task.abort();
    node_task.abort();
}

#[actix_web::test]
async fn public_goal_start_stays_native_and_fails_closed_when_database_is_disabled() {
    let mut host = fixture::FixtureHost::new("public-goal-start-database-disabled");
    install_goal_start_claude(&mut host);
    // This request must fail before any provider dispatch, so the test binary
    // is a safe placeholder and the all-targets suite needs no process-host
    // executable merely to exercise database-disabled routing.
    let paths = host.paths_with_process_host(std::env::current_exe().unwrap());
    let context = host.take_context();
    let native_runtime =
        crate::NativeChatPublicRuntime::new(context, paths, Duration::from_secs(30)).unwrap();
    let (node_url, node_hits, node_requests, node_task) = start_node_sentinel().await;
    let ingress = start_ingress_without_database(&node_url, native_runtime).await;
    let body = public_goal_start_body("database-disabled-native-start");
    let path = format!("/api/orgs/{}/goals/start", fixture::ORG);

    let (status, response) = post(&ingress.base, &path, None, body).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response["reason"], "database_disabled");
    assert_eq!(node_hits.load(Ordering::SeqCst), 0);
    assert!(node_requests.lock().unwrap().is_empty());

    ingress.task.abort();
    node_task.abort();
}

#[actix_web::test]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST and PostgreSQL binaries; disposable database and synthetic Claude CLI"]
async fn public_goal_start_owns_native_wakeup_run_cancel_cleanup_and_replay() {
    fixture::assert_ignored_external_dependencies();
    let database = fixture::Database::start().await;
    seed_goal_start_owner(&database).await;

    let mut host = fixture::FixtureHost::new("public-goal-start");
    install_goal_start_claude(&mut host);
    let paths = host.paths();
    let context = host.take_context();
    let native_runtime =
        crate::NativeChatPublicRuntime::new(context, paths, Duration::from_secs(30)).unwrap();

    let board = board_key(&database, fixture::ORG, false).await;
    let foreign_board = board_key(&database, OTHER, false).await;
    let revoked_board = board_key(&database, fixture::ORG, true).await;
    let agent = agent_key(&database).await;
    let (node_url, node_hits, node_requests, node_task) = start_node_sentinel().await;
    let ingress =
        start_ingress_with_runtime(&database, &node_url, true, Some(native_runtime)).await;
    let request_key = "public-goal-start-native-http";
    let body = public_goal_start_body(request_key);
    let path = format!("/api/orgs/{}/goals/start", fixture::ORG);

    let side_effects_before_auth = preview_side_effect_snapshot(&database).await;
    let auth_body = public_goal_start_body("public-goal-start-auth-denied");
    let (status, _) = post(&ingress.base, &path, None, auth_body.clone()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = post(&ingress.base, &path, Some("pcp_unknown"), auth_body.clone()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, response) = post(
        &ingress.base,
        &path,
        Some(&foreign_board),
        auth_body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        response["error"],
        "User does not have access to this organization"
    );
    let (status, _) = post(
        &ingress.base,
        &path,
        Some(&revoked_board),
        auth_body.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, response) = post(&ingress.base, &path, Some(&agent), auth_body).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(response["error"], "Board access required");
    assert_eq!(node_hits.load(Ordering::SeqCst), 0);
    assert_eq!(
        preview_side_effect_snapshot(&database).await,
        side_effects_before_auth,
        "unauthorized Goal Starts must not create or activate anything"
    );

    let invalid_native_body = public_goal_start_body("public-goal-start-invalid-packet");
    let mut invalid_native_body = invalid_native_body;
    invalid_native_body["packetHash"] = json!("0".repeat(64));
    let before_invalid_native = preview_side_effect_snapshot(&database).await;
    let (status, response) = post(&ingress.base, &path, Some(&board), invalid_native_body).await;
    assert_eq!(status, StatusCode::CONFLICT, "{response}");
    assert_eq!(node_hits.load(Ordering::SeqCst), 0);
    assert_eq!(
        preview_side_effect_snapshot(&database).await,
        before_invalid_native,
        "a native packet validation failure must not fall back to Node or write partial state"
    );

    let unsupported_body = public_goal_start_body("public-goal-start-unsupported-provider");
    let unsupported_bytes = serde_json::to_vec(&unsupported_body).unwrap();
    let before_unsupported = preview_side_effect_snapshot(&database).await;
    sqlx::query(
        "UPDATE agents SET agent_runtime_type='codex_local'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(SAMPLE_OWNER)
    .execute(&database.pool)
    .await
    .unwrap();
    let (status, response) = post(&ingress.base, &path, Some(&board), unsupported_body).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["proxied"], true);
    assert_eq!(node_hits.load(Ordering::SeqCst), 1);
    assert_eq!(
        preview_side_effect_snapshot(&database).await,
        before_unsupported,
        "unsupported provider Start stays wholly legacy-owned"
    );
    {
        let requests = node_requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, path);
        assert_eq!(requests[0].1, unsupported_bytes);
    }
    sqlx::query(
        "UPDATE agents SET agent_runtime_type='claude_local'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(SAMPLE_OWNER)
    .execute(&database.pool)
    .await
    .unwrap();

    let legacy_replay_key = "public-goal-start-legacy-replay";
    let legacy_replay_body = public_goal_start_body(legacy_replay_key);
    let legacy_replay_bytes = serde_json::to_vec(&legacy_replay_body).unwrap();
    let legacy_request_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO goal_start_requests
           (id,org_id,request_key,packet_hash,packet,status,goal_id,completed_at)
         VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb,'completed',$6::uuid,statement_timestamp())",
    )
    .bind(&legacy_request_id)
    .bind(fixture::ORG)
    .bind(legacy_replay_key)
    .bind(legacy_replay_body["packetHash"].as_str().unwrap())
    .bind(legacy_replay_body["packet"].to_string())
    .bind(GOAL)
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE goals SET owner_agent_id=$2::uuid WHERE org_id=$1::uuid AND id=$3::uuid")
        .bind(fixture::ORG)
        .bind(SAMPLE_OWNER)
        .bind(GOAL)
        .execute(&database.pool)
        .await
        .unwrap();
    let legacy_wakeup_id: String = sqlx::query_scalar(
        "INSERT INTO agent_wakeup_requests
           (org_id,agent_id,source,trigger_detail,reason,payload,status,idempotency_key,execution_authority)
         VALUES($1::uuid,$2::uuid,'on_demand','system','goal_started',$3::jsonb,'queued',$4,'legacy_ts')
         RETURNING id::text",
    )
    .bind(fixture::ORG)
    .bind(SAMPLE_OWNER)
    .bind(json!({"event":"goal_started","goalId":GOAL}).to_string())
    .bind(format!("goal-start:{legacy_request_id}"))
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let before_legacy_replay = preview_side_effect_snapshot(&database).await;
    let (status, response) = post(&ingress.base, &path, Some(&board), legacy_replay_body).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["proxied"], true);
    assert_eq!(node_hits.load(Ordering::SeqCst), 2);
    assert_eq!(
        preview_side_effect_snapshot(&database).await,
        before_legacy_replay,
        "Rust must not retag or duplicate a legacy Goal Start replay"
    );
    let retained_legacy_authority: String = sqlx::query_scalar(
        "SELECT execution_authority FROM agent_wakeup_requests
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(&legacy_wakeup_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(retained_legacy_authority, "legacy_ts");
    {
        let requests = node_requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1].0, path);
        assert_eq!(requests[1].1, legacy_replay_bytes);
    }

    sqlx::query(
        "UPDATE agents SET runtime_config=jsonb_build_object('heartbeat',jsonb_build_object('wakeOnDemand',false))
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(SAMPLE_OWNER)
    .execute(&database.pool)
    .await
    .unwrap();

    let (status, started) = post(&ingress.base, &path, Some(&board), body.clone()).await;
    assert_eq!(status, StatusCode::CREATED, "{started}");
    assert_eq!(started["lifecycle"], "active");
    assert_eq!(started["ownerAgentId"], SAMPLE_OWNER);
    let goal_id = started["id"].as_str().expect("public Goal ID").to_owned();

    // The replay stands in for a lost first response: it returns the same
    // Goal while preserving one request, wakeup, activity and outbox event.
    let (status, replay) = post(&ingress.base, &path, Some(&board), body).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["id"], goal_id);
    let request_id: String = sqlx::query_scalar(
        "SELECT id::text FROM goal_start_requests WHERE org_id=$1::uuid AND request_key=$2",
    )
    .bind(fixture::ORG)
    .bind(request_key)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let (request_count, wakeup_count, started_activity_count, outbox_count): (i64, i64, i64, i64) =
        sqlx::query_as(
            "SELECT
               (SELECT count(*) FROM goal_start_requests WHERE org_id=$1::uuid AND request_key=$2),
               (SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid AND idempotency_key=$4),
               (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND action='goal.started' AND entity_id=$5 AND idempotency_key=$3),
               (SELECT count(*) FROM organization_mutation_outbox o JOIN activity_log a ON a.org_id=o.org_id AND a.id=o.activity_id WHERE a.org_id=$1::uuid AND a.action='goal.started' AND a.entity_id=$5 AND a.idempotency_key=$3)",
        )
        .bind(fixture::ORG)
        .bind(request_key)
        .bind(format!("goal-start:{request_key}"))
        .bind(format!("goal-start:{request_id}"))
        .bind(&goal_id)
        .fetch_one(&database.pool)
        .await
        .unwrap();
    assert_eq!(
        (
            request_count,
            wakeup_count,
            started_activity_count,
            outbox_count
        ),
        (1, 1, 1, 1)
    );
    let (wakeup_id, authority): (String, String) = sqlx::query_as(
        "SELECT id::text,execution_authority FROM agent_wakeup_requests
         WHERE org_id=$1::uuid AND idempotency_key=$2",
    )
    .bind(fixture::ORG)
    .bind(format!("goal-start:{request_id}"))
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(authority, "native_rust");
    let deferred_by_policy = wait_for_goal_wakeup_status(
        &database,
        &wakeup_id,
        "deferred_goal_blocked",
        Some("heartbeat.wakeOnDemand.disabled"),
    )
    .await;
    assert!(
        deferred_by_policy["runId"].is_null(),
        "{deferred_by_policy}"
    );
    assert_eq!(deferred_by_policy["authority"], "native_rust");
    sqlx::query(
        "UPDATE agents SET runtime_config=jsonb_build_object(
           'heartbeat',jsonb_build_object('wakeOnDemand',true))
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(SAMPLE_OWNER)
    .execute(&database.pool)
    .await
    .unwrap();

    let input_pending = host.probe_path("goal-claude-input-pending");
    let interrupt_ack = host.probe_path("goal-claude-interrupt-acknowledged");
    let release_success = host.probe_path("release-goal-claude-success");
    let success_seen = host.probe_path("goal-claude-success-seen");
    let success_emitted = host.probe_path("goal-claude-success-emitted");
    let release_terminal = host.probe_path("release-goal-claude-terminal");
    let provider_started = wait_for_path(&input_pending).await;
    let dispatch_diagnostic: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'wakeup',(SELECT jsonb_build_object('status',status,'error',error,
             'runId',run_id,'authority',execution_authority)
             FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid),
           'run',(SELECT jsonb_build_object('status',status,'errorCode',error_code,
             'error',error,'result',result_json) FROM heartbeat_runs
             WHERE org_id=$1::uuid AND wakeup_request_id=$2::uuid),
           'eligibleBudgetPolicies',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'scopeType',scope_type,'scopeId',scope_id,'hardStop',hard_stop_enabled,
             'amount',amount,'active',is_active)),'[]'::jsonb)
             FROM budget_policies WHERE org_id=$1::uuid),
           'goal',(SELECT jsonb_build_object('status',status,'lifecycle',lifecycle,
             'ownerAgentId',owner_agent_id) FROM goals WHERE org_id=$1::uuid AND id=$3::uuid))",
    )
    .bind(fixture::ORG)
    .bind(&wakeup_id)
    .bind(&goal_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert!(
        provider_started,
        "native Goal worker did not start synthetic Claude: {dispatch_diagnostic}"
    );
    let run_id: String = sqlx::query_scalar(
        "SELECT run_id::text FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(&wakeup_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    fs::write(&release_success, "complete").expect("release synthetic successful result");
    assert!(
        wait_for_path(&success_seen).await,
        "synthetic Claude fixture did not observe the success gate"
    );
    assert!(
        wait_for_path(&success_emitted).await,
        "synthetic Claude fixture did not write the terminal result: {}",
        fs::read_to_string(host.probe_path("goal-claude-events.jsonl"))
            .unwrap_or_else(|error| format!("event log unavailable: {error}"))
    );
    let succeeded = wait_for_goal_run_terminal(
        &database,
        &run_id,
        &host.probe_path("goal-claude-events.jsonl"),
    )
    .await;
    assert_eq!(succeeded["status"], "succeeded", "{succeeded}");
    let session_storage: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'runSessionIdAfter',r.session_id_after,
           'runSessionParamsAfter',r.session_params_after_json,
           'resultHasSessionId',r.result_json ? 'sessionId',
           'attemptSessionDisplayId',a.session_display_id,
           'attemptSessionParams',a.session_params_json)
         FROM heartbeat_runs r
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert!(
        session_storage["runSessionIdAfter"].is_null(),
        "{session_storage}"
    );
    assert!(
        session_storage["runSessionParamsAfter"].is_null(),
        "{session_storage}"
    );
    assert_eq!(
        session_storage["resultHasSessionId"], false,
        "{session_storage}"
    );
    let private_session_id = session_storage["attemptSessionDisplayId"]
        .as_str()
        .expect("private Attempt keeps the provider session display ID");
    assert!(!private_session_id.is_empty(), "{session_storage}");
    assert_eq!(
        session_storage["attemptSessionParams"]["sessionId"], private_session_id,
        "{session_storage}"
    );
    assert!(
        session_storage["attemptSessionParams"]["cwd"].is_string(),
        "{session_storage}"
    );
    let success_cost: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object('count',count(*),'inputTokens',max(input_tokens),
           'outputTokens',max(output_tokens),'budgetEvaluated',bool_or(budget_evaluated_at IS NOT NULL))
         FROM cost_events WHERE org_id=$1::uuid AND heartbeat_run_id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(success_cost["count"], 1, "{success_cost}");
    assert_eq!(success_cost["inputTokens"], 12, "{success_cost}");
    assert_eq!(success_cost["outputTokens"], 4, "{success_cost}");
    assert_eq!(success_cost["budgetEvaluated"], true, "{success_cost}");
    fs::remove_file(&release_success).expect("reset synthetic Claude to cancellation mode");
    fs::remove_file(&input_pending).expect("reset synthetic provider-start marker");

    let mut cost_fixture_tx = database.pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:goal_run_cost',true)")
        .execute(&mut *cost_fixture_tx)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE cost_events SET cost_cents=10
         WHERE org_id=$1::uuid AND heartbeat_run_id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(&run_id)
    .execute(&mut *cost_fixture_tx)
    .await
    .unwrap();
    cost_fixture_tx.commit().await.unwrap();
    sqlx::query(
        "INSERT INTO budget_policies
           (org_id,scope_type,scope_id,metric,window_kind,amount,hard_stop_enabled,notify_enabled,is_active)
         VALUES($1::uuid,'organization',$1::uuid,'billed_cents','lifetime',1,true,false,true)",
    )
    .bind(fixture::ORG)
    .execute(&database.pool)
    .await
    .unwrap();

    let cancel_request_key = "public-goal-start-native-cancel";
    let cancel_body = public_goal_start_body(cancel_request_key);
    let (cancel_start_status, cancel_started) =
        post(&ingress.base, &path, Some(&board), cancel_body).await;
    assert_eq!(cancel_start_status, StatusCode::CREATED, "{cancel_started}");
    let cancel_goal_id = cancel_started["id"].as_str().expect("cancel Goal ID");
    let cancel_request_id: String = sqlx::query_scalar(
        "SELECT id::text FROM goal_start_requests WHERE org_id=$1::uuid AND request_key=$2",
    )
    .bind(fixture::ORG)
    .bind(cancel_request_key)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let cancel_wakeup_id: String = sqlx::query_scalar(
        "SELECT id::text FROM agent_wakeup_requests WHERE org_id=$1::uuid AND idempotency_key=$2",
    )
    .bind(fixture::ORG)
    .bind(format!("goal-start:{cancel_request_id}"))
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let deferred_by_budget = wait_for_goal_wakeup_status(
        &database,
        &cancel_wakeup_id,
        "deferred_goal_blocked",
        Some("budget.blocked"),
    )
    .await;
    assert!(
        deferred_by_budget["runId"].is_null(),
        "{deferred_by_budget}"
    );
    assert_eq!(deferred_by_budget["authority"], "native_rust");
    sqlx::query(
        "UPDATE budget_policies SET is_active=false
         WHERE org_id=$1::uuid AND scope_type='organization' AND scope_id=$1::uuid
           AND metric='billed_cents' AND window_kind='lifetime'",
    )
    .bind(fixture::ORG)
    .execute(&database.pool)
    .await
    .unwrap();
    assert!(
        wait_for_path(&input_pending).await,
        "native Goal worker must launch the second Claude execution"
    );
    let cancel_run_id: String = sqlx::query_scalar(
        "SELECT run_id::text FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(&cancel_wakeup_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();

    let (cancel_status, cancel_response) = post(
        &ingress.base,
        &format!("/api/agent-runs/{cancel_run_id}/cancel"),
        Some(&board),
        json!({}),
    )
    .await;
    assert_eq!(cancel_status, StatusCode::OK, "{cancel_response}");
    assert_eq!(cancel_response["status"], "running");
    assert_eq!(cancel_response["errorCode"], "cancel_requested");
    let (duplicate_status, duplicate_cancel) = post(
        &ingress.base,
        &format!("/api/agent-runs/{cancel_run_id}/cancel"),
        Some(&board),
        json!({}),
    )
    .await;
    assert_eq!(duplicate_status, StatusCode::OK, "{duplicate_cancel}");
    assert_eq!(duplicate_cancel["status"], "running");
    assert_eq!(duplicate_cancel["errorCode"], "cancel_requested");
    assert!(
        wait_for_path(&interrupt_ack).await,
        "native Claude must acknowledge cancellation before process exit"
    );
    let before_release: (String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT status,error_code,process_exited_at::text FROM heartbeat_runs
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(&cancel_run_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(before_release.0, "running");
    assert_eq!(before_release.1.as_deref(), Some("cancel_requested"));
    assert!(
        before_release.2.is_none(),
        "cancel ACK is not process cleanup proof"
    );
    fs::write(&release_terminal, "release").expect("release terminal provider evidence");

    let cancelled = wait_for_goal_run_terminal(
        &database,
        &cancel_run_id,
        &host.probe_path("goal-claude-events.jsonl"),
    )
    .await;
    assert_eq!(cancelled["status"], "cancelled");
    assert_eq!(cancelled["errorCode"], "cancelled");
    assert_process_pid_exited(
        cancelled["processPid"]
            .as_i64()
            .expect("terminal response records the owned Claude child PID"),
    );
    let cancel_effects: Value = sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'costEvents',(SELECT count(*) FROM cost_events WHERE org_id=$1::uuid AND heartbeat_run_id=$2::uuid),
           'attemptStatus',(SELECT status FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND run_id=$2::uuid),
           'wakeupStatus',(SELECT status FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$3::uuid),
           'goalId',(SELECT goal_id::text FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid),
           'cancelEventCount',(SELECT count(*) FROM heartbeat_run_events
             WHERE org_id=$1::uuid AND run_id=$2::uuid
               AND idempotency_key=$4),
           'cancelActivityCount',(SELECT count(*) FROM activity_log
             WHERE org_id=$1::uuid AND entity_type='heartbeat_run'
               AND entity_id=$2 AND action='heartbeat.cancelled'),
           'cancelOutboxCount',(SELECT count(*) FROM organization_mutation_outbox o
             JOIN activity_log a ON a.org_id=o.org_id AND a.id=o.activity_id
             WHERE a.org_id=$1::uuid AND a.entity_type='heartbeat_run'
               AND a.entity_id=$2 AND a.action='heartbeat.cancelled'))",
    )
    .bind(fixture::ORG)
    .bind(&cancel_run_id)
    .bind(&cancel_wakeup_id)
    .bind(format!("goal-run-cancel:{cancel_run_id}"))
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(cancel_effects["costEvents"], 0, "{cancel_effects}");
    assert_eq!(
        cancel_effects["attemptStatus"], "cancelled",
        "{cancel_effects}"
    );
    assert_eq!(
        cancel_effects["wakeupStatus"], "cancelled",
        "{cancel_effects}"
    );
    assert_eq!(cancel_effects["goalId"], cancel_goal_id, "{cancel_effects}");
    assert_eq!(cancel_effects["cancelEventCount"], 1, "{cancel_effects}");
    assert_eq!(cancel_effects["cancelActivityCount"], 1, "{cancel_effects}");
    assert_eq!(cancel_effects["cancelOutboxCount"], 1, "{cancel_effects}");
    assert_eq!(node_hits.load(Ordering::SeqCst), 2);

    ingress.task.abort();
    node_task.abort();
}
