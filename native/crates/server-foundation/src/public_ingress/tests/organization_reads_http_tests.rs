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

    let foundation = Arc::new(
        AppState::new(ServerConfig {
            database_url: Some(env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap()),
            actor_envelope_key: Some(SigningKey::new(SECRET.as_bytes()).unwrap()),
            workers: 1,
            ..ServerConfig::default()
        })
        .unwrap(),
    );
    let mut ingress =
        PublicIngressConfig::new("127.0.0.1:0".parse().unwrap(), &upstream, INTERNAL).unwrap();
    ingress.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            INTERNAL,
            "native-organization-read-agent-jwt-secret",
            "rudder-test",
            "rudder-api",
            true,
        )
        .unwrap(),
    );
    ingress.session_auth = Some(
        NativeSessionAuthConfig::new(NativeSessionAuthKind::BetterAuth, SECRET, false, INTERNAL)
            .unwrap(),
    );
    let runtime = PublicIngressRuntime::bind(ingress, foundation).unwrap();
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

    control.stop(true).await;
    task.await.unwrap().unwrap();
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
    sqlx::query("DELETE FROM session WHERE id=$1")
        .bind(&session_id)
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
