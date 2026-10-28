//! Public listener -> Automation receipt -> existing generic queue -> owned
//! process cleanup -> native Issue/Automation readback, with no Node fallback.
#[path = "../../../../d1-persistence/tests/support/mod.rs"]
mod support;
use super::*;
use crate::{agent_run_context::AgentRunContextHost, native_bearer_auth::hash_token};
use actix_web::{App, HttpServer};
use hmac::{Hmac, Mac};
use rudder_d1_persistence::agent_core::OrganizationWorkspaceHost;
use sha2::Sha256;
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};

async fn call(
    client: &awc::Client,
    base: &str,
    token: &str,
    method: Method,
    path: &str,
    input: Value,
) -> (StatusCode, Value) {
    let mut response = client
        .request(method, format!("{base}{path}"))
        .insert_header(("authorization", format!("Bearer {token}")))
        .send_json(&input)
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.body().await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn settled_native_run(pool: &sqlx::PgPool, issue: &str) -> String {
    tokio::time::timeout(Duration::from_secs(20),async{loop {
        let run=sqlx::query_scalar::<_,String>("SELECT id::text FROM heartbeat_runs WHERE context_snapshot->>'issueId'=$1 AND status='succeeded' AND process_exited_at IS NOT NULL AND NOT terminal_effects_pending ORDER BY started_at DESC LIMIT 1").bind(issue).fetch_optional(pool).await.unwrap();
        if let Some(run)=run{return run;}tokio::time::sleep(Duration::from_millis(50)).await;
    }}).await.expect("actual generic execution and owned cleanup settle")
}
#[actix_web::test]
#[ignore = "requires disposable PostgreSQL188, isolated logs/secrets and prebuilt RUDDER_TEST_PROCESS_HOST"]
async fn manual_webhook_and_schedule_execution_use_native_admission_receipts_and_owned_worker() {
    assert!(std::env::var_os("RUN_LOG_BASE_PATH").is_some());
    assert!(std::env::var_os("RUDDER_SECRETS_MASTER_KEY_FILE").is_some());
    let db = support::Database::start().await;
    let root = tempfile::tempdir().unwrap();
    let path = root.path();
    let cwd = path.join("cwd");
    let operator = path.join("operator");
    let runtime_root = path.join("runtime");
    for directory in [&cwd, &operator, &runtime_root] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let user = "automation-execution-public-fixture";
    let token = "pcp_board_synthetic_automation_execution_fixture";
    sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES($1,'Automation execution fixture','automation-execution@example.test',now(),now())").bind(user).execute(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES($1::uuid,'user',$2,'member','active')").bind(support::ORG).bind(user).execute(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO principal_permission_grants(org_id,principal_type,principal_id,permission_key) VALUES($1::uuid,'user',$2,'tasks:assign')").bind(support::ORG).bind(user).execute(&db.pool).await.unwrap();
    sqlx::query(
        "INSERT INTO board_api_keys(user_id,name,key_hash) VALUES($1,'Automation fixture',$2)",
    )
    .bind(user)
    .bind(hash_token(token))
    .execute(&db.pool)
    .await
    .unwrap();
    let agent = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type,agent_runtime_config) VALUES($1::uuid,$2::uuid,'Automation public execution','general','idle','process',$3::jsonb)")
        .bind(&agent).bind(support::ORG).bind(json!({"command":"/bin/sh","args":["-c","printf 'synthetic automation result\\n'"],"cwd":cwd})).execute(&db.pool).await.unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let node = HttpServer::new({
        let hits = hits.clone();
        move || {
            let hits = hits.clone();
            App::new().default_service(web::to(move || {
                let hits = hits.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    HttpResponse::Ok().json(json!({"unexpectedNode":true}))
                }
            }))
        }
    })
    .workers(1)
    .listen(listener)
    .unwrap()
    .run();
    let node_control = node.handle();
    let node_task = actix_web::rt::spawn(node);
    let mut app = AppState::new(ServerConfig {
        actor_envelope_key: Some(
            rudder_auth_core::SigningKey::new(b"synthetic-automation-execution-envelope-key")
                .unwrap(),
        ),
        workers: 1,
        ..ServerConfig::default()
    })
    .unwrap();
    app.database = DatabaseState::Configured(db.pool.clone());
    let app = Arc::new(app);
    let host = Arc::new(AgentRunContextHost {
        workspace: OrganizationWorkspaceHost {
            instance_root: path.display().to_string(),
            workspace_home: path.join("workspaces").display().to_string(),
            previous_documents_root: path.join("previous").display().to_string(),
            friendly_workspace_home: false,
            hostname: "fixture".into(),
        },
        operator_home: operator,
        process_cwd: cwd.clone(),
        executable_search_path: "/usr/bin:/bin".into(),
        environment: BTreeMap::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HEARTBEAT_SCHEDULER_INTERVAL_MS".into(), "10000".into()),
        ]),
        runtime_root,
        rudder_cli: PathBuf::from("/usr/bin/false"),
        process_host: std::env::var_os("RUDDER_TEST_PROCESS_HOST")
            .map(PathBuf::from)
            .expect("prebuilt process host"),
        api_url: "http://127.0.0.1:1".into(),
        deployment_mode: "local_trusted".into(),
        bundled_skills_root: None,
        desktop_brokers: app.desktop_brokers.clone(),
    });
    let mut config = PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        &upstream,
        "synthetic-automation-forwarding-key",
    )
    .unwrap();
    config.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            "synthetic-automation-identity-key",
            "synthetic-automation-agent-jwt-key",
            "rudder-test",
            "rudder-api",
            false,
        )
        .unwrap(),
    );
    config.agent_run_host = Some(host);
    let runtime = PublicIngressRuntime::bind(config, app.clone()).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let (status,definition)=call(&client,&base,token,Method::POST,&format!("/api/orgs/{}/automations",support::ORG),json!({"title":"Synthetic end-to-end automation","description":"Complete isolated fixture work","assigneeAgentId":agent,"outputMode":"track_issue"})).await;
    assert_eq!(status, StatusCode::CREATED, "{definition}");
    let automation = definition["id"].as_str().unwrap();
    let (status, run) = call(
        &client,
        &base,
        token,
        Method::POST,
        &format!("/api/automations/{automation}/run"),
        json!({"source":"api","idempotencyKey":"fixture-manual"}),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{run}");
    assert_eq!(run["status"], "issue_created");
    let (status, replay) = call(
        &client,
        &base,
        token,
        Method::POST,
        &format!("/api/automations/{automation}/run"),
        json!({"source":"api","idempotencyKey":"fixture-manual"}),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(replay["id"], run["id"]);
    let issue = run["linkedIssueId"].as_str().unwrap();
    let native_run = settled_native_run(&db.pool, issue).await;
    let (status, readback) = call(
        &client,
        &base,
        token,
        Method::GET,
        &format!("/api/agent-runs/{native_run}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(readback["status"], "succeeded");
    let (status, updated) = call(
        &client,
        &base,
        token,
        Method::PATCH,
        &format!("/api/issues/{issue}"),
        json!({"status":"done"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    let (status, runs) = call(
        &client,
        &base,
        token,
        Method::GET,
        &format!("/api/automations/{automation}/runs"),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        runs.as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == run["id"] && r["status"] == "completed")
    );
    let (status, created) = call(
        &client,
        &base,
        token,
        Method::POST,
        &format!("/api/automations/{automation}/triggers"),
        json!({"kind":"webhook","signingMode":"hmac_sha256","replayWindowSec":300}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let public = created["trigger"]["publicId"].as_str().unwrap();
    let secret = created["secretMaterial"]["webhookSecret"].as_str().unwrap();
    let body = "{\"fixture\": true}";
    let stamp = time::OffsetDateTime::now_utc().unix_timestamp().to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(format!("{stamp}.{body}").as_bytes());
    let signature = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let fire = format!("{base}/api/automation-triggers/public/{public}/fire");
    let mut rejected = client
        .post(&fire)
        .insert_header(("content-type", "application/json"))
        .insert_header(("x-rudder-timestamp", stamp.clone()))
        .insert_header(("x-rudder-signature", "0".repeat(64)))
        .send_body(body)
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    let _ = rejected.body().await.unwrap();
    let mut response = client
        .post(&fire)
        .insert_header(("content-type", "application/json"))
        .insert_header(("x-rudder-timestamp", stamp))
        .insert_header(("x-rudder-signature", signature))
        .insert_header(("idempotency-key", "fixture-webhook"))
        .send_body(body)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let fired: Value = response.json().await.unwrap();
    assert_eq!(fired["source"], "webhook");
    let issue = fired["linkedIssueId"].as_str().unwrap();
    settled_native_run(&db.pool, issue).await;
    let (status, _) = call(
        &client,
        &base,
        token,
        Method::PATCH,
        &format!("/api/issues/{issue}"),
        json!({"status":"done"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, scheduled) = call(
        &client,
        &base,
        token,
        Method::POST,
        &format!("/api/automations/{automation}/triggers"),
        json!({"kind":"schedule","cronExpression":"* * * * *","timezone":"UTC"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    sqlx::query("UPDATE automation_triggers SET next_run_at=statement_timestamp()-interval '1 minute' WHERE id=$1::uuid").bind(scheduled["trigger"]["id"].as_str()).execute(&db.pool).await.unwrap();
    let scheduled_issue=tokio::time::timeout(Duration::from_secs(25),async{loop{let issue=sqlx::query_scalar::<_,String>("SELECT linked_issue_id::text FROM automation_runs WHERE automation_id=$1::uuid AND source='schedule' AND linked_issue_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").bind(automation).fetch_optional(&db.pool).await.unwrap();if let Some(issue)=issue{break issue;}tokio::time::sleep(Duration::from_millis(80)).await;}}).await.expect("native configured cadence fires schedule");
    settled_native_run(&db.pool, &scheduled_issue).await;
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    control.stop(true).await;
    task.await.unwrap().unwrap();
    node_control.stop(true).await;
    node_task.await.unwrap().unwrap();
}
