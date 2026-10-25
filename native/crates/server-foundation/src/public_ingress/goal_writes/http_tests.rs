#![cfg(unix)]

use super::*;
use crate::native_chat_test_fixture as fixture;
use crate::native_chat_test_fixture::support::OTHER;
use actix_web::{App, HttpServer, web};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

const IDENTITY_KEY: &str = "goal-preview-http-identity-assertion-key-0001";
const JWT_SECRET: &str = "goal-preview-http-agent-jwt-secret";
const SAMPLE_OWNER: &str = "55555555-5555-4555-8555-555555555555";
const FOREIGN_OWNER: &str = "55555555-5555-4555-8555-555555555556";

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
    let runtime = PublicIngressRuntime::bind(config, foundation).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    RunningIngress {
        base,
        task: actix_web::rt::spawn(runtime.run()),
    }
}

async fn start_node_sentinel() -> (
    String,
    Arc<AtomicUsize>,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let hits = Arc::new(AtomicUsize::new(0));
    let server = HttpServer::new({
        let hits = hits.clone();
        move || {
            let hits = hits.clone();
            App::new().default_service(web::to(move || {
                let hits = hits.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    HttpResponse::Ok().json(json!({"proxied":true}))
                }
            }))
        }
    })
    .bind(("127.0.0.1", 0))
    .unwrap();
    let address = server.addrs()[0];
    (
        format!("http://{address}"),
        hits,
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
    let (node_url, node_hits, node_task) = start_node_sentinel().await;
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
    let (node_url, node_hits, node_task) = start_node_sentinel().await;
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
