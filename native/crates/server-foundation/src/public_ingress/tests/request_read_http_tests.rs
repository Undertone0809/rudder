use super::*;
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
use serde_json::json;
use sqlx::PgPool;
use std::{
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
};

#[actix_web::test]
#[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB"]
async fn native_request_reads_revalidate_scope_and_never_fall_back() {
    let database_url = env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL")
        .expect("set RUDDER_NATIVE_AUTH_TEST_DATABASE_URL to a migrated disposable DB");
    let pool = super::disposable_native_auth_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let organization_id = insert_organization(&pool, &suffix, "own").await;
    let foreign_organization_id = insert_organization(&pool, &suffix, "foreign").await;
    let user_id = format!("native-request-read-user-{suffix}");
    insert_user(&pool, &user_id).await;
    sqlx::query(
        "INSERT INTO organization_memberships (org_id, principal_type, principal_id, status) VALUES ($1::uuid, 'user', $2, 'active')",
    )
    .bind(&organization_id)
    .bind(&user_id)
    .execute(&pool)
    .await
    .unwrap();

    let board_token = format!("pcp_native_request_read_board_{suffix}");
    let board_key_id: String = sqlx::query_scalar(
        "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'request read board', $2) RETURNING id::text",
    )
    .bind(&user_id)
    .bind(crate::native_bearer_auth::hash_token(&board_token))
    .fetch_one(&pool)
    .await
    .unwrap();
    let agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, 'Request read agent', 'general', 'idle') RETURNING id::text",
    )
    .bind(&organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let agent_token = format!("pcp_native_request_read_agent_{suffix}");
    let agent_key_id: String = sqlx::query_scalar(
        "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash) VALUES ($1::uuid, $2::uuid, 'request read agent', $3) RETURNING id::text",
    )
    .bind(&agent_id)
    .bind(&organization_id)
    .bind(crate::native_bearer_auth::hash_token(&agent_token))
    .fetch_one(&pool)
    .await
    .unwrap();

    let ancient_request_id: String = sqlx::query_scalar(
        "INSERT INTO requests (org_id, kind, subtype, title, prompt, created_at, updated_at) VALUES ($1::uuid, 'assistance', 'issue_blocker', 'Ancient request', 'Stored date is AD 0044', '0044-01-02T03:04:05.123456Z', '0044-01-03T04:05:06.654321Z') RETURNING id::text",
    )
    .bind(&organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let modern_request_id: String = sqlx::query_scalar(
        "INSERT INTO requests (org_id, kind, subtype, title, prompt, created_at, updated_at) VALUES ($1::uuid, 'assistance', 'issue_blocker', 'Modern request', 'Stored date is 2026', '2026-01-02T03:04:05.123456Z', '2026-01-03T04:05:06.654321Z') RETURNING id::text",
    )
    .bind(&organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let approval_id: String = sqlx::query_scalar(
        "INSERT INTO approvals (org_id, type, status, payload, created_at, updated_at) VALUES ($1::uuid, 'hire_agent', 'pending', '{\"password\":\"secret\",\"safe\":true}'::jsonb, '2026-02-02T00:00:00Z', '2026-02-02T00:00:00Z') RETURNING id::text",
    )
    .bind(&organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let collision_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO approvals (id, org_id, type, payload) VALUES ($1::uuid, $2::uuid, 'hire_agent', '{\"must\":\"not escape\"}'::jsonb)",
    )
    .bind(&collision_id)
    .bind(&organization_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO requests (id, org_id, kind, subtype, title, prompt) VALUES ($1::uuid, $2::uuid, 'assistance', 'issue_blocker', 'Foreign winner', 'Hidden')",
    )
    .bind(&collision_id)
    .bind(&foreign_organization_id)
    .execute(&pool)
    .await
    .unwrap();
    let foreign_request_id: String = sqlx::query_scalar(
        "INSERT INTO requests (org_id, kind, subtype, title, prompt) VALUES ($1::uuid, 'assistance', 'issue_blocker', 'Foreign request', 'Hidden') RETURNING id::text",
    )
    .bind(&foreign_organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    let issue_id: String = sqlx::query_scalar(
        "INSERT INTO issues (org_id, title) VALUES ($1::uuid, 'Block Audit issue') RETURNING id::text",
    )
    .bind(&organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let run_one: String = sqlx::query_scalar(
        "INSERT INTO heartbeat_runs (org_id, agent_id, status) VALUES ($1::uuid, $2::uuid, 'succeeded') RETURNING id::text",
    )
    .bind(&organization_id)
    .bind(&agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let run_two: String = sqlx::query_scalar(
        "INSERT INTO heartbeat_runs (org_id, agent_id, status) VALUES ($1::uuid, $2::uuid, 'succeeded') RETURNING id::text",
    )
    .bind(&organization_id)
    .bind(&agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    for (run_id, attempt_number) in [(&run_one, 2), (&run_two, 1)] {
        sqlx::query(
            "INSERT INTO issue_block_audit_attempts (org_id, issue_id, request_id, run_id, root_run_id, agent_id, continuation_kind, failure_class, blocker_fingerprint, attempt_number, required_attempts, status_before, status_after, blocker_reason, requested_action) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'initial', 'issue', 'request-read-fingerprint', $7, 3, 'in_progress', 'in_progress', 'Blocked', 'Continue')",
        )
        .bind(&organization_id)
        .bind(&issue_id)
        .bind(&ancient_request_id)
        .bind(run_id)
        .bind(&run_one)
        .bind(&agent_id)
        .bind(attempt_number)
        .execute(&pool)
        .await
        .unwrap();
    }

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
                    HttpResponse::Ok().json(json!({"nodePath":request.path()}))
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

    let (foundation, runtime) = request_reads_runtime(Some(database_url), &upstream);
    let address = runtime.bound_addr();
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let base = format!("http://{address}");

    let (list_status, list) = get_json(
        &client,
        &format!("{base}/api/orgs/{organization_id}/requests?kind=assistance&unknown=ignored"),
        Some(&board_token),
    )
    .await;
    let (detail_status, detail) = get_json(
        &client,
        &format!("{base}/api/requests/{ancient_request_id}"),
        Some(&agent_token),
    )
    .await;
    let (approval_status, approval) = get_json(
        &client,
        &format!("{base}/api/requests/{approval_id}"),
        Some(&board_token),
    )
    .await;
    let (attempts_status, attempts) = get_json(
        &client,
        &format!("{base}/api/requests/{ancient_request_id}/block-audit-attempts"),
        Some(&board_token),
    )
    .await;
    let (bad_filter_status, bad_filter) = get_json(
        &client,
        &format!("{base}/api/orgs/{organization_id}/requests?status=open&status=resolved"),
        Some(&board_token),
    )
    .await;
    let (foreign_agent_status, foreign_agent) = get_json(
        &client,
        &format!("{base}/api/requests/{foreign_request_id}"),
        Some(&agent_token),
    )
    .await;
    let (collision_status, collision) = get_json(
        &client,
        &format!("{base}/api/requests/{collision_id}"),
        Some(&board_token),
    )
    .await;
    let (anonymous_status, anonymous) = get_json(
        &client,
        &format!("{base}/api/requests/{ancient_request_id}"),
        None,
    )
    .await;
    let (anonymous_missing_status, anonymous_missing) = get_json(
        &client,
        &format!("{base}/api/requests/{}", Uuid::new_v4()),
        None,
    )
    .await;
    let (anonymous_malformed_status, anonymous_malformed) =
        get_json(&client, &format!("{base}/api/requests/not-a-uuid"), None).await;
    let (missing_status, missing) = get_json(
        &client,
        &format!("{base}/api/requests/{}", Uuid::new_v4()),
        Some(&board_token),
    )
    .await;
    let malformed_id_status = client
        .get(format!("{base}/api/requests/not-a-uuid"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {board_token}")))
        .send()
        .await
        .unwrap()
        .status();
    let head_status = client
        .head(format!("{base}/api/requests/{modern_request_id}"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {board_token}")))
        .send()
        .await
        .unwrap()
        .status();
    let head_list_status = client
        .head(format!("{base}/api/orgs/{organization_id}/requests"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {board_token}")))
        .send()
        .await
        .unwrap()
        .status();
    let head_attempts_status = client
        .head(format!(
            "{base}/api/requests/{ancient_request_id}/block-audit-attempts"
        ))
        .insert_header((header::AUTHORIZATION, format!("Bearer {board_token}")))
        .send()
        .await
        .unwrap()
        .status();

    let node_requests_before_write = node_requests.load(Ordering::SeqCst);
    let mut write_response = client
        .post(format!("{base}/api/requests/{ancient_request_id}/resolve"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {board_token}")))
        .insert_header((header::CONTENT_TYPE, "application/json"))
        .send_body("{}")
        .await
        .unwrap();
    let write_status = write_response.status();
    let write_body: serde_json::Value = write_response.json().await.unwrap();
    let node_requests_after_write = node_requests.load(Ordering::SeqCst);

    let (foreign_board_status, foreign_board) = get_json(
        &client,
        &format!("{base}/api/orgs/{foreign_organization_id}/requests"),
        Some(&board_token),
    )
    .await;
    let (wrong_kind_status, wrong_kind) = get_json(
        &client,
        &format!("{base}/api/requests/{approval_id}/block-audit-attempts"),
        Some(&board_token),
    )
    .await;

    let DatabaseState::Configured(native_pool) = &foundation.database else {
        panic!("public Request ingress must keep its configured database pool");
    };
    native_pool.close().await;
    let (database_failure_status, _) = get_json(
        &client,
        &format!("{base}/api/orgs/{organization_id}/requests"),
        Some(&board_token),
    )
    .await;
    control.stop(true).await;
    task.await.unwrap().unwrap();
    node_handle.stop(true).await;
    node_task.await.unwrap().unwrap();

    assert_eq!(list_status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert_eq!(list[0]["id"], modern_request_id);
    assert_eq!(list[1]["id"], ancient_request_id);
    assert_eq!(list[1]["createdAt"], "0044-01-02T03:04:05.123Z");
    assert_eq!(list[1]["updatedAt"], "0044-01-03T04:05:06.654Z");
    assert_eq!(detail_status, StatusCode::OK);
    assert_eq!(detail["id"], ancient_request_id);
    assert_eq!(detail["createdAt"], "0044-01-02T03:04:05.123Z");
    assert_eq!(detail["updatedAt"], "0044-01-03T04:05:06.654Z");
    assert_eq!(approval_status, StatusCode::OK);
    assert_eq!(approval["kind"], "approval");
    assert_eq!(approval["payload"]["password"], "***REDACTED***");
    assert_eq!(attempts_status, StatusCode::OK);
    assert_eq!(attempts.as_array().unwrap().len(), 2);
    assert_eq!(attempts[0]["attemptNumber"], 1);
    assert_eq!(attempts[1]["attemptNumber"], 2);
    assert_eq!(bad_filter_status, StatusCode::BAD_REQUEST);
    assert_eq!(bad_filter["error"], "Validation error");
    assert_eq!(foreign_agent_status, StatusCode::FORBIDDEN);
    assert_eq!(
        foreign_agent["error"],
        "Agent key cannot access another organization"
    );
    assert_eq!(collision_status, StatusCode::FORBIDDEN);
    assert_eq!(
        collision["error"],
        "User does not have access to this organization"
    );
    assert_eq!(anonymous_status, StatusCode::UNAUTHORIZED);
    assert_eq!(anonymous["error"], "Unauthorized");
    assert_eq!(anonymous_missing_status, StatusCode::UNAUTHORIZED);
    assert_eq!(anonymous_missing["error"], "Unauthorized");
    assert_eq!(anonymous_malformed_status, StatusCode::UNAUTHORIZED);
    assert_eq!(anonymous_malformed["error"], "Unauthorized");
    assert_eq!(missing_status, StatusCode::NOT_FOUND);
    assert_eq!(missing["error"], "Request not found");
    assert_eq!(malformed_id_status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(head_status, StatusCode::OK);
    assert_eq!(head_list_status, StatusCode::OK);
    assert_eq!(head_attempts_status, StatusCode::OK);
    assert_eq!(foreign_board_status, StatusCode::FORBIDDEN);
    assert_eq!(
        foreign_board["error"],
        "User does not have access to this organization"
    );
    assert_eq!(wrong_kind_status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        wrong_kind["error"],
        "Only Assistance Requests have Block Audit attempts"
    );
    assert_eq!(write_status, StatusCode::OK);
    assert_eq!(
        write_body["nodePath"],
        format!("/api/requests/{ancient_request_id}/resolve")
    );
    assert_eq!(node_requests_before_write, 0);
    assert_eq!(node_requests_after_write, 1);
    assert!(database_failure_status.is_server_error());
    assert_eq!(node_requests.load(Ordering::SeqCst), 1);

    sqlx::query("DELETE FROM issue_block_audit_attempts WHERE request_id=$1::uuid")
        .bind(&ancient_request_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM requests WHERE id IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)")
        .bind(&ancient_request_id)
        .bind(&modern_request_id)
        .bind(&collision_id)
        .bind(&foreign_request_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM approvals WHERE id IN ($1::uuid, $2::uuid)")
        .bind(&approval_id)
        .bind(&collision_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id IN ($1::uuid, $2::uuid)")
        .bind(&run_one)
        .bind(&run_two)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&issue_id)
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
        .bind(&organization_id)
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
        .bind(&organization_id)
        .bind(&foreign_organization_id)
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

fn request_reads_runtime(
    database_url: Option<String>,
    upstream: &str,
) -> (Arc<AppState>, PublicIngressRuntime) {
    let foundation = Arc::new(
        AppState::new(ServerConfig {
            database_url,
            actor_envelope_key: Some(SigningKey::new(b"native-request-read-envelope-key").unwrap()),
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
            "native-request-read-agent-jwt-secret",
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
    .bind(format!("native-request-read-{suffix}-{label}"))
    .bind(format!("Native Request read {label}"))
    .bind(format!("RR{}{}", suffix[..7].to_ascii_uppercase(), label.to_ascii_uppercase()))
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn insert_user(pool: &PgPool, user_id: &str) {
    sqlx::query(
        r#"INSERT INTO "user" (id, name, email, created_at, updated_at)
           VALUES ($1, 'Native Request Read User', $2, now(), now())"#,
    )
    .bind(user_id)
    .bind(format!("{user_id}@invalid.test"))
    .execute(pool)
    .await
    .unwrap();
}
