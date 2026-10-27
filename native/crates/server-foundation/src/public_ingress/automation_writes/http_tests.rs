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
    let value = if status == StatusCode::NO_CONTENT {
        Value::Null
    } else {
        response.json().await.unwrap()
    };
    (status, value)
}
async fn snapshot(pool: &PgPool, org: &str) -> String {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM automations t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM automation_triggers t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM organization_secrets t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM organization_secret_versions v JOIN organization_secrets t ON t.id=v.secret_id WHERE t.org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM activity_log t WHERE org_id=$1::uuid),(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM organization_mutation_outbox t WHERE org_id=$1::uuid))::text").bind(org).fetch_one(pool).await.unwrap()
}

#[actix_web::test]
#[ignore = "requires migrated disposable RUDDER_NATIVE_AUTH_TEST_DATABASE_URL and isolated secrets key file"]
async fn native_automation_management_preserves_full_journey_permissions_secret_schedule_atomicity_and_no_fallback()
 {
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
        .bind(format!("Automation writes {label}"))
        .bind(format!("automation-write-{suffix}-{label}"))
        .bind(format!("AW{}{}", &suffix[..6], label))
        .execute(&pool)
        .await
        .unwrap();
    }
    let user = format!("automation-write-user-{suffix}");
    let foreign_user = format!("automation-write-foreign-{suffix}");
    let token = format!("automation-write-key-{suffix}");
    let foreign_token = format!("automation-write-foreign-key-{suffix}");
    for (user, org, token) in [
        (&user, &org, &token),
        (&foreign_user, &foreign, &foreign_token),
    ] {
        sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES($1,'Automation fixture',$2,now(),now())").bind(user).bind(format!("{user}@invalid.test")).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,status) VALUES($1::uuid,'user',$2,'active')").bind(org).bind(user).execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO board_api_keys(user_id,name,key_hash) VALUES($1,'Automation fixture',$2)",
        )
        .bind(user)
        .bind(crate::native_bearer_auth::hash_token(token))
        .execute(&pool)
        .await
        .unwrap();
    }
    let agent: String = sqlx::query_scalar("INSERT INTO agents(org_id,name,role,status) VALUES($1::uuid,'Automation fixture agent','general','idle') RETURNING id::text").bind(&org).fetch_one(&pool).await.unwrap();
    let agent_token = format!("automation-write-agent-{suffix}");
    sqlx::query("INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) VALUES($1::uuid,$2::uuid,'Automation fixture',$3)").bind(&org).bind(&agent).bind(crate::native_bearer_auth::hash_token(&agent_token)).execute(&pool).await.unwrap();
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
                SigningKey::new(b"automation-write-test-envelope-key").unwrap(),
            ),
            workers: 1,
            ..ServerConfig::default()
        })
        .unwrap(),
    );
    let mut config = PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        &upstream,
        "automation-write-test-forwarding-key",
    )
    .unwrap();
    config.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            "automation-write-test-identity-assertion-key-0001",
            "automation-write-test-agent-jwt-secret-0001",
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

    let collection = format!("/api/orgs/{org}/automations");
    let body = json!({"title":"  Synthetic recurring work  ","instructions":"Canonical instructions","description":"Legacy instructions","assigneeAgentId":agent,"assigneeAgentRuntimeOverrides":{"agentRuntimeConfig":{"model":"synthetic-model"}},"notifyOnIssueCreated":true,"ignored":true});
    let before = snapshot(&pool, &org).await;
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &collection,
            None,
            Some(body.clone())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &collection,
            Some(&foreign_token),
            Some(body.clone())
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
            &collection,
            Some(&token),
            Some(body.clone())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(snapshot(&pool, &org).await, before);
    sqlx::query("INSERT INTO principal_permission_grants(org_id,principal_type,principal_id,permission_key) VALUES($1::uuid,'user',$2,'tasks:assign')").bind(&org).bind(&user).execute(&pool).await.unwrap();
    let (status, created) = call(
        &client,
        &base,
        Method::POST,
        &collection.to_uppercase(),
        Some(&token),
        Some(body.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["title"], "Synthetic recurring work");
    assert_eq!(created["description"], "Canonical instructions");
    assert_eq!(created["outputMode"], "track_issue");
    assert_eq!(created["notifyOnIssueCreatedUserId"], user);
    assert!(created.get("ignored").is_none());
    assert!(created["createdAt"].as_str().unwrap().ends_with('Z'));
    let id = created["id"].as_str().unwrap();
    let path = format!("/api/automations/{id}");
    let triggers = format!("{path}/triggers");
    let encoded_id = format!("%{:02X}{}", id.as_bytes()[0], &id[1..]);
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &format!("/API/AUTOMATIONS/{encoded_id}/"),
            Some(&token),
            Some(json!({"title":"Synthetic recurring work"}))
        )
        .await
        .0,
        StatusCode::OK
    );

    let other_agent:String=sqlx::query_scalar("INSERT INTO agents(org_id,name,role,status) VALUES($1::uuid,'Other automation fixture','general','idle') RETURNING id::text").bind(&org).fetch_one(&pool).await.unwrap();
    let foreign_agent:String=sqlx::query_scalar("INSERT INTO agents(org_id,name,role,status) VALUES($1::uuid,'Foreign automation fixture','general','idle') RETURNING id::text").bind(&foreign).fetch_one(&pool).await.unwrap();
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &path,
            Some(&agent_token),
            Some(json!({"assigneeAgentId":other_agent}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &path,
            Some(&token),
            Some(json!({"assigneeAgentId":foreign_agent}))
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &path,
            Some(&foreign_token),
            Some(json!({"title":"foreign"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let audits: i64 = sqlx::query_scalar("SELECT count(*) FROM activity_log WHERE org_id=$1::uuid")
        .bind(&org)
        .fetch_one(&pool)
        .await
        .unwrap();
    let updated=call(&client,&base,Method::PATCH,&path,Some(&token),Some(json!({"assigneeAgentId":other_agent,"outputMode":"chat_output","notifyOnIssueCreated":true,"description":null}))).await;
    assert_eq!(updated.0, StatusCode::OK);
    assert_eq!(updated.1["assigneeAgentRuntimeOverrides"], Value::Null);
    assert_eq!(updated.1["notifyOnIssueCreated"], false);
    assert_eq!(updated.1["description"], Value::Null);
    let after_audits: i64 =
        sqlx::query_scalar("SELECT count(*) FROM activity_log WHERE org_id=$1::uuid")
            .bind(&org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(after_audits, audits + 1, "definition PATCH emits activity");
    let update_receipts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log a JOIN organization_mutation_outbox o ON o.activity_id=a.id AND o.org_id=a.org_id WHERE a.org_id=$1::uuid AND a.action='automation.updated' AND a.entity_type='automation' AND a.entity_id=$2 AND a.actor_type='user' AND a.actor_id=$3 AND a.details=jsonb_build_object('title',$4::text,'assigneeAgentId',$5::text) AND o.event_type='activity.logged' AND o.payload->>'action'=a.action AND o.payload->>'entityType'=a.entity_type AND o.payload->>'entityId'=a.entity_id AND o.payload->>'actorType'=a.actor_type AND o.payload->>'actorId'=a.actor_id AND o.payload->'details'=a.details",
    )
    .bind(&org)
    .bind(id)
    .bind(&user)
    .bind(updated.1["title"].as_str().unwrap())
    .bind(&other_agent)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        update_receipts, 1,
        "definition PATCH emits its bound outbox"
    );
    call(
        &client,
        &base,
        Method::PATCH,
        &path,
        Some(&token),
        Some(json!({"assigneeAgentId":agent})),
    )
    .await;
    let agent_created = call(
        &client,
        &base,
        Method::POST,
        &collection,
        Some(&agent_token),
        Some(json!({"title":"Agent owned","assigneeAgentId":agent})),
    )
    .await;
    assert_eq!(agent_created.0, StatusCode::CREATED);
    assert_eq!(agent_created.1["createdByAgentId"], agent);
    assert_eq!(agent_created.1["createdByUserId"], Value::Null);
    assert_eq!(call(&client,&base,Method::POST,&triggers,Some(&token),Some(json!({"kind":"schedule","cronExpression":"* * * * *","timezone":"Invalid/Synthetic"}))).await.0,StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &triggers,
            Some(&token),
            Some(json!({"kind":"schedule","cronExpression":"60 * * * *","timezone":"UTC"}))
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let schedule = call(
        &client,
        &base,
        Method::POST,
        &triggers,
        Some(&token),
        Some(json!({"kind":"schedule","cronExpression":"* * * * *","timezone":"asia/shanghai"})),
    )
    .await;
    assert_eq!(schedule.0, StatusCode::CREATED, "{}", schedule.1);
    assert_eq!(schedule.1["secretMaterial"], Value::Null);
    assert_eq!(schedule.1["trigger"]["timezone"], "asia/shanghai");
    let schedule_id = schedule.1["trigger"]["id"].as_str().unwrap();
    let schedule_path = format!("/api/automation-triggers/{schedule_id}");
    sqlx::query(
        "UPDATE automation_triggers SET next_run_at='2000-01-01T00:00:00Z' WHERE id=$1::uuid",
    )
    .bind(schedule_id)
    .execute(&pool)
    .await
    .unwrap();
    let schedule_update = call(
        &client,
        &base,
        Method::PATCH,
        &schedule_path,
        Some(&token),
        Some(json!({"label":"Label-only update","enabled":false})),
    )
    .await;
    assert_eq!(schedule_update.0, StatusCode::OK);
    assert_ne!(schedule_update.1["nextRunAt"], "2000-01-01T00:00:00.000Z");
    assert_eq!(schedule_update.1["enabled"], false);
    assert_eq!(
        call(
            &client,
            &base,
            Method::PATCH,
            &schedule_path,
            Some(&token),
            Some(json!({"timezone":null}))
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let hook = call(
        &client,
        &base,
        Method::POST,
        &triggers,
        Some(&agent_token),
        Some(json!({"kind":"webhook","signingMode":"hmac_sha256","replayWindowSec":600})),
    )
    .await;
    assert_eq!(hook.0, StatusCode::CREATED, "{}", hook.1);
    let hook_id = hook.1["trigger"]["id"].as_str().unwrap();
    let secret_id = hook.1["trigger"]["secretId"].as_str().unwrap();
    let hook_path = format!("/api/automation-triggers/{hook_id}");
    let rotate = format!("{hook_path}/rotate-secret");
    let secret = hook.1["secretMaterial"]["webhookSecret"].as_str().unwrap();
    assert_eq!(secret.len(), 48);
    let api = std::env::var("RUDDER_NATIVE_HOST_API_URL")
        .or_else(|_| std::env::var("RUDDER_API_URL"))
        .unwrap_or_else(|_| "undefined".to_owned());
    assert_eq!(
        hook.1["secretMaterial"]["webhookUrl"],
        format!(
            "{api}/api/automation-triggers/public/{}/fire",
            hook.1["trigger"]["publicId"].as_str().unwrap()
        )
    );
    let stored:(String,String,String)=sqlx::query_as("SELECT s.created_by_agent_id::text,v.material::text,v.value_sha256 FROM organization_secrets s JOIN organization_secret_versions v ON v.secret_id=s.id WHERE s.id=$1::uuid").bind(secret_id).fetch_one(&pool).await.unwrap();
    assert_eq!(stored.0, agent);
    assert!(!stored.1.contains(secret));
    assert!(stored.1.contains("local_encrypted_v1"));
    use sha2::{Digest, Sha256};
    assert_eq!(stored.2, format!("{:x}", Sha256::digest(secret.as_bytes())));
    let rotated = call(
        &client,
        &base,
        Method::POST,
        &rotate,
        Some(&agent_token),
        Some(json!({})),
    )
    .await;
    assert_eq!(rotated.0, StatusCode::OK);
    assert_eq!(
        rotated.1["trigger"]["publicId"],
        hook.1["trigger"]["publicId"]
    );
    assert_ne!(rotated.1["secretMaterial"]["webhookSecret"], secret);
    let version: i32 =
        sqlx::query_scalar("SELECT latest_version FROM organization_secrets WHERE id=$1::uuid")
            .bind(secret_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(version, 2);
    let secret_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND action LIKE 'secret.%'",
    )
    .bind(&org)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        secret_events, 0,
        "Automation secret creation has only trigger audit"
    );
    let failure = format!("automation_write_fail_{}", &suffix[..12]);
    for target in ["activity_log", "organization_mutation_outbox"] {
        sqlx::raw_sql(&format!("CREATE FUNCTION {failure}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.org_id='{org}'::uuid THEN RAISE EXCEPTION 'synthetic automation receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER {failure} BEFORE INSERT ON {target} FOR EACH ROW EXECUTE FUNCTION {failure}();")).execute(&pool).await.unwrap();
        let before = snapshot(&pool, &org).await;
        for (method, path, payload) in [
            (Method::POST, collection.as_str(), Some(body.clone())),
            (
                Method::PATCH,
                path.as_str(),
                Some(json!({"title":"rollback definition"})),
            ),
            (
                Method::POST,
                triggers.as_str(),
                Some(json!({"kind":"webhook"})),
            ),
            (Method::POST, rotate.as_str(), Some(json!({}))),
            (
                Method::PATCH,
                hook_path.as_str(),
                Some(json!({"label":"rollback"})),
            ),
            (Method::DELETE, hook_path.as_str(), None),
            (Method::DELETE, path.as_str(), None),
        ] {
            assert_eq!(
                call(&client, &base, method, path, Some(&token), payload)
                    .await
                    .0,
                StatusCode::INTERNAL_SERVER_ERROR
            );
            assert_eq!(snapshot(&pool, &org).await, before);
        }
        sqlx::raw_sql(&format!(
            "DROP TRIGGER {failure} ON {target}; DROP FUNCTION {failure}();"
        ))
        .execute(&pool)
        .await
        .unwrap();
    }
    assert_eq!(
        call(
            &client,
            &base,
            Method::DELETE,
            &hook_path,
            Some(&token),
            None
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let retained: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM organization_secrets WHERE id=$1::uuid)")
            .bind(secret_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        retained,
        "trigger deletion preserves the existing orphan-secret contract"
    );
    let second_hook = call(
        &client,
        &base,
        Method::POST,
        &triggers,
        Some(&token),
        Some(json!({"kind":"webhook"})),
    )
    .await;
    let second_secret = second_hook.1["trigger"]["secretId"].as_str().unwrap();
    // A malformed historical trigger relation must never rotate/delete a
    // secret in another organization.
    let foreign_secret:String=sqlx::query_scalar("INSERT INTO organization_secrets(org_id,name,provider,purpose,latest_version) VALUES($1::uuid,$2,'local_encrypted','user_managed',1) RETURNING id::text").bind(&foreign).bind(format!("automation-foreign-{suffix}")).fetch_one(&pool).await.unwrap();
    let corrupt_trigger:String=sqlx::query_scalar("INSERT INTO automation_triggers(org_id,automation_id,kind,public_id,secret_id) VALUES($1::uuid,$2::uuid,'webhook',$3,$4::uuid) RETURNING id::text").bind(&org).bind(id).bind(format!("synthetic-cross-org-{suffix}")).bind(&foreign_secret).fetch_one(&pool).await.unwrap();
    let foreign_before = snapshot(&pool, &foreign).await;
    assert_eq!(
        call(
            &client,
            &base,
            Method::POST,
            &format!("/api/automation-triggers/{corrupt_trigger}/rotate-secret"),
            Some(&token),
            Some(json!({}))
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(snapshot(&pool, &foreign).await, foreign_before);

    let api_trigger = call(
        &client,
        &base,
        Method::POST,
        &triggers,
        Some(&token),
        Some(json!({"kind":"api"})),
    )
    .await;
    assert_eq!(api_trigger.0, StatusCode::CREATED);
    assert_eq!(api_trigger.1["secretMaterial"], Value::Null);
    assert_eq!(
        call(&client, &base, Method::DELETE, &path, Some(&token), None)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let removed: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS(SELECT 1 FROM organization_secrets WHERE id=$1::uuid)",
    )
    .bind(second_secret)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(removed);
    assert_eq!(snapshot(&pool, &foreign).await, foreign_before);
    let dispatched:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM automation_runs WHERE org_id=$1::uuid),(SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid),(SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid)").bind(&org).fetch_one(&pool).await.unwrap();
    assert_eq!(
        dispatched,
        (0, 0, 0),
        "management never dispatches or creates execution intents"
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
    let activity_count: i64 =
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
    assert_eq!(activity_count, outbox_count);
    let before = snapshot(&pool, &org).await;
    if let DatabaseState::Configured(native_pool) = &foundation.database {
        native_pool.close().await;
    }
    for (method, path, payload) in [
        (Method::POST, collection.as_str(), Some(body)),
        (Method::PATCH, path.as_str(), Some(json!({}))),
        (Method::DELETE, path.as_str(), None),
        (Method::POST, triggers.as_str(), Some(json!({"kind":"api"}))),
        (Method::PATCH, schedule_path.as_str(), Some(json!({}))),
        (Method::DELETE, schedule_path.as_str(), None),
        (Method::POST, rotate.as_str(), Some(json!({}))),
    ] {
        assert_eq!(
            call(&client, &base, method, path, Some(&token), payload)
                .await
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    assert_eq!(snapshot(&pool, &org).await, before);
    assert_eq!(count.load(Ordering::SeqCst), 0);
    control.stop().await;
    task.await.unwrap().unwrap();
    node_control.stop(true).await;
    node_task.await.unwrap().unwrap();
    pool.close().await;
}
