use super::*;
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
};

fn runtime(database_url: Option<String>, upstream: &str) -> (Arc<AppState>, PublicIngressRuntime) {
    let state = Arc::new(
        AppState::new(ServerConfig {
            database_url,
            actor_envelope_key: Some(
                SigningKey::new(b"request-write-synthetic-native-envelope-key").unwrap(),
            ),
            workers: 1,
            ..ServerConfig::default()
        })
        .unwrap(),
    );
    let mut config =
        PublicIngressConfig::new("127.0.0.1:0".parse().unwrap(), upstream, INTERNAL).unwrap();
    config.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            INTERNAL,
            "request-write-synthetic-jwt-secret",
            "rudder-test",
            "rudder-api",
            false,
        )
        .unwrap(),
    );
    config.session_auth = Some(
        NativeSessionAuthConfig::new(NativeSessionAuthKind::BetterAuth, SECRET, false, INTERNAL)
            .unwrap(),
    );
    let runtime = PublicIngressRuntime::bind(config, state.clone()).unwrap();
    (state, runtime)
}
async fn post(
    client: &awc::Client,
    base: &str,
    id: &str,
    action: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut response = client
        .post(format!("{base}/api/requests/{id}/{action}"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
        .send_json(&body)
        .await
        .unwrap();
    (response.status(), response.json().await.unwrap())
}
async fn seed_issue_request(
    pool: &PgPool,
    org: &str,
    agent: &str,
    status: &str,
    origin: Option<&str>,
) -> (String, String) {
    let issue = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO issues(id,org_id,title,status,assignee_agent_id,identifier,issue_number) VALUES($1::uuid,$2::uuid,'Human input needed',$3,$4::uuid,$5,$6)")
        .bind(&issue).bind(org).bind(status).bind(agent).bind(format!("REQ-{}",&issue[..8])).bind((Uuid::new_v4().as_u128()%1_000_000_000) as i32).execute(pool).await.unwrap();
    let request=sqlx::query_scalar("INSERT INTO requests(org_id,kind,subtype,status,issue_id,requested_by_agent_id,assignee_agent_id,origin_run_id,blocker_fingerprint,title,prompt) VALUES($1::uuid,'assistance','issue_blocker','open',$2::uuid,$3::uuid,$3::uuid,$4::uuid,'original-fingerprint','Input needed','Supply access') RETURNING id::text")
        .bind(org).bind(&issue).bind(agent).bind(origin).fetch_one(pool).await.unwrap();
    (issue, request)
}
async fn request_state(pool: &PgPool, id: &str) -> (String, String, i64) {
    sqlx::query_as("SELECT r.status,i.status,(SELECT count(*) FROM agent_wakeup_requests w WHERE w.org_id=r.org_id AND (w.idempotency_key='assistance-request:'||r.id::text||':resolved' OR w.payload->>'requestId'=r.id::text)) FROM requests r JOIN issues i ON i.id=r.issue_id AND i.org_id=r.org_id WHERE r.id=$1::uuid")
        .bind(id).fetch_one(pool).await.unwrap()
}

#[actix_web::test]
#[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB; no provider, processhost or Node backend"]
async fn native_assistance_writes_unblock_audit_wake_replay_and_fail_closed() {
    let url = env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap();
    let pool = super::disposable_native_auth_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let org: String=sqlx::query_scalar("INSERT INTO organizations(url_key,name,issue_prefix) VALUES($1,'Request writes',$2) RETURNING id::text").bind(format!("request-writes-{suffix}")).bind(format!("RW{}",&suffix[..6])).fetch_one(&pool).await.unwrap();
    let foreign: String=sqlx::query_scalar("INSERT INTO organizations(url_key,name,issue_prefix) VALUES($1,'Foreign requests',$2) RETURNING id::text").bind(format!("request-foreign-{suffix}")).bind(format!("RF{}",&suffix[..6])).fetch_one(&pool).await.unwrap();
    let user = format!("request-writer-{suffix}");
    sqlx::query(r#"INSERT INTO "user"(id,name,email,created_at,updated_at) VALUES($1,'Request writer',$2,now(),now())"#).bind(&user).bind(format!("{user}@invalid.test")).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,status) VALUES($1::uuid,'user',$2,'active')").bind(&org).bind(&user).execute(&pool).await.unwrap();
    let session_token = format!("request-write-cookie-{suffix}");
    sqlx::query("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,now()+interval '1 day',now(),now())").bind(format!("request-session-{suffix}")).bind(&session_token).bind(&user).execute(&pool).await.unwrap();
    let token = format!("request-write-board-{suffix}");
    let key: String=sqlx::query_scalar("INSERT INTO board_api_keys(user_id,name,key_hash) VALUES($1,'Request writer',$2) RETURNING id::text").bind(&user).bind(crate::native_bearer_auth::hash_token(&token)).fetch_one(&pool).await.unwrap();
    let agent: String=sqlx::query_scalar("INSERT INTO agents(org_id,name,role,status,agent_runtime_type,runtime_config) VALUES($1::uuid,'Request worker','general','idle','process','{\"command\":\"/bin/true\"}'::jsonb) RETURNING id::text").bind(&org).fetch_one(&pool).await.unwrap();
    let other_agent: String=sqlx::query_scalar("INSERT INTO agents(org_id,name,role,status) VALUES($1::uuid,'Changed owner','general','idle') RETURNING id::text").bind(&org).fetch_one(&pool).await.unwrap();
    let agent_token = format!("request-write-agent-{suffix}");
    sqlx::query("INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) VALUES($1::uuid,$2::uuid,'Request agent',$3)").bind(&org).bind(&agent).bind(crate::native_bearer_auth::hash_token(&agent_token)).execute(&pool).await.unwrap();
    let origin:String=sqlx::query_scalar("INSERT INTO heartbeat_runs(org_id,agent_id,status,invocation_source,execution_authority) VALUES($1::uuid,$2::uuid,'succeeded','assignment','legacy_ts') RETURNING id::text").bind(&org).bind(&agent).fetch_one(&pool).await.unwrap();
    let node_requests = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let node = HttpServer::new({
        let count = node_requests.clone();
        move || {
            let count = count.clone();
            App::new().default_service(web::to(move |request: HttpRequest| {
                let count = count.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    HttpResponse::Ok().json(json!({"node":request.path()}))
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
    let (foundation, native) = runtime(Some(url.clone()), &upstream);
    let base = format!("http://{}", native.bound_addr());
    let control = native.control();
    let task = actix_web::rt::spawn(native.run());
    let client = awc::Client::default();
    let (issue, request) = seed_issue_request(&pool, &org, &agent, "blocked", Some(&origin)).await;
    let body =
        json!({"resolution":"answered","response":"  bearer sample-secret  ","ignored":true});
    let (status, resolved) = post(&client, &base, &request, "resolve", &token, body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{resolved}");
    assert_eq!(resolved["status"], "resolved");
    assert_eq!(resolved["response"], "bearer [REDACTED]");
    assert_eq!(resolved["blockerFingerprint"], "original-fingerprint");
    let run = resolved["wakeRunId"]
        .as_str()
        .expect("eligible resolution must enqueue a native Run");
    assert_eq!(
        request_state(&pool, &request).await,
        ("resolved".into(), "in_progress".into(), 1)
    );
    let actual: (String,String,Value,Value,String,String)=sqlx::query_as("SELECT r.execution_authority,r.status,r.context_snapshot,w.payload,w.trigger_detail,w.idempotency_key FROM heartbeat_runs r JOIN agent_wakeup_requests w ON w.id=r.wakeup_request_id AND w.org_id=r.org_id WHERE r.id=$1::uuid AND r.org_id=$2::uuid").bind(run).bind(&org).fetch_one(&pool).await.unwrap();
    assert_eq!(
        (&actual.0, &actual.1),
        (&"native_rust".to_string(), &"queued".to_string())
    );
    assert_eq!(actual.2["requestResponse"], "bearer [REDACTED]");
    assert_eq!(actual.2["issueId"], issue);
    assert_eq!(actual.3["expectedIssueStatus"], "in_progress");
    assert_eq!(actual.4, "user");
    assert_eq!(actual.5, format!("assistance-request:{request}:resolved"));
    let mut read = client
        .get(format!("{base}/api/agent-runs/{run}"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(read.status(), StatusCode::OK);
    let read: Value = read.json().await.unwrap();
    assert_eq!(read["id"], run);
    let mut read = client
        .get(format!("{base}/api/requests/{request}"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
        .send()
        .await
        .unwrap();
    assert_eq!(read.status(), StatusCode::OK);
    let read: Value = read.json().await.unwrap();
    assert_eq!(read["response"], resolved["response"]);
    let (status, repeated) = post(
        &client,
        &base,
        &request,
        "resolve",
        &token,
        json!({"resolution":"answered","response":"different response"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(repeated["response"], resolved["response"]);
    assert!(repeated["wakeRunId"].is_null());
    assert_eq!(
        post(
            &client,
            &base,
            &request,
            "resolve",
            &token,
            json!({"resolution":"action_completed","response":"changed"})
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        post(&client, &base, &request, "cancel", &token, json!({}))
            .await
            .1["status"],
        "resolved"
    );
    let counts:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND idempotency_key=$2),(SELECT count(*) FROM organization_mutation_outbox o JOIN activity_log a ON a.id=o.activity_id WHERE a.org_id=$1::uuid AND a.idempotency_key=$2),(SELECT count(*) FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$3::uuid AND idempotency_key=$2)").bind(&org).bind(format!("request-resolved:{request}")).bind(&origin).fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (1, 1, 1));
    // Cancel stays idempotent and never unblocks or wakes the linked Issue.
    let (_, cancel) = seed_issue_request(&pool, &org, &agent, "blocked", Some(&origin)).await;
    let (status, cancelled) = post(
        &client,
        &base,
        &cancel,
        "cancel",
        &token,
        json!({"reason":"  token=sample-secret  "}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cancelled["response"], "token=[REDACTED]");
    assert!(cancelled.get("wakeRunId").is_none());
    assert_eq!(
        request_state(&pool, &cancel).await,
        ("cancelled".into(), "blocked".into(), 0)
    );
    assert_eq!(
        post(
            &client,
            &base,
            &cancel,
            "cancel",
            &token,
            json!({"reason":"different"})
        )
        .await
        .1,
        cancelled
    );
    assert_eq!(
        post(&client, &base, &cancel, "resolve", &token, body.clone())
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    // Owner/status/fingerprint lifecycle has its existing Node meaning.
    let (changed_issue, changed) = seed_issue_request(&pool, &org, &agent, "blocked", None).await;
    sqlx::query("UPDATE issues SET assignee_agent_id=$2::uuid WHERE id=$1::uuid")
        .bind(&changed_issue)
        .bind(&other_agent)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        post(&client, &base, &changed, "resolve", &token, body.clone())
            .await
            .1["wakeRunId"]
            .is_null()
    );
    assert_eq!(
        request_state(&pool, &changed).await,
        ("resolved".into(), "blocked".into(), 0)
    );
    for issue_status in ["done", "cancelled"] {
        let (_, id) = seed_issue_request(&pool, &org, &agent, issue_status, None).await;
        assert!(
            post(&client, &base, &id, "resolve", &token, body.clone())
                .await
                .1["wakeRunId"]
                .is_null()
        );
        assert_eq!(
            request_state(&pool, &id).await,
            ("resolved".into(), issue_status.into(), 0)
        );
    }
    let (_, cannot) = seed_issue_request(&pool, &org, &agent, "blocked", None).await;
    assert!(
        post(
            &client,
            &base,
            &cannot,
            "resolve",
            &token,
            json!({"resolution":"cannot_help","response":"No access"})
        )
        .await
        .1["wakeRunId"]
            .is_null()
    );
    assert_eq!(
        request_state(&pool, &cannot).await,
        ("resolved".into(), "blocked".into(), 0)
    );
    let (_, superseded) = seed_issue_request(&pool, &org, &agent, "blocked", None).await;
    sqlx::query("UPDATE requests SET status='superseded',blocker_fingerprint='old-fingerprint',metadata='{\"supersededReason\":\"blocker_changed\"}' WHERE id=$1::uuid").bind(&superseded).execute(&pool).await.unwrap();
    let (_, old) = post(&client, &base, &superseded, "resolve", &token, body.clone()).await;
    assert_eq!(old["status"], "superseded");
    assert!(old["response"].is_null());
    assert!(old["wakeRunId"].is_null());
    // Cookie-backed operators retain the existing same-host Origin contract.
    let (_, cookie_request) = seed_issue_request(&pool, &org, &agent, "blocked", None).await;
    let cookie = signed_cookie("better-auth.session_token", &session_token, SECRET);
    for origin in [None, Some("https://foreign.invalid")] {
        let mut request = client
            .post(format!("{base}/api/requests/{cookie_request}/cancel"))
            .insert_header((header::COOKIE, cookie.as_str()));
        if let Some(origin) = origin {
            request = request.insert_header((header::ORIGIN, origin));
        }
        assert_eq!(
            request.send_json(&json!({})).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        request_state(&pool, &cookie_request).await,
        ("open".into(), "blocked".into(), 0)
    );
    assert_eq!(
        client
            .post(format!("{base}/api/requests/{cookie_request}/cancel"))
            .insert_header((header::COOKIE, cookie.as_str()))
            .insert_header((header::ORIGIN, base.as_str()))
            .send_json(&json!({}))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    // Current organization and actor checks run under the mutation locks.
    let (_, denied) = seed_issue_request(&pool, &org, &agent, "blocked", None).await;
    for action in ["resolve", "cancel"] {
        assert_eq!(
            post(&client, &base, &denied, action, &agent_token, body.clone())
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    let foreign_request:String=sqlx::query_scalar("INSERT INTO requests(org_id,kind,subtype,title,prompt) VALUES($1::uuid,'assistance','issue_blocker','Foreign','Hidden') RETURNING id::text").bind(&foreign).fetch_one(&pool).await.unwrap();
    assert_eq!(
        post(
            &client,
            &base,
            &foreign_request,
            "resolve",
            &token,
            body.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let approval:String=sqlx::query_scalar("INSERT INTO approvals(org_id,type,status,payload) VALUES($1::uuid,'hire_agent','pending','{}') RETURNING id::text").bind(&org).fetch_one(&pool).await.unwrap();
    assert_eq!(
        post(&client, &base, &approval, "resolve", &token, body.clone())
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (locked_issue, revoked) = seed_issue_request(&pool, &org, &agent, "blocked", None).await;
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM issues WHERE id=$1::uuid FOR UPDATE")
        .bind(&locked_issue)
        .execute(&mut *lock)
        .await
        .unwrap();
    let waiter = actix_web::rt::spawn({
        let base = base.clone();
        let token = token.clone();
        let revoked = revoked.clone();
        let body = body.clone();
        async move {
            post(
                &awc::Client::default(),
                &base,
                &revoked,
                "resolve",
                &token,
                body,
            )
            .await
        }
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE state='active' AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM issues WHERE org_id%')").fetch_one(&pool).await.unwrap();
        if blocked {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "request must reach actual Issue mutation lock"
        );
        tokio::task::yield_now().await;
    }
    sqlx::query("UPDATE board_api_keys SET revoked_at=now() WHERE id=$1::uuid")
        .bind(&key)
        .execute(&pool)
        .await
        .unwrap();
    lock.rollback().await.unwrap();
    assert_eq!(waiter.await.unwrap().0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        request_state(&pool, &revoked).await,
        ("open".into(), "blocked".into(), 0)
    );
    sqlx::query("UPDATE board_api_keys SET revoked_at=NULL WHERE id=$1::uuid")
        .bind(&key)
        .execute(&pool)
        .await
        .unwrap();
    // Fail after native admission (origin event insert), proving all writes roll back.
    let (_, rollback) = seed_issue_request(&pool, &org, &agent, "blocked", Some(&origin)).await;
    let trigger = format!("request_rollback_{}", &suffix[..10]);
    sqlx::raw_sql(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'requestId'='{rollback}' THEN RAISE EXCEPTION 'synthetic request event failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER {trigger} BEFORE INSERT ON heartbeat_run_events FOR EACH ROW EXECUTE FUNCTION {trigger}();")).execute(&pool).await.unwrap();
    assert_eq!(
        post(&client, &base, &rollback, "resolve", &token, body.clone())
            .await
            .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(
        request_state(&pool, &rollback).await,
        ("open".into(), "blocked".into(), 0)
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid AND context_snapshot->>'requestId'=$2").bind(&org).bind(&rollback).fetch_one(&pool).await.unwrap(),0);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2"
        )
        .bind(&org)
        .bind(&rollback)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    sqlx::raw_sql(&format!(
        "DROP TRIGGER {trigger} ON heartbeat_run_events; DROP FUNCTION {trigger}();"
    ))
    .execute(&pool)
    .await
    .unwrap();
    // Zod error shape/order, aliases and native database failure never reach Node.
    for action in ["resolve", "cancel"] {
        let mut response = client
            .post(format!("{base}/api/requests/{denied}/{action}"))
            .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let error: Value = response.json().await.unwrap();
        assert_eq!(error["details"][0]["received"], "undefined");
    }
    let invalid = post(
        &client,
        &base,
        &denied,
        "resolve",
        &token,
        json!({"resolution":"bogus","response":" "}),
    )
    .await;
    assert_eq!(invalid.0, StatusCode::BAD_REQUEST);
    assert_eq!(invalid.1["error"], "Validation error");
    assert_eq!(invalid.1["details"][0]["path"], json!(["resolution"]));
    assert_eq!(invalid.1["details"][1]["code"], "too_small");
    let mut alias = client
        .post(format!("{base}/API/REQUESTS/{denied}/CANCEL/"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
        .send_json(&json!({}))
        .await
        .unwrap();
    assert_eq!(alias.status(), StatusCode::OK);
    let _: Value = alias.json().await.unwrap();
    let DatabaseState::Configured(native_pool) = &foundation.database else {
        panic!("native write fixture requires database");
    };
    native_pool.close().await;
    for action in ["resolve", "cancel"] {
        assert!(
            post(&client, &base, &denied, action, &token, body.clone())
                .await
                .0
                .is_server_error()
        );
    }
    let (disabled, offline) = runtime(None, &upstream);
    let offline_base = format!("http://{}", offline.bound_addr());
    let offline_control = offline.control();
    let offline_task = actix_web::rt::spawn(offline.run());
    for action in ["resolve", "cancel"] {
        assert_eq!(
            post(
                &client,
                &offline_base,
                &denied,
                action,
                &token,
                body.clone()
            )
            .await
            .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    assert_eq!(node_requests.load(Ordering::SeqCst), 0);
    offline_control.stop(true).await;
    offline_task.await.unwrap().unwrap();
    disabled.live_event_publisher.close();
    control.stop(true).await;
    task.await.unwrap().unwrap();
    foundation.live_event_publisher.close();
    node_control.stop(true).await;
    node_task.await.unwrap().unwrap();
    // Dispose this fixture's domain rows; the externally supplied DB is test-only.
    let mut cleanup = pool.begin().await.unwrap();
    sqlx::query(
        "SELECT set_config('rudder.native_chat_write','native_chat:request_fixture_cleanup',true)",
    )
    .execute(&mut *cleanup)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE issues SET execution_run_id=NULL,checkout_run_id=NULL WHERE org_id=$1::uuid",
    )
    .bind(&org)
    .execute(&mut *cleanup)
    .await
    .unwrap();
    sqlx::query("DELETE FROM heartbeat_run_events WHERE org_id=$1::uuid")
        .bind(&org)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM requests WHERE org_id IN($1::uuid,$2::uuid)")
        .bind(&org)
        .bind(&foreign)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE org_id=$1::uuid")
        .bind(&org)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_wakeup_requests WHERE org_id=$1::uuid")
        .bind(&org)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE org_id=$1::uuid")
        .bind(&org)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM approvals WHERE org_id=$1::uuid")
        .bind(&org)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organization_mutation_outbox WHERE org_id=$1::uuid")
        .bind(&org)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM activity_log WHERE org_id=$1::uuid")
        .bind(&org)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_api_keys WHERE org_id=$1::uuid")
        .bind(&org)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE org_id=$1::uuid")
        .bind(&org)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM board_api_keys WHERE user_id=$1")
        .bind(&user)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organization_memberships WHERE principal_id=$1")
        .bind(&user)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organizations WHERE id IN($1::uuid,$2::uuid)")
        .bind(&org)
        .bind(&foreign)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM session WHERE user_id=$1")
        .bind(&user)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query(r#"DELETE FROM "user" WHERE id=$1"#)
        .bind(&user)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    cleanup.commit().await.unwrap();
    pool.close().await;
}
