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
async fn native_automation_reads_revalidate_scope_and_keep_writes_on_node() {
    let database_url = env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL")
        .expect("set RUDDER_NATIVE_AUTH_TEST_DATABASE_URL to a migrated disposable DB");
    let pool = super::disposable_native_auth_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let org_id = insert_organization(&pool, &suffix, "own").await;
    let foreign_org_id = insert_organization(&pool, &suffix, "foreign").await;
    let user_id = format!("native-automation-read-user-{suffix}");
    insert_user(&pool, &user_id).await;
    let other_user_id = format!("native-automation-read-other-user-{suffix}");
    insert_user(&pool, &other_user_id).await;
    sqlx::query(
        "INSERT INTO organization_memberships (org_id, principal_type, principal_id, status) VALUES ($1::uuid, 'user', $2, 'active')",
    )
    .bind(&org_id)
    .bind(&user_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO organization_memberships (org_id, principal_type, principal_id, status) VALUES ($1::uuid, 'user', $2, 'active')",
    )
    .bind(&org_id)
    .bind(&other_user_id)
    .execute(&pool)
    .await
    .unwrap();

    let board_token = format!("pcp_native_automation_read_board_{suffix}");
    let board_key_id: String = sqlx::query_scalar(
        "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'automation read board', $2) RETURNING id::text",
    )
    .bind(&user_id)
    .bind(crate::native_bearer_auth::hash_token(&board_token))
    .fetch_one(&pool)
    .await
    .unwrap();
    let other_board_token = format!("pcp_native_automation_read_other_board_{suffix}");
    let other_board_key_id: String = sqlx::query_scalar(
        "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'other automation reader', $2) RETURNING id::text",
    )
    .bind(&other_user_id)
    .bind(crate::native_bearer_auth::hash_token(&other_board_token))
    .fetch_one(&pool)
    .await
    .unwrap();
    let agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, 'Automation read agent', 'general', 'idle') RETURNING id::text",
    )
    .bind(&org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let agent_token = format!("pcp_native_automation_read_agent_{suffix}");
    let agent_key_id: String = sqlx::query_scalar(
        "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash) VALUES ($1::uuid, $2::uuid, 'automation read agent', $3) RETURNING id::text",
    )
    .bind(&agent_id)
    .bind(&org_id)
    .bind(crate::native_bearer_auth::hash_token(&agent_token))
    .fetch_one(&pool)
    .await
    .unwrap();

    let automation_id: String = sqlx::query_scalar(
        "INSERT INTO automations (org_id, title, description, assignee_agent_id, assignee_agent_runtime_overrides, created_at, updated_at) VALUES ($1::uuid, 'Native Automation', 'native read payload', $2::uuid, '{\"nested\":[1,true]}'::jsonb, '2044-01-02T03:04:05.123456Z', '0044-01-02T03:04:06.123456Z') RETURNING id::text",
    )
    .bind(&org_id)
    .bind(&agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let archived_automation_id: String = sqlx::query_scalar(
        "INSERT INTO automations (org_id, title, assignee_agent_id, status) VALUES ($1::uuid, 'Archived Automation', $2::uuid, 'archived') RETURNING id::text",
    )
    .bind(&org_id)
    .bind(&agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let foreign_automation_id: String = sqlx::query_scalar(
        "INSERT INTO automations (org_id, title, assignee_agent_id) VALUES ($1::uuid, 'Foreign Automation', $2::uuid) RETURNING id::text",
    )
    .bind(&foreign_org_id)
    .bind(&agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let trigger_id: String = sqlx::query_scalar(
        "INSERT INTO automation_triggers (org_id, automation_id, kind, label, enabled, last_result, created_at) VALUES ($1::uuid, $2::uuid, 'schedule', 'Daily report', true, 'succeeded', '2044-01-02T03:00:00Z') RETURNING id::text",
    )
    .bind(&org_id)
    .bind(&automation_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let old_run_id: String = sqlx::query_scalar(
        "INSERT INTO automation_runs (org_id, automation_id, trigger_id, source, status, trigger_payload, failure_reason, created_at, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 'schedule', 'completed', '{\"sequence\":1}'::jsonb, 'old failure detail', '2044-01-02T03:05:00.000001Z', '2044-01-02T03:05:00.000001Z') RETURNING id::text",
    )
    .bind(&org_id)
    .bind(&automation_id)
    .bind(&trigger_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let latest_run_id: String = sqlx::query_scalar(
        "INSERT INTO automation_runs (org_id, automation_id, trigger_id, source, status, trigger_payload, failure_reason, created_at, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 'schedule', 'failed', '{\"sequence\":2,\"secretLike\":\"retained\"}'::jsonb, 'latest failure detail', '2044-01-02T03:05:00.000002Z', '2044-01-02T03:05:00.000002Z') RETURNING id::text",
    )
    .bind(&org_id)
    .bind(&automation_id)
    .bind(&trigger_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let private_chat_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO chat_conversations (id, org_id, conversation_kind, created_by_user_id, title, preferred_agent_id, last_message_at) VALUES ($1::uuid, $2::uuid, 'side_chat', $3, 'OWNER_PRIVATE_AUTOMATION_CHAT', $4::uuid, '2044-01-02T03:05:00.654321Z')",
    )
    .bind(&private_chat_id)
    .bind(&org_id)
    .bind(&user_id)
    .bind(&agent_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE automation_runs SET linked_chat_conversation_id=$1::uuid WHERE id=$2::uuid",
    )
    .bind(&private_chat_id)
    .bind(&latest_run_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO automation_runs (org_id, automation_id, source, status, created_at) VALUES ($1::uuid, $2::uuid, 'manual', 'completed', '2044-01-02T03:06:00Z')",
    )
    .bind(&org_id)
    .bind(&archived_automation_id)
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

    let (foundation, runtime) = automation_reads_runtime(Some(database_url), &upstream);
    let address = runtime.bound_addr();
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let base = format!("http://{address}");
    let list_path = format!("{base}/api/orgs/{org_id}/automations");
    let detail_path = format!("{base}/api/automations/{automation_id}");
    let runs_path = format!("{base}/api/automations/{automation_id}/runs");

    let (board_list_status, board_list) = get_json(&client, &list_path, Some(&board_token)).await;
    let (board_detail_status, board_detail) =
        get_json(&client, &detail_path, Some(&board_token)).await;
    let (board_runs_status, board_runs) =
        get_json(&client, &format!("{runs_path}?limit=1"), Some(&board_token)).await;
    let (other_board_list_status, other_board_list) =
        get_json(&client, &list_path, Some(&other_board_token)).await;
    let (other_board_detail_status, other_board_detail) =
        get_json(&client, &detail_path, Some(&other_board_token)).await;
    let (other_board_runs_status, other_board_runs) = get_json(
        &client,
        &format!("{runs_path}?limit=1"),
        Some(&other_board_token),
    )
    .await;
    let (agent_list_status, agent_list) = get_json(&client, &list_path, Some(&agent_token)).await;
    let (agent_detail_status, agent_detail) =
        get_json(&client, &detail_path, Some(&agent_token)).await;
    let (agent_runs_status, agent_runs) =
        get_json(&client, &format!("{runs_path}?limit=1"), Some(&agent_token)).await;
    let (archived_detail_status, _) = get_json(
        &client,
        &format!("{base}/api/automations/{archived_automation_id}"),
        Some(&board_token),
    )
    .await;
    let (archived_runs_status, archived_runs) = get_json(
        &client,
        &format!("{base}/api/automations/{archived_automation_id}/runs"),
        Some(&board_token),
    )
    .await;
    let (missing_status, _) = get_json(
        &client,
        &format!("{base}/api/automations/{}", Uuid::new_v4()),
        Some(&board_token),
    )
    .await;
    let (foreign_board_status, foreign_board) = get_json(
        &client,
        &format!("{base}/api/automations/{foreign_automation_id}"),
        Some(&board_token),
    )
    .await;
    let (foreign_agent_status, foreign_agent) = get_json(
        &client,
        &format!("{base}/api/orgs/{foreign_org_id}/automations"),
        Some(&agent_token),
    )
    .await;
    let (anonymous_status, anonymous) = get_json(&client, &list_path, None).await;
    let (fractional_status, _) = get_json(
        &client,
        &format!("{runs_path}?limit=1.5"),
        Some(&board_token),
    )
    .await;
    let head_status = client
        .head(&list_path)
        .insert_header((header::AUTHORIZATION, format!("Bearer {board_token}")))
        .send()
        .await
        .unwrap()
        .status();
    let node_requests_before_write = node_requests.load(Ordering::SeqCst);
    let mut invalid_trigger = client
        .post(format!("{base}/api/automations/{automation_id}/triggers"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {board_token}")))
        .send_json(&serde_json::json!({}))
        .await
        .unwrap();
    let invalid_trigger_status = invalid_trigger.status();
    let invalid_trigger_body: serde_json::Value = invalid_trigger.json().await.unwrap();
    let node_requests_after_invalid_trigger = node_requests.load(Ordering::SeqCst);
    // Management writes are native now; execution still belongs to Node.
    let mut write = client
        .post(format!("{base}/api/automations/{automation_id}/run"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {board_token}")))
        .send_json(&serde_json::json!({}))
        .await
        .unwrap();
    let write_status = write.status();
    let write_body: serde_json::Value = write.json().await.unwrap();
    let node_requests_after_write = node_requests.load(Ordering::SeqCst);

    let DatabaseState::Configured(native_pool) = &foundation.database else {
        panic!("public Automation ingress must keep its configured database pool");
    };
    native_pool.close().await;
    let (database_failure_status, _) = get_json(&client, &list_path, Some(&board_token)).await;
    let node_requests_after_failure = node_requests.load(Ordering::SeqCst);

    control.stop(true).await;
    task.await.unwrap().unwrap();
    node_handle.stop(true).await;
    node_task.await.unwrap().unwrap();

    sqlx::query("DELETE FROM board_api_keys WHERE id=$1::uuid")
        .bind(&board_key_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM board_api_keys WHERE id=$1::uuid")
        .bind(&other_board_key_id)
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
    sqlx::query("DELETE FROM organization_memberships WHERE org_id=$1::uuid AND principal_id=$2")
        .bind(&org_id)
        .bind(&other_user_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM chat_conversations WHERE id=$1::uuid")
        .bind(&private_chat_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM automations WHERE org_id IN ($1::uuid, $2::uuid)")
        .bind(&org_id)
        .bind(&foreign_org_id)
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
    sqlx::query(r#"DELETE FROM "user" WHERE id=$1"#)
        .bind(&other_user_id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    assert_eq!(board_list_status, StatusCode::OK);
    assert_eq!(board_list.as_array().unwrap().len(), 1);
    assert_eq!(board_list[0]["id"], automation_id);
    assert_eq!(board_list[0]["description"], "native read payload");
    assert_eq!(board_list[0]["updatedAt"], "0044-01-02T03:04:06.123Z");
    assert_eq!(
        board_list[0]["assigneeAgentRuntimeOverrides"]["nested"],
        json!([1, true])
    );
    assert_eq!(board_list[0]["triggers"][0]["label"], "Daily report");
    assert_eq!(board_list[0]["lastRun"]["id"], latest_run_id);
    assert!(
        !board_list
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == archived_automation_id)
    );
    assert_eq!(board_detail_status, StatusCode::OK);
    assert_eq!(board_detail["description"], "native read payload");
    assert_eq!(board_detail["recentRuns"][0]["id"], latest_run_id);
    assert_eq!(
        board_detail["recentRuns"][0]["failureReason"],
        "latest failure detail"
    );
    assert_eq!(
        board_detail["recentRuns"][0]["triggerPayload"]["secretLike"],
        "retained"
    );
    assert_eq!(
        board_detail["recentRuns"][0]["createdAt"],
        "2044-01-02T03:05:00.000Z"
    );
    assert_chat_visible(&board_list[0]["lastRun"], &private_chat_id, &agent_id);
    assert_chat_visible(&board_detail["recentRuns"][0], &private_chat_id, &agent_id);
    assert_chat_visible(&board_runs[0], &private_chat_id, &agent_id);
    assert_eq!(other_board_list_status, StatusCode::OK);
    assert_eq!(other_board_detail_status, StatusCode::OK);
    assert_eq!(other_board_runs_status, StatusCode::OK);
    assert_chat_hidden(&other_board_list[0]["lastRun"], &private_chat_id);
    assert_chat_hidden(&other_board_detail["recentRuns"][0], &private_chat_id);
    assert_chat_hidden(&other_board_runs[0], &private_chat_id);
    assert_eq!(agent_list_status, StatusCode::OK);
    assert_eq!(agent_detail_status, StatusCode::OK);
    assert_eq!(agent_runs_status, StatusCode::OK);
    assert_chat_hidden(&agent_list[0]["lastRun"], &private_chat_id);
    assert_chat_hidden(&agent_detail["recentRuns"][0], &private_chat_id);
    assert_chat_hidden(&agent_runs[0], &private_chat_id);
    assert_eq!(agent_detail["description"], "native read payload");
    assert_eq!(agent_detail["recentRuns"][0]["id"], latest_run_id);
    assert_eq!(
        agent_detail["recentRuns"][0]["failureReason"],
        "latest failure detail"
    );
    assert_eq!(
        agent_detail["recentRuns"][0]["triggerPayload"]["secretLike"],
        "retained"
    );
    assert_eq!(board_runs_status, StatusCode::OK);
    assert_eq!(board_runs.as_array().unwrap().len(), 1);
    assert_eq!(board_runs[0]["id"], latest_run_id);
    assert_eq!(board_runs[0]["trigger"]["label"], "Daily report");
    assert_ne!(old_run_id, latest_run_id);
    assert_eq!(archived_detail_status, StatusCode::NOT_FOUND);
    assert_eq!(archived_runs_status, StatusCode::OK);
    assert_eq!(archived_runs.as_array().unwrap().len(), 1);
    assert_eq!(missing_status, StatusCode::NOT_FOUND);
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
    assert!(fractional_status.is_server_error());
    assert_eq!(head_status, StatusCode::OK);
    assert_eq!(invalid_trigger_status, StatusCode::BAD_REQUEST);
    assert_eq!(
        invalid_trigger_body,
        json!({
            "error": "Validation error",
            "details": [{
                "code": "invalid_union_discriminator",
                "options": ["schedule", "webhook", "api"],
                "path": ["kind"],
                "message": "Invalid discriminator value. Expected 'schedule' | 'webhook' | 'api'"
            }]
        })
    );
    assert_eq!(
        node_requests_after_invalid_trigger, 0,
        "native management validation must not fall back to Node"
    );
    assert_eq!(write_status, StatusCode::OK);
    assert_eq!(
        write_body["nodePath"],
        format!("/api/automations/{automation_id}/run")
    );
    assert_eq!(node_requests_before_write, 0);
    assert_eq!(node_requests_after_write, 1);
    assert!(database_failure_status.is_server_error());
    assert_eq!(
        node_requests_after_failure, 1,
        "native database failures must not fall back to Node"
    );
}

fn automation_reads_runtime(
    database_url: Option<String>,
    upstream: &str,
) -> (Arc<AppState>, PublicIngressRuntime) {
    let foundation = Arc::new(
        AppState::new(ServerConfig {
            database_url,
            actor_envelope_key: Some(
                SigningKey::new(b"native-automation-read-envelope-key").unwrap(),
            ),
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
            "native-automation-read-agent-jwt-secret",
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
    .bind(format!("native-automation-read-{suffix}-{label}"))
    .bind(format!("Native Automation read {label}"))
    .bind(format!("AR{}{}", suffix[..7].to_ascii_uppercase(), label.to_ascii_uppercase()))
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn insert_user(pool: &PgPool, user_id: &str) {
    sqlx::query(
        r#"INSERT INTO "user" (id, name, email, created_at, updated_at)
           VALUES ($1, 'Native Automation Read User', $2, now(), now())"#,
    )
    .bind(user_id)
    .bind(format!("{user_id}@invalid.test"))
    .execute(pool)
    .await
    .unwrap();
}

fn assert_chat_visible(run: &serde_json::Value, chat_id: &str, agent_id: &str) {
    assert_eq!(run["linkedChatConversationId"], chat_id);
    assert_eq!(run["linkedChatConversation"]["id"], chat_id);
    assert_eq!(
        run["linkedChatConversation"]["title"],
        "OWNER_PRIVATE_AUTOMATION_CHAT"
    );
    assert_eq!(run["linkedChatConversation"]["preferredAgentId"], agent_id);
    assert_eq!(
        run["linkedChatConversation"]["lastMessageAt"],
        "2044-01-02T03:05:00.654Z"
    );
}

fn assert_chat_hidden(run: &serde_json::Value, chat_id: &str) {
    assert_eq!(run["linkedChatConversationId"], chat_id);
    assert_eq!(run["linkedChatConversation"]["id"], chat_id);
    assert_eq!(run["linkedChatConversation"]["title"], "Chat");
    assert_eq!(run["linkedChatConversation"]["status"], "active");
    assert_eq!(
        run["linkedChatConversation"]["preferredAgentId"],
        serde_json::Value::Null
    );
    assert_eq!(
        run["linkedChatConversation"]["lastMessageAt"],
        serde_json::Value::Null
    );
}
