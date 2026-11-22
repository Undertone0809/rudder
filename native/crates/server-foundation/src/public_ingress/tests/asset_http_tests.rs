use super::*;
use actix_web::{App, HttpServer};
use serde_json::{Value, json};
use std::{net::TcpListener, sync::Arc};

fn multipart(
    filename: &str,
    content_type: &str,
    content: &[u8],
    namespace: Option<&str>,
) -> Vec<u8> {
    let mut body = Vec::new();
    if let Some(namespace) = namespace {
        body.extend_from_slice(format!("--asset-boundary\r\nContent-Disposition: form-data; name=\"namespace\"\r\n\r\n{namespace}\r\n").as_bytes());
    }
    body.extend_from_slice(format!("--asset-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(content);
    body.extend_from_slice(b"\r\n--asset-boundary--\r\n");
    body
}

#[actix_web::test]
#[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing to disposable migrated PostgreSQL"]
async fn public_assets_persist_sanitize_scope_and_fail_without_node() {
    let pool = super::disposable_native_auth_pool().await;
    // Validate fixture identity and required schema before starting any listeners.
    let db: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!db.is_empty());
    for table in [
        "assets",
        "activity_log",
        "organization_mutation_outbox",
        "organizations",
        "agents",
        "agent_api_keys",
        "instance_settings",
    ] {
        let exists: bool = sqlx::query_scalar("SELECT to_regclass($1) IS NOT NULL")
            .bind(table)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(exists, "missing fixture table {table}");
    }
    let suffix = Uuid::new_v4().simple().to_string();
    let mut orgs = Vec::new();
    for marker in ["own", "foreign"] {
        let org:String=sqlx::query_scalar("INSERT INTO organizations(url_key,name,issue_prefix) VALUES($1,$2,$3) RETURNING id::text")
            .bind(format!("asset-{marker}-{suffix}")).bind(format!("Asset {marker}")).bind(format!("A{}{}",&suffix[..8],marker)).fetch_one(&pool).await.unwrap();
        orgs.push(org);
    }
    let org = &orgs[0];
    let foreign = &orgs[1];
    let agent:String=sqlx::query_scalar("INSERT INTO agents(org_id,name,role,status) VALUES($1::uuid,'Asset agent','general','idle') RETURNING id::text").bind(org).fetch_one(&pool).await.unwrap();
    let token = format!("pcp_asset_{suffix}");
    sqlx::query("INSERT INTO agent_api_keys(agent_id,org_id,name,key_hash) VALUES($1::uuid,$2::uuid,'Asset HTTP',$3)").bind(&agent).bind(org).bind(crate::native_bearer_auth::hash_token(&token)).execute(&pool).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let storage_root = dir.path().join("storage");
    std::fs::create_dir(&storage_root).unwrap();
    let node_calls = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let node = HttpServer::new({
        let calls = node_calls.clone();
        move || {
            let calls = calls.clone();
            App::new().default_service(web::to(move || {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    HttpResponse::Ok().json(json!({"legacyInvoked":true}))
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
    let foundation = Arc::new(
        crate::AppState::new(crate::ServerConfig {
            database_url: Some(env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap()),
            actor_envelope_key: Some(
                rudder_auth_core::SigningKey::new(b"asset-http-actor-envelope-key").unwrap(),
            ),
            workers: 1,
            ..crate::ServerConfig::default()
        })
        .unwrap(),
    );
    let mut config = crate::PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        &upstream,
        "asset-http-ingress-forwarding-key",
    )
    .unwrap();
    config.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            "asset-http-identity-assertion-key",
            "asset-http-agent-jwt-secret",
            "rudder-test",
            "rudder-api",
            false,
        )
        .unwrap(),
    );
    config.issue_asset_storage = Some(
        crate::issue_asset_storage::NativeIssueAssetStorage::from_config(
            crate::issue_asset_storage::IssueAssetStorageConfig::LocalDisk {
                local_disk_base_dir: storage_root.to_str().unwrap().into(),
            },
        )
        .unwrap(),
    );
    // This fixture checks anonymous denial, so use authenticated ingress.
    config.deployment_mode = "authenticated".into();
    let mut unavailable_config = config.clone();
    unavailable_config.issue_asset_storage = None;
    let runtime = PublicIngressRuntime::bind(config, foundation.clone()).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = reqwest::Client::new();
    let form_type = "multipart/form-data; boundary=asset-boundary";
    let svg=br##"<svg xmlns="http://www.w3.org/2000/svg" onload="bad()"><script>bad()</script><foreignObject><div>bad</div></foreignObject><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><path d="M0 0" fill="url(#g)"/><use href="#g"/><image href="https://evil.test"/></svg>"##;
    let response = client
        .post(format!("{base}/API/ORGS/{org}/ASSETS/IMAGES/"))
        .bearer_auth(&token)
        .header("content-type", form_type)
        .body(multipart(
            "vector.svg",
            "image/svg+xml",
            svg,
            Some("issues/inline"),
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CREATED);
    let asset: Value = response.json().await.unwrap();
    let id = asset["assetId"].as_str().unwrap();
    let key = asset["objectKey"].as_str().unwrap();
    assert!(key.starts_with(&format!("{org}/assets/issues/inline/")));
    assert_eq!(asset["createdByAgentId"], agent);
    assert!(asset["createdByUserId"].is_null());
    for field in ["createdAt", "updatedAt"] {
        let stamp = asset[field].as_str().unwrap();
        assert_eq!(stamp.len(), 24);
        assert!(stamp.ends_with('Z'));
    }
    let stored = std::fs::read(storage_root.join(key)).unwrap();
    let sanitized = String::from_utf8(stored.clone()).unwrap();
    for banned in ["onload", "script", "foreignObject", "https://evil"] {
        assert!(!sanitized.contains(banned));
    }
    assert!(sanitized.contains("linearGradient"));
    assert!(sanitized.contains("url(#g)"));
    assert_eq!(asset["byteSize"], stored.len());
    let counts:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM assets WHERE id=$1::uuid AND org_id=$2::uuid),(SELECT count(*) FROM activity_log WHERE org_id=$2::uuid AND entity_id=$1 AND action='asset.created')").bind(id).bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (1, 1));
    let response = client
        .get(format!("{base}/api/assets/{id}/content"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/svg+xml");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert!(
        response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .starts_with("sandbox;")
    );
    assert_eq!(response.bytes().await.unwrap().as_ref(), stored.as_slice());
    let response = client
        .head(format!("{base}/api/assets/{id}/content?download=1"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert!(
        response.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment;")
    );
    assert!(response.bytes().await.unwrap().is_empty());
    for (route, ct, bytes, expected) in [
        (
            format!("/api/orgs/{org}/logo"),
            "image/png",
            b"png".as_slice(),
            201,
        ),
        (
            format!("/api/orgs/{org}/logo"),
            "text/html",
            b"html".as_slice(),
            422,
        ),
        (
            format!("/api/orgs/{foreign}/assets/images"),
            "image/png",
            b"foreign".as_slice(),
            403,
        ),
        (
            format!("/api/orgs/{org}/assets/images"),
            "image/svg+xml",
            b"<svg><g></svg>".as_slice(),
            422,
        ),
    ] {
        let response = client
            .post(format!("{base}{route}"))
            .bearer_auth(&token)
            .header("content-type", form_type)
            .body(multipart("input.png", ct, bytes, None))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected, "{route}");
    }
    let unauthorized = client
        .get(format!("{base}/api/assets/{id}/content"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), 401);
    for (filename, ct, bytes, namespace, expected) in [
        ("empty.png", "image/png", Vec::new(), None, 422),
        (
            "invalid.png",
            "image/png",
            b"png".to_vec(),
            Some("../invalid"),
            400,
        ),
        (
            "oversized.png",
            "image/png",
            vec![b'x'; 10 * 1024 * 1024 + 1],
            None,
            422,
        ),
    ] {
        let before = file_count(&storage_root);
        let response = client
            .post(format!("{base}/api/orgs/{org}/assets/images"))
            .bearer_auth(&token)
            .header("content-type", form_type)
            .body(multipart(filename, ct, &bytes, namespace))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), expected, "{filename}");
        assert_eq!(file_count(&storage_root), before);
    }
    // HTML remains downloadable, never an active inline document.
    let response = client
        .post(format!("{base}/api/orgs/{org}/assets/images"))
        .bearer_auth(&token)
        .header("content-type", form_type)
        .body(multipart(
            "page.html",
            "text/html",
            b"<script>alert(1)</script>",
            None,
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 201);
    let html: Value = response.json().await.unwrap();
    let response = client
        .get(format!("{base}{}", html["contentPath"].as_str().unwrap()))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.headers()["content-type"],
        "application/octet-stream"
    );
    assert!(
        response.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment;")
    );
    assert!(
        response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("form-action 'none'")
    );
    // Existing foreign Asset must be denied before any storage access.
    let foreign_asset:String=sqlx::query_scalar("INSERT INTO assets(org_id,provider,object_key,content_type,byte_size,sha256) VALUES($1::uuid,'local_disk',$2,'image/png',1,'x') RETURNING id::text").bind(foreign).bind(format!("{foreign}/missing.png")).fetch_one(&pool).await.unwrap();
    let response = client
        .get(format!("{base}/api/assets/{foreign_asset}/content"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    // Storage failure has no SQL or audit side effect and does not invoke Node.
    let moved = dir.path().join("preserved-storage");
    std::fs::rename(&storage_root, &moved).unwrap();
    std::fs::write(&storage_root, b"storage-blocker").unwrap();
    let response = client
        .post(format!("{base}/api/orgs/{org}/assets/images"))
        .bearer_auth(&token)
        .header("content-type", form_type)
        .body(multipart(
            "storage-failure.png",
            "image/png",
            b"failure",
            None,
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 500);
    let no_row:i64=sqlx::query_scalar("SELECT count(*) FROM assets WHERE org_id=$1::uuid AND original_filename='storage-failure.png'").bind(org).fetch_one(&pool).await.unwrap();
    assert_eq!(no_row, 0);
    std::fs::remove_file(&storage_root).unwrap();
    std::fs::rename(&moved, &storage_root).unwrap();
    // A database rejection removes the staged object, preserving preexisting bytes.
    let before = file_count(&storage_root);
    sqlx::query("ALTER TABLE assets ADD CONSTRAINT asset_http_rollback CHECK (original_filename IS DISTINCT FROM 'database-failure.png')").execute(&pool).await.unwrap();
    let response = client
        .post(format!("{base}/api/orgs/{org}/assets/images"))
        .bearer_auth(&token)
        .header("content-type", form_type)
        .body(multipart(
            "database-failure.png",
            "image/png",
            b"failure",
            None,
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 500);
    assert_eq!(file_count(&storage_root), before);
    sqlx::query("ALTER TABLE assets DROP CONSTRAINT asset_http_rollback")
        .execute(&pool)
        .await
        .unwrap();
    let unavailable = PublicIngressRuntime::bind(unavailable_config, foundation).unwrap();
    let unavailable_base = format!("http://{}", unavailable.bound_addr());
    let unavailable_control = unavailable.control();
    let unavailable_task = actix_web::rt::spawn(unavailable.run());
    let response = client
        .post(format!("{unavailable_base}/api/orgs/{org}/assets/images"))
        .bearer_auth(&token)
        .header("content-type", form_type)
        .body(multipart("unavailable.png", "image/png", b"failure", None))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 503);
    let no_row: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM assets WHERE org_id=$1::uuid AND original_filename='unavailable.png'",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(no_row, 0);
    unavailable_control.stop(true).await;
    unavailable_task.await.unwrap().unwrap();
    assert_eq!(node_calls.load(Ordering::SeqCst), 0);
    control.stop(true).await;
    task.await.unwrap().unwrap();
    node_control.stop(true).await;
    node_task.await.unwrap().unwrap();
    for org in orgs {
        sqlx::query("DELETE FROM organizations WHERE id=$1::uuid")
            .bind(org)
            .execute(&pool)
            .await
            .unwrap();
    }
}
fn file_count(path: &std::path::Path) -> usize {
    std::fs::read_dir(path)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            if path.is_dir() { file_count(&path) } else { 1 }
        })
        .sum()
}
