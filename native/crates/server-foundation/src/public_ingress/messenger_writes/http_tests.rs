//! Real public workflow against a migrated disposable database. The upstream
//! is a tripwire; title generation uses a real loopback HTTP provider.
use super::*;
use actix_web::{App, HttpServer};
use sqlx::PgPool;
use std::{
    env,
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
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
    let bytes = response.body().await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn organization(pool: &PgPool, suffix: &str, label: &str) -> String {
    sqlx::query_scalar(
        "INSERT INTO organizations(name,url_key,issue_prefix) VALUES($1,$2,$3) RETURNING id::text",
    )
    .bind(label)
    .bind(format!("m21-{suffix}-{label}"))
    .bind(format!("MW{}{}", &suffix[..6], label))
    .fetch_one(pool)
    .await
    .unwrap()
}
async fn operator(pool: &PgPool, org: &str, user: &str) -> String {
    sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES($1,'Messenger fixture',$2,now(),now())").bind(user).bind(format!("{user}@invalid.test")).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,status) VALUES($1::uuid,'user',$2,'active')").bind(org).bind(user).execute(pool).await.unwrap();
    let token = format!("pcp_{user}");
    sqlx::query("INSERT INTO board_api_keys(user_id,name,key_hash) VALUES($1,'Messenger21',$2)")
        .bind(user)
        .bind(crate::native_bearer_auth::hash_token(&token))
        .execute(pool)
        .await
        .unwrap();
    token
}
async fn chat(pool: &PgPool, org: &str, user: &str, title: &str, private: bool) -> String {
    sqlx::query_scalar("INSERT INTO chat_conversations(org_id,title,created_by_user_id,conversation_kind,last_message_at) VALUES($1::uuid,$2,$3,$4,'2026-10-01T12:34:56.123Z') RETURNING id::text").bind(org).bind(title).bind(user).bind(if private{"side_chat"}else{"chat"}).fetch_one(pool).await.unwrap()
}
async fn snapshot(pool: &PgPool, org: &str) -> String {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM messenger_custom_groups t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM messenger_custom_group_entries t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM messenger_saved_views t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM messenger_saved_view_mutations t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM chat_conversation_user_states t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM messenger_thread_user_states t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM issue_read_states t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM issue_follows t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM activity_log t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM organization_mutation_outbox t WHERE org_id=$1::uuid))::text").bind(org).fetch_one(pool).await.unwrap()
}
fn prompt(titles: &[&str]) -> String {
    format!(
        "Generate a concise title for this Messenger group.\nRules:\n- Return only the title text.\n- No quotes, markdown, emoji, or trailing punctuation.\n- Maximum 80 characters.\n\nMessenger item titles:\n{}",
        titles
            .iter()
            .enumerate()
            .map(|(i, t)| format!("{}. {t}", i + 1))
            .collect::<Vec<_>>()
            .join(" ")
    )
}
#[actix_web::test]
#[ignore = "requires migrated RUDDER_NATIVE_AUTH_TEST_DATABASE_URL; source-only until qualification"]
async fn native_messenger_writes_cover_all_twenty_one_journey_privacy_titles_rollback_and_no_node_fallback()
 {
    let url = env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().contains("test"));
    let pool = PgPool::connect(&url).await.unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let org = organization(&pool, &suffix, "own").await;
    let foreign = organization(&pool, &suffix, "foreign").await;
    let user = format!("m21-{suffix}");
    let other = format!("m21-other-{suffix}");
    let token = operator(&pool, &org, &user).await;
    let other_token = operator(&pool, &org, &other).await;
    let foreign_token = operator(&pool, &foreign, &format!("m21-foreign-{suffix}")).await;
    let own_chat = chat(&pool, &org, &user, "Inbox seed", false).await;
    let private = chat(&pool, &org, &other, "Private side chat", true).await;
    let foreign_chat = chat(&pool, &foreign, &other, "Foreign chat", false).await;
    let issue:String=sqlx::query_scalar("INSERT INTO issues(org_id,title,issue_number,identifier,created_by_user_id) VALUES($1::uuid,'Tracked issue',1,$2,$3) RETURNING id::text").bind(&org).bind(format!("MW{}-1",&suffix[..6])).bind(&user).fetch_one(&pool).await.unwrap();
    // Production-shaped volume: grouping the oldest tracked Issue must not use
    // the split-directory's 100-card page as an eligibility decision.
    sqlx::query("INSERT INTO issues(org_id,title,issue_number,identifier,created_by_user_id,created_at,updated_at) SELECT $1::uuid,'Newer issue '||n,n,$2||'-'||n,$3,now()+n*interval '1 second',now()+n*interval '1 second' FROM generate_series(2,106)n").bind(&org).bind(format!("MW{}",&suffix[..6])).bind(&user).execute(&pool).await.unwrap();
    let agent:String=sqlx::query_scalar("INSERT INTO agents(org_id,name,role,status) VALUES($1::uuid,'M21 fixture','general','idle') RETURNING id::text").bind(&org).fetch_one(&pool).await.unwrap();
    let agent_token = format!("pcp_m21_agent_{suffix}");
    sqlx::query("INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) VALUES($1::uuid,$2::uuid,'M21 fixture',$3)").bind(&org).bind(&agent).bind(crate::native_bearer_auth::hash_token(&agent_token)).execute(&pool).await.unwrap();
    let upstream_calls = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let upstream_server = HttpServer::new({
        let calls = upstream_calls.clone();
        move || {
            let calls = calls.clone();
            App::new().default_service(web::to(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { HttpResponse::ImATeapot().finish() }
            }))
        }
    })
    .workers(1)
    .disable_signals()
    .listen(listener)
    .unwrap()
    .run();
    let upstream_control = upstream_server.handle();
    let upstream_task = actix_web::rt::spawn(upstream_server);
    let expected = Arc::new(Mutex::new(String::new()));
    let provider_calls = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let provider = format!("http://{}", listener.local_addr().unwrap());
    let provider_server = HttpServer::new({
        let expected = expected.clone();
        let calls = provider_calls.clone();
        move || {
            let expected = expected.clone();
            let calls = calls.clone();
            App::new()
                .route(
                    "/fail",
                    web::post().to(|| async { HttpResponse::BadGateway().finish() }),
                )
                .route(
                    "/title",
                    web::post().to(move |body: web::Json<Value>| {
                        assert_eq!(body["context"]["chatMode"], true);
                        assert_eq!(
                            body["context"]["chatPrompt"],
                            expected.lock().unwrap().as_str()
                        );
                        assert_eq!(
                            body["context"]["productIntelligence"]["feature"],
                            "messenger_group_title"
                        );
                        calls.fetch_add(1, Ordering::SeqCst);
                        async { HttpResponse::Ok().json(json!({"text":"# Generated group!"})) }
                    }),
                )
        }
    })
    .workers(1)
    .disable_signals()
    .listen(listener)
    .unwrap()
    .run();
    let provider_control = provider_server.handle();
    let provider_task = actix_web::rt::spawn(provider_server);
    let foundation = Arc::new(
        AppState::new(ServerConfig {
            database_url: Some(url),
            actor_envelope_key: Some(SigningKey::new(b"messenger-write-fixture-envelope").unwrap()),
            workers: 1,
            ..ServerConfig::default()
        })
        .unwrap(),
    );
    let mut config = PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        &upstream,
        "messenger-write-fixture-forwarding-key",
    )
    .unwrap();
    config.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            "messenger-write-fixture-identity-assertion-key",
            "messenger-write-fixture-agent-jwt-secret",
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
    let m = format!("/api/orgs/{org}/messenger");
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &format!("{m}/groups"),
            None,
            Some(json!({"name":"Denied"}))
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    for denied in [&agent_token, &foreign_token] {
        assert_eq!(
            call(
                &client,
                &base,
                Method::POST,
                &format!("{m}/groups"),
                Some(denied),
                Some(json!({"name":"Denied"}))
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    let (status, a) = call(
        &client,
        &base,
        Method::POST,
        &format!("{m}/groups"),
        Some(&token),
        Some(json!({"name":"Source"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let a = a["id"].as_str().unwrap().to_owned();
    let (_, b) = call(
        &client,
        &base,
        Method::POST,
        &format!("{m}/groups"),
        Some(&token),
        Some(json!({"name":"Second"})),
    )
    .await;
    let b = b["id"].as_str().unwrap().to_owned();
    let keep = json!({"target":{"kind":"browser","tabId":"fixture-tab","url":"https://example.invalid","viewInstanceId":format!("view-{suffix}")},"title":"Saved page","clientMutationId":Uuid::new_v4().to_string(),"placement":{"kind":"group","groupId":a}});
    let (status, saved) = call(
        &client,
        &base,
        Method::POST,
        &format!("{m}/saved-views/keep"),
        Some(&token),
        Some(keep.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let saved_id = saved["savedView"]["id"].as_str().unwrap().to_owned();
    let before = snapshot(&pool, &org).await;
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &format!("{m}/saved-views/keep"),
            Some(&token),
            Some(keep)
        )
        .await
        .1,
        saved
    );
    assert_eq!(
        snapshot(&pool, &org).await,
        before,
        "Keep replay is durable and effect-free"
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &format!("{m}/saved-views"),
            Some(&token),
            Some(json!({}))
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
            &format!("{m}/groups/{a}/entries"),
            Some(&token),
            Some(json!({"threadKey":format!("chat:{own_chat}")}))
        )
        .await
        .0,
        StatusCode::CREATED
    );
    for denied in [&private, &foreign_chat] {
        let before = snapshot(&pool, &org).await;
        assert_eq!(
            call(
                &client,
                &base,
                Method::POST,
                &format!("{m}/groups/{a}/entries"),
                Some(&token),
                Some(json!({"itemKey":format!("chat:{denied}")}))
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(snapshot(&pool, &org).await, before);
        assert_eq!(
            call(
                &client,
                &base,
                Method::POST,
                &format!("{m}/threads/chat%3A{denied}/user-state"),
                Some(&token),
                Some(json!({"pinned":true}))
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &format!("{m}/groups/{a}"),
            Some(&other_token),
            Some(json!({"name":"No"}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let profile = json!({"url":format!("{provider}/fail"),"model":"primary","modelFallbacks":[{"agentRuntimeType":"http","model":"secondary","config":{"url":format!("{provider}/title")}}]});
    sqlx::query("INSERT INTO organization_intelligence_profiles(org_id,purpose,agent_runtime_type,agent_runtime_config,status) VALUES($1::uuid,'default','http',$2::jsonb,'configured')").bind(&org).bind(profile.to_string()).execute(&pool).await.unwrap();
    *expected.lock().unwrap() = prompt(&["Inbox seed", "Saved page"]);
    let (status,merged)=call(&client,&base,Method::POST,&format!("{m}/groups/merge"),Some(&token),Some(json!({"name":"Fallback name","itemKeys":[format!("chat:{own_chat}"),format!("saved-view:{saved_id}")],"autoGenerateName":true}))).await;
    assert_eq!(status, StatusCode::CREATED, "{merged}");
    let group = merged["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == "Generated group")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        merged["groups"]
            .as_array()
            .unwrap()
            .iter()
            .all(|g| g["id"] != a)
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &format!("{m}/groups/{group}"),
            Some(&token),
            Some(json!({"collapsed":true,"pinned":false}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &format!("{m}/groups/reorder"),
            Some(&token),
            Some(json!({"groupIds":[group,b]}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &format!("{m}/groups/{group}/entries"),
            Some(&token),
            Some(json!({"itemKey":format!("issue:{issue}")}))
        )
        .await
        .0,
        StatusCode::CREATED,
        "old Issue beyond page stays eligible"
    );
    assert_eq!(call(&client,&base,Method::PATCH,&format!("{m}/groups/{group}/entries/reorder"),Some(&token),Some(json!({"itemKeys":[format!("issue:{issue}"),format!("chat:{own_chat}"),format!("saved-view:{saved_id}")]}))).await.0,StatusCode::OK);
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &format!("{m}/saved-views/{saved_id}"),
            Some(&token),
            Some(json!({"title":"Changed"}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &format!("{m}/saved-views/reorder"),
            Some(&token),
            Some(json!({"ids":[saved_id]}))
        )
        .await
        .0,
        StatusCode::OK
    );
    *expected.lock().unwrap() = prompt(&["Tracked issue", "Inbox seed", "Changed"]);
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &format!("{m}/groups/{group}/title/regenerate"),
            Some(&token),
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        provider_calls.load(Ordering::SeqCst),
        2,
        "real prompt/fallback executed for merge and regenerate"
    );
    // The public profile->secret->native process path must actually deliver the
    // exact prompt and environment to a child, then commit the returned title.
    assert!(
        env::var_os("RUDDER_SECRETS_MASTER_KEY_FILE").is_some(),
        "supply an isolated synthetic secret key file"
    );
    let (status, secret) = call(
        &client,
        &base,
        Method::POST,
        &format!("/api/orgs/{org}/secrets"),
        Some(&token),
        Some(json!({"name":format!("M21 title {suffix}"),"value":"synthetic title key"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{secret}");
    // PI's existing explicit internal access may use managed secrets; this
    // does not widen the separate Agent runtime's user-managed-only helper.
    sqlx::query("UPDATE organization_secrets SET purpose='managed_mcp_connection' WHERE org_id=$1::uuid AND id=$2::uuid").bind(&org).bind(secret["id"].as_str().unwrap()).execute(&pool).await.unwrap();
    let (status, foreign_secret) = call(
        &client,
        &base,
        Method::POST,
        &format!("/api/orgs/{foreign}/secrets"),
        Some(&foreign_token),
        Some(json!({"name":format!("M21 foreign {suffix}"),"value":"synthetic foreign title key"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{foreign_secret}");
    let script = "const fs=require('fs');const input=fs.readFileSync(0,'utf8');if(input!==process.env.EXPECTED_TITLE_PROMPT||process.env.M21_TITLE_SECRET!=='synthetic title key')process.exit(23);process.stdout.write('Actual process title');";
    let process_profile = json!({"command":"node","args":["-e",script],"timeoutSec":10,"graceSec":1,"env":{"EXPECTED_TITLE_PROMPT":prompt(&["Tracked issue","Inbox seed","Changed"]),"M21_TITLE_SECRET":{"type":"secret_ref","secretId":secret["id"],"version":"latest"}}});
    sqlx::query("UPDATE organization_intelligence_profiles SET agent_runtime_type='process',agent_runtime_config=$2::jsonb WHERE org_id=$1::uuid AND purpose='default'").bind(&org).bind(process_profile.to_string()).execute(&pool).await.unwrap();
    for (secret_id, version, status, message) in [
        (
            Uuid::new_v4().to_string(),
            json!("latest"),
            StatusCode::NOT_FOUND,
            "Secret not found",
        ),
        (
            secret["id"].as_str().unwrap().to_owned(),
            json!(999),
            StatusCode::NOT_FOUND,
            "Secret version not found",
        ),
        (
            foreign_secret["id"].as_str().unwrap().to_owned(),
            json!("latest"),
            StatusCode::UNPROCESSABLE_ENTITY,
            "Secret must belong to same organization",
        ),
    ] {
        let mut invalid = process_profile.clone();
        invalid["env"]["M21_TITLE_SECRET"] =
            json!({"type":"secret_ref","secretId":secret_id,"version":version});
        sqlx::query("UPDATE organization_intelligence_profiles SET agent_runtime_config=$2::jsonb WHERE org_id=$1::uuid AND purpose='default'").bind(&org).bind(invalid.to_string()).execute(&pool).await.unwrap();
        let before = snapshot(&pool, &org).await;
        let response = call(
            &client,
            &base,
            Method::POST,
            &format!("{m}/groups/{group}/title/regenerate"),
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(response.0, status, "{}", response.1);
        assert_eq!(response.1["error"], message);
        assert_eq!(snapshot(&pool, &org).await, before);
    }
    sqlx::query("UPDATE organization_intelligence_profiles SET agent_runtime_config=$2::jsonb WHERE org_id=$1::uuid AND purpose='default'").bind(&org).bind(process_profile.to_string()).execute(&pool).await.unwrap();
    sqlx::query(
        "UPDATE organization_secret_versions SET revoked_at=now() WHERE secret_id=$1::uuid",
    )
    .bind(secret["id"].as_str().unwrap())
    .execute(&pool)
    .await
    .unwrap();
    let before = snapshot(&pool, &org).await;
    let revoked = call(
        &client,
        &base,
        Method::POST,
        &format!("{m}/groups/{group}/title/regenerate"),
        Some(&token),
        Some(json!({})),
    )
    .await;
    assert_eq!(revoked.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(revoked.1["error"], "Secret version is revoked");
    assert_eq!(snapshot(&pool, &org).await, before);
    sqlx::query("UPDATE organization_secret_versions SET revoked_at=NULL WHERE secret_id=$1::uuid")
        .bind(secret["id"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let (status, generated) = call(
        &client,
        &base,
        Method::POST,
        &format!("{m}/groups/{group}/title/regenerate"),
        Some(&token),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{generated}");
    assert_eq!(generated["name"], "Actual process title");
    sqlx::query("UPDATE organization_intelligence_profiles SET agent_runtime_type='http',agent_runtime_config=$2::jsonb WHERE org_id=$1::uuid AND purpose='default'").bind(&org).bind(profile.to_string()).execute(&pool).await.unwrap();
    let encoded_org = format!("%{:02X}{}", org.as_bytes()[0], &org[1..]);
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &format!("/API/ORGS/{encoded_org}/MESSENGER/THREADS/chat%3A{own_chat}/USER-STATE/"),
            Some(&token),
            Some(json!({"pinned":true}))
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, read) = call(
        &client,
        &base,
        Method::POST,
        &format!("{m}/threads/chat%3A{own_chat}/read"),
        Some(&token),
        Some(json!({"lastReadAt":"0044-01-01T00:00:00Z"})),
    )
    .await;
    assert_eq!(
        read["lastReadAt"], "2026-10-01T12:34:56.123Z",
        "Chat read uses last message, not supplied date"
    );
    let issue_path = format!("/api/issues/{issue}");
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &format!("{issue_path}/follow"),
            Some(&token),
            None
        )
        .await
        .0,
        StatusCode::CREATED
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &format!("{issue_path}/read"),
            Some(&token),
            None
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
            &format!("{issue_path}/follow"),
            Some(&token),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &format!("{m}/unreads/dismiss"),
            Some(&token),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    // Both receipt writes must roll back the domain rows too, including new
    // group/pin/read workflows; retain the original synthetic fail evidence.
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &format!("{issue_path}/follow"),
            Some(&token),
            None
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let rollback_keep = json!({"target":{"kind":"browser","tabId":"rollback-tab","url":"https://example.invalid/rollback","viewInstanceId":format!("rollback-{suffix}")},"title":"Rollback page","clientMutationId":Uuid::new_v4().to_string(),"placement":{"kind":"group","groupId":group}});
    let hook = format!("m21_fail_{}", &suffix[..12]);
    for target in ["activity_log", "organization_mutation_outbox"] {
        sqlx::raw_sql(&format!("CREATE FUNCTION {hook}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.org_id='{org}'::uuid THEN RAISE EXCEPTION 'synthetic messenger receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER {hook} BEFORE INSERT ON {target} FOR EACH ROW EXECUTE FUNCTION {hook}();")).execute(&pool).await.unwrap();
        let before = snapshot(&pool, &org).await;
        for (method, path, body) in [
            (
                Method::POST,
                format!("{m}/saved-views/keep"),
                rollback_keep.clone(),
            ),
            (
                Method::POST,
                format!("{m}/groups/{group}/title/regenerate"),
                json!({}),
            ),
            (Method::DELETE, format!("{issue_path}/follow"), json!({})),
            (
                Method::POST,
                format!("{m}/groups"),
                json!({"name":"Rollback"}),
            ),
            (
                Method::PATCH,
                format!("{m}/groups/{group}"),
                json!({"name":"Rollback"}),
            ),
            (
                Method::POST,
                format!("{m}/groups/{group}/separate"),
                json!({}),
            ),
            (Method::DELETE, format!("{m}/groups/{group}"), json!({})),
            (
                Method::POST,
                format!("{m}/groups/merge"),
                json!({"name":"Rollback","itemKeys":[format!("chat:{own_chat}")]}),
            ),
            (
                Method::PATCH,
                format!("{m}/groups/reorder"),
                json!({"groupIds":[group]}),
            ),
            (
                Method::POST,
                format!("{m}/groups/{group}/entries"),
                json!({"itemKey":format!("chat:{own_chat}")}),
            ),
            (
                Method::PATCH,
                format!("{m}/groups/{group}/entries/reorder"),
                json!({"itemKeys":[format!("chat:{own_chat}")]}),
            ),
            (
                Method::DELETE,
                format!("{m}/groups/entries/chat%3A{own_chat}"),
                json!({}),
            ),
            (
                Method::POST,
                format!("{m}/threads/chat%3A{own_chat}/user-state"),
                json!({"pinned":false}),
            ),
            (
                Method::POST,
                format!("{m}/threads/chat%3A{own_chat}/read"),
                json!({}),
            ),
            (Method::POST, format!("{m}/unreads/dismiss"), json!({})),
            (Method::POST, format!("{issue_path}/read"), json!({})),
            (Method::POST, format!("{issue_path}/follow"), json!({})),
            (
                Method::PATCH,
                format!("{m}/saved-views/{saved_id}"),
                json!({"title":"Rollback"}),
            ),
            (
                Method::PATCH,
                format!("{m}/saved-views/reorder"),
                json!({"ids":[saved_id]}),
            ),
            (
                Method::DELETE,
                format!("{m}/saved-views/{saved_id}"),
                json!({}),
            ),
        ] {
            assert_eq!(
                call(&client, &base, method, &path, Some(&token), Some(body))
                    .await
                    .0,
                StatusCode::INTERNAL_SERVER_ERROR,
                "{path}"
            );
            assert_eq!(snapshot(&pool, &org).await, before, "{path} rollback");
        }
        sqlx::raw_sql(&format!(
            "DROP TRIGGER {hook} ON {target}; DROP FUNCTION {hook}();"
        ))
        .execute(&pool)
        .await
        .unwrap();
    }
    let before = snapshot(&pool, &org).await;
    sqlx::query("UPDATE organization_memberships SET status='inactive' WHERE org_id=$1::uuid AND principal_id=$2").bind(&org).bind(&user).execute(&pool).await.unwrap();
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &format!("{m}/groups/{group}"),
            Some(&token),
            Some(json!({"name":"Revoked"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(snapshot(&pool, &org).await, before);
    sqlx::query("UPDATE organization_memberships SET status='active' WHERE org_id=$1::uuid AND principal_id=$2").bind(&org).bind(&user).execute(&pool).await.unwrap();
    assert_eq!(
        call(
            &client,
            &base,
            Method::DELETE,
            &format!("{m}/groups/entries/issue%3A{issue}"),
            Some(&token),
            None
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
            &format!("{m}/saved-views/{saved_id}"),
            Some(&token),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &format!("{m}/groups/{group}/separate"),
            Some(&token),
            None
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
            &format!("{m}/groups/{b}"),
            Some(&token),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    let receipts:(i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid),(SELECT count(*) FROM organization_mutation_outbox WHERE org_id=$1::uuid)").bind(&org).fetch_one(&pool).await.unwrap();
    assert_eq!(receipts.0, receipts.1);
    let execution:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid),(SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid),(SELECT count(*) FROM automation_runs WHERE org_id=$1::uuid)").bind(&org).fetch_one(&pool).await.unwrap();
    assert_eq!(execution, (0, 0, 0));
    if let DatabaseState::Configured(native_pool) = &foundation.database {
        native_pool.close().await;
    }
    for (method, path, body) in [
        (
            Method::POST,
            format!("{m}/groups"),
            json!({"name":"Closed"}),
        ),
        (Method::POST, format!("{issue_path}/read"), json!({})),
        (
            Method::POST,
            format!("{m}/groups/{group}/title/regenerate"),
            json!({}),
        ),
    ] {
        assert!(
            call(&client, &base, method, &path, Some(&token), Some(body))
                .await
                .0
                .is_server_error()
        );
    }
    assert_eq!(
        upstream_calls.load(Ordering::SeqCst),
        0,
        "no selected request reaches Node even on native failure"
    );
    control.stop(true).await;
    task.await.unwrap().unwrap();
    provider_control.stop(true).await;
    provider_task.await.unwrap().unwrap();
    upstream_control.stop(true).await;
    upstream_task.await.unwrap().unwrap();
}
