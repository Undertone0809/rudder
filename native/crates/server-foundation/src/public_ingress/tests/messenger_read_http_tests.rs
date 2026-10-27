use super::*;
use actix_web::{App, HttpResponse, HttpServer, web};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
};

#[actix_web::test]
#[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB"]
async fn native_messenger_reads_cover_journey_paging_privacy_effects_and_no_node_fallback() {
    let database_url = env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap();
    let pool = super::disposable_native_auth_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let org = organization(&pool, &suffix, "own").await;
    let foreign = organization(&pool, &suffix, "foreign").await;
    let user = format!("messenger-{suffix}");
    let other = format!("messenger-other-{suffix}");
    let token = operator(&pool, &org, &user).await;
    let other_token = operator(&pool, &org, &other).await;
    let agent = sqlx::query_scalar::<_,String>("INSERT INTO agents(org_id,name,role,status) VALUES($1::uuid,'Messenger agent','general','idle') RETURNING id::text").bind(&org).fetch_one(&pool).await.unwrap();
    let agent_token = format!("pcp_messenger_agent_{suffix}");
    sqlx::query("INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) VALUES($1::uuid,$2::uuid,'Messenger test',$3)").bind(&org).bind(&agent).bind(crate::native_bearer_auth::hash_token(&agent_token)).execute(&pool).await.unwrap();
    let mut chats = Vec::new();
    for n in 0..105 {
        chats.push(chat(&pool, &org, &user, &format!("Chat {n:03}"), false).await);
    }
    let private = chat(&pool, &org, &other, "Private SideChat", true).await;
    let foreign_chat = chat(&pool, &foreign, &other, "Foreign chat", false).await;
    let issue = sqlx::query_scalar::<_,String>("INSERT INTO issues(org_id,title,issue_number,identifier,created_by_user_id) VALUES($1::uuid,'Tracked issue',1,$2,$3) RETURNING id::text").bind(&org).bind(format!("MS{}-1",&suffix[..6])).bind(&user).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO issues(org_id,title,issue_number,identifier,created_by_user_id,created_at,updated_at) SELECT $1::uuid,'Tracked issue '||n,n,$2||'-'||n,$3,'2026-09-01T00:00:00Z'::timestamptz+n*interval '1 second','2026-09-01T00:00:00Z'::timestamptz+n*interval '1 second' FROM generate_series(2,106) n").bind(&org).bind(format!("MS{}",&suffix[..6])).bind(&user).execute(&pool).await.unwrap();
    sqlx::query("UPDATE chat_conversations SET primary_issue_id=$2::uuid WHERE id=$1::uuid")
        .bind(&chats[0])
        .bind(&issue)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO chat_context_links(org_id,conversation_id,entity_type,entity_id) VALUES($1::uuid,$2::uuid,'issue',$3)").bind(&org).bind(&chats[0]).bind(&issue).execute(&pool).await.unwrap();
    let incoming = message(
        &pool,
        &org,
        &chats[0],
        "assistant",
        "# Progress\nThe useful reply",
        json!({"__chatTranscript":[{"kind":"assistant","text":"legacy"}]}),
    )
    .await;
    let generation = sqlx::query_scalar::<_,String>("INSERT INTO chat_generations(org_id,conversation_id,status,terminal_reason,accepted_through_seq) VALUES($1::uuid,$2::uuid,'completed','completed',1) RETURNING id::text").bind(&org).bind(&chats[0]).fetch_one(&pool).await.unwrap();
    for seq in 1..=2 {
        sqlx::query("INSERT INTO chat_generation_events(org_id,generation_id,generation_seq,attempt_epoch,event_kind,assistant_message_id,payload) VALUES($1::uuid,$2::uuid,$3,1,'transcript',$4::uuid,jsonb_build_object('entry',jsonb_build_object('kind','assistant','text',$5::text,'ts','2026-10-01T00:00:00.000Z')))").bind(&org).bind(&generation).bind(seq).bind(&incoming).bind(if seq==1 {"accepted"}else{"beyond-cutoff"}).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO chat_message_transcript_entries(org_id,message_id,entry_seq,payload) VALUES($1::uuid,$2::uuid,0,'{\"kind\":\"assistant\",\"text\":\"detached\"}')").bind(&org).bind(&incoming).execute(&pool).await.unwrap();
    sqlx::query(
        "UPDATE chat_messages SET created_at='0044-01-02T03:04:05.123456Z' WHERE id=$1::uuid",
    )
    .bind(&incoming)
    .execute(&pool)
    .await
    .unwrap();
    let outgoing = message(
        &pool,
        &org,
        &chats[0],
        "user",
        "My question",
        json!({"source":"steer","targetGenerationId":generation}),
    )
    .await;
    sqlx::query("INSERT INTO chat_queued_messages(org_id,conversation_id,position,client_mutation_id,payload,source_message_id,delivery_disposition,dequeued_at) VALUES($1::uuid,$2::uuid,1,'messenger-steer','{}',$3::uuid,'acceptance_unknown',now())").bind(&org).bind(&chats[0]).bind(&outgoing).execute(&pool).await.unwrap();
    let asset=sqlx::query_scalar::<_,String>("INSERT INTO assets(org_id,provider,object_key,content_type,byte_size,sha256,created_by_agent_id) VALUES($1::uuid,'local','messenger-html','text/html',12,'fixture',$2::uuid) RETURNING id::text").bind(&org).bind(&agent).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO chat_attachments(org_id,conversation_id,message_id,asset_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)").bind(&org).bind(&chats[0]).bind(&incoming).bind(&asset).execute(&pool).await.unwrap();
    message(&pool,&org,&chats[1],"assistant","External reply",json!({"source":"agent_integration","provider":"feishu","integrationId":"historical-binding","externalChatId":"external-chat","externalChatType":"group"})).await;
    let run=sqlx::query_scalar::<_,String>("INSERT INTO heartbeat_runs(org_id,agent_id,status,result_json,context_snapshot) VALUES($1::uuid,$2::uuid,'failed','{\"userMessage\":\"Visible failure\"}',jsonb_build_object('issueId',$3::text,'scene','issue')) RETURNING id::text").bind(&org).bind(&agent).bind(&issue).fetch_one(&pool).await.unwrap();
    let private_run=sqlx::query_scalar::<_,String>("INSERT INTO heartbeat_runs(org_id,agent_id,status,chat_conversation_id,context_snapshot,result_json) VALUES($1::uuid,$2::uuid,'failed',$3::uuid,'{\"scene\":\"side_chat\"}','{\"userMessage\":\"Private failure\"}') RETURNING id::text").bind(&org).bind(&agent).bind(&private).fetch_one(&pool).await.unwrap();
    let approval=sqlx::query_scalar::<_,String>("INSERT INTO approvals(org_id,type,payload,requested_by_user_id) VALUES($1::uuid,'chat_operation','{\"operationProposal\":{\"summary\":\"Review this operation\"},\"apiKey\":\"do-not-echo\"}',$2) RETURNING id::text").bind(&org).bind(&user).fetch_one(&pool).await.unwrap();
    sqlx::query("INSERT INTO requests(org_id,kind,subtype,title,prompt,issue_id) VALUES($1::uuid,'assistance','issue_blocker','Need input','Choose the next step',$2::uuid)").bind(&org).bind(&issue).execute(&pool).await.unwrap();
    let group = create_group(&pool, &org, &user, "My group", 0).await;
    let empty = create_group(&pool, &org, &user, "Stale group", 1).await;
    entry(&pool, &org, &user, &group, &format!("chat:{}", chats[0]), 0).await;
    entry(&pool, &org, &user, &group, "join-requests", 1).await;
    let saved=sqlx::query_scalar::<_,String>("INSERT INTO messenger_saved_views(org_id,user_id,target_kind,target_payload,resource_key,instance_id,canonical_resource_key,title,hidden_at) VALUES($1::uuid,$2,'url','{\"kind\":\"url\",\"url\":\"https://example.invalid\"}','fixture','fixture','fixture','Hidden saved view',now()) RETURNING id::text").bind(&org).bind(&user).fetch_one(&pool).await.unwrap();
    entry(
        &pool,
        &org,
        &user,
        &group,
        &format!("saved-view:{saved}"),
        2,
    )
    .await;
    entry(
        &pool,
        &org,
        &user,
        &empty,
        "chat:00000000-0000-0000-0000-000000000001",
        0,
    )
    .await;

    let node_count = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let node = HttpServer::new({
        let count = node_count.clone();
        move || {
            let count = count.clone();
            App::new().default_service(web::to(move || {
                let count = count.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    HttpResponse::ImATeapot().finish()
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
    let (_foundation, runtime) = messenger_runtime(Some(database_url), &upstream);
    let base = format!("http://{}", runtime.bound_addr());
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let prefix = format!("/api/orgs/{org}/messenger");
    for suffix in [
        "groups",
        "threads",
        "issues",
        "approvals",
        "system/failed-runs",
        "system/budget-alerts",
        "system/join-requests",
    ]
    .into_iter()
    .map(str::to_owned)
    .chain(std::iter::once(format!("chat/{}", chats[0])))
    {
        let path = format!("{prefix}/{suffix}");
        assert_eq!(
            get(&client, &base, &path, None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            get(&client, &base, &path, Some(&agent_token)).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            get(&client, &base, &path, Some(&token)).await.0,
            StatusCode::OK,
            "{path}"
        );
        let mut response = client
            .head(format!("{base}{path}"))
            .insert_header((header::AUTHORIZATION, format!("Bearer {token}")))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.body().await.unwrap().is_empty());
    }
    let (_, directory) = get(&client, &base, &format!("{prefix}/groups"), Some(&token)).await;
    assert_eq!(directory["groups"].as_array().unwrap().len(), 1);
    assert_eq!(
        directory["groups"][0]["entries"].as_array().unwrap().len(),
        1
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM messenger_custom_group_entries WHERE org_id=$1::uuid AND group_id=$2::uuid").bind(&org).bind(&group).fetch_one(&pool).await.unwrap(),3,"hidden Saved View and dormant synthetic retain membership");
    let snapshot = state_snapshot(&pool, &org, &user).await;
    get(&client, &base, &format!("{prefix}/threads"), Some(&token)).await;
    assert_eq!(
        state_snapshot(&pool, &org, &user).await,
        snapshot,
        "GET initialization is idempotent and preserves read baselines"
    );
    message(
        &pool,
        &org,
        &chats[0],
        "assistant",
        "A newer incoming reply",
        Value::Null,
    )
    .await;
    sqlx::query("UPDATE chat_conversation_user_states SET pinned_at='2026-10-02T00:00:00Z' WHERE org_id=$1::uuid AND user_id=$2 AND conversation_id=$3::uuid").bind(&org).bind(&user).bind(&chats[0]).execute(&pool).await.unwrap();
    let (_, fresh) = get(
        &client,
        &base,
        &format!("{prefix}/chat/{}", chats[0]),
        Some(&token),
    )
    .await;
    assert_eq!(fresh["conversation"]["unreadCount"], 1);
    assert_eq!(fresh["conversation"]["needsAttention"], true);
    let (_, pinned) = get(
        &client,
        &base,
        &format!("{prefix}/threads?limit=1"),
        Some(&token),
    )
    .await;
    assert_eq!(
        pinned["items"][0]["threadKey"],
        format!("chat:{}", chats[0])
    );
    assert_eq!(pinned["items"][0]["isPinned"], true);
    let mut cursor = None;
    let mut observed = HashSet::new();
    loop {
        let path = format!(
            "{prefix}/threads?limit=17{}",
            cursor
                .as_ref()
                .map(|s: &String| format!("&cursor={s}"))
                .unwrap_or_default()
        );
        let (status, page) = get(&client, &base, &path, Some(&token)).await;
        assert_eq!(status, StatusCode::OK);
        for item in page["items"].as_array().unwrap() {
            let key = item["threadKey"].as_str().unwrap();
            assert!(observed.insert(key.to_owned()), "duplicate {key}");
        }
        cursor = page["pageInfo"]["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    for id in &chats {
        assert!(observed.contains(&format!("chat:{id}")));
    }
    assert!(!observed.contains(&format!("chat:{private}")));
    assert!(!observed.contains(&format!("chat:{foreign_chat}")));
    // The selector runs with an explicit sv-SE host fact even when all four
    // Linux locale variables are absent, exercising the real ingress handoff.
    if matches!(
        env::var("RUDDER_NATIVE_HOST_LOCALE").as_deref(),
        Ok("sv" | "sv-SE")
    ) {
        let a = chat(&pool, &org, &user, "Ångström", false).await;
        let z = chat(&pool, &org, &user, "Zebra", false).await;
        let (_, titles) = get(&client, &base, &format!("{prefix}/threads"), Some(&token)).await;
        let titles = titles.as_array().unwrap();
        let pos = |id: &str| {
            titles
                .iter()
                .position(|item| item["threadKey"] == format!("chat:{id}"))
                .unwrap()
        };
        assert!(
            pos(&z) < pos(&a),
            "public sort must use handed-off Swedish locale"
        );
    }
    assert_eq!(
        get(
            &client,
            &base,
            &format!("{prefix}/chat/{private}"),
            Some(&token)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM chat_conversation_user_states WHERE conversation_id=$1::uuid AND user_id=$2").bind(&private).bind(&user).fetch_one(&pool).await.unwrap(),0);
    assert_eq!(
        get(
            &client,
            &base,
            &format!("{prefix}/chat/{private}"),
            Some(&other_token)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        get(
            &client,
            &base,
            &format!("{prefix}/chat/{foreign_chat}"),
            Some(&token)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(
            &client,
            &base,
            &format!("/api/orgs/{foreign}/messenger/threads"),
            Some(&token)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let encoded_org = org
        .chars()
        .map(|c| format!("%{:02X}", c as u32))
        .collect::<String>();
    assert_eq!(
        get(
            &client,
            &base,
            &format!("/API/ORGS/{encoded_org}/MESSENGER/THREADS/"),
            Some(&token)
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, detail) = get(
        &client,
        &base,
        &format!("{prefix}/chat/{}", chats[0]),
        Some(&token),
    )
    .await;
    assert_eq!(detail["conversation"]["primaryIssue"]["id"], issue);
    assert_eq!(
        detail["conversation"]["contextLinks"][0]["entity"]["id"],
        issue
    );
    let messages = detail["messages"].as_array().unwrap();
    let reply = messages.iter().find(|m| m["id"] == incoming).unwrap();
    assert_eq!(reply["createdAt"], "0044-01-02T03:04:05.123Z");
    assert_eq!(reply["transcript"].as_array().unwrap().len(), 1);
    assert_eq!(reply["transcript"][0]["text"], "accepted");
    assert_eq!(reply["transcript"][0]["generationId"], generation);
    assert_eq!(reply["transcriptSummary"]["entryCount"], 1);
    assert!(reply["structuredPayload"].is_null());
    assert!(reply.get("clientMutationId").is_none());
    assert!(reply["attachments"][0].get("objectKey").is_none());
    assert!(reply["attachments"][0].get("provider").is_none());
    assert_eq!(
        messages.iter().find(|m| m["id"] == outgoing).unwrap()["structuredPayload"]["deliveryDisposition"],
        "continuation_pending"
    );
    let (_, external) = get(
        &client,
        &base,
        &format!("{prefix}/chat/{}", chats[1]),
        Some(&token),
    )
    .await;
    assert_eq!(
        external["conversation"]["mutability"],
        "external_bound_chat"
    );
    assert_eq!(
        external["conversation"]["sourceMetadata"]["provider"],
        "feishu"
    );
    assert_eq!(external["conversation"]["unreadCount"], 0);
    let (_, failures) = get(
        &client,
        &base,
        &format!("{prefix}/system/failed-runs"),
        Some(&token),
    )
    .await;
    assert!(
        failures["detail"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == run)
    );
    assert!(!failures.to_string().contains(&private_run));
    let (_, owner_failures) = get(
        &client,
        &base,
        &format!("{prefix}/system/failed-runs"),
        Some(&other_token),
    )
    .await;
    assert!(
        owner_failures["detail"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == private_run)
    );
    let (_, requests) = get(&client, &base, &format!("{prefix}/approvals"), Some(&token)).await;
    let approval_card = requests["detail"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == approval)
        .unwrap();
    assert!(
        !approval_card["metadata"]["payload"]
            .to_string()
            .contains("do-not-echo")
    );
    assert_eq!(requests["summary"]["unreadCount"], 2);
    let mut issue_cursor = None;
    let mut issue_ids = HashSet::new();
    loop {
        let path = format!(
            "{prefix}/issues?limit=13{}",
            issue_cursor
                .as_ref()
                .map(|s: &String| format!("&cursor={s}"))
                .unwrap_or_default()
        );
        let (status, page) = get(&client, &base, &path, Some(&token)).await;
        assert_eq!(status, StatusCode::OK);
        for card in page["detail"]["items"].as_array().unwrap() {
            assert!(issue_ids.insert(card["issueId"].as_str().unwrap().to_owned()));
        }
        issue_cursor = page["detail"]["pageInfo"]["nextCursor"]
            .as_str()
            .map(str::to_owned);
        if issue_cursor.is_none() {
            break;
        }
    }
    assert_eq!(issue_ids.len(), 106);
    assert_eq!(
        get(
            &client,
            &base,
            &format!("{prefix}/issues?cursor=invalid"),
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
            &format!("{prefix}/system/unknown"),
            Some(&token)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    // A real read failure after initialization must roll the GET effect back.
    let broken = chat(&pool, &org, &user, "Broken payload", false).await;
    let deep = format!("{{\"opaque\":{}0{}}}", "[".repeat(514), "]".repeat(514));
    message(
        &pool,
        &org,
        &broken,
        "assistant",
        "Cannot hydrate",
        Value::Null,
    )
    .await;
    sqlx::query(
        "UPDATE chat_messages SET structured_payload=$2::jsonb WHERE conversation_id=$1::uuid",
    )
    .bind(&broken)
    .bind(deep)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        get(
            &client,
            &base,
            &format!("{prefix}/chat/{broken}"),
            Some(&token)
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM chat_conversation_user_states WHERE conversation_id=$1::uuid AND user_id=$2").bind(&broken).bind(&user).fetch_one(&pool).await.unwrap(),0);
    group_snapshot_cas(&pool, &client, &base, &prefix, &org, &user, &token).await;
    let (_disabled, disabled) = messenger_runtime(None, &upstream);
    let disabled_base = format!("http://{}", disabled.bound_addr());
    let disabled_control = disabled.control();
    let disabled_task = actix_web::rt::spawn(disabled.run());
    assert_eq!(
        get(
            &client,
            &disabled_base,
            &format!("{prefix}/threads"),
            Some(&token)
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    disabled_control.stop(true).await;
    disabled_task.await.unwrap().unwrap();
    assert_eq!(node_count.load(Ordering::SeqCst), 0);
    control.stop(true).await;
    task.await.unwrap().unwrap();
    node_control.stop(true).await;
    node_task.await.unwrap().unwrap();
    for org_id in [&org, &foreign] {
        for table in [
            "requests",
            "approvals",
            "chat_generations",
            "heartbeat_runs",
            "chat_conversations",
            "assets",
            "issues",
            "messenger_saved_views",
            "messenger_custom_groups",
            "agent_api_keys",
            "agents",
            "organization_memberships",
        ] {
            sqlx::query(&format!("DELETE FROM {table} WHERE org_id=$1::uuid"))
                .bind(org_id)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("DELETE FROM organizations WHERE id=$1::uuid")
            .bind(org_id)
            .execute(&pool)
            .await
            .unwrap();
    }
    for user in [&user, &other] {
        sqlx::query("DELETE FROM board_api_keys WHERE user_id=$1")
            .bind(user)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM \"user\" WHERE id=$1")
            .bind(user)
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
}

async fn organization(pool: &sqlx::PgPool, suffix: &str, label: &str) -> String {
    sqlx::query_scalar(
        "INSERT INTO organizations(url_key,name,issue_prefix) VALUES($1,$2,$3) RETURNING id::text",
    )
    .bind(format!("messenger-{suffix}-{label}"))
    .bind(label)
    .bind(format!("M{}{}", &suffix[..6], label))
    .fetch_one(pool)
    .await
    .unwrap()
}
async fn operator(pool: &sqlx::PgPool, org: &str, user: &str) -> String {
    sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES($1,'Messenger operator',$2,now(),now())").bind(user).bind(format!("{user}@invalid.test")).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,status) VALUES($1::uuid,'user',$2,'active')").bind(org).bind(user).execute(pool).await.unwrap();
    let token = format!("pcp_{user}");
    sqlx::query(
        "INSERT INTO board_api_keys(user_id,name,key_hash) VALUES($1,'Messenger fixture',$2)",
    )
    .bind(user)
    .bind(crate::native_bearer_auth::hash_token(&token))
    .execute(pool)
    .await
    .unwrap();
    token
}
async fn chat(pool: &sqlx::PgPool, org: &str, user: &str, title: &str, private: bool) -> String {
    sqlx::query_scalar("INSERT INTO chat_conversations(org_id,title,created_by_user_id,conversation_kind,last_message_at,created_at,updated_at) VALUES($1::uuid,$2,$3,$4,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z') RETURNING id::text").bind(org).bind(title).bind(user).bind(if private {"side_chat"}else{"chat"}).fetch_one(pool).await.unwrap()
}
async fn message(
    pool: &sqlx::PgPool,
    org: &str,
    chat: &str,
    role: &str,
    body: &str,
    payload: Value,
) -> String {
    sqlx::query_scalar("INSERT INTO chat_messages(org_id,conversation_id,role,body,structured_payload,client_mutation_id,client_mutation_fingerprint) VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6,'private-fingerprint') RETURNING id::text").bind(org).bind(chat).bind(role).bind(body).bind(payload.to_string()).bind(Uuid::new_v4().to_string()).fetch_one(pool).await.unwrap()
}
async fn create_group(
    pool: &sqlx::PgPool,
    org: &str,
    user: &str,
    name: &str,
    order: i32,
) -> String {
    sqlx::query_scalar("INSERT INTO messenger_custom_groups(org_id,user_id,name,sort_order) VALUES($1::uuid,$2,$3,$4) RETURNING id::text").bind(org).bind(user).bind(name).bind(order).fetch_one(pool).await.unwrap()
}
async fn entry(
    pool: &sqlx::PgPool,
    org: &str,
    user: &str,
    group: &str,
    key: &str,
    order: i32,
) -> String {
    sqlx::query_scalar("INSERT INTO messenger_custom_group_entries(org_id,user_id,group_id,thread_key,sort_order) VALUES($1::uuid,$2,$3::uuid,$4,$5) RETURNING id::text").bind(org).bind(user).bind(group).bind(key).bind(order).fetch_one(pool).await.unwrap()
}
async fn state_snapshot(pool: &sqlx::PgPool, org: &str, user: &str) -> String {
    sqlx::query_scalar("SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY conversation_id),'[]'::jsonb)::text FROM chat_conversation_user_states s WHERE org_id=$1::uuid AND user_id=$2").bind(org).bind(user).fetch_one(pool).await.unwrap()
}
async fn group_snapshot_cas(
    pool: &sqlx::PgPool,
    _client: &awc::Client,
    base: &str,
    prefix: &str,
    org: &str,
    user: &str,
    token: &str,
) {
    let old = create_group(pool, org, user, "Concurrent source", 2).await;
    let target = create_group(pool, org, user, "Concurrent destination", 3).await;
    let membership = entry(
        pool,
        org,
        user,
        &old,
        "chat:00000000-0000-0000-0000-000000000002",
        0,
    )
    .await;
    let lock = format!("messenger-saved-views:{org}:{user}");
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(&lock)
        .execute(&mut *tx)
        .await
        .unwrap();
    let base = base.to_owned();
    let path = format!("{prefix}/groups");
    let token = token.to_owned();
    let pending = actix_web::rt::spawn(async move {
        get(&awc::Client::default(), &base, &path, Some(&token)).await
    });
    let mut waiting = false;
    for _ in 0..100 {
        waiting=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objid=hashtext($1)::oid)").bind(&lock).fetch_one(pool).await.unwrap();
        if waiting {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(waiting, "GET reached the existing owner-placement lock");
    sqlx::query("UPDATE messenger_custom_group_entries SET group_id=$2::uuid WHERE id=$1::uuid")
        .bind(&membership)
        .bind(&target)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(pending.await.unwrap().0, StatusCode::OK);
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT group_id::text FROM messenger_custom_group_entries WHERE id=$1::uuid"
        )
        .bind(&membership)
        .fetch_one(pool)
        .await
        .unwrap(),
        target,
        "snapshot CAS must preserve a concurrent move"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM messenger_custom_groups WHERE id=$1::uuid"
        )
        .bind(old)
        .fetch_one(pool)
        .await
        .unwrap(),
        0
    );
}
fn messenger_runtime(
    database_url: Option<String>,
    upstream: &str,
) -> (Arc<AppState>, PublicIngressRuntime) {
    let foundation = Arc::new(
        AppState::new(ServerConfig {
            database_url,
            actor_envelope_key: Some(SigningKey::new(b"messenger-read-envelope-key").unwrap()),
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
            "messenger-agent-jwt-secret",
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
