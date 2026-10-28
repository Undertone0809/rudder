//! Approval public ingress -> native domain effects -> actual owned process.
//! The runner supplies a fresh migrated database, synthetic secret key and
//! canonical isolated host/log paths, just like the existing public fixtures.
use super::*;
use crate::{agent_run_context::AgentRunContextHost, native_bearer_auth::hash_token};
use actix_web::{App, HttpServer};
use rudder_d1_persistence::agent_core::OrganizationWorkspaceHost;
use serde_json::{Value, json};
use std::{collections::BTreeMap, net::TcpListener, path::PathBuf, time::Duration};

async fn call(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    method: reqwest::Method,
    path: &str,
    input: Value,
) -> (u16, Value) {
    let request = client
        .request(method.clone(), format!("{base}{path}"))
        .bearer_auth(token);
    let response = if method == reqwest::Method::GET {
        request.send().await
    } else {
        request.json(&input).send().await
    }
    .unwrap();
    let status = response.status().as_u16();
    let body = response.text().await.unwrap();
    (
        status,
        serde_json::from_str(&body).unwrap_or_else(|_| json!({"raw":body})),
    )
}
async fn post(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    path: &str,
    input: Value,
    expected: u16,
) -> Value {
    let (status, value) = call(client, base, token, reqwest::Method::POST, path, input).await;
    assert_eq!(status, expected, "POST {path}: {value}");
    value
}
async fn create(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    org: &str,
    kind: &str,
    payload: Value,
) -> String {
    let value = post(
        client,
        base,
        token,
        &format!("/api/orgs/{org}/approvals"),
        json!({"type":kind,"payload":payload}),
        201,
    )
    .await;
    value["id"].as_str().unwrap().to_owned()
}
async fn wait_issue(pool: &PgPool, issue: &str) -> String {
    tokio::time::timeout(Duration::from_secs(30),async {loop {
        let run:Option<String>=sqlx::query_scalar("SELECT id::text FROM heartbeat_runs WHERE execution_authority='native_rust' AND context_snapshot->>'issueId'=$1 AND status='succeeded' AND process_exited_at IS NOT NULL AND NOT terminal_effects_pending ORDER BY created_at DESC LIMIT 1").bind(issue).fetch_optional(pool).await.unwrap();
        if let Some(run)=run {return run;}tokio::time::sleep(Duration::from_millis(50)).await;
    }}).await.expect("public Approval wake runs an owned process and settles cleanup")
}

