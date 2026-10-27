use super::*;
use actix_web::{App, HttpServer};
use sqlx::PgPool;
use std::{
    env,
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
};

async fn call(
    client: &awc::Client,
    base: &str,
    method: Method,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = client.request(method, format!("{base}{path}"));
    if let Some(token) = token {
        request = request.insert_header((header::AUTHORIZATION, format!("Bearer {token}")));
    }
    let mut response = if let Some(body) = body {
        request.send_json(&body).await.unwrap()
    } else {
        request.send().await.unwrap()
    };
    let status = response.status();
    (status, response.json().await.unwrap())
}
async fn snapshot(pool: &PgPool, org: &str) -> String {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM organization_secrets s WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM organization_secret_versions v JOIN organization_secrets s ON s.id=v.secret_id WHERE s.org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM activity_log a WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM organization_mutation_outbox o WHERE org_id=$1::uuid))::text").bind(org).fetch_one(pool).await.unwrap()
}

#[actix_web::test]
#[ignore = "requires migrated disposable RUDDER_NATIVE_AUTH_TEST_DATABASE_URL and isolated secrets key file"]
async fn native_secret_writes_preserve_crypto_scope_receipts_rollback_and_no_fallback() {
    let url = env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap();
    assert!(
        url::Url::parse(&url)
            .unwrap()
            .path()
            .to_ascii_lowercase()
            .contains("test")
    );
    assert!(
        env::var_os("RUDDER_SECRETS_MASTER_KEY_FILE").is_some(),
        "use an isolated synthetic master-key file"
    );
    let pool = PgPool::connect(&url).await.unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let org = Uuid::new_v4().to_string();
    let foreign = Uuid::new_v4().to_string();
    for (id, label) in [(&org, "own"), (&foreign, "foreign")] {
        sqlx::query(
            "INSERT INTO organizations(id,name,url_key,issue_prefix) VALUES($1::uuid,$2,$3,$4)",
        )
        .bind(id)
        .bind(format!("Secret writes {label}"))
        .bind(format!("secret-write-{suffix}-{label}"))
        .bind(format!("SW{}{}", &suffix[..6], label))
        .execute(&pool)
        .await
        .unwrap();
    }
    let user = format!("secret-write-user-{suffix}");
    let foreign_user = format!("secret-write-foreign-{suffix}");
    let token = format!("secret-write-key-{suffix}");
    let foreign_token = format!("secret-write-foreign-key-{suffix}");
    for (user, org, token) in [
        (&user, &org, &token),
        (&foreign_user, &foreign, &foreign_token),
    ] {
        sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES($1,'Secret fixture',$2,now(),now())").bind(user).bind(format!("{user}@invalid.test")).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,status) VALUES($1::uuid,'user',$2,'active')").bind(org).bind(user).execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO board_api_keys(user_id,name,key_hash) VALUES($1,'Secret fixture',$2)",
        )
        .bind(user)
        .bind(crate::native_bearer_auth::hash_token(token))
        .execute(&pool)
        .await
        .unwrap();
    }
    let agent: String = sqlx::query_scalar("INSERT INTO agents(org_id,name,role,status) VALUES($1::uuid,'Secret fixture agent','general','idle') RETURNING id::text").bind(&org).fetch_one(&pool).await.unwrap();
    let agent_token = format!("secret-write-agent-{suffix}");
    sqlx::query("INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) VALUES($1::uuid,$2::uuid,'Secret fixture',$3)").bind(&org).bind(&agent).bind(crate::native_bearer_auth::hash_token(&agent_token)).execute(&pool).await.unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let node_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream = format!("http://{}", node_listener.local_addr().unwrap());
    let node = HttpServer::new({
        let count = count.clone();
        move || {
            let count = count.clone();
            App::new().default_service(web::to(move || {
                count.fetch_add(1, Ordering::SeqCst);
                async {
                    HttpResponse::InternalServerError()
                        .json(json!({"error":"Node fallback must not execute"}))
                }
            }))
        }
    })
    .workers(1)
    .listen(node_listener)
    .unwrap()
    .run();
    let node_control = node.handle();
    let node_task = actix_web::rt::spawn(node);
    let foundation = Arc::new(
        AppState::new(ServerConfig {
            database_url: Some(url),
            actor_envelope_key: Some(SigningKey::new(b"secret-write-test-envelope-key").unwrap()),
            workers: 1,
            ..ServerConfig::default()
        })
        .unwrap(),
    );
    let mut config = PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        &upstream,
        "secret-write-test-forwarding-key",
    )
    .unwrap();
    config.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            "secret-write-test-identity-assertion-key-0001",
            "secret-write-test-agent-jwt-secret-0001",
            "rudder-test",
            "rudder-api",
            false,
        )
        .unwrap(),
    );
    let runtime = PublicIngressRuntime::bind(config, foundation.clone()).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let create_path = format!("/api/orgs/{org}/secrets");
    let invalid = call(
        &client,
        &base,
        Method::POST,
        &create_path,
        None,
        Some(json!({})),
    )
    .await;
    assert_eq!(invalid.0, StatusCode::BAD_REQUEST);
    assert_eq!(invalid.1["details"][0]["path"], json!(["name"]));
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &create_path,
            None,
            Some(json!({"name":"Key","value":"synthetic-secret"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &create_path,
            Some(&agent_token),
            Some(json!({"name":"Key","value":"synthetic-secret"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let before = snapshot(&pool, &org).await;
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &create_path,
            Some(&foreign_token),
            Some(json!({"name":"Key","value":"synthetic-secret"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(snapshot(&pool, &org).await, before);
    let (status, created) = call(
        &client,
        &base,
        Method::POST,
        &create_path,
        Some(&token),
        Some(json!({"name":"Key","value":"synthetic-secret"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["latestVersion"], 1);
    assert!(created.get("value").is_none());
    let id = created["id"].as_str().unwrap();
    let path = format!("/api/secrets/{id}");
    let rotate = format!("{path}/rotate");
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &create_path,
            Some(&token),
            Some(json!({"name":"Key","value":"synthetic-duplicate"}))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &create_path,
            Some(&token),
            Some(json!({"name":"Unsupported","value":"synthetic-value","provider":"vault"}))
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let managed: String=sqlx::query_scalar("INSERT INTO organization_secrets(org_id,name,provider,purpose) VALUES($1::uuid,'Managed fixture','local_encrypted','managed_mcp_connection') RETURNING id::text").bind(&org).fetch_one(&pool).await.unwrap();
    for (method, path, body) in [
        (
            Method::POST,
            format!("/api/secrets/{managed}/rotate"),
            Some(json!({"value":"synthetic-value"})),
        ),
        (
            Method::PATCH,
            format!("/api/secrets/{managed}"),
            Some(json!({})),
        ),
        (Method::DELETE, format!("/api/secrets/{managed}"), None),
    ] {
        assert_eq!(
            call(&client, &base, method, &path, Some(&token), body)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }
    let before = snapshot(&pool, &org).await;
    sqlx::query("UPDATE organization_memberships SET status='inactive' WHERE org_id=$1::uuid AND principal_id=$2").bind(&org).bind(&user).execute(&pool).await.unwrap();
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &path,
            Some(&token),
            Some(json!({"name":"Revoked"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(snapshot(&pool, &org).await, before);
    sqlx::query("UPDATE organization_memberships SET status='active' WHERE org_id=$1::uuid AND principal_id=$2").bind(&org).bind(&user).execute(&pool).await.unwrap();
    let material:String=sqlx::query_scalar("SELECT material::text FROM organization_secret_versions WHERE secret_id=$1::uuid AND version=1").bind(id).fetch_one(&pool).await.unwrap();
    assert!(!material.contains("synthetic-secret"));
    assert!(material.contains("local_encrypted_v1"));
    let state = snapshot(&pool, &org).await;
    for (method, path, body) in [
        (
            Method::POST,
            rotate.as_str(),
            Some(json!({"value":"foreign-value"})),
        ),
        (
            Method::PATCH,
            path.as_str(),
            Some(json!({"name":"Foreign"})),
        ),
        (Method::DELETE, path.as_str(), None),
    ] {
        assert_eq!(
            call(&client, &base, method, path, Some(&foreign_token), body)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(snapshot(&pool, &org).await, state);
    let rotated = call(
        &client,
        &base,
        Method::POST,
        &rotate,
        Some(&token),
        Some(json!({"value":"synthetic-rotated"})),
    )
    .await;
    assert_eq!(rotated.0, StatusCode::OK);
    assert_eq!(rotated.1["latestVersion"], 2);
    let updated = call(
        &client,
        &base,
        Method::PATCH,
        &path,
        Some(&token),
        Some(json!({"name":"Renamed","description":null})),
    )
    .await;
    assert_eq!(updated.0, StatusCode::OK);
    assert_eq!(updated.1["name"], "Renamed");
    let trigger = format!("secret_write_fail_{}", &suffix[..12]);
    for target in ["activity_log", "organization_mutation_outbox"] {
        sqlx::raw_sql(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.org_id='{org}'::uuid THEN RAISE EXCEPTION 'synthetic secret receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER {trigger} BEFORE INSERT ON {target} FOR EACH ROW EXECUTE FUNCTION {trigger}();")).execute(&pool).await.unwrap();
        let before = snapshot(&pool, &org).await;
        for (method, path, body) in [
            (
                Method::POST,
                create_path.as_str(),
                Some(json!({"name":"Rollback","value":"synthetic-rollback"})),
            ),
            (
                Method::POST,
                rotate.as_str(),
                Some(json!({"value":"synthetic-rollback"})),
            ),
            (
                Method::PATCH,
                path.as_str(),
                Some(json!({"name":"Rollback"})),
            ),
            (Method::DELETE, path.as_str(), None),
        ] {
            assert_eq!(
                call(&client, &base, method, path, Some(&token), body)
                    .await
                    .0,
                StatusCode::INTERNAL_SERVER_ERROR
            );
            assert_eq!(snapshot(&pool, &org).await, before);
        }
        sqlx::raw_sql(&format!(
            "DROP TRIGGER {trigger} ON {target}; DROP FUNCTION {trigger}();"
        ))
        .execute(&pool)
        .await
        .unwrap();
    }
    assert_eq!(
        call(&client, &base, Method::DELETE, &path, Some(&token), None).await,
        (StatusCode::OK, json!({"ok":true}))
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &path,
            Some(&token),
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let actions: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM activity_log WHERE org_id=$1::uuid ORDER BY created_at,id",
    )
    .bind(&org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        actions,
        vec![
            "secret.created",
            "secret.rotated",
            "secret.updated",
            "secret.deleted"
        ]
    );
    let DatabaseState::Configured(native_pool) = &foundation.database else {
        unreachable!()
    };
    native_pool.close().await;
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &create_path,
            Some(&token),
            Some(json!({"name":"Unavailable","value":"synthetic-value"}))
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
    control.stop(true).await;
    task.await.unwrap().unwrap();
    node_control.stop(true).await;
    node_task.await.unwrap().unwrap();
    sqlx::query("DELETE FROM organization_mutation_outbox WHERE org_id IN($1::uuid,$2::uuid)")
        .bind(&org)
        .bind(&foreign)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM activity_log WHERE org_id IN($1::uuid,$2::uuid)")
        .bind(&org)
        .bind(&foreign)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM board_api_keys WHERE user_id IN($1,$2)")
        .bind(&user)
        .bind(&foreign_user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organization_memberships WHERE org_id IN($1::uuid,$2::uuid)")
        .bind(&org)
        .bind(&foreign)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organization_secrets WHERE org_id IN($1::uuid,$2::uuid)")
        .bind(&org)
        .bind(&foreign)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_api_keys WHERE agent_id=$1::uuid")
        .bind(&agent)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=$1::uuid")
        .bind(&agent)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organizations WHERE id IN($1::uuid,$2::uuid)")
        .bind(&org)
        .bind(&foreign)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM \"user\" WHERE id IN($1,$2)")
        .bind(&user)
        .bind(&foreign_user)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}
