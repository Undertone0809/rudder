use super::*;
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
use std::{
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
};

#[actix_web::test]
#[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB"]
async fn native_organization_list_and_detail_match_projection_scope_and_node_boundaries() {
    let pool = super::disposable_native_auth_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let org_id = insert_organization(&pool, &suffix, "one").await;
    let foreign_org_id = insert_organization(&pool, &suffix, "two").await;
    let user_id = format!("native-org-read-user-{suffix}");
    let admin_user_id = format!("native-org-read-admin-{suffix}");
    insert_user(&pool, &user_id, "Member").await;
    insert_user(&pool, &admin_user_id, "Admin").await;
    sqlx::query(
        "INSERT INTO organization_memberships (org_id, principal_type, principal_id, status) VALUES ($1::uuid, 'user', $2, 'active')",
    )
    .bind(&org_id)
    .bind(&user_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO instance_user_roles (user_id, role) VALUES ($1, 'instance_admin')")
        .bind(&admin_user_id)
        .execute(&pool)
        .await
        .unwrap();

    let session_token = format!("native-org-read-session-{suffix}");
    let session_id = format!("native-org-read-session-row-{suffix}");
    sqlx::query(
        r#"INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())"#,
    )
    .bind(&session_id)
    .bind(&session_token)
    .bind(&user_id)
    .execute(&pool)
    .await
    .unwrap();

    let board_token = format!("pcp_native_org_read_board_{suffix}");
    let board_key_id: String = sqlx::query_scalar(
        "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'organization read member', $2) RETURNING id::text",
    )
    .bind(&user_id)
    .bind(crate::native_bearer_auth::hash_token(&board_token))
    .fetch_one(&pool)
    .await
    .unwrap();
    let admin_board_token = format!("pcp_native_org_read_admin_{suffix}");
    let admin_board_key_id: String = sqlx::query_scalar(
        "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'organization read admin', $2) RETURNING id::text",
    )
    .bind(&admin_user_id)
    .bind(crate::native_bearer_auth::hash_token(&admin_board_token))
    .fetch_one(&pool)
    .await
    .unwrap();

    let agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, 'Organization Read Agent', 'general', 'idle') RETURNING id::text",
    )
    .bind(&org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let agent_token = format!("pcp_native_org_read_agent_{suffix}");
    let agent_key_id: String = sqlx::query_scalar(
        "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash) VALUES ($1::uuid, $2::uuid, 'organization read agent', $3) RETURNING id::text",
    )
    .bind(&agent_id)
    .bind(&org_id)
    .bind(crate::native_bearer_auth::hash_token(&agent_token))
    .fetch_one(&pool)
    .await
    .unwrap();

    let asset_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO assets (id, org_id, provider, object_key, content_type, byte_size, sha256) VALUES ($1::uuid, $2::uuid, 'local', $3, 'image/png', 1, $4)",
    )
    .bind(&asset_id)
    .bind(&org_id)
    .bind(format!("native-org-read-{suffix}"))
    .bind("a".repeat(64))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO organization_logos (org_id, asset_id) VALUES ($1::uuid, $2::uuid)")
        .bind(&org_id)
        .bind(&asset_id)
        .execute(&pool)
        .await
        .unwrap();
    let alias = format!("OLD{}", suffix[..8].to_ascii_uppercase());
    sqlx::query(
        "INSERT INTO organization_issue_prefix_aliases (org_id, prefix) VALUES ($1::uuid, $2)",
    )
    .bind(&org_id)
    .bind(&alias)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE organizations SET description='Projection detail', status='paused', pause_reason='maintenance', paused_at='2026-01-14 12:13:14.123Z', issue_counter=42, budget_monthly_cents=9000, require_board_approval_for_new_agents=false, default_chat_issue_creation_mode='automatic', brand_color='#123abc' WHERE id=$1::uuid",
    )
    .bind(&org_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO cost_events (org_id, agent_id, provider, model, cost_cents, occurred_at) VALUES ($1::uuid, $2::uuid, 'test', 'org-read-test', 321, now())",
    )
    .bind(&org_id)
    .bind(&agent_id)
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

    let (foundation, runtime) = organization_reads_runtime(
        Some(env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap()),
        &upstream,
        true,
    );
    let address = runtime.bound_addr();
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let base = format!("http://{address}");
    let session_cookie = super::signed_cookie("better-auth.session_token", &session_token, SECRET);

    let mut list = client
        .get(format!("{base}/API/ORGS/"))
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send()
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::OK);
    let list_body: serde_json::Value = list.json().await.unwrap();
    assert_eq!(list_body.as_array().unwrap().len(), 1);
    assert_eq!(list_body[0]["id"], org_id);
    assert_eq!(list_body[0]["spentMonthlyCents"], 321);
    assert_eq!(
        list_body[0]["issuePrefixAliases"],
        serde_json::json!([alias])
    );

    let detail_url = format!("{base}/API/ORGS/{org_id}/");
    let mut detail = client
        .get(&detail_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send()
        .await
        .unwrap();
    assert_eq!(detail.status(), StatusCode::OK);
    let detail_body: serde_json::Value = detail.json().await.unwrap();
    let mut keys = detail_body
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(
        keys,
        [
            "brandColor",
            "budgetMonthlyCents",
            "createdAt",
            "defaultChatIssueCreationMode",
            "description",
            "id",
            "issueCounter",
            "issuePrefix",
            "issuePrefixAliases",
            "logoAssetId",
            "logoUrl",
            "name",
            "pauseReason",
            "pausedAt",
            "requireBoardApprovalForNewAgents",
            "spentMonthlyCents",
            "status",
            "updatedAt",
            "urlKey",
            "workspace",
        ]
        .map(str::to_owned)
    );
    assert_eq!(detail_body["description"], "Projection detail");
    assert_eq!(detail_body["status"], "paused");
    assert_eq!(detail_body["pauseReason"], "maintenance");
    assert_eq!(detail_body["pausedAt"], "2026-01-14T12:13:14.123Z");
    assert_eq!(detail_body["issueCounter"], 42);
    assert_eq!(detail_body["budgetMonthlyCents"], 9000);
    assert_eq!(detail_body["spentMonthlyCents"], 321);
    assert_eq!(detail_body["requireBoardApprovalForNewAgents"], false);
    assert_eq!(detail_body["defaultChatIssueCreationMode"], "automatic");
    assert_eq!(detail_body["brandColor"], "#123abc");
    assert_eq!(detail_body["logoAssetId"], asset_id);
    assert_eq!(
        detail_body["logoUrl"],
        format!("/api/assets/{asset_id}/content")
    );
    assert_eq!(
        detail_body["issuePrefixAliases"],
        serde_json::json!([alias])
    );
    assert_eq!(detail_body["workspace"], serde_json::Value::Null);
    assert_eq!(node_requests.load(Ordering::SeqCst), 0);

    let mut head = client
        .head(&detail_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send()
        .await
        .unwrap();
    assert_eq!(head.status(), StatusCode::OK);
    assert!(head.headers().contains_key(header::CONTENT_LENGTH));
    assert!(head.body().await.unwrap().is_empty());

    let mut board_list = client
        .get(format!("{base}/api/orgs"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {board_token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(board_list.status(), StatusCode::OK);
    let board_list_body: serde_json::Value = board_list.json().await.unwrap();
    assert_eq!(board_list_body.as_array().unwrap().len(), 1);
    assert_eq!(board_list_body[0]["id"], org_id);

    let mut admin_list = client
        .get(format!("{base}/api/orgs"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {admin_board_token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(admin_list.status(), StatusCode::OK);
    let admin_list_body: serde_json::Value = admin_list.json().await.unwrap();
    assert!(
        admin_list_body
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == org_id)
    );
    assert!(
        admin_list_body
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == foreign_org_id)
    );
    let mut missing_detail = client
        .get(format!(
            "{base}/api/orgs/60000000-0000-4000-8000-000000000099"
        ))
        .insert_header((header::AUTHORIZATION, format!("Bearer {admin_board_token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_detail.status(), StatusCode::NOT_FOUND);
    let missing_detail_body: serde_json::Value = missing_detail.json().await.unwrap();
    assert_eq!(
        missing_detail_body,
        serde_json::json!({"error":"Organization not found"})
    );

    let mut agent_detail = client
        .get(&detail_url)
        .insert_header((header::AUTHORIZATION, format!("Bearer {agent_token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(agent_detail.status(), StatusCode::OK);
    let agent_detail_body: serde_json::Value = agent_detail.json().await.unwrap();
    assert_eq!(agent_detail_body["id"], org_id);
    let mut agent_foreign = client
        .get(format!("{base}/api/orgs/{foreign_org_id}"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {agent_token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(agent_foreign.status(), StatusCode::FORBIDDEN);
    let agent_foreign_body: serde_json::Value = agent_foreign.json().await.unwrap();
    assert_eq!(
        agent_foreign_body,
        serde_json::json!({"error":"Agent key cannot access another organization"})
    );
    let mut agent_list = client
        .get(format!("{base}/api/orgs"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {agent_token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(agent_list.status(), StatusCode::FORBIDDEN);
    let agent_list_body: serde_json::Value = agent_list.json().await.unwrap();
    assert_eq!(
        agent_list_body,
        serde_json::json!({"error":"Board access required"})
    );
    assert_eq!(node_requests.load(Ordering::SeqCst), 0);

    sqlx::query("UPDATE board_api_keys SET revoked_at=now() WHERE id=$1::uuid")
        .bind(&board_key_id)
        .execute(&pool)
        .await
        .unwrap();
    let mut revoked_board = client
        .get(format!("{base}/api/orgs"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {board_token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(revoked_board.status(), StatusCode::UNAUTHORIZED);
    let revoked_board_body: serde_json::Value = revoked_board.json().await.unwrap();
    assert_eq!(revoked_board_body["reason"], "unauthorized");
    assert_eq!(node_requests.load(Ordering::SeqCst), 0);

    sqlx::query(
        "UPDATE organization_memberships SET status='inactive' WHERE org_id=$1::uuid AND principal_id=$2",
    )
    .bind(&org_id)
    .bind(&user_id)
    .execute(&pool)
    .await
    .unwrap();
    let mut inactive_list = client
        .get(format!("{base}/api/orgs"))
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send()
        .await
        .unwrap();
    assert_eq!(inactive_list.status(), StatusCode::OK);
    let inactive_list_body: serde_json::Value = inactive_list.json().await.unwrap();
    assert!(inactive_list_body.as_array().unwrap().is_empty());
    let mut inactive_detail = client
        .get(&detail_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send()
        .await
        .unwrap();
    assert_eq!(inactive_detail.status(), StatusCode::FORBIDDEN);
    let inactive_detail_body: serde_json::Value = inactive_detail.json().await.unwrap();
    assert_eq!(
        inactive_detail_body,
        serde_json::json!({"error":"User does not have access to this organization"})
    );

    sqlx::query("DELETE FROM session WHERE id=$1")
        .bind(&session_id)
        .execute(&pool)
        .await
        .unwrap();
    let mut revoked_session = client
        .get(&detail_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send()
        .await
        .unwrap();
    assert_eq!(revoked_session.status(), StatusCode::UNAUTHORIZED);
    let revoked_session_body: serde_json::Value = revoked_session.json().await.unwrap();
    assert_eq!(revoked_session_body["reason"], "unauthorized");
    assert_eq!(node_requests.load(Ordering::SeqCst), 0);

    let mut local_list = client.get(format!("{base}/api/orgs")).send().await.unwrap();
    assert_eq!(local_list.status(), StatusCode::OK);
    let local_list_body: serde_json::Value = local_list.json().await.unwrap();
    assert!(
        local_list_body
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == org_id)
    );
    assert!(
        local_list_body
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == foreign_org_id)
    );

    for path in ["/api/orgs/stats/", "/API/ORGS/ISSUES/"] {
        let mut response = client.get(format!("{base}{path}")).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["nodePath"], path);
    }
    assert_eq!(node_requests.load(Ordering::SeqCst), 2);

    let DatabaseState::Configured(database_pool) = &foundation.database else {
        panic!("the HTTP runtime must keep its configured database pool");
    };
    database_pool.close().await;
    for path in [
        "/api/orgs",
        "/api/orgs/60000000-0000-4000-8000-000000000099",
    ] {
        let mut response = client.get(format!("{base}{path}")).send().await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::INTERNAL_SERVER_ERROR,
            "{path}"
        );
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "internal_server_error", "{path}");
    }
    let configured_write_node_count = node_requests.load(Ordering::SeqCst);
    let mut unavailable_create = client
        .post(format!("{base}/api/orgs"))
        .send_json(&serde_json::json!({"name":format!("Unavailable Create {suffix}")}))
        .await
        .unwrap();
    assert_eq!(
        unavailable_create.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let unavailable_create_body: serde_json::Value = unavailable_create.json().await.unwrap();
    assert_eq!(unavailable_create_body["reason"], "mutation_failed");
    assert_eq!(
        node_requests.load(Ordering::SeqCst),
        configured_write_node_count
    );
    assert_eq!(node_requests.load(Ordering::SeqCst), 2);

    control.stop(true).await;
    task.await.unwrap().unwrap();

    let (_authenticated_foundation, authenticated_runtime) = organization_reads_runtime(
        Some(env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap()),
        &upstream,
        false,
    );
    let authenticated_base = format!("http://{}", authenticated_runtime.bound_addr());
    let authenticated_control = authenticated_runtime.control();
    let authenticated_task = actix_web::rt::spawn(authenticated_runtime.run());
    let mut anonymous_list = client
        .get(format!("{authenticated_base}/api/orgs"))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous_list.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        anonymous_list.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"error":"Unauthorized"})
    );
    let mut agent_list = client
        .get(format!("{authenticated_base}/api/orgs"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {agent_token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(agent_list.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        agent_list.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"error":"Board access required"})
    );
    assert_eq!(node_requests.load(Ordering::SeqCst), 2);
    authenticated_control.stop(true).await;
    authenticated_task.await.unwrap().unwrap();

    let (_disabled_foundation, disabled_runtime) =
        organization_reads_runtime(None, &upstream, true);
    let disabled_address = disabled_runtime.bound_addr();
    let disabled_control = disabled_runtime.control();
    let disabled_task = actix_web::rt::spawn(disabled_runtime.run());
    let disabled_base = format!("http://{disabled_address}");
    for path in [
        "/api/orgs",
        "/api/orgs/60000000-0000-4000-8000-000000000099",
    ] {
        let mut response = client
            .get(format!("{disabled_base}{path}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE, "{path}");
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "database_disabled", "{path}");
    }
    let mut disabled_create = client
        .post(format!("{disabled_base}/api/orgs"))
        .send_json(&serde_json::json!({"name":format!("Disabled Create {suffix}")}))
        .await
        .unwrap();
    assert_eq!(disabled_create.status(), StatusCode::SERVICE_UNAVAILABLE);
    let disabled_create_body: serde_json::Value = disabled_create.json().await.unwrap();
    assert_eq!(disabled_create_body["reason"], "database_disabled");
    assert_eq!(node_requests.load(Ordering::SeqCst), 2);
    disabled_control.stop(true).await;
    disabled_task.await.unwrap().unwrap();

    node_handle.stop(true).await;
    node_task.await.unwrap().unwrap();

    sqlx::query("DELETE FROM cost_events WHERE org_id IN ($1::uuid, $2::uuid)")
        .bind(&org_id)
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM board_api_keys WHERE id IN ($1::uuid, $2::uuid)")
        .bind(&board_key_id)
        .bind(&admin_board_key_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_api_keys WHERE id=$1::uuid")
        .bind(&agent_key_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM instance_user_roles WHERE user_id=$1")
        .bind(&admin_user_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organization_memberships WHERE principal_id IN ($1, $2)")
        .bind(&user_id)
        .bind(&admin_user_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organization_logos WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organization_issue_prefix_aliases WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM assets WHERE id=$1::uuid")
        .bind(&asset_id)
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
    sqlx::query(r#"DELETE FROM "user" WHERE id IN ($1, $2)"#)
        .bind(&user_id)
        .bind(&admin_user_id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}

fn organization_reads_runtime(
    database_url: Option<String>,
    upstream: &str,
    local_implicit_enabled: bool,
) -> (Arc<AppState>, PublicIngressRuntime) {
    let foundation = Arc::new(
        AppState::new(ServerConfig {
            database_url,
            actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
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
            "native-organization-read-agent-jwt-secret",
            "rudder-test",
            "rudder-api",
            local_implicit_enabled,
        )
        .unwrap(),
    );
    ingress.session_auth = Some(
        NativeSessionAuthConfig::new(NativeSessionAuthKind::BetterAuth, SECRET, false, INTERNAL)
            .unwrap(),
    );
    let runtime = PublicIngressRuntime::bind(ingress, foundation.clone()).unwrap();
    (foundation, runtime)
}

async fn insert_organization(pool: &sqlx::PgPool, suffix: &str, label: &str) -> String {
    sqlx::query_scalar(
        "INSERT INTO organizations (url_key, name, issue_prefix) VALUES ($1, $2, $3) RETURNING id::text",
    )
    .bind(format!("native-org-read-{suffix}-{label}"))
    .bind(format!("Native organization read {label}"))
    .bind(format!("OR{}{}", suffix[..7].to_ascii_uppercase(), label.to_ascii_uppercase()))
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn insert_user(pool: &sqlx::PgPool, user_id: &str, label: &str) {
    sqlx::query(
        r#"INSERT INTO "user" (id, name, email, created_at, updated_at)
           VALUES ($1, $2, $3, now(), now())"#,
    )
    .bind(user_id)
    .bind(format!("Native Organization Read {label}"))
    .bind(format!("{user_id}@invalid.test"))
    .execute(pool)
    .await
    .unwrap();
}

#[actix_web::test]
#[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL and isolated organization workspace paths"]
async fn native_organization_create_update_branding_archive_and_delete_are_rust_owned() {
    let workspace_home = std::path::PathBuf::from(
        env::var("RUDDER_NATIVE_HOST_ORGANIZATION_WORKSPACE_HOME")
            .expect("the test runner must supply an isolated organization workspace home"),
    );
    let home_directory = env::var("RUDDER_NATIVE_HOST_HOME_DIRECTORY")
        .expect("the test runner must supply an isolated home directory");
    let process_working_directory = env::var("RUDDER_NATIVE_HOST_PROCESS_WORKING_DIRECTORY")
        .expect("the test runner must supply an isolated process working directory");
    let rudder_home = env::var("RUDDER_NATIVE_HOST_RUDDER_HOME")
        .expect("the test runner must supply an isolated Rudder home");
    assert!(workspace_home.is_absolute());
    assert!(std::path::Path::new(&home_directory).is_absolute());
    assert!(std::path::Path::new(&process_working_directory).is_absolute());
    assert!(std::path::Path::new(&rudder_home).is_absolute());
    assert_ne!(
        workspace_home,
        std::path::PathBuf::from(&home_directory).join("Documents/Rudder"),
        "the test must not write into the default user workspace"
    );
    assert!(env::var("RUDDER_NATIVE_HOST_INSTANCE_ID").is_ok());
    assert!(env::var("RUDDER_NATIVE_HOST_HOSTNAME").is_ok());

    let pool = super::disposable_native_auth_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let admin_id = format!("native-org-write-admin-{suffix}");
    let outsider_id = format!("native-org-write-outsider-{suffix}");
    insert_user(&pool, &admin_id, "Admin").await;
    insert_user(&pool, &outsider_id, "Outsider").await;
    sqlx::query("INSERT INTO instance_user_roles (user_id, role) VALUES ($1, 'instance_admin')")
        .bind(&admin_id)
        .execute(&pool)
        .await
        .unwrap();

    let session_token = format!("native-org-write-session-{suffix}");
    let session_id = format!("native-org-write-session-row-{suffix}");
    sqlx::query(
        r#"INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, now() + interval '1 hour', now(), now())"#,
    )
    .bind(&session_id)
    .bind(&session_token)
    .bind(&admin_id)
    .execute(&pool)
    .await
    .unwrap();
    let outsider_token = format!("pcp_native_org_write_outsider_{suffix}");
    let outsider_key_id: String = sqlx::query_scalar(
        "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'org write outsider', $2) RETURNING id::text",
    )
    .bind(&outsider_id)
    .bind(crate::native_bearer_auth::hash_token(&outsider_token))
    .fetch_one(&pool)
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

    let (foundation, runtime) = organization_reads_runtime(
        Some(env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap()),
        &upstream,
        true,
    );
    let address = runtime.bound_addr();
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let base = format!("http://{address}");
    let session_cookie = super::signed_cookie("better-auth.session_token", &session_token, SECRET);

    let denied_name = format!("Denied Organization {suffix}");
    let denied_create = client
        .post(format!("{base}/api/orgs"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {outsider_token}")))
        .send_json(&serde_json::json!({"name":denied_name}))
        .await
        .unwrap();
    assert_eq!(denied_create.status(), StatusCode::FORBIDDEN);
    let denied_url_key = format!("denied-organization-{suffix}");
    let denied_row_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organizations WHERE url_key=$1)")
            .bind(&denied_url_key)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!denied_row_exists);
    assert_eq!(node_requests.load(Ordering::SeqCst), 0);

    let organization_name = format!("North Star Operations {suffix}");
    let issue_prefix = format!("OR{}", suffix[..10].to_ascii_uppercase());
    let mut created = client
        .post(format!("{base}/API/ORGS/"))
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send_json(&serde_json::json!({
            "name": organization_name,
            "issuePrefix": issue_prefix,
            "description": "Initial description",
            "budgetMonthlyCents": 12000,
            "defaultChatIssueCreationMode": "auto_create",
            "requireBoardApprovalForNewAgents": false,
            "brandColor": "#123abc"
        }))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let created_body: serde_json::Value = created.json().await.unwrap();
    let organization_id = created_body["id"].as_str().unwrap().to_owned();
    assert_eq!(created_body["name"], organization_name);
    assert_eq!(
        created_body["urlKey"],
        format!("north-star-operations-{suffix}")
    );
    assert_eq!(created_body["issuePrefix"], issue_prefix);
    assert_eq!(created_body["budgetMonthlyCents"], 12000);
    assert_eq!(created_body["defaultChatIssueCreationMode"], "auto_create");
    assert_eq!(created_body["brandColor"], "#123abc");
    let organization_url = format!("{base}/api/orgs/{organization_id}/");
    let mut created_readback = client
        .get(&organization_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send()
        .await
        .unwrap();
    assert_eq!(created_readback.status(), StatusCode::OK);
    let created_readback_body: serde_json::Value = created_readback.json().await.unwrap();
    assert_eq!(created_readback_body["id"], organization_id);
    assert_eq!(created_readback_body["name"], organization_name);
    assert_eq!(created_readback_body["issuePrefix"], issue_prefix);
    assert_eq!(created_readback_body["spentMonthlyCents"], 0);
    let owner_membership: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM organization_memberships WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2 AND status='active' AND membership_role='owner')",
    )
    .bind(&organization_id)
    .bind(&admin_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(owner_membership);
    let defaults: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM labels WHERE org_id=$1::uuid AND (name,color) IN (('Bug','#ef4444'),('Feature','#a855f7'),('UI','#06b6d4'))",
    )
    .bind(&organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(defaults, 3);
    let created_activity: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM activity_log WHERE org_id=$1::uuid AND action='organization.created' AND actor_id=$2)",
    )
    .bind(&organization_id)
    .bind(&admin_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(created_activity);
    let created_analytics: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM product_analytics_events WHERE org_id=$1::uuid AND event_name='organization_created' AND dedupe_key='organization_created:'||$1::text AND properties->>'creation_path'='manual' AND properties->>'template_kind'='custom' AND properties->>'is_user_initiated'='true')",
    )
    .bind(&organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(created_analytics);
    let created_budget_policy: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM budget_policies WHERE org_id=$1::uuid AND scope_type='organization' AND scope_id=$1::uuid AND metric='billed_cents' AND window_kind='calendar_month_utc' AND amount=12000 AND is_active)",
    )
    .bind(&organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(created_budget_policy);
    let budget_activity: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM activity_log WHERE org_id=$1::uuid AND action='budget.policy_upserted' AND entity_type='budget_policy')",
    )
    .bind(&organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(budget_activity);
    let branding_owner: String = sqlx::query_scalar(
        "SELECT owner FROM organization_branding_mutation_state WHERE org_id=$1::uuid",
    )
    .bind(&organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(branding_owner, "rust");

    let workspace_map: serde_json::Value = serde_json::from_slice(
        &std::fs::read(workspace_home.join(".rudder-organizations.json")).unwrap(),
    )
    .unwrap();
    let workspace_record = workspace_map["organizations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["orgId"] == organization_id)
        .unwrap();
    assert_eq!(workspace_record["orgName"], organization_name);
    let workspace_path = workspace_home.join(workspace_record["folderName"].as_str().unwrap());
    assert!(workspace_path.is_dir());

    // Force a database failure after the filesystem workspace is prepared.
    // The failed transaction must remove only the workspace created for its
    // rolled-back organization, and must not fall through to Node.
    let trigger_suffix = Uuid::new_v4().simple().to_string();
    let trigger_function = format!("test_reject_org_created_{trigger_suffix}");
    let trigger_name = format!("test_reject_org_created_{trigger_suffix}");
    let rollback_name = format!("Rollback Compensation {suffix}");
    sqlx::query(&format!(
        "CREATE FUNCTION {trigger_function}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action='organization.created'
              AND NEW.details->>'name'='{rollback_name}' THEN
             RAISE EXCEPTION 'forced organization create rollback';
           END IF;
           RETURN NEW;
         END; $$"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(&format!(
        "CREATE TRIGGER {trigger_name} BEFORE INSERT ON activity_log
         FOR EACH ROW EXECUTE FUNCTION {trigger_function}()"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let rollback_url_key = format!("rollback-compensation-{suffix}");
    let failed_create = client
        .post(format!("{base}/api/orgs"))
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send_json(&serde_json::json!({"name":rollback_name}))
        .await
        .unwrap();
    assert_eq!(failed_create.status(), StatusCode::INTERNAL_SERVER_ERROR);
    sqlx::query(&format!("DROP TRIGGER {trigger_name} ON activity_log"))
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(&format!("DROP FUNCTION {trigger_function}()"))
        .execute(&pool)
        .await
        .unwrap();
    let rolled_back_row: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organizations WHERE url_key=$1)")
            .bind(&rollback_url_key)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!rolled_back_row);
    let rollback_workspace_map: serde_json::Value = serde_json::from_slice(
        &std::fs::read(workspace_home.join(".rudder-organizations.json")).unwrap(),
    )
    .unwrap();
    assert!(
        rollback_workspace_map["organizations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|record| record["orgName"] != rollback_name
                && record["folderName"] != format!("rollback-compensation-{suffix}"))
    );
    assert!(!workspace_home.join(&rollback_url_key).exists());
    assert_eq!(node_requests.load(Ordering::SeqCst), 0);

    let denied = client
        .patch(&organization_url)
        .insert_header((header::AUTHORIZATION, format!("Bearer {outsider_token}")))
        .send_json(&serde_json::json!({"name":"Must stay denied"}))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);

    let mut patched = client
        .patch(&organization_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .insert_header(("x-rudder-idempotency-key", "legacy-ignored-key"))
        .send_json(&serde_json::json!({
            "name": format!("North Star Updated {suffix}"),
            "description": null,
            "issuePrefix": format!("UP{}", &suffix[..10].to_ascii_uppercase()),
            "budgetMonthlyCents": 9000,
            "brandColor": "#abcdef"
        }))
        .await
        .unwrap();
    assert_eq!(patched.status(), StatusCode::OK);
    let patched_body: serde_json::Value = patched.json().await.unwrap();
    assert_eq!(patched_body["description"], serde_json::Value::Null);
    assert_eq!(patched_body["issuePrefixAliases"][0], issue_prefix);
    assert_eq!(patched_body["brandColor"], "#abcdef");
    let mut repeated_header = client
        .patch(&organization_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .insert_header(("x-rudder-idempotency-key", "legacy-ignored-key"))
        .send_json(&serde_json::json!({"name":format!("North Star Final {suffix}")}))
        .await
        .unwrap();
    assert_eq!(repeated_header.status(), StatusCode::OK);
    let repeated_body: serde_json::Value = repeated_header.json().await.unwrap();
    assert_eq!(repeated_body["name"], format!("North Star Final {suffix}"));

    let mut patched_readback = client
        .get(&organization_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send()
        .await
        .unwrap();
    assert_eq!(patched_readback.status(), StatusCode::OK);
    let patched_readback_body: serde_json::Value = patched_readback.json().await.unwrap();
    assert_eq!(
        patched_readback_body["name"],
        format!("North Star Final {suffix}")
    );
    assert_eq!(
        patched_readback_body["description"],
        serde_json::Value::Null
    );
    assert_eq!(
        patched_readback_body["issuePrefix"],
        format!("UP{}", suffix[..10].to_ascii_uppercase())
    );
    assert_eq!(patched_readback_body["issuePrefixAliases"][0], issue_prefix);
    assert_eq!(patched_readback_body["budgetMonthlyCents"], 9000);
    assert_eq!(patched_readback_body["brandColor"], "#abcdef");

    let foreign_org_id = insert_organization(&pool, &suffix, "foreign-logo").await;
    let foreign_asset_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO assets (id, org_id, provider, object_key, content_type, byte_size, sha256) VALUES ($1::uuid, $2::uuid, 'local', $3, 'image/png', 1, $4)",
    )
    .bind(&foreign_asset_id)
    .bind(&foreign_org_id)
    .bind(format!("native-org-write-foreign-{suffix}"))
    .bind("b".repeat(64))
    .execute(&pool)
    .await
    .unwrap();
    let rejected_foreign_logo = client
        .patch(&organization_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send_json(&serde_json::json!({"brandColor":"#445566","logoAssetId":foreign_asset_id}))
        .await
        .unwrap();
    assert_eq!(
        rejected_foreign_logo.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut after_foreign_logo = client
        .get(&organization_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send()
        .await
        .unwrap();
    let after_foreign_logo_body: serde_json::Value = after_foreign_logo.json().await.unwrap();
    assert_eq!(after_foreign_logo_body["brandColor"], "#abcdef");
    assert_eq!(
        after_foreign_logo_body["logoAssetId"],
        serde_json::Value::Null
    );

    let branding_key = format!("native-org-branding-{suffix}");
    let branding_url = format!("{base}/api/orgs/{organization_id}/branding");
    let branding_body = serde_json::json!({"brandColor":"#778899"});
    let mut branded = client
        .patch(&branding_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .insert_header(("x-rudder-idempotency-key", branding_key.as_str()))
        .send_json(&branding_body)
        .await
        .unwrap();
    assert_eq!(branded.status(), StatusCode::OK);
    let branded_body: serde_json::Value = branded.json().await.unwrap();
    assert_eq!(branded_body["brandColor"], "#778899");
    let replayed = client
        .patch(&branding_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .insert_header(("x-rudder-idempotency-key", branding_key.as_str()))
        .send_json(&branding_body)
        .await
        .unwrap();
    assert_eq!(replayed.status(), StatusCode::OK);
    let branding_receipt: Option<(String, String)> = sqlx::query_as(
        "SELECT idempotency_key, activity_id::text FROM organization_branding_mutation_receipts WHERE org_id=$1::uuid AND idempotency_key=$2",
    )
    .bind(&organization_id)
    .bind(&branding_key)
    .fetch_optional(&pool)
    .await
    .unwrap();
    let (receipt_key, receipt_activity_id) = branding_receipt.unwrap();
    assert_eq!(receipt_key, branding_key);
    let branding_activity_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND action='organization.branding_updated'",
    )
    .bind(&organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(branding_activity_count, 1);
    let receipt_activity_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM activity_log WHERE org_id=$1::uuid AND id=$2::uuid AND action='organization.branding_updated')",
    )
    .bind(&organization_id)
    .bind(&receipt_activity_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(receipt_activity_exists);
    let conflict = client
        .patch(&branding_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .insert_header(("x-rudder-idempotency-key", branding_key.as_str()))
        .send_json(&serde_json::json!({"brandColor":"#667788"}))
        .await
        .unwrap();
    assert_eq!(conflict.status(), StatusCode::CONFLICT);

    let mut archived = client
        .post(format!("{base}/api/orgs/{organization_id}/archive"))
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send()
        .await
        .unwrap();
    assert_eq!(archived.status(), StatusCode::OK);
    let archived_body: serde_json::Value = archived.json().await.unwrap();
    assert_eq!(archived_body["status"], "archived");
    let archived_activity_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND action='organization.archived'",
    )
    .bind(&organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(archived_activity_count, 1);

    let primary_project: String = sqlx::query_scalar(
        "INSERT INTO projects (org_id,name) VALUES ($1::uuid,$2) RETURNING id::text",
    )
    .bind(&organization_id)
    .bind(format!("Delete target project {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let primary_issue: String = sqlx::query_scalar(
        "INSERT INTO issues (org_id,project_id,title) VALUES ($1::uuid,$2::uuid,$3) RETURNING id::text",
    )
    .bind(&organization_id)
    .bind(&primary_project)
    .bind(format!("Delete target issue {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let primary_agent: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id,name) VALUES ($1::uuid,$2) RETURNING id::text",
    )
    .bind(&organization_id)
    .bind(format!("Delete target agent {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let primary_run: String = sqlx::query_scalar(
        "INSERT INTO heartbeat_runs (org_id,agent_id,status) VALUES ($1::uuid,$2::uuid,'completed') RETURNING id::text",
    )
    .bind(&organization_id)
    .bind(&primary_agent)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO runtime_source_aliases (org_id,run_id,source_kind,source_ref,principal_scope_ref)
         VALUES ($1::uuid,$2::uuid,'native','delete-lineage','test:delete-lineage')",
    )
    .bind(&organization_id)
    .bind(&primary_run)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO runtime_retention_claims (org_id,resource_ref,purpose,principal_scope_ref)
         VALUES ($1::uuid,'delete-lineage','organization-delete-test','test:delete-lineage')",
    )
    .bind(&organization_id)
    .execute(&pool)
    .await
    .unwrap();

    let foreign_agent: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id,name) VALUES ($1::uuid,$2) RETURNING id::text",
    )
    .bind(&foreign_org_id)
    .bind(format!("Foreign Delete Agent {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    for (org_id, agent_id, requester_id, key_suffix) in [
        (
            organization_id.as_str(),
            primary_agent.as_str(),
            admin_id.as_str(),
            "target",
        ),
        (
            foreign_org_id.as_str(),
            foreign_agent.as_str(),
            outsider_id.as_str(),
            "foreign",
        ),
    ] {
        sqlx::query(
            "INSERT INTO agent_issue_creation_requests (org_id,requested_by_user_id,agent_id,instruction,idempotency_key)
             VALUES ($1::uuid,$2,$3::uuid,'delete-order coverage',$4)",
        )
        .bind(org_id)
        .bind(requester_id)
        .bind(agent_id)
        .bind(format!("org-delete-{key_suffix}-{suffix}"))
        .execute(&pool)
        .await
        .unwrap();
    }
    let primary_calendar_source: String = sqlx::query_scalar(
        "INSERT INTO calendar_sources (org_id,name) VALUES ($1::uuid,$2) RETURNING id::text",
    )
    .bind(&organization_id)
    .bind(format!("Target calendar source {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let foreign_calendar_source: String = sqlx::query_scalar(
        "INSERT INTO calendar_sources (org_id,name) VALUES ($1::uuid,$2) RETURNING id::text",
    )
    .bind(&foreign_org_id)
    .bind(format!("Foreign calendar source {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    for (org_id, source_id, title) in [
        (
            organization_id.as_str(),
            primary_calendar_source.as_str(),
            "Target calendar event",
        ),
        (
            foreign_org_id.as_str(),
            foreign_calendar_source.as_str(),
            "Foreign calendar event",
        ),
    ] {
        sqlx::query(
            "INSERT INTO calendar_events (org_id,source_id,event_kind,event_status,owner_type,title,start_at,end_at)
             VALUES ($1::uuid,$2::uuid,'event','confirmed','user',$3,now(),now()+interval '1 hour')",
        )
        .bind(org_id)
        .bind(source_id)
        .bind(format!("{title} {suffix}"))
        .execute(&pool)
        .await
        .unwrap();
    }
    let foreign_project: String = sqlx::query_scalar(
        "INSERT INTO projects (org_id,name) VALUES ($1::uuid,$2) RETURNING id::text",
    )
    .bind(&foreign_org_id)
    .bind(format!("Foreign delete project {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let foreign_issue: String = sqlx::query_scalar(
        "INSERT INTO issues (org_id,project_id,title) VALUES ($1::uuid,$2::uuid,$3) RETURNING id::text",
    )
    .bind(&foreign_org_id)
    .bind(&foreign_project)
    .bind(format!("Foreign delete issue {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let foreign_run: String = sqlx::query_scalar(
        "INSERT INTO heartbeat_runs (org_id,agent_id,status) VALUES ($1::uuid,$2::uuid,'completed') RETURNING id::text",
    )
    .bind(&foreign_org_id)
    .bind(&foreign_agent)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO runtime_source_aliases (org_id,run_id,source_kind,source_ref,principal_scope_ref)
         VALUES ($1::uuid,$2::uuid,'native','foreign-delete-lineage','test:foreign-delete-lineage')",
    )
    .bind(&foreign_org_id)
    .bind(&foreign_run)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO runtime_retention_claims (org_id,resource_ref,purpose,principal_scope_ref)
         VALUES ($1::uuid,'foreign-delete-lineage','organization-delete-test','test:foreign-delete-lineage')",
    )
    .bind(&foreign_org_id)
    .execute(&pool)
    .await
    .unwrap();
    let lineage_before_delete: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM runtime_source_aliases a
         JOIN heartbeat_runs r ON r.org_id=a.org_id AND r.id=a.run_id
         JOIN issues i ON i.org_id=a.org_id
         JOIN projects p ON p.org_id=i.org_id AND p.id=i.project_id
         WHERE a.org_id=$1::uuid AND r.id=$2::uuid AND i.id=$3::uuid AND p.id=$4::uuid",
    )
    .bind(&organization_id)
    .bind(&primary_run)
    .bind(&primary_issue)
    .bind(&primary_project)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(lineage_before_delete, 1);

    let mut removed = client
        .delete(&organization_url)
        .insert_header((header::COOKIE, session_cookie.as_str()))
        .send()
        .await
        .unwrap();
    assert_eq!(removed.status(), StatusCode::OK);
    assert_eq!(
        removed.json::<serde_json::Value>().await.unwrap()["ok"],
        true
    );
    let map_after_delete: serde_json::Value = serde_json::from_slice(
        &std::fs::read(workspace_home.join(".rudder-organizations.json")).unwrap(),
    )
    .unwrap();
    assert!(
        map_after_delete["organizations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|record| record["orgId"] != organization_id)
    );
    assert!(!workspace_path.exists());
    assert_eq!(node_requests.load(Ordering::SeqCst), 0);
    for table in [
        "projects",
        "issues",
        "heartbeat_runs",
        "runtime_source_aliases",
        "runtime_retention_claims",
        "agent_issue_creation_requests",
        "calendar_events",
        "calendar_sources",
    ] {
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {table} WHERE org_id=$1::uuid"
        ))
        .bind(&organization_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0, "{table} rows remain for the deleted organization");
    }
    for (table, row_id) in [
        ("projects", foreign_project.as_str()),
        ("issues", foreign_issue.as_str()),
        ("heartbeat_runs", foreign_run.as_str()),
    ] {
        let exists: bool = sqlx::query_scalar(&format!(
            "SELECT EXISTS(SELECT 1 FROM {table} WHERE id=$1::uuid AND org_id=$2::uuid)"
        ))
        .bind(row_id)
        .bind(&foreign_org_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(exists, "{table} row for second organization was removed");
    }
    let foreign_retention_rows: i64 = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM runtime_source_aliases WHERE org_id=$1::uuid)
              + (SELECT count(*) FROM runtime_retention_claims WHERE org_id=$1::uuid)",
    )
    .bind(&foreign_org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(foreign_retention_rows, 2);
    for table in [
        "agent_issue_creation_requests",
        "calendar_events",
        "calendar_sources",
    ] {
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {table} WHERE org_id=$1::uuid"
        ))
        .bind(&foreign_org_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1, "{table} row for second organization was removed");
    }

    let local_name = format!("Local Board Organization {suffix}");
    let mut local_created = client
        .post(format!("{base}/api/orgs"))
        .send_json(&serde_json::json!({"name":local_name}))
        .await
        .unwrap();
    assert_eq!(local_created.status(), StatusCode::CREATED);
    let local_org: serde_json::Value = local_created.json().await.unwrap();
    let local_org_id = local_org["id"].as_str().unwrap().to_owned();
    let local_url = format!("{base}/api/orgs/{local_org_id}");
    let local_patch = client
        .patch(&local_url)
        .send_json(&serde_json::json!({"description":"local board update"}))
        .await
        .unwrap();
    assert_eq!(local_patch.status(), StatusCode::OK);
    let local_archive = client
        .post(format!("{base}/api/orgs/{local_org_id}/archive"))
        .send()
        .await
        .unwrap();
    assert_eq!(local_archive.status(), StatusCode::OK);
    let local_activity_rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT action,actor_type,actor_id FROM activity_log WHERE org_id=$1::uuid
         AND action IN ('organization.created','organization.updated','organization.archived')
         ORDER BY action",
    )
    .bind(&local_org_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        local_activity_rows,
        vec![
            (
                "organization.archived".to_owned(),
                "user".to_owned(),
                "local-board".to_owned()
            ),
            (
                "organization.created".to_owned(),
                "user".to_owned(),
                "local-board".to_owned()
            ),
            (
                "organization.updated".to_owned(),
                "user".to_owned(),
                "local-board".to_owned()
            ),
        ]
    );
    let local_delete = client.delete(&local_url).send().await.unwrap();
    assert_eq!(local_delete.status(), StatusCode::OK);
    assert_eq!(node_requests.load(Ordering::SeqCst), 0);

    sqlx::query("DELETE FROM agent_issue_creation_requests WHERE org_id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM calendar_events WHERE org_id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM calendar_sources WHERE org_id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM assets WHERE org_id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM runtime_source_aliases WHERE org_id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM runtime_retention_claims WHERE org_id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE org_id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE org_id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM projects WHERE org_id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=$1::uuid")
        .bind(&foreign_agent)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organizations WHERE id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();

    control.stop(true).await;
    let _ = task.await;
    node_handle.stop(true).await;
    let _ = node_task.await;
    let _ = foundation;
    sqlx::query("DELETE FROM board_api_keys WHERE id=$1::uuid")
        .bind(&outsider_key_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM session WHERE id=$1")
        .bind(&session_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(r#"DELETE FROM "user" WHERE id IN ($1, $2)"#)
        .bind(&admin_id)
        .bind(&outsider_id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}
