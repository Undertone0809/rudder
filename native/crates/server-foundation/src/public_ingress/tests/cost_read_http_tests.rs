use super::*;
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
use sqlx::PgPool;
use std::{
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
};

#[actix_web::test]
#[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB"]
async fn native_cost_reads_revalidate_scope_and_keep_finance_events_transport_explicit() {
    let database_url = env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL")
        .expect("set RUDDER_NATIVE_AUTH_TEST_DATABASE_URL to a migrated disposable DB");
    let pool = super::disposable_native_auth_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let org_id = insert_organization(&pool, &suffix, "own").await;
    let foreign_org_id = insert_organization(&pool, &suffix, "foreign").await;
    let user_id = format!("native-cost-read-user-{suffix}");
    insert_user(&pool, &user_id).await;
    sqlx::query(
        "INSERT INTO organization_memberships (org_id, principal_type, principal_id, status) VALUES ($1::uuid, 'user', $2, 'active')",
    )
    .bind(&org_id)
    .bind(&user_id)
    .execute(&pool)
    .await
    .unwrap();

    let board_token = format!("pcp_native_cost_read_board_{suffix}");
    let board_key_id: String = sqlx::query_scalar(
        "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'cost read board', $2) RETURNING id::text",
    )
    .bind(&user_id)
    .bind(crate::native_bearer_auth::hash_token(&board_token))
    .fetch_one(&pool)
    .await
    .unwrap();
    let agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, 'Cost read agent', 'general', 'idle') RETURNING id::text",
    )
    .bind(&org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let agent_token = format!("pcp_native_cost_read_agent_{suffix}");
    let agent_key_id: String = sqlx::query_scalar(
        "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash) VALUES ($1::uuid, $2::uuid, 'cost read agent', $3) RETURNING id::text",
    )
    .bind(&agent_id)
    .bind(&org_id)
    .bind(crate::native_bearer_auth::hash_token(&agent_token))
    .fetch_one(&pool)
    .await
    .unwrap();

    sqlx::raw_sql(&format!(
        r#"
INSERT INTO cost_events (org_id,agent_id,provider,biller,billing_type,model,cost_cents,occurred_at) VALUES
 ('{org_id}','{agent_id}','openai','openai','metered_api','february',100,'2024-02-29T00:00:00Z'),
 ('{org_id}','{agent_id}','openai','openai','metered_api','march',200,'2024-03-01T00:00:00Z'),
 ('{org_id}','{agent_id}','openai','openai','metered_api','recent',50,CURRENT_TIMESTAMP);
INSERT INTO finance_events (org_id,event_kind,direction,biller,amount_cents,estimated,occurred_at,created_at,metadata_json) VALUES
 ('{org_id}','february','debit','test',1,false,'2024-02-29T00:00:00Z','2024-02-29T00:00:00Z',NULL),
 ('{org_id}','march','debit','test',2,false,'2024-03-01T00:00:00Z','2024-03-01T00:00:00Z',NULL),
 ('{org_id}','latest','debit','test',3,false,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,NULL);
"#
    ))
    .execute(&pool)
    .await
    .unwrap();

    let node_requests = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let node = HttpServer::new({
        let node_requests = node_requests.clone();
        move || {
            let node_requests = node_requests.clone();
            App::new().default_service(web::to(move |request: HttpRequest| {
                let node_requests = node_requests.clone();
                async move {
                    node_requests.fetch_add(1, Ordering::SeqCst);
                    HttpResponse::Ok().json(serde_json::json!({"nodePath":request.path()}))
                }
            }))
        }
    })
    .workers(1)
    .disable_signals()
    .listen(listener)
    .unwrap()
    .run();
    let node_handle = node.handle();
    let node_task = actix_web::rt::spawn(node);

    let (foundation, runtime) = cost_reads_runtime(Some(database_url), &upstream);
    let address = runtime.bound_addr();
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let base = format!("http://{address}");

    let own_range = format!(
        "{base}/API/ORGS/{org_id}/COSTS/SUMMARY/?from=2024-02-29T08%3A00%3A00%2B08%3A00&to=2024-03-01T00%3A00%3A00Z"
    );
    let (board_summary_status, board_summary) =
        get_json(&client, &own_range, Some(&board_token)).await;
    let board_head_status = client
        .head(format!("{base}/api/orgs/{org_id}/costs/summary"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {board_token}")))
        .send()
        .await
        .unwrap()
        .status();
    let (agent_finance_status, agent_finance) = get_json(
        &client,
        &format!("{base}/api/orgs/{org_id}/costs/finance-summary"),
        Some(&agent_token),
    )
    .await;
    let (window_status, windows) = get_json(
        &client,
        &format!("{base}/api/orgs/{org_id}/costs/window-spend"),
        Some(&board_token),
    )
    .await;
    let migrated_paths = [
        "summary",
        "by-agent",
        "trend",
        "by-agent-model",
        "by-provider",
        "by-biller",
        "finance-summary",
        "finance-by-biller",
        "finance-by-kind",
        "window-spend",
        "by-project",
    ];
    for path in migrated_paths {
        let (status, body) = get_json(
            &client,
            &format!("{base}/api/orgs/{org_id}/costs/{path}"),
            Some(&board_token),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert!(
            body.get("nodePath").is_none(),
            "{path} reached Node: {body}"
        );
    }
    assert_eq!(node_requests.load(Ordering::SeqCst), 0);
    let (finance_events_status, finance_events_passthrough) = get_json(
        &client,
        &format!("{base}/api/orgs/{org_id}/costs/finance-events?limit=1"),
        Some(&board_token),
    )
    .await;
    let (foreign_board_status, foreign_board) = get_json(
        &client,
        &format!("{base}/api/orgs/{foreign_org_id}/costs/summary"),
        Some(&board_token),
    )
    .await;
    let (foreign_agent_status, foreign_agent) = get_json(
        &client,
        &format!("{base}/api/orgs/{foreign_org_id}/costs/summary"),
        Some(&agent_token),
    )
    .await;
    let (anonymous_status, anonymous) = get_json(
        &client,
        &format!("{base}/api/orgs/{org_id}/costs/summary"),
        None,
    )
    .await;

    let node_requests_before_native_failure = node_requests.load(Ordering::SeqCst);
    let DatabaseState::Configured(native_pool) = &foundation.database else {
        panic!("public cost ingress must keep its configured database pool");
    };
    native_pool.close().await;
    let (database_failure_status, _) = get_json(
        &client,
        &format!("{base}/api/orgs/{org_id}/costs/summary"),
        Some(&board_token),
    )
    .await;
    control.stop(true).await;
    task.await.unwrap().unwrap();
    node_handle.stop(true).await;
    node_task.await.unwrap().unwrap();

    assert_eq!(board_summary_status, StatusCode::OK);
    assert_eq!(board_summary["spendCents"], 300);
    assert_eq!(board_head_status, StatusCode::OK);
    assert_eq!(agent_finance_status, StatusCode::OK);
    assert_eq!(agent_finance["eventCount"], 3);
    assert_eq!(window_status, StatusCode::OK);
    assert_eq!(windows.as_array().unwrap().len(), 3);
    assert!(
        windows
            .as_array()
            .unwrap()
            .iter()
            .all(|window| window["costCents"] == 50)
    );
    assert_eq!(
        finance_events_status,
        StatusCode::OK,
        "FinanceEvents deliberately remains on the Node transport"
    );
    assert_eq!(
        finance_events_passthrough["nodePath"],
        format!("/api/orgs/{org_id}/costs/finance-events")
    );
    assert_eq!(node_requests.load(Ordering::SeqCst), 1);
    assert_eq!(foreign_board_status, StatusCode::FORBIDDEN);
    assert_eq!(
        foreign_board["error"],
        "User does not have access to this organization"
    );
    assert_eq!(foreign_agent_status, StatusCode::FORBIDDEN);
    assert_eq!(
        foreign_agent["error"],
        "Agent key cannot access another organization"
    );
    assert_eq!(anonymous_status, StatusCode::UNAUTHORIZED);
    assert_eq!(anonymous["error"], "Unauthorized");
    assert!(database_failure_status.is_server_error());
    assert_eq!(node_requests_before_native_failure, 1);
    assert_eq!(node_requests.load(Ordering::SeqCst), 1);

    sqlx::query("DELETE FROM cost_events WHERE org_id IN ($1::uuid, $2::uuid)")
        .bind(&org_id)
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM finance_events WHERE org_id IN ($1::uuid, $2::uuid)")
        .bind(&org_id)
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM board_api_keys WHERE id=$1::uuid")
        .bind(&board_key_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_api_keys WHERE id=$1::uuid")
        .bind(&agent_key_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organization_memberships WHERE org_id=$1::uuid AND principal_id=$2")
        .bind(&org_id)
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=$1::uuid")
        .bind(&agent_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)")
        .bind(&org_id)
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(r#"DELETE FROM "user" WHERE id=$1"#)
        .bind(&user_id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

fn cost_reads_runtime(
    database_url: Option<String>,
    upstream: &str,
) -> (Arc<AppState>, PublicIngressRuntime) {
    let foundation = Arc::new(
        AppState::new(ServerConfig {
            database_url,
            actor_envelope_key: Some(SigningKey::new(b"native-cost-read-envelope-key").unwrap()),
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
            "native-cost-read-agent-jwt-secret",
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

async fn get_json(
    client: &awc::Client,
    url: &str,
    token: Option<&str>,
) -> (StatusCode, serde_json::Value) {
    let mut request = client.get(url);
    if let Some(token) = token {
        request = request.insert_header((header::AUTHORIZATION, format!("Bearer {token}")));
    }
    let mut response = request.send().await.unwrap();
    let status = response.status();
    let body = response.json().await.unwrap();
    (status, body)
}

async fn insert_organization(pool: &PgPool, suffix: &str, label: &str) -> String {
    sqlx::query_scalar(
        "INSERT INTO organizations (url_key, name, issue_prefix) VALUES ($1, $2, $3) RETURNING id::text",
    )
    .bind(format!("native-cost-read-{suffix}-{label}"))
    .bind(format!("Native cost read {label}"))
    .bind(format!("CR{}{}", suffix[..7].to_ascii_uppercase(), label.to_ascii_uppercase()))
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn insert_user(pool: &PgPool, user_id: &str) {
    sqlx::query(
        r#"INSERT INTO "user" (id, name, email, created_at, updated_at)
           VALUES ($1, 'Native Cost Read User', $2, now(), now())"#,
    )
    .bind(user_id)
    .bind(format!("{user_id}@invalid.test"))
    .execute(pool)
    .await
    .unwrap();
}
