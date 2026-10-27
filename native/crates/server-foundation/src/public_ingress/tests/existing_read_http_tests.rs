use super::*;
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
};

#[actix_web::test]
#[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB"]
async fn native_existing_reads_keep_scope_owners_filters_artifact_streams_and_no_fallback() {
    let database_url =
        env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").expect("set migrated disposable DB URL");
    let pool = super::disposable_native_auth_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let mut orgs = Vec::new();
    for label in ["own", "foreign"] {
        orgs.push(sqlx::query_scalar::<_,String>("INSERT INTO organizations (url_key,name,issue_prefix) VALUES ($1,$2,$3) RETURNING id::text").bind(format!("existing-read-{suffix}-{label}")).bind(label).bind(format!("E{}{}",&suffix[..6],label)).fetch_one(&pool).await.unwrap());
    }
    let org = &orgs[0];
    let foreign = &orgs[1];
    let user = format!("existing-read-{suffix}");
    sqlx::query(r#"INSERT INTO "user" (id,name,email,created_at,updated_at) VALUES ($1,'Existing reader',$2,now(),now())"#).bind(&user).bind(format!("{user}@invalid.test")).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO organization_memberships (org_id,principal_type,principal_id,status) VALUES ($1::uuid,'user',$2,'active')").bind(org).bind(&user).execute(&pool).await.unwrap();
    let token = format!("pcp_existing_{suffix}");
    sqlx::query(
        "INSERT INTO board_api_keys (user_id,name,key_hash) VALUES ($1,'existing read',$2)",
    )
    .bind(&user)
    .bind(crate::native_bearer_auth::hash_token(&token))
    .execute(&pool)
    .await
    .unwrap();
    let agent=sqlx::query_scalar::<_,String>("INSERT INTO agents (org_id,name,role,status) VALUES ($1::uuid,'Existing read agent','general','idle') RETURNING id::text").bind(org).fetch_one(&pool).await.unwrap();
    let agent_token = format!("pcp_existing_agent_{suffix}");
    sqlx::query("INSERT INTO agent_api_keys (org_id,agent_id,name,key_hash) VALUES ($1::uuid,$2::uuid,'existing read',$3)").bind(org).bind(&agent).bind(crate::native_bearer_auth::hash_token(&agent_token)).execute(&pool).await.unwrap();
    let issue=sqlx::query_scalar::<_,String>("INSERT INTO issues (org_id,title,identifier,issue_number) VALUES ($1::uuid,'Existing read issue',$2,1) RETURNING id::text").bind(org).bind(format!("EX{}-1",&suffix[..6].to_ascii_uppercase())).fetch_one(&pool).await.unwrap();
    let chat=sqlx::query_scalar::<_,String>("INSERT INTO chat_conversations (org_id,conversation_kind,created_by_user_id,title) VALUES ($1::uuid,'side_chat',$2,'Private read chat') RETURNING id::text").bind(org).bind(&user).fetch_one(&pool).await.unwrap();
    for private in [false, true] {
        sqlx::query("INSERT INTO heartbeat_runs (org_id,agent_id,status,context_snapshot,chat_conversation_id) VALUES ($1::uuid,$2::uuid,'running',jsonb_build_object('issueId',$3::text,'scene',$4::text),$5::uuid)").bind(org).bind(&agent).bind(&issue).bind(if private {"side_chat"}else{"issue"}).bind(if private {Some(&chat)}else{None}).execute(&pool).await.unwrap();
    }
    let source=sqlx::query_scalar::<_,String>("INSERT INTO calendar_sources (org_id,name,owner_user_id) VALUES ($1::uuid,'Existing read source',$2) RETURNING id::text").bind(org).bind(&user).fetch_one(&pool).await.unwrap();
    let event=sqlx::query_scalar::<_,String>("INSERT INTO calendar_events (org_id,source_id,event_kind,event_status,owner_type,owner_user_id,title,start_at,end_at) VALUES ($1::uuid,$2::uuid,'human_event','planned','user',$3,'Existing read event','2026-10-01T01:00:00Z','2026-10-01T02:00:00Z') RETURNING id::text").bind(org).bind(&source).bind(&user).fetch_one(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO organization_secrets (org_id,name) VALUES ($1::uuid,'Existing read secret')",
    )
    .bind(org)
    .execute(&pool)
    .await
    .unwrap();
    let mut views = Vec::new();
    for (owner, label) in [(&user, "own"), ("other-reader", "other")] {
        views.push(sqlx::query_scalar::<_,String>("INSERT INTO messenger_saved_views (org_id,user_id,target_kind,target_payload,resource_key,instance_id,canonical_resource_key,title) VALUES ($1::uuid,$2,'browser','{}'::jsonb,$3,$3,$3,$3) RETURNING id::text").bind(org).bind(owner).bind(label).fetch_one(&pool).await.unwrap());
    }
    let artifacts = tempfile::tempdir().unwrap();
    let artifact = artifacts.path().join("legacy.json");
    let content = b"existing native backup read\n";
    std::fs::write(&artifact,serde_json::to_vec(&json!({"version":1,"orgId":org,"createdAt":"2026-10-01T00:00:00Z","rootPath":"/fixture/workspace","entries":[{"path":"hello.txt","kind":"file","byteSize":content.len(),"dataBase64":base64::engine::general_purpose::STANDARD.encode(content)}]})).unwrap()).unwrap();
    let backup=sqlx::query_scalar::<_,String>("INSERT INTO workspace_backups (org_id,status,artifact_ref,file_count,byte_size) VALUES ($1::uuid,'succeeded',$2,1,$3) RETURNING id::text").bind(org).bind(artifact.to_str().unwrap()).bind(content.len() as i64).fetch_one(&pool).await.unwrap();
    let running=sqlx::query_scalar::<_,String>("INSERT INTO workspace_backups (org_id,status,artifact_ref) VALUES ($1::uuid,'running',$2) RETURNING id::text").bind(org).bind(artifact.to_str().unwrap()).fetch_one(&pool).await.unwrap();
    let (v2_path, v2_hash) = v2_artifact(artifacts.path(), org);
    let v2 = sqlx::query_scalar::<_,String>("INSERT INTO workspace_backups (org_id,status,artifact_ref,archive_sha256,file_count,byte_size) VALUES ($1::uuid,'succeeded',$2,$3,1,3145728) RETURNING id::text")
        .bind(org).bind(v2_path.to_str().unwrap()).bind(&v2_hash).fetch_one(&pool).await.unwrap();
    let before = snapshot(&pool, org).await;
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
    let (foundation, runtime) = existing_runtime(Some(database_url), &upstream);
    let address = runtime.bound_addr();
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let base = format!("http://{address}");
    let client = awc::Client::default();
    let paths = [
        format!("/api/orgs/{org}/secret-providers"),
        format!("/api/orgs/{org}/secrets"),
        format!("/api/orgs/{org}/calendar/sources"),
        format!(
            "/api/orgs/{org}/calendar/events?start=2026-10-01T00:00:00Z&end=2026-10-02T00:00:00Z"
        ),
        format!("/api/orgs/{org}/calendar/events/{event}"),
        format!("/api/orgs/{org}/messenger/saved-views"),
        format!("/api/orgs/{org}/messenger/saved-views/{}", views[0]),
        format!("/api/orgs/{org}/live-runs"),
        format!("/api/issues/{issue}/live-runs"),
        format!("/api/orgs/{org}/workspace/backups"),
        format!("/api/orgs/{org}/workspace/backups/{backup}/files"),
        format!("/api/orgs/{org}/workspace/backups/{backup}/file?path=hello.txt"),
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
        let mut head = client
            .head(format!("{base}{path}"))
            .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
            .send()
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::OK, "HEAD {path}");
        assert!(head.body().await.unwrap().is_empty());
    }
    assert_eq!(
        get(&client, &base, &paths[1], Some(&token))
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        get(&client, &base, &paths[5], Some(&token)).await.1["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        get(
            &client,
            &base,
            &format!("/api/orgs/{org}/messenger/saved-views/{}", views[1]),
            Some(&token)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(&client, &base, &paths[7], Some(&token))
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        get(&client, &base, &paths[7], Some(&agent_token))
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        get(&client, &base, &paths[8], Some(&agent_token))
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        get(
            &client,
            &base,
            &format!("/api/orgs/{foreign}/live-runs"),
            Some(&agent_token)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for path in [&paths[0], &paths[1], &paths[2], &paths[5], &paths[9]] {
        assert_eq!(
            get(&client, &base, path, Some(&agent_token)).await.0,
            StatusCode::FORBIDDEN,
            "{path}"
        );
    }
    for path in [
        format!("{}?unknown=true", paths[5]),
        format!("{}?primaryRailPinned=false", paths[5]),
        format!("{}?limit=1&limit=2", paths[5]),
        format!("/api/orgs/{org}/calendar/events?start=bad&end=bad"),
    ] {
        assert_eq!(
            get(&client, &base, &path, Some(&token)).await.0,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
    assert_eq!(
        get(
            &client,
            &base,
            &format!("/api/orgs/{org}/workspace/backups/{running}/files"),
            Some(&token)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        get(
            &client,
            &base,
            &format!("/api/orgs/{org}/workspace/backups/{backup}/file?path=..%2Fescape"),
            Some(&token)
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let download = format!("/api/orgs/{org}/workspace/backups/{backup}/download");
    assert_eq!(
        get(&client, &base, &download, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    let mut response = client
        .get(format!("{base}{download}"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/zip"
    );
    let length = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .unwrap()
        .to_str()
        .unwrap()
        .parse::<usize>()
        .unwrap();
    let bytes = response.body().await.unwrap();
    assert_eq!(bytes.len(), length);
    assert!(bytes.starts_with(b"PK"));
    let mut head = client
        .head(format!("{base}{download}"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(head.status(), StatusCode::OK);
    assert!(head.body().await.unwrap().is_empty());
    let download = format!("/api/orgs/{org}/workspace/backups/{v2}/download");
    let mut v2_response = client
        .get(format!("{base}{download}"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(v2_response.status(), StatusCode::OK);
    assert_eq!(
        v2_response
            .headers()
            .get("x-rudder-archive-sha256")
            .unwrap()
            .to_str()
            .unwrap(),
        v2_hash
    );
    assert_eq!(
        v2_response
            .body()
            .limit(5 * 1024 * 1024)
            .await
            .unwrap()
            .as_ref(),
        std::fs::read(&v2_path).unwrap()
    );
    sqlx::query("UPDATE workspace_backups SET archive_sha256='bad' WHERE id=$1::uuid")
        .bind(&v2)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        get(&client, &base, &download, Some(&token)).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    sqlx::query("UPDATE workspace_backups SET archive_sha256=$2 WHERE id=$1::uuid")
        .bind(&v2)
        .bind(&v2_hash)
        .execute(&pool)
        .await
        .unwrap();
    let permits = foundation.config.workers;
    let response = client
        .get(format!("{base}{download}"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
        .send()
        .await
        .unwrap();
    drop(response);
    for _ in 0..100 {
        if foundation.download_admission.available_permits() == permits {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(
        foundation.download_admission.available_permits(),
        permits,
        "disconnect must release admission"
    );
    assert_eq!(
        before,
        snapshot(&pool, org).await,
        "public reads must not mutate business data"
    );
    assert_eq!(node_count.load(Ordering::SeqCst), 0);
    sqlx::query("UPDATE organization_memberships SET status='suspended' WHERE org_id=$1::uuid AND principal_id=$2").bind(org).bind(&user).execute(&pool).await.unwrap();
    assert_eq!(
        get(&client, &base, &paths[0], Some(&token)).await.0,
        StatusCode::FORBIDDEN
    );
    let DatabaseState::Configured(native_pool) = &foundation.database else {
        panic!("configured native pool")
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
    assert_eq!(node_count.load(Ordering::SeqCst), 0);
    node_control.stop(true).await;
    node_task.await.unwrap().unwrap();
    for table in [
        "workspace_backups",
        "messenger_saved_views",
        "organization_secrets",
        "calendar_events",
        "calendar_sources",
        "heartbeat_runs",
        "chat_conversations",
        "issues",
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
async fn snapshot(pool: &sqlx::PgPool, org: &str) -> Vec<String> {
    let mut rows = Vec::new();
    for table in [
        "workspace_backups",
        "messenger_saved_views",
        "organization_secrets",
        "calendar_events",
        "calendar_sources",
        "heartbeat_runs",
    ] {
        rows.push(sqlx::query_scalar(&format!("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM {table} t WHERE org_id=$1::uuid")).bind(org).fetch_one(pool).await.unwrap());
    }
    rows
}
fn existing_runtime(
    database_url: Option<String>,
    upstream: &str,
) -> (Arc<AppState>, PublicIngressRuntime) {
    let foundation = Arc::new(
        AppState::new(ServerConfig {
            database_url,
            actor_envelope_key: Some(SigningKey::new(b"existing-read-envelope-key").unwrap()),
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
            "existing-agent-jwt-secret",
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

fn v2_artifact(root: &std::path::Path, org: &str) -> (std::path::PathBuf, String) {
    let source = root.join("root.txt");
    let content = vec![b'x'; 3 * 1024 * 1024];
    std::fs::write(&source, &content).unwrap();
    let file_hash = format!("{:x}", Sha256::digest(&content));
    let tree_hash = format!(
        "{:x}",
        Sha256::digest(format!("root.txt\0file\0{}\0{file_hash}\n", content.len()).as_bytes())
    );
    let manifest = root.join("manifest.json");
    std::fs::write(&manifest,serde_json::to_vec(&json!({
        "version":2,"policyVersion":"workspace-backup-v2-policy-1",
        "identity":{"orgId":org,"instanceId":"test","rootPath":"/fixture/workspace"},
        "createdAt":"2026-10-01T00:00:00.000Z",
        "entries":[{"path":"root.txt","kind":"file","byteSize":content.len(),"mtimeMs":null,"mode":null,"sha256":file_hash}],
        "treeSha256":tree_hash,"warnings":[]
    })).unwrap()).unwrap();
    let plan = root.join("plan.json");
    std::fs::write(&plan,serde_json::to_vec(&json!({
        "protocolVersion":1,"manifestSource":manifest,"treeSha256":tree_hash,
        "entries":[{"kind":"directory","archivePath":"workspace/"},{"kind":"file","archivePath":"workspace/root.txt","sourcePath":source}]
    })).unwrap()).unwrap();
    let archive = root.join("workspace.zip");
    let created = rudder_archive_core::create_archive(
        &plan,
        &archive,
        116 * 1024 * 1024,
        5 * 1024 * 1024,
        100 * 1024 * 1024,
    )
    .unwrap();
    (archive, created.sha256)
}
