//! Public listener -> native admission -> real owned process -> durable effects.
use super::*;
use crate::postgres_test_support as support;
use crate::{agent_run_context::AgentRunContextHost, native_bearer_auth::hash_token};
use actix_web::{App, HttpServer};
use awc::ws::Frame;
use rudder_d1_persistence::agent_core::OrganizationWorkspaceHost;
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
    body: Option<Value>,
) -> (StatusCode, Value) {
    let request = client
        .request(method, format!("{base}{path}"))
        .insert_header(("authorization", format!("Bearer {token}")));
    let mut response = if let Some(body) = body {
        request.send_json(&body).await.unwrap()
    } else {
        request.send().await.unwrap()
    };
    let status = response.status();
    let bytes = response.body().await.unwrap();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"body":String::from_utf8_lossy(&bytes)}));
    (status, value)
}
async fn completed(
    client: &awc::Client,
    base: &str,
    token: &str,
    run: &str,
    status: &str,
) -> Value {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let (code, value) = call(
                client,
                base,
                token,
                Method::GET,
                &format!("/api/agent-runs/{run}"),
                None,
            )
            .await;
            assert_eq!(code, StatusCode::OK, "{value}");
            if value["status"] == status {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .expect("public Run reaches expected status")
}

async fn settled(pool: &sqlx::PgPool, run: &str) {
    tokio::time::timeout(Duration::from_secs(8),async {loop {
        let done:bool=sqlx::query_scalar("SELECT process_exited_at IS NOT NULL AND NOT terminal_effects_pending FROM heartbeat_runs WHERE id=$1::uuid").bind(run).fetch_one(pool).await.unwrap();
        if done {break;}tokio::time::sleep(Duration::from_millis(40)).await;
    }}).await.expect("exact owned cleanup and all terminal effects settle");
}

#[actix_web::test]
#[ignore = "requires disposable PostgreSQL188, isolated RUN_LOG_BASE_PATH and prebuilt RUDDER_TEST_PROCESS_HOST"]
async fn public_goal_and_generic_execution_stream_stop_retry_and_failures_are_native() {
    let database = support::Database::start().await;
    let root = tempfile::tempdir().unwrap();
    let path = root.path();
    let cwd = path.join("cwd");
    let operator = path.join("operator");
    let runtime_root = path.join("runtime");
    for directory in [&cwd, &operator, &runtime_root] {
        std::fs::create_dir_all(directory).unwrap();
    }
    assert!(
        std::env::var_os("RUN_LOG_BASE_PATH").is_some(),
        "runner supplies isolated log root"
    );
    let goal_ready = cwd.join("goal.retry.ready");
    let goal_script = format!(
        "printf 'goal-public-stream\\n'; if [ -f '{}' ]; then exit 0; fi; while :; do sleep .03; done",
        goal_ready.display()
    );
    let agent = Uuid::new_v4().to_string();
    let foreign_agent = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO agents(id,org_id,name,role,status,capabilities,agent_runtime_type,agent_runtime_config) VALUES($1::uuid,$2::uuid,'Public execution fixture','engineer','idle','Plan and execute software releases','process',$3)")
        .bind(&agent).bind(support::ORG).bind(json!({"command":"/bin/sh","args":["-c",goal_script],"cwd":cwd})).execute(&database.pool).await.unwrap();
    sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type) VALUES($1::uuid,$2::uuid,'Foreign execution fixture','general','idle','process')").bind(&foreign_agent).bind(support::OTHER).execute(&database.pool).await.unwrap();
    let user = "public-execution-board";
    let token = "pcp_board_synthetic_public_execution_fixture";
    sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES($1,'Public execution fixture','public-execution@example.test',now(),now())").bind(user).execute(&database.pool).await.unwrap();
    sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES($1::uuid,'user',$2,'member','active')").bind(support::ORG).bind(user).execute(&database.pool).await.unwrap();
    sqlx::query(
        "INSERT INTO board_api_keys(user_id,name,key_hash) VALUES($1,'Synthetic fixture',$2)",
    )
    .bind(user)
    .bind(hash_token(token))
    .execute(&database.pool)
    .await
    .unwrap();
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
    .disable_signals()
    .listen(listener)
    .unwrap()
    .run();
    let node_control = node.handle();
    let node_task = actix_web::rt::spawn(node);
    let mut app = AppState::new(ServerConfig {
        actor_envelope_key: Some(
            rudder_auth_core::SigningKey::new(b"synthetic-public-execution-envelope-key").unwrap(),
        ),
        workers: 1,
        ..ServerConfig::default()
    })
    .unwrap();
    app.database = DatabaseState::Configured(database.pool.clone());
    let app = Arc::new(app);
    let host = Arc::new(AgentRunContextHost {
        workspace: OrganizationWorkspaceHost {
            instance_root: path.display().to_string(),
            workspace_home: path.join("workspaces").display().to_string(),
            previous_documents_root: path.join("old-documents").display().to_string(),
            friendly_workspace_home: false,
            hostname: "fixture".into(),
        },
        operator_home: operator,
        process_cwd: cwd.clone(),
        executable_search_path: "/usr/bin:/bin".into(),
        environment: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
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
        "synthetic-public-execution-forwarding-key",
    )
    .unwrap();
    config.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            "synthetic-public-execution-identity-key",
            "synthetic-public-execution-agent-jwt-key",
            "rudder-test",
            "rudder-api",
            false,
        )
        .unwrap(),
    );
    config.agent_run_host = Some(host);
    let mut auth_only_config = config.clone();
    auth_only_config.agent_run_host = None;
    let runtime = PublicIngressRuntime::bind(config, app.clone()).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let (_, mut socket) = client
        .ws(format!(
            "{}/api/orgs/{}/events/ws",
            base.replacen("http", "ws", 1),
            support::ORG
        ))
        .set_header("authorization", format!("Bearer {token}"))
        .connect()
        .await
        .unwrap();
    let (code,preview)=call(&client,&base,token,Method::POST,&format!("/api/orgs/{}/goals/start-preview",support::ORG),Some(json!({"title":"Publish a verified software release","context":"Record concrete execution evidence","ownerAgentId":agent,"targetTime":"2031-10-28T10:00:00.000Z"}))).await;
    assert_eq!(code, StatusCode::OK, "{preview}");
    let (code,goal)=call(&client,&base,token,Method::POST,&format!("/api/orgs/{}/goals/start",support::ORG),Some(json!({"requestKey":"public-native-goal","packetHash":preview["packetHash"],"packet":preview["packet"],"allowCapabilityMismatch":true}))).await;
    assert_eq!(code, StatusCode::CREATED, "{goal}");
    let goal_id = goal["id"].as_str().unwrap();
    let goal_run = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let (code, runs) = call(
                &client,
                &base,
                token,
                Method::GET,
                &format!("/api/orgs/{}/agent-runs?goalId={goal_id}", support::ORG),
                None,
            )
            .await;
            assert_eq!(code, StatusCode::OK, "{runs}");
            if let Some(run) = runs
                .as_array()
                .and_then(|runs| runs.first())
                .and_then(|run| run["id"].as_str())
            {
                break run.to_owned();
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .unwrap();
    let mut streamed = false;
    tokio::time::timeout(Duration::from_secs(8), async {
        while let Some(frame) = socket.next().await {
            if let Frame::Text(bytes) = frame.unwrap() {
                let event: Value = serde_json::from_slice(&bytes).unwrap();
                if event["type"] == "heartbeat.run.log"
                    && event["payload"]["runId"] == goal_run
                    && event["payload"]["chunk"]
                        .as_str()
                        .is_some_and(|chunk| chunk.contains("goal-public-stream"))
                {
                    streamed = true;
                    break;
                }
            }
        }
    })
    .await
    .unwrap();
    assert!(streamed, "public socket received actual owned child stdout");
    let (code, log) = call(
        &client,
        &base,
        token,
        Method::GET,
        &format!("/api/agent-runs/{goal_run}/log"),
        None,
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{log}");
    assert!(log.to_string().contains("goal-public-stream"));
    let (code, stopping) = call(
        &client,
        &base,
        token,
        Method::POST,
        &format!("/api/agent-runs/{goal_run}/cancel"),
        Some(json!({})),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{stopping}");
    completed(&client, &base, token, &goal_run, "cancelled").await;

    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let pending: bool = sqlx::query_scalar(
                "SELECT terminal_effects_pending FROM heartbeat_runs WHERE id=$1::uuid",
            )
            .bind(&goal_run)
            .fetch_one(&database.pool)
            .await
            .unwrap();
            if !pending {
                break;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .unwrap();
    let evidence:(String,Value,i64)=sqlx::query_as("SELECT g.lifecycle,r.terminal_effects_completed_json,(SELECT count(*) FROM cost_events c WHERE c.heartbeat_run_id=r.id) FROM goals g JOIN heartbeat_runs r ON r.goal_id=g.id AND r.id=$2::uuid WHERE g.id=$1::uuid").bind(goal_id).bind(&goal_run).fetch_one(&database.pool).await.unwrap();
    assert_eq!(
        evidence.0, "active",
        "only human acceptance completes a Goal"
    );
    assert_eq!(evidence.1.as_array().unwrap().len(), 7);
    assert!(
        evidence
            .1
            .as_array()
            .unwrap()
            .contains(&json!("runtime_cost"))
    );
    assert_eq!(
        evidence.2, 0,
        "plain process reports no billable tokens or cost"
    );
    std::fs::write(&goal_ready, "goal retry may finish").unwrap();
    let (code, goal_retry) = call(
        &client,
        &base,
        token,
        Method::POST,
        &format!("/api/heartbeat-runs/{goal_run}/retry"),
        Some(json!({})),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{goal_retry}");
    let goal_retry_id = goal_retry["id"].as_str().unwrap();
    assert_ne!(goal_retry_id, goal_run);
    completed(&client, &base, token, goal_retry_id, "succeeded").await;
    settled(&database.pool, goal_retry_id).await;
    let retry_ready = cwd.join("retry.ready");
    let script = format!(
        "printf 'generic-public-stream\\n'; if [ -f '{}' ]; then printf 'retry-public-complete\\n'; exit 0; fi; while :; do printf 'still-running\\n'; sleep .03; done",
        retry_ready.display()
    );
    sqlx::query("UPDATE agents SET agent_runtime_config=$2 WHERE id=$1::uuid")
        .bind(&agent)
        .bind(json!({"command":"/bin/sh","args":["-c",script],"cwd":cwd}))
        .execute(&database.pool)
        .await
        .unwrap();
    let (code, wake) = call(
        &client,
        &base,
        token,
        Method::POST,
        &format!("/api/agents/{agent}/wakeup"),
        Some(json!({"reason":"public_fixture","idempotencyKey":"public-native-generic"})),
    )
    .await;
    assert_eq!(code, StatusCode::ACCEPTED, "{wake}");
    let run = wake["id"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            let pid: Option<i32> =
                sqlx::query_scalar("SELECT process_pid FROM heartbeat_runs WHERE id=$1::uuid")
                    .bind(run)
                    .fetch_one(&database.pool)
                    .await
                    .unwrap();
            if pid.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .unwrap();
    let (code, stopping) = call(
        &client,
        &base,
        token,
        Method::POST,
        &format!("/api/heartbeat-runs/{run}/cancel"),
        Some(json!({})),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{stopping}");
    completed(&client, &base, token, run, "cancelled").await;
    tokio::time::timeout(Duration::from_secs(8),async {loop {let proof:bool=sqlx::query_scalar("SELECT process_exited_at IS NOT NULL AND NOT terminal_effects_pending FROM heartbeat_runs WHERE id=$1::uuid").bind(run).fetch_one(&database.pool).await.unwrap();if proof{break;}tokio::time::sleep(Duration::from_millis(40)).await;}}).await.unwrap();
    // Auth-only ingress may read and cancel native Runs, but cannot admit a
    // retry without its execution consumer. Both aliases must fail before any
    // durable admission and must not reach the private Node server.
    let auth_only = PublicIngressRuntime::bind(auth_only_config, app.clone()).unwrap();
    let auth_only_base = format!("http://{}", auth_only.bound_addr());
    let auth_only_control = auth_only.control();
    let auth_only_task = actix_web::rt::spawn(auth_only.run());
    let counts_before: (i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid),(SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid)")
        .bind(support::ORG).fetch_one(&database.pool).await.unwrap();
    for surface in ["agent-runs", "heartbeat-runs"] {
        let (code, unavailable) = call(
            &client,
            &auth_only_base,
            token,
            Method::POST,
            &format!("/api/{surface}/{run}/retry"),
            Some(json!({})),
        )
        .await;
        assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE, "{unavailable}");
        assert_eq!(unavailable["reason"], "agent_execution_unavailable");
    }
    let counts_after: (i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid),(SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid)")
        .bind(support::ORG).fetch_one(&database.pool).await.unwrap();
    assert_eq!(counts_after, counts_before);
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    auth_only_control.stop(true).await;
    auth_only_task.await.unwrap().unwrap();
    std::fs::write(&retry_ready, "retry fixture ready").unwrap();
    let (code, retry) = call(
        &client,
        &base,
        token,
        Method::POST,
        &format!("/api/agent-runs/{run}/retry"),
        Some(json!({})),
    )
    .await;
    assert_eq!(code, StatusCode::OK, "{retry}");
    let retry_id = retry["id"].as_str().unwrap();
    assert_ne!(retry_id, run);
    completed(&client, &base, token, retry_id, "succeeded").await;
    settled(&database.pool, retry_id).await;
    let outbox:i64=sqlx::query_scalar("SELECT count(*) FROM organization_mutation_outbox o JOIN activity_log a ON a.id=o.activity_id WHERE o.org_id=$1::uuid AND a.entity_id IN($2,$3)").bind(support::ORG).bind(run).bind(retry_id).fetch_one(&database.pool).await.unwrap();
    assert!(
        outbox >= 2,
        "native wake/retry activity committed with outbox"
    );
    let (code, invoked) = call(
        &client,
        &base,
        token,
        Method::POST,
        &format!("/api/agents/{agent}/heartbeat/invoke"),
        Some(json!({})),
    )
    .await;
    assert_eq!(code, StatusCode::ACCEPTED, "{invoked}");
    let invoked_id = invoked["id"].as_str().unwrap();
    completed(&client, &base, token, invoked_id, "succeeded").await;
    settled(&database.pool, invoked_id).await;
    let (code, denied) = call(
        &client,
        &base,
        token,
        Method::POST,
        &format!("/api/agents/{foreign_agent}/wakeup"),
        Some(json!({})),
    )
    .await;
    assert_eq!(code, StatusCode::FORBIDDEN, "{denied}");
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    database.pool.close().await;
    let (code, _) = call(
        &client,
        &base,
        token,
        Method::POST,
        &format!("/api/agents/{agent}/heartbeat/invoke"),
        Some(json!({})),
    )
    .await;
    assert!(code.is_server_error());
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "database failure never falls back to Node"
    );
    drop(socket);
    control.stop(true).await;
    task.await.unwrap().unwrap();
    node_control.stop(true).await;
    node_task.await.unwrap().unwrap();
}
