#![cfg(unix)]

use super::*;
use crate::native_chat_test_fixture as fixture;
use crate::native_chat_test_fixture::support::{GOAL, OTHER};
use actix_web::{App, HttpServer, web};
use rudder_d1_persistence::goal_runs;
use serde_json::{Value, json};
use sqlx::Row;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

const IDENTITY_KEY: &str = "native-goal-cancel-identity-assertion-key";
const JWT_SECRET: &str = "native-goal-cancel-agent-jwt-secret";
const OTHER_AGENT: &str = "50000000-0000-4000-8000-000000000002";
const FOREIGN_AGENT: &str = "50000000-0000-4000-8000-000000000003";
const SECOND_GOAL: &str = "30000000-0000-4000-8000-000000000002";

struct RunningIngress {
    base: String,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}

async fn start_ingress(
    database: &fixture::Database,
    node_upstream: &str,
    identity_auth: bool,
) -> RunningIngress {
    let database_url = format!(
        "postgresql://postgres@127.0.0.1:{}/postgres",
        database.pool.connect_options().get_port()
    );
    let foundation = Arc::new(
        crate::AppState::new(crate::ServerConfig {
            database_url: Some(database_url),
            actor_envelope_key: Some(
                rudder_auth_core::SigningKey::new(b"native-goal-cancel-envelope-key-v1").unwrap(),
            ),
            workers: 1,
            ..crate::ServerConfig::default()
        })
        .unwrap(),
    );
    let mut config = crate::PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        node_upstream,
        "native-goal-cancel-authorization-key",
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
    let runtime = PublicIngressRuntime::bind(config, foundation).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    RunningIngress {
        base,
        task: actix_web::rt::spawn(runtime.run()),
    }
}

async fn start_node_mock() -> (
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
            App::new().default_service(web::to(move |request: HttpRequest, body: web::Bytes| {
                let hits = hits.clone();
                let requests = requests.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    requests
                        .lock()
                        .unwrap()
                        .push((request.uri().to_string(), body.to_vec()));
                    HttpResponse::Ok().json(json!({ "proxied": true }))
                }
            }))
        }
    })
    .bind(("127.0.0.1", 0))
    .unwrap();
    let address = server.addrs()[0];
    let task = actix_web::rt::spawn(server.run());
    (format!("http://{address}"), hits, requests, task)
}

