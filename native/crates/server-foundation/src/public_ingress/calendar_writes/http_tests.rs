use super::*;
use actix_web::{App, HttpServer};
use sqlx::PgPool;
use std::{
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
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM calendar_sources s WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM calendar_events e WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM activity_log a WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM organization_mutation_outbox o WHERE org_id=$1::uuid))::text").bind(org).fetch_one(pool).await.unwrap()
}

#[actix_web::test]
#[ignore = "requires migrated disposable RUDDER_NATIVE_AUTH_TEST_DATABASE_URL"]
async fn native_calendar_writes_preserve_validation_scope_privacy_rollback_and_no_fallback() {
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
        .bind(format!("Calendar writes {label}"))
        .bind(format!("calendar-write-{suffix}-{label}"))
        .bind(format!("CW{}{}", &suffix[..6], label))
        .execute(&pool)
        .await
        .unwrap();
    }
    let user = format!("calendar-write-user-{suffix}");
    let foreign_user = format!("calendar-write-foreign-{suffix}");
    let token = format!("calendar-write-key-{suffix}");
    let foreign_token = format!("calendar-write-foreign-key-{suffix}");
    for (user, org, token) in [
        (&user, &org, &token),
        (&foreign_user, &foreign, &foreign_token),
    ] {
        sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES($1,'Calendar fixture',$2,now(),now())").bind(user).bind(format!("{user}@invalid.test")).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,status) VALUES($1::uuid,'user',$2,'active')").bind(org).bind(user).execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO board_api_keys(user_id,name,key_hash) VALUES($1,'Calendar fixture',$2)",
        )
        .bind(user)
        .bind(crate::native_bearer_auth::hash_token(token))
        .execute(&pool)
        .await
        .unwrap();
    }
    let agent: String = sqlx::query_scalar("INSERT INTO agents(org_id,name,role,status) VALUES($1::uuid,'Calendar fixture agent','general','idle') RETURNING id::text").bind(&org).fetch_one(&pool).await.unwrap();
    let agent_token = format!("calendar-write-agent-{suffix}");
    sqlx::query("INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) VALUES($1::uuid,$2::uuid,'Calendar fixture',$3)").bind(&org).bind(&agent).bind(crate::native_bearer_auth::hash_token(&agent_token)).execute(&pool).await.unwrap();
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
            actor_envelope_key: Some(SigningKey::new(b"calendar-write-test-envelope-key").unwrap()),
            workers: 1,
            ..ServerConfig::default()
        })
        .unwrap(),
    );
    let mut config = PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        &upstream,
        "calendar-write-test-forwarding-key",
    )
    .unwrap();
    config.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            "calendar-write-test-identity-key",
            "calendar-write-test-jwt",
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
    let sources = format!("/api/orgs/{org}/calendar/sources");
    let events = format!("/api/orgs/{org}/calendar/events");
    // Existing Calendar route authorization precedes its D1 body validators.
    assert_eq!(
        call(&client, &base, Method::POST, &sources, None, None).await,
        (
            StatusCode::FORBIDDEN,
            json!({"error":"Board access required"})
        )
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &sources,
            Some(&agent_token),
            Some(json!({}))
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
            &sources,
            Some(&foreign_token),
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&client, &base, Method::POST, &sources, Some(&token), None)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &sources,
            Some(&token),
            Some(json!({"name":null}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut created=client.post(format!("{base}/API/ORGS/{org}/CALENDAR/SOURCES/"))
        .insert_header((header::AUTHORIZATION,format!("Bearer {token}")))
        .insert_header(("x-rudder-run-id",Uuid::new_v4().to_string()))
        .send_json(&json!({"name":" Personal calendar ","syncCursorJson":{"accessToken":"synthetic-private-access","refreshToken":"synthetic-private-refresh","syncToken":"cursor-safe"},"ignoredField":"stripped"})).await.unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let source: Value = created.json().await.unwrap();
    assert_eq!(source["name"], "Personal calendar");
    assert_eq!(source["type"], "rudder_local");
    assert_eq!(source["ownerUserId"], user);
    assert_eq!(
        source["syncCursorJson"],
        json!({"accessToken":"[redacted]","refreshToken":"[redacted]","syncToken":"cursor-safe"})
    );
    assert!(!source.to_string().contains("synthetic-private"));
    let source_id = source["id"].as_str().unwrap();
    let source_path = format!("{sources}/{source_id}");
    let audit_run:Option<String>=sqlx::query_scalar("SELECT run_id::text FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='calendar.source_created'").bind(&org).bind(source_id).fetch_one(&pool).await.unwrap();
    assert!(audit_run.is_none());
    let foreign_source:String=sqlx::query_scalar("INSERT INTO calendar_sources(org_id,name) VALUES($1::uuid,'Foreign fixture') RETURNING id::text").bind(&foreign).fetch_one(&pool).await.unwrap();
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &format!("{sources}/{foreign_source}"),
            Some(&token),
            Some(json!({"name":"Cross-org"}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &format!("{sources}/not-a-uuid"),
            Some(&token),
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let input = json!({"sourceId":source_id,"eventKind":"human_event","ownerType":"user","ownerUserId":user,"title":" Planning ","startAt":"2030-07-01T10:00:00Z","endAt":"2030-07-01T11:00:00Z"});
    let (status, event) = call(
        &client,
        &base,
        Method::POST,
        &events,
        Some(&token),
        Some(input.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(event["title"], "Planning");
    assert_eq!(event["eventStatus"], "planned");
    assert_eq!(event["timezone"], "UTC");
    assert_eq!(event["allDay"], false);
    assert_eq!(event["sourceMode"], "manual");
    let event_id = event["id"].as_str().unwrap();
    let event_path = format!("{events}/{event_id}");
    let mut invalid = input.clone();
    invalid["endAt"] = json!("2030-07-01T09:00:00Z");
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &events,
            Some(&token),
            Some(invalid)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &event_path,
            Some(&token),
            Some(json!({"endAt":"2030-07-01T09:00:00Z"}))
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let mut foreign_ref = input.clone();
    foreign_ref["sourceId"] = json!(foreign_source);
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &events,
            Some(&token),
            Some(foreign_ref)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let before = snapshot(&pool, &org).await;
    for (method, path, body) in [
        (
            Method::POST,
            sources.as_str(),
            Some(json!({"name":"Forbidden"})),
        ),
        (
            Method::PATCH,
            source_path.as_str(),
            Some(json!({"name":"Forbidden"})),
        ),
        (Method::DELETE, source_path.as_str(), None),
        (Method::POST, events.as_str(), Some(input.clone())),
        (
            Method::PATCH,
            event_path.as_str(),
            Some(json!({"title":"Forbidden"})),
        ),
        (Method::DELETE, event_path.as_str(), None),
    ] {
        assert_eq!(
            call(&client, &base, method, path, Some(&foreign_token), body)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(snapshot(&pool, &org).await, before);
    sqlx::query("UPDATE organization_memberships SET status='inactive' WHERE org_id=$1::uuid AND principal_id=$2").bind(&org).bind(&user).execute(&pool).await.unwrap();
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &source_path,
            Some(&token),
            Some(json!({"name":"Revoked"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(snapshot(&pool, &org).await, before);
    sqlx::query("UPDATE organization_memberships SET status='active' WHERE org_id=$1::uuid AND principal_id=$2").bind(&org).bind(&user).execute(&pool).await.unwrap();
    for mode in ["imported", "derived"] {
        sqlx::query("UPDATE calendar_events SET source_mode=$2 WHERE id=$1::uuid")
            .bind(event_id)
            .bind(mode)
            .execute(&pool)
            .await
            .unwrap();
        let unchanged = snapshot(&pool, &org).await;
        assert_eq!(
            call(
                &client,
                &base,
                Method::PATCH,
                &event_path,
                Some(&token),
                Some(json!({"title":"Denied"}))
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            call(
                &client,
                &base,
                Method::DELETE,
                &event_path,
                Some(&token),
                None
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
        assert_eq!(snapshot(&pool, &org).await, unchanged);
    }
    sqlx::query("UPDATE calendar_events SET source_mode='manual' WHERE id=$1::uuid")
        .bind(event_id)
        .execute(&pool)
        .await
        .unwrap();
    let trigger = format!("calendar_write_fail_{}", &suffix[..12]);
    for target in ["activity_log", "organization_mutation_outbox"] {
        sqlx::raw_sql(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.org_id='{org}'::uuid THEN RAISE EXCEPTION 'synthetic Calendar receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER {trigger} BEFORE INSERT ON {target} FOR EACH ROW EXECUTE FUNCTION {trigger}();")).execute(&pool).await.unwrap();
        let before = snapshot(&pool, &org).await;
        for (method, path, body) in [
            (
                Method::POST,
                sources.as_str(),
                Some(json!({"name":"Rollback source"})),
            ),
            (
                Method::PATCH,
                source_path.as_str(),
                Some(json!({"name":"Rollback source"})),
            ),
            (Method::DELETE, source_path.as_str(), None),
            (Method::POST, events.as_str(), Some(input.clone())),
            (
                Method::PATCH,
                event_path.as_str(),
                Some(json!({"title":"Rollback event"})),
            ),
            (Method::DELETE, event_path.as_str(), None),
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
    let updated = call(
        &client,
        &base,
        Method::PATCH,
        &source_path,
        Some(&token),
        Some(json!({"name":"Renamed","syncCursorJson":null})),
    )
    .await;
    assert_eq!(updated.0, StatusCode::OK);
    assert!(updated.1["syncCursorJson"].is_null());
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &event_path,
            Some(&token),
            Some(json!({"title":"Updated"}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::DELETE,
            &event_path,
            Some(&token),
            None
        )
        .await,
        (StatusCode::OK, json!({"ok":true}))
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &event_path,
            Some(&token),
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::DELETE,
            &source_path,
            Some(&token),
            None
        )
        .await,
        (StatusCode::OK, json!({"ok":true}))
    );
    let audit_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM activity_log WHERE org_id=$1::uuid")
            .bind(&org)
            .fetch_one(&pool)
            .await
            .unwrap();
    let outbox_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid",
    )
    .bind(&org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_count, 6);
    assert_eq!(outbox_count, 6);
    let DatabaseState::Configured(native_pool) = &foundation.database else {
        unreachable!()
    };
    native_pool.close().await;
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &sources,
            Some(&token),
            Some(json!({"name":"Unavailable"}))
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
    for table in [
        "organization_mutation_outbox",
        "activity_log",
        "calendar_events",
        "calendar_sources",
        "agent_api_keys",
        "organization_memberships",
        "agents",
        "organizations",
    ] {
        let field = if table == "organizations" {
            "id"
        } else {
            "org_id"
        };
        sqlx::query(&format!(
            "DELETE FROM {table} WHERE {field} IN($1::uuid,$2::uuid)"
        ))
        .bind(&org)
        .bind(&foreign)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query("DELETE FROM board_api_keys WHERE user_id IN($1,$2)")
        .bind(&user)
        .bind(&foreign_user)
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