#[actix_web::test]
#[ignore = "requires fresh migrated RUDDER_NATIVE_AUTH_TEST_DATABASE_URL, isolated host/log/secret paths and frozen RUDDER_TEST_PROCESS_HOST"]
async fn public_approval_lifecycle_comments_and_domain_effects_run_without_node() {
    crate::init_tracing();
    for key in [
        "RUN_LOG_BASE_PATH",
        "RUDDER_SECRETS_MASTER_KEY_FILE",
        "RUDDER_NATIVE_HOST_RUDDER_HOME",
        "RUDDER_NATIVE_HOST_INSTANCE_ID",
        "RUDDER_NATIVE_HOST_ORGANIZATION_WORKSPACE_HOME",
        "RUDDER_NATIVE_HOST_HOME_DIRECTORY",
        "RUDDER_NATIVE_HOST_HOSTNAME",
    ] {
        assert!(env::var_os(key).is_some(), "fixture requires {key}");
    }
    let process_host =
        PathBuf::from(env::var_os("RUDDER_TEST_PROCESS_HOST").expect("frozen process host"));
    assert!(process_host.is_file());
    let pool = super::disposable_native_auth_pool().await;
    let root = tempfile::tempdir().unwrap();
    let suffix = Uuid::new_v4().simple().to_string();
    let org = Uuid::new_v4().to_string();
    let foreign = Uuid::new_v4().to_string();
    for (id, prefix) in [(&org, "AP"), (&foreign, "AF")] {
        sqlx::query("INSERT INTO organizations(id,url_key,name,issue_prefix) VALUES ($1::uuid,$2,'Approval fixture',$3)").bind(id).bind(format!("approval-{prefix}-{suffix}")).bind(format!("{prefix}{}",&suffix[..6])).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO organization_mutation_state(org_id,owner) VALUES ($1::uuid,'node') ON CONFLICT DO NOTHING").bind(id).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO organization_branding_mutation_state(org_id,owner) VALUES ($1::uuid,'node') ON CONFLICT DO NOTHING").bind(id).execute(&pool).await.unwrap();
    }
    let user = format!("approval-board-{suffix}");
    let other = format!("approval-foreign-{suffix}");
    let limited = format!("approval-limited-{suffix}");
    let token = format!("pcp_board_approval_{suffix}");
    let other_token = format!("pcp_board_approval_foreign_{suffix}");
    let limited_token = format!("pcp_board_approval_limited_{suffix}");
    for (user, token, organization) in [
        (&user, &token, &org),
        (&other, &other_token, &foreign),
        (&limited, &limited_token, &org),
    ] {
        sqlx::query("INSERT INTO \"user\"(id,name,email,created_at,updated_at) VALUES ($1,'Approval fixture',$2,now(),now())").bind(user).bind(format!("{user}@example.test")).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO organization_memberships(org_id,principal_type,principal_id,membership_role,status) VALUES ($1::uuid,'user',$2,'member','active')").bind(organization).bind(user).execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO board_api_keys(user_id,name,key_hash) VALUES ($1,'Approval fixture',$2)",
        )
        .bind(user)
        .bind(hash_token(token))
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO principal_permission_grants(org_id,principal_type,principal_id,permission_key) VALUES ($1::uuid,'user',$2,'tasks:assign')").bind(&org).bind(&user).execute(&pool).await.unwrap();
    let agent = Uuid::new_v4().to_string();
    let pending = Uuid::new_v4().to_string();
    let rejected = Uuid::new_v4().to_string();
    let agent_token = format!("pcp_approval_agent_{suffix}");
    for (id, status) in [
        (&agent, "idle"),
        (&pending, "pending_approval"),
        (&rejected, "pending_approval"),
    ] {
        sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type,agent_runtime_config,budget_monthly_cents) VALUES ($1::uuid,$2::uuid,$3,'general',$4,'process',$5::jsonb,500)")
            .bind(id).bind(&org).bind(format!("Approval {}",&id[..8])).bind(status).bind(json!({"command":"/bin/sh","args":["-c","cat >/dev/null; printf 'RUDDER_RESULT_BEGIN\\nsynthetic approval result\\nRUDDER_RESULT_END\\n'"],"cwd":root.path()}).to_string()).execute(&pool).await.unwrap();
    }
    sqlx::query("INSERT INTO agent_api_keys(org_id,agent_id,name,key_hash) VALUES ($1::uuid,$2::uuid,'Approval fixture',$3)").bind(&org).bind(&agent).bind(hash_token(&agent_token)).execute(&pool).await.unwrap();
    let revoked = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO agent_api_keys(id,org_id,agent_id,name,key_hash) VALUES ($1::uuid,$2::uuid,$3::uuid,'Rejected hire fixture',$4)").bind(&revoked).bind(&org).bind(&rejected).bind(hash_token(&format!("unused-{suffix}"))).execute(&pool).await.unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let node = HttpServer::new({
        let hits = hits.clone();
        move || {
            let hits = hits.clone();
            App::new().default_service(web::to(move || {
                let hits = hits.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    HttpResponse::InternalServerError().json(json!({"unexpectedNode":true}))
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
    let app = Arc::new(
        crate::AppState::new(crate::ServerConfig {
            database_url: Some(env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap()),
            actor_envelope_key: Some(
                rudder_auth_core::SigningKey::new(b"synthetic-approval-envelope-key").unwrap(),
            ),
            workers: 1,
            ..Default::default()
        })
        .unwrap(),
    );
    assert!(
        app.native_chat_worker.is_some(),
        "complete database initialization installs the supervisor"
    );
    let host = Arc::new(AgentRunContextHost {
        deployment_mode: "local_trusted".into(),
        environment: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
        desktop_brokers: app.desktop_brokers.clone(),
        workspace: OrganizationWorkspaceHost {
            instance_root: root.path().join("instance").display().to_string(),
            workspace_home: root.path().join("workspaces").display().to_string(),
            previous_documents_root: root.path().join("previous").display().to_string(),
            friendly_workspace_home: false,
            hostname: "approval-fixture".into(),
        },
        operator_home: root.path().join("operator"),
        process_cwd: root.path().to_path_buf(),
        executable_search_path: "/usr/bin:/bin".into(),
        runtime_root: root.path().join("runtime"),
        rudder_cli: PathBuf::from("/usr/bin/false"),
        process_host,
        api_url: "http://127.0.0.1:1".into(),
        bundled_skills_root: None,
    });
    for path in [&host.operator_home, &host.runtime_root] {
        std::fs::create_dir_all(path).unwrap();
    }
    for path in [
        &host.workspace.instance_root,
        &host.workspace.workspace_home,
        &host.workspace.previous_documents_root,
    ] {
        std::fs::create_dir_all(path).unwrap();
    }
    let mut config = PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        &upstream,
        "synthetic-approval-forwarding-key",
    )
    .unwrap();
    config.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            "synthetic-approval-identity-key",
            "synthetic-approval-agent-jwt-key",
            "rudder-test",
            "rudder-api",
            false,
        )
        .unwrap(),
    );
    config.agent_run_host = Some(host);
    let runtime = PublicIngressRuntime::bind(config, app).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = reqwest::Client::new();

    // Existing pending hire activation, budget policy, decision replay and key
    // revocation on rejection all use the public contract.
    let hire = create(
        &client,
        &base,
        &token,
        &org,
        "hire_agent",
        json!({"agentId":pending}),
    )
    .await;
    post(
        &client,
        &base,
        &agent_token,
        &format!("/api/approvals/{hire}/approve"),
        json!({}),
        403,
    )
    .await;
    post(
        &client,
        &base,
        &other_token,
        &format!("/api/approvals/{hire}/approve"),
        json!({}),
        403,
    )
    .await;
    let approved = post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{hire}/approve"),
        json!({"decisionNote":"Approved fixture"}),
        200,
    )
    .await;
    assert_eq!(approved["status"], "approved");
    post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{hire}/approve"),
        json!({}),
        200,
    )
    .await;
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM agents WHERE id=$1::uuid")
            .bind(&pending)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "idle"
    );
    assert_eq!(sqlx::query_scalar::<_,i32>("SELECT amount FROM budget_policies WHERE org_id=$1::uuid AND scope_type='agent' AND scope_id=$2::uuid AND window_kind='calendar_month_utc'").bind(&org).bind(&pending).fetch_one(&pool).await.unwrap(),500);
    let decline = create(
        &client,
        &base,
        &token,
        &org,
        "hire_agent",
        json!({"agentId":rejected}),
    )
    .await;
    post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{decline}/reject"),
        json!({"decisionNote":"Rejected fixture"}),
        200,
    )
    .await;
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT revoked_at IS NOT NULL FROM agent_api_keys WHERE id=$1::uuid"
        )
        .bind(&revoked)
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    let new_hire=create(&client,&base,&token,&org,"hire_agent",json!({"name":"Public approved new Agent","agentRuntimeType":"process","agentRuntimeConfig":{"command":"/bin/sh","promptTemplate":"Keep the approved process template"},"budgetMonthlyCents":100})).await;
    post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{new_hire}/approve"),
        json!({}),
        200,
    )
    .await;
    assert!(sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM agents a JOIN organization_memberships m ON m.org_id=a.org_id AND m.principal_type='agent' AND m.principal_id=a.id::text WHERE a.org_id=$1::uuid AND a.name='Public approved new Agent' AND a.status='idle')").bind(&org).fetch_one(&pool).await.unwrap());

    assert_eq!(sqlx::query_scalar::<_,String>("SELECT agent_runtime_config->>'promptTemplate' FROM agents WHERE org_id=$1::uuid AND name='Public approved new Agent'").bind(&org).fetch_one(&pool).await.unwrap(),"Keep the approved process template");
    let overflow = create(
        &client,
        &base,
        &token,
        &org,
        "hire_agent",
        json!({"name":"Invalid overflowing budget","budgetMonthlyCents":4294967296_i64}),
    )
    .await;
    post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{overflow}/approve"),
        json!({}),
        422,
    )
    .await;
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM approvals WHERE id=$1::uuid")
            .bind(&overflow)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "pending"
    );
    let runtime_permission = create(
        &client,
        &base,
        &token,
        &org,
        "agent_runtime",
        json!({"permissionId":"synthetic-public-runtime-permission"}),
    )
    .await;
    let resolved = post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{runtime_permission}/approve"),
        json!({}),
        200,
    )
    .await;
    assert_eq!(resolved["status"], "approved");
    let revision = create(
        &client,
        &base,
        &agent_token,
        &org,
        "approve_ceo_strategy",
        json!({"plan":"first"}),
    )
    .await;
    post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{revision}/request-revision"),
        json!({"decisionNote":"Revise this"}),
        200,
    )
    .await;
    post(
        &client,
        &base,
        &agent_token,
        &format!("/api/approvals/{revision}/resubmit"),
        json!({"payload":{"plan":"second"}}),
        200,
    )
    .await;
    let comment = post(
        &client,
        &base,
        &agent_token,
        &format!("/api/approvals/{revision}/comments"),
        json!({"body":"Fixture comment"}),
        201,
    )
    .await;
    assert_eq!(comment["authorAgentId"], agent);
    let (status, comments) = call(
        &client,
        &base,
        &token,
        reqwest::Method::GET,
        &format!("/api/approvals/{revision}/comments"),
        Value::Null,
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(comments[0]["body"], "Fixture comment");
    post(
        &client,
        &base,
        &other_token,
        &format!("/api/approvals/{revision}/comments"),
        json!({"body":"Foreign mutation"}),
        403,
    )
    .await;
    post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{revision}/reject"),
        json!({}),
        200,
    )
    .await;
    post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{revision}/approve"),
        json!({}),
        422,
    )
    .await;

    let issue = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO issues(id,org_id,title,status,assignee_agent_id) VALUES ($1::uuid,$2::uuid,'Blocked Approval fixture','blocked',$3::uuid)").bind(&issue).bind(&org).bind(&agent).execute(&pool).await.unwrap();
    let linked = post(
        &client,
        &base,
        &token,
        &format!("/api/orgs/{org}/approvals"),
        json!({"type":"budget_override_required","payload":{},"issueIds":[issue,issue]}),
        201,
    )
    .await;
    let linked_id = linked["id"].as_str().unwrap();
    post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{linked_id}/approve"),
        json!({}),
        200,
    )
    .await;
    let run = wait_issue(&pool, &issue).await;
    let (status, result) = call(
        &client,
        &base,
        &token,
        reqwest::Method::GET,
        &format!("/api/agent-runs/{run}"),
        Value::Null,
    )
    .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["status"], "succeeded");
    post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{linked_id}/approve"),
        json!({}),
        200,
    )
    .await;
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid AND reason='approval_approved' AND payload->>'approvalId'=$2").bind(&org).bind(linked_id).fetch_one(&pool).await.unwrap(),1);

    // Chat conversion uses the real payload field names and preserves explicit
    // owner/label policy before approving or creating an Issue.
    let conversation = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO chat_conversations(id,org_id,title,created_by_user_id) VALUES ($1::uuid,$2::uuid,'Approval conversation',$3)").bind(&conversation).bind(&org).bind(&user).execute(&pool).await.unwrap();
    let chat=create(&client,&base,&token,&org,"chat_issue_creation",json!({"chatConversationId":conversation,"proposedByAgentId":agent,"proposedIssue":{"title":"Approved chat Issue","description":"Public Approval conversion","assigneeAgentId":agent}})).await;
    post(
        &client,
        &base,
        &limited_token,
        &format!("/api/approvals/{chat}/approve"),
        json!({}),
        403,
    )
    .await;
    let approved = post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{chat}/approve"),
        json!({"decisionNote":"Keep this feedback"}),
        200,
    )
    .await;
    assert_eq!(approved["status"], "approved");
    let converted: String = sqlx::query_scalar(
        "SELECT primary_issue_id::text FROM chat_conversations WHERE id=$1::uuid",
    )
    .bind(&conversation)
    .fetch_one(&pool)
    .await
    .unwrap();
    let (_, value) = call(
        &client,
        &base,
        &token,
        reqwest::Method::GET,
        &format!("/api/issues/{converted}"),
        Value::Null,
    )
    .await;
    assert_eq!(value["createdByAgentId"], agent);
    assert!(
        value["description"]
            .as_str()
            .unwrap()
            .contains("## Approval feedback\n\nKeep this feedback")
    );
    wait_issue(&pool, &converted).await;
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM chat_messages WHERE conversation_id=$1::uuid AND structured_payload->>'eventType'='issue_created'").bind(&conversation).fetch_one(&pool).await.unwrap(),1);
    let fallback_conversation = Uuid::new_v4().to_string();
    let fallback_message = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO chat_conversations(id,org_id,title,created_by_user_id) VALUES ($1::uuid,$2::uuid,'Stored proposal fallback',$3)").bind(&fallback_conversation).bind(&org).bind(&user).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO chat_messages(id,org_id,conversation_id,role,kind,status,body,structured_payload,replying_agent_id) VALUES ($1::uuid,$2::uuid,$3::uuid,'assistant','issue_proposal','completed','Stored proposal',$4::jsonb,$5::uuid)").bind(&fallback_message).bind(&org).bind(&fallback_conversation).bind(json!({"issueProposal":{"title":"Stored source proposal","description":"Native conversion preserves the pre-existing source fallback","assigneeUnassignedReason":"Operator triage"}}).to_string()).bind(&agent).execute(&pool).await.unwrap();
    let fallback=create(&client,&base,&token,&org,"chat_issue_creation",json!({"chatConversationId":fallback_conversation,"chatMessageId":fallback_message,"proposedIssue":{"assigneeUnassignedReason":"Operator triage"}})).await;
    post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{fallback}/approve"),
        json!({}),
        200,
    )
    .await;
    let source_creator:String=sqlx::query_scalar("SELECT i.created_by_agent_id::text FROM issues i JOIN chat_conversations c ON c.primary_issue_id=i.id AND c.org_id=i.org_id WHERE c.id=$1::uuid AND i.title='Stored source proposal'").bind(&fallback_conversation).fetch_one(&pool).await.unwrap();
    assert_eq!(source_creator, agent);
    for index in 0..5 {
        sqlx::query("INSERT INTO labels(org_id,name,color) VALUES ($1::uuid,$2,'#123456')")
            .bind(&org)
            .bind(format!("Fixture label {index}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    let needs_label=create(&client,&base,&token,&org,"chat_issue_creation",json!({"chatConversationId":conversation,"proposedByAgentId":agent,"proposedIssue":{"title":"Missing label","description":"Must not silently approve","assigneeAgentId":agent}})).await;
    let rejected_label = post(
        &client,
        &base,
        &token,
        &format!("/api/approvals/{needs_label}/approve"),
        json!({}),
        422,
    )
    .await;
    assert_eq!(
        rejected_label["details"]["code"],
        "agent_issue_label_required"
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT status FROM approvals WHERE id=$1::uuid")
            .bind(&needs_label)
            .fetch_one(&pool)
            .await
            .unwrap(),
        "pending"
    );
    for (target, patch, summary) in [
        ("agent", json!({"title":"Approved title"}), "Update Agent"),
        (
            "organization",
            json!({"name":"Approved organization"}),
            "Update organization",
        ),
        (
            "organization",
            json!({"brandColor":"#123456"}),
            "Update branding",
        ),
    ] {
        let approval=create(&client,&base,&token,&org,"chat_operation",json!({"chatConversationId":conversation,"operationProposal":{"targetType":target,"targetId":if target=="agent" {&agent} else {&org},"summary":summary,"patch":patch}})).await;
        post(
            &client,
            &base,
            &token,
            &format!("/api/approvals/{approval}/approve"),
            json!({}),
            200,
        )
        .await;
        if patch.get("brandColor").is_some() {
            post(
                &client,
                &base,
                &limited_token,
                &format!("/api/approvals/{approval}/approve"),
                json!({}),
                403,
            )
            .await;
            post(
                &client,
                &base,
                &token,
                &format!("/api/approvals/{approval}/approve"),
                json!({}),
                200,
            )
            .await;
            assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM organization_branding_mutation_receipts WHERE org_id=$1::uuid").bind(&org).fetch_one(&pool).await.unwrap(),1);
        }
    }

    // Goal approval composes its contract revision and owner wake; stale
    // proposals durably supersede and return 409 without applying a contract.
    let goal = Uuid::new_v4().to_string();
    let criteria = json!([{"id":"evidence","label":"Evidence exists","evaluator":"artifact"}]);
    sqlx::query("INSERT INTO goals(id,org_id,title,status,lifecycle,owner_agent_id,outcome_statement,criteria,plan_revision,continuation_kind,continuation_summary) VALUES ($1::uuid,$2::uuid,'Approval Goal','active','active',$3::uuid,'Before',$4::jsonb,1,'commitment','Complete the fixture')").bind(&goal).bind(&org).bind(&agent).bind(criteria.to_string()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO goal_owner_assignments(org_id,goal_id,agent_id,assignment_revision) VALUES ($1::uuid,$2::uuid,$3::uuid,1)").bind(&org).bind(&goal).bind(&agent).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO goal_plans(org_id,goal_id,revision,summary) VALUES ($1::uuid,$2::uuid,1,'Complete the fixture')").bind(&org).bind(&goal).execute(&pool).await.unwrap();
    for (index, decision, expected_status) in
        [(0, "approve", 200), (1, "approve", 409), (2, "reject", 200)]
    {
        let proposal = Uuid::new_v4().to_string();
        let approval = create(
            &client,
            &base,
            &token,
            &org,
            "goal_change",
            json!({"proposalId":proposal}),
        )
        .await;
        let expected = if index == 2 { 2 } else { 1 };
        sqlx::query("INSERT INTO goal_change_proposals(id,org_id,goal_id,expected_contract_revision,before_contract,after_contract,rationale,approval_id,idempotency_key,proposed_by_agent_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6::jsonb,'Approval fixture',$7::uuid,$8,$9::uuid)")
            .bind(&proposal).bind(&org).bind(&goal).bind(expected).bind(json!({"outcomeStatement":"Before","objectiveMode":"target","criteria":criteria,"autonomyEnvelope":{},"humanAuthorities":{},"evaluationPolicy":{}}).to_string()).bind(json!({"outcomeStatement":"After"}).to_string()).bind(&approval).bind(format!("proposal-{index}-{suffix}")).bind(&agent).execute(&pool).await.unwrap();
        post(
            &client,
            &base,
            &token,
            &format!("/api/approvals/{approval}/{decision}"),
            json!({"decisionNote":"Goal feedback"}),
            expected_status,
        )
        .await;
        if index == 0 {
            post(
                &client,
                &base,
                &token,
                &format!("/api/approvals/{approval}/{decision}"),
                json!({"decisionNote":"Goal feedback"}),
                200,
            )
            .await;
        }
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT status FROM goal_change_proposals WHERE id=$1::uuid"
            )
            .bind(&proposal)
            .fetch_one(&pool)
            .await
            .unwrap(),
            if index == 0 {
                "applied"
            } else if index == 1 {
                "superseded"
            } else {
                "rejected"
            }
        );
    }
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT contract_revision FROM goals WHERE id=$1::uuid")
            .bind(&goal)
            .fetch_one(&pool)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "Approval authority never forwards to Node"
    );
    control.stop(true).await;
    task.await.unwrap().unwrap();
    node_control.stop(true).await;
    node_task.await.unwrap().unwrap();
    pool.close().await;
}