async fn post_cancel(
    url: String,
    token: Option<&str>,
    body: Value,
) -> (actix_web::http::StatusCode, Value) {
    let client = awc::Client::default();
    let mut request = client
        .post(url)
        .insert_header((header::CONTENT_TYPE, "application/json"));
    if let Some(token) = token {
        request = request.insert_header((header::AUTHORIZATION, format!("Bearer {token}")));
    }
    let mut response = request
        .send_body(serde_json::to_vec(&body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let response_body = response.body().await.unwrap();
    (
        status,
        serde_json::from_slice(&response_body).unwrap_or(Value::Null),
    )
}

async fn goal_run(
    database: &fixture::Database,
    agent_id: &str,
    goal_id: &str,
    request_id: &str,
) -> (goal_runs::GoalRunClaim, String) {
    sqlx::query(
        "UPDATE agents SET agent_runtime_type='claude_local',status='idle'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(agent_id)
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE goals SET owner_agent_id=$2::uuid,lifecycle='active',status='active',
           plan_revision=1 WHERE org_id=$1::uuid AND id=$3::uuid",
    )
    .bind(fixture::ORG)
    .bind(agent_id)
    .bind(goal_id)
    .execute(&database.pool)
    .await
    .unwrap();
    let payload = json!({
        "event":"goal_started",
        "goalId":goal_id,
        "taskKey":format!("goal:{goal_id}:goal_started:{request_id}"),
        "goalStartRequestId":request_id,
        "_paperclipWakeContext":{
            "goalId":goal_id,
            "goal":{"id":goal_id,"title":"Cancellation fixture"},
            "plan":{"revision":1},
            "continuation":{"summary":"Continue cancellation fixture"}
        }
    });
    let wakeup_id: String = sqlx::query_scalar(
        "INSERT INTO agent_wakeup_requests
           (org_id,agent_id,source,trigger_detail,reason,payload,execution_authority)
         VALUES($1::uuid,$2::uuid,'on_demand','system','goal_started',$3::jsonb,'native_rust')
         RETURNING id::text",
    )
    .bind(fixture::ORG)
    .bind(agent_id)
    .bind(payload.to_string())
    .fetch_one(&database.pool)
    .await
    .unwrap();
    let claim = goal_runs::claim_wakeup(&database.pool, fixture::ORG, &wakeup_id)
        .await
        .unwrap()
        .expect("claim the native Goal Run without launching its worker");
    (claim, wakeup_id)
}

async fn agent_key(
    database: &fixture::Database,
    agent_id: &str,
    org_id: &str,
    revoked: bool,
) -> String {
    let token = format!("pcp_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO agent_api_keys(agent_id,org_id,name,key_hash,revoked_at)
         VALUES($1::uuid,$2::uuid,'Goal cancel HTTP fixture',$3,
           CASE WHEN $4 THEN clock_timestamp() ELSE NULL END)",
    )
    .bind(agent_id)
    .bind(org_id)
    .bind(crate::native_bearer_auth::hash_token(&token))
    .bind(revoked)
    .execute(&database.pool)
    .await
    .unwrap();
    token
}

async fn seed_agent(database: &fixture::Database, id: &str, org_id: &str) {
    sqlx::query(
        "INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type)
         VALUES($1::uuid,$2::uuid,'Goal cancel HTTP Agent','general','idle','claude_local')",
    )
    .bind(id)
    .bind(org_id)
    .execute(&database.pool)
    .await
    .unwrap();
}

async fn board_key(database: &fixture::Database) -> String {
    let user_id = format!("goal-cancel-board-{}", uuid::Uuid::new_v4());
    let token = format!("pcp_board_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(
        "INSERT INTO \"user\"(id,name,email,created_at,updated_at)
         VALUES($1,'Goal cancel Board fixture',$2,now(),now())",
    )
    .bind(&user_id)
    .bind(format!("{user_id}@goal-cancel.invalid"))
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status)
         VALUES($1::uuid,'user',$2,'member','active')",
    )
    .bind(fixture::ORG)
    .bind(&user_id)
    .execute(&database.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO board_api_keys(user_id,name,key_hash)
         VALUES($1,'Goal cancel HTTP fixture',$2)",
    )
    .bind(&user_id)
    .bind(crate::native_bearer_auth::hash_token(&token))
    .execute(&database.pool)
    .await
    .unwrap();
    token
}

async fn legacy_run(database: &fixture::Database) -> String {
    sqlx::query_scalar(
        "INSERT INTO heartbeat_runs(org_id,agent_id,status,started_at,invocation_source,execution_authority,context_snapshot)
         VALUES($1::uuid,$2::uuid,'running',clock_timestamp(),'manual','legacy_ts','{}'::jsonb)
         RETURNING id::text",
    )
    .bind(fixture::ORG)
    .bind(fixture::CEO)
    .fetch_one(&database.pool)
    .await
    .unwrap()
}

