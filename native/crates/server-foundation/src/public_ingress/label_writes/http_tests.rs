use super::*;
use actix_web::{App, HttpServer};
use sqlx::PgPool;
use std::{
    env,
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::time::{Duration, Instant, sleep};

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
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM labels t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.issue_id,t.label_id) FROM issue_labels t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM activity_log t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM organization_mutation_outbox t WHERE org_id=$1::uuid))::text").bind(org).fetch_one(pool).await.unwrap()
}
async fn blocked_on(pool: &PgPool, blocker: i32) {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        let blocked: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)))",
        )
        .bind(blocker)
        .fetch_one(pool)
        .await
        .unwrap();
        if blocked {
            return;
        }
        assert!(
            Instant::now() < until,
            "public Label write must reach the actual row lock"
        );
        sleep(Duration::from_millis(10)).await;
    }
}

#[actix_web::test]
#[ignore = "requires migrated disposable RUDDER_NATIVE_AUTH_TEST_DATABASE_URL"]
async fn native_label_writes_preserve_validation_scope_receipts_revocation_rollback_and_no_fallback()
 {
    let url = env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap();
    assert!(
        url::Url::parse(&url)
            .unwrap()
            .path()
            .to_ascii_lowercase()
            .contains("test")
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
        .bind(format!("Label writes {label}"))
        .bind(format!("label-write-{suffix}-{label}"))
        .bind(format!("CW{}{}", &suffix[..6], label))
        .execute(&pool)
        .await
        .unwrap();
    }
    let user = format!("label-write-user-{suffix}");
    let foreign_user = format!("label-write-foreign-{suffix}");
    let token = format!("label-write-key-{suffix}");
    let foreign_token = format!("label-write-foreign-key-{suffix}");
    for (user, org, token) in [
        (&user, &org, &token),
        (&foreign_user, &foreign, &foreign_token),
    ] {
        sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES($1,'Label fixture',$2,now(),now())").bind(user).bind(format!("{user}@invalid.test")).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,status) VALUES($1::uuid,'user',$2,'active')").bind(org).bind(user).execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO board_api_keys(user_id,name,key_hash) VALUES($1,'Label fixture',$2)",
        )
        .bind(user)
        .bind(crate::native_bearer_auth::hash_token(token))
        .execute(&pool)
        .await
        .unwrap();
    }
    let agent: String = sqlx::query_scalar("INSERT INTO agents(org_id,name,role,status) VALUES($1::uuid,'Label fixture agent','general','idle') RETURNING id::text").bind(&org).fetch_one(&pool).await.unwrap();
    let agent_token = format!("label-write-agent-{suffix}");
    sqlx::query("INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) VALUES($1::uuid,$2::uuid,'Label fixture',$3)").bind(&org).bind(&agent).bind(crate::native_bearer_auth::hash_token(&agent_token)).execute(&pool).await.unwrap();
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
            actor_envelope_key: Some(
                SigningKey::new(b"label-write-test-envelope-key-0001").unwrap(),
            ),
            workers: 1,
            ..ServerConfig::default()
        })
        .unwrap(),
    );
    let mut config = PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        &upstream,
        "label-write-test-forwarding-key-0001",
    )
    .unwrap();
    config.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            "label-write-test-identity-assertion-key-0001",
            "label-write-test-agent-jwt-secret-0001",
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
    let collection = format!("/api/orgs/{org}/labels");
    let missing = format!("/api/labels/{}", Uuid::new_v4());
    let input =
        json!({"name":" \u{feff}Roadmap\n","color":"#aB10Ef","actorId":"forged","unknown":true});
    let empty = snapshot(&pool, &org).await;
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &collection,
            None,
            Some(input.clone())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../d1-persistence/src/label_writes-validation-cases.json"
    ))
    .unwrap();
    for case in cases
        .iter()
        .filter(|c| c.get("issues").is_some() && c.get("input").is_none_or(Value::is_object))
    {
        let (method, path) = if case["operation"] == "create" {
            (Method::POST, collection.as_str())
        } else {
            (Method::PATCH, missing.as_str())
        };
        assert_eq!(
            call(
                &client,
                &base,
                method,
                path,
                Some(&token),
                case.get("input").cloned()
            )
            .await,
            (
                StatusCode::BAD_REQUEST,
                json!({"error":"Validation error","details":case["issues"]})
            ),
            "{case}"
        );
    }
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &collection,
            None,
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST,
        "schema middleware precedes actor access"
    );
    assert_eq!(snapshot(&pool, &org).await, empty);
    let created = call(
        &client,
        &base,
        Method::POST,
        &collection,
        Some(&token),
        Some(input.clone()),
    )
    .await;
    assert_eq!(created.0, StatusCode::CREATED, "{}", created.1);
    assert_eq!(created.1["name"], "Roadmap");
    assert_eq!(created.1["color"], "#aB10Ef");
    assert_eq!(created.1["orgId"], org);
    assert_eq!(created.1.as_object().unwrap().len(), 6);
    for field in ["createdAt", "updatedAt"] {
        assert!(created.1[field].as_str().unwrap().ends_with('Z'));
    }
    let id = created.1["id"].as_str().unwrap().to_owned();
    let path = format!("/API/LABELS/{id}/");
    let listed = call(&client, &base, Method::GET, &collection, Some(&token), None).await;
    assert_eq!(listed.0, StatusCode::OK);
    assert!(listed.1.as_array().unwrap().contains(&created.1));
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &collection,
            Some(&token),
            Some(input)
        )
        .await,
        (
            StatusCode::CONFLICT,
            json!({"error":"Label already exists: Roadmap"})
        )
    );
    let lower = call(
        &client,
        &base,
        Method::POST,
        &collection,
        Some(&agent_token),
        Some(json!({"name":"roadmap","color":"#123456"})),
    )
    .await;
    assert_eq!(
        lower.0,
        StatusCode::CREATED,
        "case-sensitive names remain distinct"
    );
    let lower_id = lower.1["id"].as_str().unwrap().to_owned();
    let lower_path = format!("/api/labels/{lower_id}");
    let foreign_label: String = sqlx::query_scalar("INSERT INTO labels(org_id,name,color) VALUES($1::uuid,'Roadmap','#ABCDEF') RETURNING id::text").bind(&foreign).fetch_one(&pool).await.unwrap();
    let foreign_path = format!("/api/labels/{foreign_label}");
    let foreign_collection = format!("/api/orgs/{foreign}/labels");
    let before = snapshot(&pool, &org).await;
    for (key, message) in [
        (&token, "User does not have access to this organization"),
        (&agent_token, "Agent key cannot access another organization"),
    ] {
        for (method, path, body) in [
            (
                Method::POST,
                foreign_collection.as_str(),
                Some(json!({"name":"Forbidden","color":"#123456"})),
            ),
            (
                Method::PATCH,
                foreign_path.as_str(),
                Some(json!({"name":"Forbidden"})),
            ),
            (Method::DELETE, foreign_path.as_str(), None),
        ] {
            assert_eq!(
                call(&client, &base, method, path, Some(key), body).await,
                (StatusCode::FORBIDDEN, json!({"error":message}))
            );
        }
    }
    assert_eq!(snapshot(&pool, &org).await, before);
    let updated = call(
        &client,
        &base,
        Method::PATCH,
        &path,
        Some(&agent_token),
        Some(json!({"name":" \u{feff}Updated\n","color":"#Aa00bB","unknown":"stripped"})),
    )
    .await;
    assert_eq!(updated.0, StatusCode::OK);
    assert_eq!(updated.1["name"], "Updated");
    assert_eq!(updated.1["color"], "#Aa00bB");
    let board_update = call(
        &client,
        &base,
        Method::PATCH,
        &lower_path,
        Some(&token),
        Some(json!({"name":"Board label"})),
    )
    .await;
    assert_eq!(board_update.0, StatusCode::OK);
    assert_eq!(board_update.1["color"], "#123456");
    let issue: String=sqlx::query_scalar("INSERT INTO issues(org_id,title) VALUES($1::uuid,'Label cascade fixture') RETURNING id::text").bind(&org).fetch_one(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO issue_labels(org_id,issue_id,label_id) VALUES($1::uuid,$2::uuid,$3::uuid)",
    )
    .bind(&org)
    .bind(&issue)
    .bind(&id)
    .execute(&pool)
    .await
    .unwrap();
    let failure = format!("label_write_fail_{}", &suffix[..12]);
    for target in ["activity_log", "organization_mutation_outbox"] {
        sqlx::raw_sql(&format!("CREATE FUNCTION {failure}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.org_id='{org}'::uuid THEN RAISE EXCEPTION 'synthetic Label receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER {failure} BEFORE INSERT ON {target} FOR EACH ROW EXECUTE FUNCTION {failure}();")).execute(&pool).await.unwrap();
        let before = snapshot(&pool, &org).await;
        for (method, path, body) in [
            (
                Method::POST,
                collection.as_str(),
                Some(json!({"name":"Rollback","color":"#123456"})),
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
            assert_eq!(
                snapshot(&pool, &org).await,
                before,
                "Label/link/audit/outbox must all roll back"
            );
        }
        sqlx::raw_sql(&format!(
            "DROP TRIGGER {failure} ON {target}; DROP FUNCTION {failure}();"
        ))
        .execute(&pool)
        .await
        .unwrap();
    }
    // The auth check must run after the awaited mutation row lock on the same TX.
    for (method, table, key) in [
        (Method::PATCH, "board_api_keys", token.as_str()),
        (Method::DELETE, "agent_api_keys", agent_token.as_str()),
    ] {
        let mut locker = pool.begin().await.unwrap();
        let blocker: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *locker)
            .await
            .unwrap();
        sqlx::query("SELECT id FROM labels WHERE id=$1::uuid FOR UPDATE")
            .bind(&id)
            .execute(&mut *locker)
            .await
            .unwrap();
        let before = snapshot(&pool, &org).await;
        let base = base.clone();
        let path = path.clone();
        let key_owned = key.to_owned();
        let pending = actix_web::rt::spawn(async move {
            call(
                &awc::Client::default(),
                &base,
                method.clone(),
                &path,
                Some(&key_owned),
                (method == Method::PATCH).then(|| json!({"name":"Revoked write"})),
            )
            .await
        });
        blocked_on(&pool, blocker).await;
        let key_hash = crate::native_bearer_auth::hash_token(key);
        sqlx::query(&format!(
            "UPDATE {table} SET revoked_at=now() WHERE key_hash=$1"
        ))
        .bind(&key_hash)
        .execute(&pool)
        .await
        .unwrap();
        locker.commit().await.unwrap();
        let denied = tokio::time::timeout(Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            denied,
            (StatusCode::UNAUTHORIZED, json!({"error":"Unauthorized"}))
        );
        assert_eq!(snapshot(&pool, &org).await, before);
        sqlx::query(&format!(
            "UPDATE {table} SET revoked_at=NULL WHERE key_hash=$1"
        ))
        .bind(key_hash)
        .execute(&pool)
        .await
        .unwrap();
    }
    assert_eq!(
        call(
            &client,
            &base,
            Method::DELETE,
            &path,
            Some(&agent_token),
            None
        )
        .await,
        (StatusCode::OK, updated.1)
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::DELETE,
            &lower_path,
            Some(&token),
            None
        )
        .await,
        (StatusCode::OK, board_update.1)
    );
    let links: i64 =
        sqlx::query_scalar("SELECT count(*) FROM issue_labels WHERE issue_id=$1::uuid")
            .bind(&issue)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(links, 0);
    let issues: i64 = sqlx::query_scalar("SELECT count(*) FROM issues WHERE id=$1::uuid")
        .bind(&issue)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(issues, 1);
    for (method, body) in [
        (Method::PATCH, Some(json!({"name":"Missing"}))),
        (Method::DELETE, None),
    ] {
        assert_eq!(
            call(&client, &base, method, &missing, Some(&token), body).await,
            (StatusCode::NOT_FOUND, json!({"error":"Label not found"}))
        );
    }
    let receipts: i64=sqlx::query_scalar("SELECT count(*) FROM activity_log a JOIN organization_mutation_outbox o ON o.activity_id=a.id AND o.org_id=a.org_id WHERE a.org_id=$1::uuid AND a.entity_type='label' AND o.event_type='activity.logged' AND o.payload->>'action'=a.action AND o.payload->>'entityType'=a.entity_type AND o.payload->>'entityId'=a.entity_id AND o.payload->>'actorType'=a.actor_type AND o.payload->>'actorId'=a.actor_id AND o.payload->'details'=a.details AND a.run_id IS NULL").bind(&org).fetch_one(&pool).await.unwrap();
    assert_eq!(receipts, 6);
    let rows: Vec<(String,String,String,Option<String>,Value)>=sqlx::query_as("SELECT action,actor_type,actor_id,agent_id::text,details FROM activity_log WHERE org_id=$1::uuid ORDER BY created_at,id").bind(&org).fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len(), 6);
    for ((action, kind, actor, agent_id, details), (expected_action, expected_kind, name, color)) in
        rows.iter().zip([
            ("label.created", "user", "Roadmap", "#aB10Ef"),
            ("label.created", "agent", "roadmap", "#123456"),
            ("label.updated", "agent", "Updated", "#Aa00bB"),
            ("label.updated", "user", "Board label", "#123456"),
            ("label.deleted", "agent", "Updated", "#Aa00bB"),
            ("label.deleted", "user", "Board label", "#123456"),
        ])
    {
        assert_eq!(action, expected_action);
        assert_eq!(kind, expected_kind);
        assert_eq!(actor, if kind == "agent" { &agent } else { &user });
        assert_eq!(
            agent_id.as_deref(),
            (kind == "agent").then_some(agent.as_str())
        );
        assert_eq!(*details, json!({"name":name,"color":color}));
    }
    let before = snapshot(&pool, &org).await;
    if let DatabaseState::Configured(native_pool) = &foundation.database {
        native_pool.close().await;
    }
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &collection,
            Some(&token),
            Some(json!({"name":"Unavailable","color":"#123456"}))
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(snapshot(&pool, &org).await, before);
    assert_eq!(count.load(Ordering::SeqCst), 0);
    control.stop(true).await;
    task.await.unwrap().unwrap();
    node_control.stop(true).await;
    node_task.await.unwrap().unwrap();
    // Remove only this test's scoped rows, preserving the disposable DB and migrations.
    for table in [
        "organization_mutation_outbox",
        "activity_log",
        "issue_labels",
        "labels",
        "issues",
        "agent_api_keys",
        "agents",
        "organization_memberships",
    ] {
        sqlx::query(&format!(
            "DELETE FROM {table} WHERE org_id=ANY($1::text[]::uuid[])"
        ))
        .bind(vec![org.clone(), foreign.clone()])
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query("DELETE FROM board_api_keys WHERE user_id=ANY($1)")
        .bind(vec![user.clone(), foreign_user.clone()])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organizations WHERE id=ANY($1::text[]::uuid[])")
        .bind(vec![org, foreign])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM \"user\" WHERE id=ANY($1)")
        .bind(vec![user, foreign_user])
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}
