use super::*;
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
use serde_json::{Value, json};
use std::{
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
};

#[actix_web::test]
#[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB"]
async fn native_observational_reads_cover_scope_privacy_paging_dates_and_no_fallback() {
    let database_url =
        env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").expect("set migrated disposable DB URL");
    let pool = super::disposable_native_auth_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let mut orgs = Vec::new();
    for label in ["own", "foreign"] {
        orgs.push(sqlx::query_scalar::<_,String>("INSERT INTO organizations (url_key,name,issue_prefix) VALUES ($1,$2,$3) RETURNING id::text").bind(format!("observational-{suffix}-{label}")).bind(label).bind(format!("O{}{}",&suffix[..6],label)).fetch_one(&pool).await.unwrap());
    }
    let org = &orgs[0];
    let foreign = &orgs[1];
    let user = format!("observational-{suffix}");
    sqlx::query(r#"INSERT INTO "user" (id,name,email,created_at,updated_at) VALUES ($1,'Observational reader',$2,now(),now())"#).bind(&user).bind(format!("{user}@invalid.test")).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO organization_memberships (org_id,principal_type,principal_id,status) VALUES ($1::uuid,'user',$2,'active')").bind(org).bind(&user).execute(&pool).await.unwrap();
    let token = format!("pcp_observational_{suffix}");
    sqlx::query(
        "INSERT INTO board_api_keys (user_id,name,key_hash) VALUES ($1,'observational',$2)",
    )
    .bind(&user)
    .bind(crate::native_bearer_auth::hash_token(&token))
    .execute(&pool)
    .await
    .unwrap();
    let agent=sqlx::query_scalar::<_,String>("INSERT INTO agents (org_id,name,role,status) VALUES ($1::uuid,'Observational agent','general','idle') RETURNING id::text").bind(org).fetch_one(&pool).await.unwrap();
    let agent_token = format!("pcp_observational_agent_{suffix}");
    sqlx::query("INSERT INTO agent_api_keys (org_id,agent_id,name,key_hash) VALUES ($1::uuid,$2::uuid,'observational',$3)").bind(org).bind(&agent).bind(crate::native_bearer_auth::hash_token(&agent_token)).execute(&pool).await.unwrap();
    let project=sqlx::query_scalar::<_,String>("INSERT INTO projects (org_id,name) VALUES ($1::uuid,'Observational project') RETURNING id::text").bind(org).fetch_one(&pool).await.unwrap();
    let issue=sqlx::query_scalar::<_,String>("INSERT INTO issues (org_id,title,issue_number,identifier) VALUES ($1::uuid,'Observational issue',1,$2) RETURNING id::text").bind(org).bind(format!("OBS{}-1",&suffix[..6].to_ascii_uppercase())).fetch_one(&pool).await.unwrap();
    let workspace=sqlx::query_scalar::<_,String>("INSERT INTO execution_workspaces (org_id,project_id,source_issue_id,mode,strategy_type,name,opened_at) VALUES ($1::uuid,$2::uuid,$3::uuid,'isolated_workspace','git_worktree','Observational workspace','0044-01-02T03:04:05.123456Z') RETURNING id::text").bind(org).bind(&project).bind(&issue).fetch_one(&pool).await.unwrap();
    let chat=sqlx::query_scalar::<_,String>("INSERT INTO chat_conversations (org_id,conversation_kind,created_by_user_id,title) VALUES ($1::uuid,'side_chat',$2,'Private observational chat') RETURNING id::text").bind(org).bind(&user).fetch_one(&pool).await.unwrap();
    let run=sqlx::query_scalar::<_,String>("INSERT INTO heartbeat_runs (org_id,agent_id,status,context_snapshot) VALUES ($1::uuid,$2::uuid,'succeeded',jsonb_build_object('issueId',$3::text)) RETURNING id::text").bind(org).bind(&agent).bind(&issue).fetch_one(&pool).await.unwrap();
    let private_run=sqlx::query_scalar::<_,String>("INSERT INTO heartbeat_runs (org_id,agent_id,status,chat_conversation_id,context_snapshot) VALUES ($1::uuid,$2::uuid,'succeeded',$3::uuid,jsonb_build_object('issueId',$4::text,'scene','side_chat')) RETURNING id::text").bind(org).bind(&agent).bind(&chat).bind(&issue).fetch_one(&pool).await.unwrap();
    for created in ["0044-01-02T03:04:05.123456Z", "2026-01-02T03:04:05.123456Z"] {
        sqlx::query("INSERT INTO activity_log (org_id,actor_type,actor_id,action,entity_type,entity_id,run_id,created_at) VALUES ($1::uuid,'user',$2,'issue.observed','issue',$3,$4::uuid,$5::timestamptz)").bind(org).bind(&user).bind(&issue).bind(&run).bind(created).execute(&pool).await.unwrap();
    }
    let before = read_snapshot(&pool, org).await;
    let node_count = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let node = HttpServer::new({
        let count = node_count.clone();
        move || {
            let count = count.clone();
            App::new().default_service(web::to(move |request: HttpRequest| {
                let count = count.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    HttpResponse::ImATeapot().json(json!({"node":request.path()}))
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
    let (foundation, runtime) = observational_runtime(Some(database_url), &upstream);
    let address = runtime.bound_addr();
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let base = format!("http://{address}");
    let client = awc::Client::default();
    let paths = [
        format!("/api/orgs/{org}/activity"),
        format!("/api/issues/{issue}/activity"),
        format!("/api/issues/{issue}/runs"),
        format!("/api/heartbeat-runs/{run}/issues"),
        format!("/api/agent-runs/{run}/issues"),
        format!("/api/orgs/{org}/users/me/activity-ledger"),
        format!("/api/orgs/{org}/dashboard"),
        format!("/api/orgs/{org}/budgets/overview"),
        format!("/api/orgs/{org}/run-workspaces"),
        format!("/api/orgs/{org}/execution-workspaces"),
        format!("/api/run-workspaces/{workspace}"),
        format!("/api/execution-workspaces/{workspace}"),
    ];
    for path in &paths {
        assert_eq!(
            get(&client, &base, path, Some(&token)).await.0,
            StatusCode::OK,
            "{path}"
        );
        assert_eq!(
            get(&client, &base, path, None).await.0,
            StatusCode::UNAUTHORIZED,
            "{path}"
        );
        let mut response = client
            .head(format!("{base}{path}"))
            .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "HEAD {path}");
        assert!(response.body().await.unwrap().is_empty());
    }
    let (_, all) = get(&client, &base, &paths[0], Some(&token)).await;
    assert_eq!(all.as_array().unwrap().len(), 2);
    assert_eq!(all[1]["createdAt"], "0044-01-02T03:04:05.123Z");
    let (_, page) = get(
        &client,
        &base,
        &format!("{}?limit=1", paths[0]),
        Some(&token),
    )
    .await;
    let cursor = page["nextCursor"].as_str().unwrap();
    let (_, next) = get(
        &client,
        &base,
        &format!("{}?limit=1&cursor={cursor}", paths[0]),
        Some(&token),
    )
    .await;
    assert_eq!(next["items"][0]["createdAt"], "0044-01-02T03:04:05.123Z");
    assert!(next["nextCursor"].is_null());
    let (_, details) = get(&client, &base, &paths[10], Some(&token)).await;
    assert_eq!(details["openedAt"], "0044-01-02T03:04:05.123Z");
    let ledger_path = format!(
        "/api/orgs/{org}/users/me/activity-ledger?include=activity&since=2026-01-01&until=2026-12-31&limit=1"
    );
    let (_, ledger) = get(&client, &base, &ledger_path, Some(&token)).await;
    assert_eq!(ledger["items"].as_array().unwrap().len(), 1);
    let (_, owner_runs) = get(&client, &base, &paths[2], Some(&token)).await;
    assert_eq!(owner_runs.as_array().unwrap().len(), 2);
    let (_, agent_runs) = get(&client, &base, &paths[2], Some(&agent_token)).await;
    assert_eq!(agent_runs.as_array().unwrap().len(), 1);
    assert_eq!(agent_runs[0]["runId"], run);
    let (_, linked) = get(&client, &base, &paths[3], Some(&token)).await;
    assert_eq!(linked[0]["issueId"], issue);
    let short = run.replace('-', "");
    assert_eq!(
        get(
            &client,
            &base,
            &format!("/api/agent-runs/{}/issues", &short[..8]),
            Some(&token)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        get(
            &client,
            &base,
            &format!("/api/agent-runs/{private_run}/issues"),
            Some(&agent_token)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    for path in [
        format!("/api/orgs/{foreign}/activity"),
        format!("/api/orgs/{foreign}/dashboard"),
        format!("/api/orgs/{foreign}/run-workspaces"),
    ] {
        assert_eq!(
            get(&client, &base, &path, Some(&agent_token)).await.0,
            StatusCode::FORBIDDEN
        );
    }
    for path in [
        format!("{}?limit=101", paths[0]),
        format!("{}?cursor=bad", paths[0]),
        format!("{}?limit=1&limit=2", paths[0]),
        format!("{}?include=bad", paths[5]),
        format!("{}?since=bad", paths[5]),
        format!("{}?cursor=bad", paths[5]),
    ] {
        assert_eq!(
            get(&client, &base, &path, Some(&token)).await.0,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
    assert_eq!(
        get(&client, &base, "/api/run-workspaces/not-a-uuid", None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        get(
            &client,
            &base,
            "/api/run-workspaces/not-a-uuid",
            Some(&token)
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        get(
            &client,
            &base,
            &format!("/api/run-workspaces/{}", Uuid::new_v4()),
            Some(&token)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(
            &client,
            &base,
            &format!("{}?status=active&status=idle", paths[8]),
            Some(&token)
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        node_count.load(Ordering::SeqCst),
        0,
        "selected reads must never reach Node"
    );
    assert_eq!(
        before,
        read_snapshot(&pool, org).await,
        "read cohort must not mutate business rows"
    );
    sqlx::query("UPDATE organization_memberships SET status='suspended' WHERE org_id=$1::uuid AND principal_id=$2").bind(org).bind(&user).execute(&pool).await.unwrap();
    assert_eq!(
        get(&client, &base, &paths[0], Some(&token)).await.0,
        StatusCode::FORBIDDEN
    );
    let DatabaseState::Configured(native_pool) = &foundation.database else {
        panic!("observational ingress must have a configured pool");
    };
    native_pool.close().await;
    assert!(
        get(&client, &base, &paths[0], Some(&token))
            .await
            .0
            .is_server_error()
    );
    control.stop(true).await;
    task.await.unwrap().unwrap();
    let (_, disabled) = observational_runtime(None, &upstream);
    let disabled_address = disabled.bound_addr();
    let disabled_control = disabled.control();
    let disabled_task = actix_web::rt::spawn(disabled.run());
    assert_eq!(
        get(
            &client,
            &format!("http://{disabled_address}"),
            &paths[0],
            Some(&token)
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    disabled_control.stop(true).await;
    disabled_task.await.unwrap().unwrap();
    assert_eq!(node_count.load(Ordering::SeqCst), 0);
    node_control.stop(true).await;
    node_task.await.unwrap().unwrap();
    for table in [
        "activity_log",
        "heartbeat_runs",
        "chat_conversations",
        "execution_workspaces",
        "issues",
        "projects",
        "agent_api_keys",
        "agents",
        "organization_memberships",
    ] {
        sqlx::query(&format!("DELETE FROM {table} WHERE org_id=$1::uuid"))
            .bind(org)
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query("DELETE FROM board_api_keys WHERE user_id=$1")
        .bind(&user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organizations WHERE id=ANY($1::uuid[])")
        .bind(orgs)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(r#"DELETE FROM "user" WHERE id=$1"#)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

async fn read_snapshot(pool: &sqlx::PgPool, org: &str) -> Vec<String> {
    let mut rows = Vec::new();
    for table in [
        "activity_log",
        "heartbeat_runs",
        "execution_workspaces",
        "issues",
        "projects",
    ] {
        rows.push(sqlx::query_scalar(&format!("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM {table} t WHERE org_id=$1::uuid")).bind(org).fetch_one(pool).await.unwrap());
    }
    rows
}
fn observational_runtime(
    database_url: Option<String>,
    upstream: &str,
) -> (Arc<AppState>, PublicIngressRuntime) {
    let foundation = Arc::new(
        AppState::new(ServerConfig {
            database_url,
            actor_envelope_key: Some(SigningKey::new(b"observational-read-envelope-key").unwrap()),
            workers: 1,
            ..ServerConfig::default()
        })
        .unwrap(),
    );
    let mut ingress =
        PublicIngressConfig::new("127.0.0.1:0".parse().unwrap(), upstream, INTERNAL).unwrap();
    ingress.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            INTERNAL,
            "observational-agent-jwt-secret",
            "rudder-test",
            "rudder-api",
            false,
        )
        .unwrap(),
    );
    (
        foundation.clone(),
        PublicIngressRuntime::bind(ingress, foundation).unwrap(),
    )
}
async fn get(
    client: &awc::Client,
    base: &str,
    path: &str,
    token: Option<&str>,
) -> (StatusCode, Value) {
    let mut request = client.get(format!("{base}{path}"));
    if let Some(token) = token {
        request = request.insert_header((header::AUTHORIZATION, format!("Bearer {token}")));
    }
    let mut response = request.send().await.unwrap();
    let status = response.status();
    let body = response.json().await.unwrap();
    (status, body)
}