#[actix_web::test]
#[ignore = "requires PostgreSQL binaries; disposable database and public ingress HTTP tests"]
async fn native_goal_agent_run_cancel_owns_auth_transaction_projection_and_legacy_boundary() {
    let database = fixture::Database::start().await;
    seed_agent(&database, OTHER_AGENT, fixture::ORG).await;
    seed_agent(&database, FOREIGN_AGENT, OTHER).await;
    let (claim, wakeup_id) = goal_run(&database, fixture::CEO, GOAL, "first").await;
    let (board_claim, _) = goal_run(&database, OTHER_AGENT, SECOND_GOAL, "board").await;
    let valid_key = agent_key(&database, fixture::CEO, fixture::ORG, false).await;
    let wrong_agent_key = agent_key(&database, OTHER_AGENT, fixture::ORG, false).await;
    let foreign_agent_key = agent_key(&database, FOREIGN_AGENT, OTHER, false).await;
    let revoked_key = agent_key(&database, fixture::CEO, fixture::ORG, true).await;
    let board_token = board_key(&database).await;

    let (node_upstream, node_hits, node_requests, node_task) = start_node_mock().await;
    let ingress = start_ingress(&database, &node_upstream, true).await;
    let url = |run_id: &str| format!("{}/api/agent-runs/{run_id}/cancel", ingress.base);

    let (status, body) = post_cancel(url(&claim.run_id), None, json!({})).await;
    assert_eq!(status, actix_web::http::StatusCode::UNAUTHORIZED, "{body}");
    let (status, body) = post_cancel(url(&claim.run_id), Some("pcp_unknown"), json!({})).await;
    assert_eq!(status, actix_web::http::StatusCode::UNAUTHORIZED, "{body}");
    let (status, body) = post_cancel(url(&claim.run_id), Some(&revoked_key), json!({})).await;
    assert_eq!(status, actix_web::http::StatusCode::UNAUTHORIZED, "{body}");
    let (status, body) = post_cancel(url(&claim.run_id), Some(&foreign_agent_key), json!({})).await;
    assert_eq!(status, actix_web::http::StatusCode::FORBIDDEN, "{body}");

    // The existing Node route authorizes Agent callers by organization. Keep
    // that compatibility even when the authorized Agent differs from the Run
    // owner; cross-organization callers remain forbidden above.
    let (status, body) = post_cancel(url(&claim.run_id), Some(&wrong_agent_key), json!({})).await;
    assert_eq!(status, actix_web::http::StatusCode::OK, "{body}");
    assert_eq!(body["id"], claim.run_id);
    assert_eq!(
        body["shortRef"],
        format!("run_{}", claim.run_id.replace('-', "").get(..8).unwrap())
    );
    assert_eq!(body["orgId"], fixture::ORG);
    assert_eq!(body["agentId"], fixture::CEO);
    assert_eq!(body["goalId"], GOAL);
    assert_eq!(body["status"], "running");
    assert_eq!(body["errorCode"], "cancel_requested");
    assert_eq!(body["scene"], "heartbeat");
    assert_eq!(body["targetType"], "wakeup_request");
    assert_eq!(body["targetId"], wakeup_id);
    assert_eq!(body["wakeupRequestId"], wakeup_id);

    let short_run_ref = format!("run_{}", claim.run_id.replace('-', "").get(..8).unwrap());
    let (status, duplicate_body) =
        post_cancel(url(&short_run_ref), Some(&valid_key), json!({})).await;
    assert_eq!(status, actix_web::http::StatusCode::OK, "{duplicate_body}");
    assert_eq!(duplicate_body["status"], "running");
    assert_eq!(duplicate_body["errorCode"], "cancel_requested");
    let bare_run_prefix = claim.run_id.replace('-', "").get(..8).unwrap().to_owned();
    let (status, bare_prefix_body) =
        post_cancel(url(&bare_run_prefix), Some(&valid_key), json!({})).await;
    assert_eq!(
        status,
        actix_web::http::StatusCode::OK,
        "{bare_prefix_body}"
    );
    assert_eq!(bare_prefix_body["id"], claim.run_id);

    let row = sqlx::query(
        "SELECT r.status,r.error_code,r.finished_at IS NOT NULL AS finished,
                r.process_exited_at IS NOT NULL AS process_exited,r.execution_owner_token,
                a.status AS attempt_status,w.status AS wakeup_status,
                (SELECT count(*) FROM heartbeat_run_events e
                 WHERE e.org_id=r.org_id AND e.run_id=r.id
                   AND e.idempotency_key=$3) AS cancel_event_count,
                (SELECT count(*) FROM activity_log l WHERE l.org_id=r.org_id
                   AND l.entity_type='heartbeat_run' AND l.entity_id=r.id::text
                   AND l.action='heartbeat.cancelled') AS cancel_activity_count,
                (SELECT actor_type FROM activity_log l WHERE l.org_id=r.org_id
                   AND l.entity_type='heartbeat_run' AND l.entity_id=r.id::text
                   AND l.action='heartbeat.cancelled' ORDER BY l.created_at LIMIT 1) AS cancel_actor_type,
                (SELECT actor_id FROM activity_log l WHERE l.org_id=r.org_id
                   AND l.entity_type='heartbeat_run' AND l.entity_id=r.id::text
                   AND l.action='heartbeat.cancelled' ORDER BY l.created_at LIMIT 1) AS cancel_actor_id
         FROM heartbeat_runs r
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         JOIN agent_wakeup_requests w ON w.org_id=r.org_id AND w.id=r.wakeup_request_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(fixture::ORG)
    .bind(&claim.run_id)
    .bind(format!("goal-run-cancel:{}", claim.run_id))
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(row.try_get::<String, _>("status").unwrap(), "running");
    assert_eq!(
        row.try_get::<Option<String>, _>("error_code")
            .unwrap()
            .as_deref(),
        Some("cancel_requested")
    );
    assert!(!row.try_get::<bool, _>("finished").unwrap());
    assert!(!row.try_get::<bool, _>("process_exited").unwrap());
    assert_eq!(
        row.try_get::<Option<String>, _>("execution_owner_token")
            .unwrap()
            .as_deref(),
        Some(claim.owner_token.as_str())
    );
    assert_eq!(
        row.try_get::<String, _>("attempt_status").unwrap(),
        "started"
    );
    assert_eq!(
        row.try_get::<String, _>("wakeup_status").unwrap(),
        "claimed"
    );
    assert_eq!(row.try_get::<i64, _>("cancel_event_count").unwrap(), 1);
    assert_eq!(row.try_get::<i64, _>("cancel_activity_count").unwrap(), 1);
    assert_eq!(
        row.try_get::<String, _>("cancel_actor_type").unwrap(),
        "agent"
    );
    assert_eq!(
        row.try_get::<String, _>("cancel_actor_id").unwrap(),
        OTHER_AGENT
    );

    let (status, board_body) =
        post_cancel(url(&board_claim.run_id), Some(&board_token), json!({})).await;
    assert_eq!(status, actix_web::http::StatusCode::OK, "{board_body}");
    assert_eq!(board_body["goalId"], SECOND_GOAL);
    assert_eq!(board_body["status"], "running");
    assert_eq!(board_body["errorCode"], "cancel_requested");
    assert_eq!(
        node_hits.load(Ordering::SeqCst),
        0,
        "native requests never reached Node"
    );

    ingress.task.abort();

    // A classified native Goal Run must fail closed when public Rust identity
    // is unavailable; it must not call the legacy handler to do the cancel.
    let unavailable_ingress = start_ingress(&database, &node_upstream, false).await;
    let (status, body) = post_cancel(
        format!(
            "{}/api/agent-runs/{}/cancel",
            unavailable_ingress.base, claim.run_id
        ),
        Some(&valid_key),
        json!({}),
    )
    .await;
    assert_eq!(
        status,
        actix_web::http::StatusCode::SERVICE_UNAVAILABLE,
        "{body}"
    );
    assert_eq!(body["reason"], "native_identity_unavailable");
    assert_eq!(node_hits.load(Ordering::SeqCst), 0);
    unavailable_ingress.task.abort();

    // A non-Goal legacy Run is delegated with the exact body untouched.
    let legacy_id = legacy_run(&database).await;
    let legacy_ingress = start_ingress(&database, &node_upstream, true).await;
    let payload = json!({ "opaque": "keep this exact JSON" });
    let (status, body) = post_cancel(
        format!("{}/api/agent-runs/{legacy_id}/cancel", legacy_ingress.base),
        Some(&valid_key),
        payload.clone(),
    )
    .await;
    assert_eq!(status, actix_web::http::StatusCode::OK, "{body}");
    assert_eq!(body["proxied"], true);
    assert_eq!(node_hits.load(Ordering::SeqCst), 1);
    let captured = node_requests.lock().unwrap();
    assert_eq!(captured.len(), 1);
    assert_eq!(captured[0].0, format!("/api/agent-runs/{legacy_id}/cancel"));
    assert_eq!(
        serde_json::from_slice::<Value>(&captured[0].1).unwrap(),
        payload
    );
    legacy_ingress.task.abort();
    node_task.abort();
}
