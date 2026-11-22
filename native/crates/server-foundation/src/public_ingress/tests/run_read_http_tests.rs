use super::*;
use actix_web::{
    App, HttpRequest, HttpResponse, HttpServer,
    http::{StatusCode, header},
    web,
};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{net::TcpListener, path::PathBuf, sync::Arc};

#[actix_web::test]
#[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB"]
async fn public_run_reads_revalidate_scope_owner_and_never_fall_back() {
    let database_url = env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL")
        .expect("set RUDDER_NATIVE_AUTH_TEST_DATABASE_URL to a migrated disposable DB");
    let pool = disposable_native_auth_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let org_id = insert_organization(&pool, &suffix, "own").await;
    let foreign_org_id = insert_organization(&pool, &suffix, "foreign").await;
    let owner_user_id = format!("native-run-owner-{suffix}");
    let other_user_id = format!("native-run-other-{suffix}");
    insert_user(&pool, &owner_user_id).await;
    insert_user(&pool, &other_user_id).await;
    sqlx::query(
        "INSERT INTO organization_memberships (org_id, principal_type, principal_id, status) VALUES ($1::uuid, 'user', $2, 'active'), ($1::uuid, 'user', $3, 'active')",
    )
    .bind(&org_id)
    .bind(&owner_user_id)
    .bind(&other_user_id)
    .execute(&pool)
    .await
    .unwrap();

    let owner_token = format!("pcp_native_run_owner_{suffix}");
    let owner_key_id: String = sqlx::query_scalar(
        "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'run owner', $2) RETURNING id::text",
    )
    .bind(&owner_user_id)
    .bind(crate::native_bearer_auth::hash_token(&owner_token))
    .fetch_one(&pool)
    .await
    .unwrap();
    let other_token = format!("pcp_native_run_other_{suffix}");
    let other_key_id: String = sqlx::query_scalar(
        "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'other run reader', $2) RETURNING id::text",
    )
    .bind(&other_user_id)
    .bind(crate::native_bearer_auth::hash_token(&other_token))
    .fetch_one(&pool)
    .await
    .unwrap();
    let agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, 'Run read agent', 'general', 'idle') RETURNING id::text",
    )
    .bind(&org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let filter_agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, 'Filter Run agent', 'general', 'idle') RETURNING id::text",
    )
    .bind(&org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let foreign_agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, 'Foreign Run agent', 'general', 'idle') RETURNING id::text",
    )
    .bind(&foreign_org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let agent_token = format!("pcp_native_run_agent_{suffix}");
    let agent_key_id: String = sqlx::query_scalar(
        "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash) VALUES ($1::uuid, $2::uuid, 'run read agent', $3) RETURNING id::text",
    )
    .bind(&agent_id)
    .bind(&org_id)
    .bind(crate::native_bearer_auth::hash_token(&agent_token))
    .fetch_one(&pool)
    .await
    .unwrap();

    let chat_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO chat_conversations (id, org_id, conversation_kind, created_by_user_id, title, preferred_agent_id, last_message_at) VALUES ($1::uuid, $2::uuid, 'side_chat', $3, 'OWNER_SIDECHAT_TITLE_SENTINEL', $4::uuid, '2044-04-05T08:00:00Z')",
    )
    .bind(&chat_id)
    .bind(&org_id)
    .bind(&owner_user_id)
    .bind(&agent_id)
    .execute(&pool)
    .await
    .unwrap();
    let issue_id: String = sqlx::query_scalar(
        "INSERT INTO issues (org_id, title, status, priority, assignee_agent_id, issue_number, identifier) VALUES ($1::uuid, 'Run read issue', 'in_progress', 'high', $2::uuid, 1, 'RRA-1') RETURNING id::text",
    )
    .bind(&org_id)
    .bind(&agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let legacy_issue_prefix = format!("Z{}", suffix[..6].to_ascii_uppercase());
    sqlx::query(
        "INSERT INTO organization_issue_prefix_aliases (org_id, prefix) VALUES ($1::uuid, $2)",
    )
    .bind(&org_id)
    .bind(&legacy_issue_prefix)
    .execute(&pool)
    .await
    .unwrap();

    let private_run_id = Uuid::new_v4().to_string();
    let normal_run_id = Uuid::new_v4().to_string();
    let older_run_id = Uuid::new_v4().to_string();
    let foreign_run_id = Uuid::new_v4().to_string();
    let ambiguous_run_one = "aabbccdd-0000-4000-8000-000000000001";
    let ambiguous_run_two = "aabbccdd-0000-4000-8000-000000000002";
    sqlx::query(
        r#"INSERT INTO heartbeat_runs
           (id, org_id, agent_id, status, created_at, started_at, context_snapshot,
            chat_conversation_id, stdout_excerpt, result_json)
           VALUES
           ($1::uuid, $2::uuid, $3::uuid, 'running', '2044-04-05T09:00:00Z', '2044-04-05T09:00:01Z', jsonb_build_object('issueId',$4::text,'scene','side_chat'), $5::uuid, 'OWNER_PRIVATE_RUN_EXCERPT', '{"summary":"OWNER_PRIVATE_RESULT"}'::jsonb),
           ($6::uuid, $2::uuid, $3::uuid, 'succeeded', '2044-04-05T10:00:00Z', '2044-04-05T10:00:01Z', jsonb_build_object('issueId',$4::text), NULL, 'PUBLIC_RUN_EXCERPT', '{"summary":"PUBLIC_RUN_RESULT"}'::jsonb),
           ($7::uuid, $2::uuid, $3::uuid, 'succeeded', '2044-04-04T10:00:00Z', '2044-04-04T10:00:01Z', jsonb_build_object('issueId',$4::text), NULL, NULL, NULL),
           ($8::uuid, $9::uuid, $10::uuid, 'running', '2044-04-05T11:00:00Z', '2044-04-05T11:00:01Z', '{}'::jsonb, NULL, 'FOREIGN_RUN_EXCERPT', NULL),
           ($11::uuid, $2::uuid, $3::uuid, 'succeeded', '2044-04-03T10:00:00Z', NULL, '{}'::jsonb, NULL, NULL, NULL),
           ($12::uuid, $2::uuid, $3::uuid, 'succeeded', '2044-04-03T11:00:00Z', NULL, '{}'::jsonb, NULL, NULL, NULL)"#,
    )
    .bind(&private_run_id)
    .bind(&org_id)
    .bind(&agent_id)
    .bind(&issue_id)
    .bind(&chat_id)
    .bind(&normal_run_id)
    .bind(&older_run_id)
    .bind(&foreign_run_id)
    .bind(&foreign_org_id)
    .bind(&foreign_agent_id)
    .bind(ambiguous_run_one)
    .bind(ambiguous_run_two)
    .execute(&pool)
    .await
    .unwrap();
    let filter_agent_run_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO heartbeat_runs (id, org_id, agent_id, status, created_at, started_at, context_snapshot, stdout_excerpt) VALUES ($1::uuid, $2::uuid, $3::uuid, 'succeeded', '2044-04-05T10:30:00Z', '2044-04-05T10:30:01Z', '{}'::jsonb, 'FILTER_AGENT_RUN_SENTINEL')",
    )
    .bind(&filter_agent_run_id)
    .bind(&org_id)
    .bind(&filter_agent_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE issues SET execution_run_id=$1::uuid WHERE id=$2::uuid")
        .bind(&private_run_id)
        .bind(&issue_id)
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO heartbeat_run_events (org_id, agent_id, run_id, seq, event_type, message, payload, created_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'adapter.output', 'PRIVATE_EVENT_ONE', '{\"value\":\"OWNER_PRIVATE_EVENT_SENTINEL\"}'::jsonb, '2044-04-05T09:01:00Z'), ($1::uuid, $2::uuid, $3::uuid, 2, 'runtime.status', 'PRIVATE_EVENT_TWO', '{\"value\":\"OWNER_PRIVATE_EVENT_PAGE_TWO\"}'::jsonb, '2044-04-05T09:02:00Z'), ($1::uuid, $2::uuid, $4::uuid, 1, 'runtime.status', 'PUBLIC_EVENT', '{\"value\":\"PUBLIC_EVENT_SENTINEL\"}'::jsonb, '2044-04-05T10:02:00Z')",
    )
    .bind(&org_id)
    .bind(&agent_id)
    .bind(&private_run_id)
    .bind(&normal_run_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_operations (org_id, heartbeat_run_id, phase, command, cwd, status, stdout_excerpt, metadata, started_at, created_at) VALUES ($1::uuid, $2::uuid, 'verify', 'echo OWNER_PRIVATE_OPERATION', '/private/owner', 'succeeded', 'OWNER_PRIVATE_OPERATION_SENTINEL', '{\"owner\":\"private\"}'::jsonb, '2044-04-05T09:03:00Z', '2044-04-05T09:03:00Z')",
    )
    .bind(&org_id)
    .bind(&private_run_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO workspace_operations (org_id, heartbeat_run_id, phase, command, cwd, status, stdout_excerpt, metadata, started_at, created_at) VALUES ($1::uuid, $2::uuid, 'verify', 'echo PUBLIC_OPERATION', '/workspace/public', 'succeeded', 'PUBLIC_OPERATION_SENTINEL', '{\"owner\":\"public\"}'::jsonb, '2044-04-05T10:03:00Z', '2044-04-05T10:03:00Z')",
    )
    .bind(&org_id)
    .bind(&normal_run_id)
    .execute(&pool)
    .await
    .unwrap();

    // The caller isolates host facts; create only unique fixture-owned log directories.
    let instance_root = PathBuf::from(agent_core::instance_root(&org_id).unwrap());
    let run_log_base = env::var_os("RUN_LOG_BASE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| instance_root.join("data/run-logs"));
    let operation_log_base = env::var_os("WORKSPACE_OPERATION_LOG_BASE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| instance_root.join("data/workspace-operation-logs"));
    std::fs::create_dir_all(&run_log_base).unwrap();
    std::fs::create_dir_all(&operation_log_base).unwrap();
    let run_logs = tempfile::tempdir_in(&run_log_base).unwrap();
    let operation_logs = tempfile::tempdir_in(&operation_log_base).unwrap();
    std::fs::write(
        run_logs.path().join("private.ndjson"),
        "😀OWNER_PRIVATE_LOG",
    )
    .unwrap();
    std::fs::write(
        operation_logs.path().join("private.ndjson"),
        "😀OWNER_PRIVATE_OPERATION_LOG",
    )
    .unwrap();
    let run_log_ref = format!(
        "{}/private.ndjson",
        run_logs.path().file_name().unwrap().to_string_lossy()
    );
    let operation_log_ref = format!(
        "{}/private.ndjson",
        operation_logs.path().file_name().unwrap().to_string_lossy()
    );
    sqlx::query("UPDATE heartbeat_runs SET log_store='local_file',log_ref=$2 WHERE id=$1::uuid")
        .bind(&private_run_id)
        .bind(&run_log_ref)
        .execute(&pool)
        .await
        .unwrap();
    let private_operation_id: String = sqlx::query_scalar(
        "UPDATE workspace_operations SET log_store='local_file',log_ref=$2 WHERE heartbeat_run_id=$1::uuid RETURNING id::text")
        .bind(&private_run_id).bind(&operation_log_ref).fetch_one(&pool).await.unwrap();

    let node_requests = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let upstream = format!("http://{}", listener.local_addr().unwrap());
    let node = HttpServer::new({
        let node_requests = node_requests.clone();
        move || {
            let node_requests = node_requests.clone();
            App::new().default_service(web::to(move |request: HttpRequest| {
                let node_requests = node_requests.clone();
                async move {
                    node_requests.fetch_add(1, Ordering::SeqCst);
                    HttpResponse::Ok().json(json!({"nodePath":request.path()}))
                }
            }))
        }
    })
    .workers(1)
    .disable_signals()
    .listen(listener)
    .unwrap()
    .run();
    let node_handle = node.handle();
    let node_task = actix_web::rt::spawn(node);

    let (foundation, runtime) = run_reads_runtime(Some(database_url), &upstream);
    let address = runtime.bound_addr();
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = awc::Client::default();
    let base = format!("http://{address}");
    let list_date_filter = format!(
        "{base}/api/orgs/{org_id}/heartbeat-runs?startDate=2044-04-05T08%3A00%3A00%2B08%3A00&endDate=2044-04-06T07%3A59%3A59%2B08%3A00&agentId={agent_id}&limit=1"
    );
    let goal_filter = format!(
        "{base}/api/orgs/{org_id}/heartbeat-runs?goalId={}&limit=5",
        Uuid::new_v4()
    );
    let list_agent = format!("{base}/api/orgs/{org_id}/agent-runs?limit=2");
    let overview = format!("{base}/api/orgs/{org_id}/agent-runs/overview");
    let private_detail = format!("{base}/api/heartbeat-runs/{private_run_id}");
    let normal_detail = format!("{base}/api/agent-runs/{normal_run_id}");
    let private_alias = format!(
        "{base}/api/heartbeat-runs/run_{}",
        private_run_id.replace('-', "").get(..12).unwrap()
    );
    let ambiguous_alias = format!("{base}/api/agent-runs/run_aabbccdd");
    let private_events =
        format!("{base}/api/heartbeat-runs/{private_run_id}/events?afterSeq=1&limit=1");
    let normal_events = format!("{base}/api/agent-runs/{normal_run_id}/events?limit=1");
    let private_operations =
        format!("{base}/api/heartbeat-runs/{private_run_id}/workspace-operations");
    let normal_operations = format!("{base}/api/agent-runs/{normal_run_id}/workspace-operations");
    let active_run = format!("{base}/api/issues/{legacy_issue_prefix}-1/active-run");
    let foreign_detail = format!("{base}/api/agent-runs/{foreign_run_id}");
    let missing_detail = format!("{base}/api/heartbeat-runs/{}", Uuid::new_v4());

    let (list_status, list_body) = get_json(&client, &list_date_filter, Some(&owner_token)).await;
    let (goal_filter_status, goal_filter_body) =
        get_json(&client, &goal_filter, Some(&owner_token)).await;
    let (agent_list_status, agent_list_body) =
        get_json(&client, &list_agent, Some(&agent_token)).await;
    let (other_list_status, other_list_body) =
        get_json(&client, &list_agent, Some(&other_token)).await;
    let (overview_status, overview_body) = get_json(&client, &overview, Some(&owner_token)).await;
    let (owner_detail_status, owner_detail) =
        get_json(&client, &private_detail, Some(&owner_token)).await;
    let (normal_detail_status, normal_detail_body) =
        get_json(&client, &normal_detail, Some(&agent_token)).await;
    let (other_detail_status, other_detail) =
        get_json(&client, &private_detail, Some(&other_token)).await;
    let (agent_detail_status, agent_detail) =
        get_json(&client, &private_detail, Some(&agent_token)).await;
    let (alias_status, alias_detail) = get_json(&client, &private_alias, Some(&owner_token)).await;
    let (ambiguous_status, ambiguous_body) =
        get_json(&client, &ambiguous_alias, Some(&owner_token)).await;
    let (owner_events_status, owner_events) =
        get_json(&client, &private_events, Some(&owner_token)).await;
    let (other_events_status, other_events) =
        get_json(&client, &private_events, Some(&other_token)).await;
    let (agent_events_status, agent_events) =
        get_json(&client, &private_events, Some(&agent_token)).await;
    let (normal_events_status, normal_events_body) =
        get_json(&client, &normal_events, Some(&agent_token)).await;
    let (owner_ops_status, owner_ops) =
        get_json(&client, &private_operations, Some(&owner_token)).await;
    let (other_ops_status, other_ops) =
        get_json(&client, &private_operations, Some(&other_token)).await;
    let (agent_ops_status, agent_ops) =
        get_json(&client, &private_operations, Some(&agent_token)).await;
    let (normal_ops_status, normal_ops_body) =
        get_json(&client, &normal_operations, Some(&agent_token)).await;
    let (active_owner_status, active_owner) =
        get_json(&client, &active_run, Some(&owner_token)).await;
    let (active_other_status, active_other) =
        get_json(&client, &active_run, Some(&other_token)).await;
    let (active_agent_status, active_agent) =
        get_json(&client, &active_run, Some(&agent_token)).await;
    let (foreign_board_status, foreign_board) =
        get_json(&client, &foreign_detail, Some(&owner_token)).await;
    let (foreign_agent_status, foreign_agent) =
        get_json(&client, &foreign_detail, Some(&agent_token)).await;
    let (foreign_list_status, foreign_list) = get_json(
        &client,
        &format!("{base}/api/orgs/{foreign_org_id}/agent-runs"),
        Some(&agent_token),
    )
    .await;
    let (missing_status, missing_body) =
        get_json(&client, &missing_detail, Some(&owner_token)).await;
    let (anonymous_status, anonymous) = get_json(&client, &overview, None).await;
    let mut head_observations = Vec::new();
    for path in [
        format!("{base}/api/orgs/{org_id}/heartbeat-runs"),
        list_agent.clone(),
        overview.clone(),
        private_detail.clone(),
        normal_detail.clone(),
        private_events.clone(),
        normal_events.clone(),
        private_operations.clone(),
        normal_operations.clone(),
        active_run.clone(),
    ] {
        let response = client
            .head(&path)
            .insert_header((header::AUTHORIZATION, format!("Bearer {owner_token}")))
            .send()
            .await
            .unwrap();
        head_observations.push((path, response.status(), format!("{:?}", response.headers())));
    }
    let mut log_observations = Vec::new();
    for (path, token, status, content) in [
        (
            format!("/api/heartbeat-runs/{private_run_id}/log?limitBytes=1"),
            Some(owner_token.as_str()),
            StatusCode::OK,
            Some("😀"),
        ),
        (
            format!("/api/agent-runs/{private_run_id}/log?offset=1&limitBytes=1"),
            Some(owner_token.as_str()),
            StatusCode::OK,
            Some("O"),
        ),
        (
            format!("/api/workspace-operations/{private_operation_id}/log?limitBytes=1"),
            Some(owner_token.as_str()),
            StatusCode::OK,
            Some("�"),
        ),
        (
            format!("/api/agent-runs/{private_run_id}/log"),
            Some(other_token.as_str()),
            StatusCode::NOT_FOUND,
            None,
        ),
        (
            format!("/api/agent-runs/{private_run_id}/log"),
            Some(agent_token.as_str()),
            StatusCode::NOT_FOUND,
            None,
        ),
        (
            format!("/api/workspace-operations/{private_operation_id}/log"),
            Some(other_token.as_str()),
            StatusCode::NOT_FOUND,
            None,
        ),
        (
            format!("/api/agent-runs/{foreign_run_id}/log"),
            Some(owner_token.as_str()),
            StatusCode::FORBIDDEN,
            None,
        ),
        (
            format!("/api/agent-runs/{normal_run_id}/log"),
            Some(owner_token.as_str()),
            StatusCode::NOT_FOUND,
            None,
        ),
        (
            format!("/api/agent-runs/{private_run_id}/log"),
            None,
            StatusCode::UNAUTHORIZED,
            None,
        ),
    ] {
        let (actual_status, body) = get_json(&client, &format!("{base}{path}"), token).await;
        log_observations.push((path, actual_status, status, body, content));
    }
    for path in [
        format!("/api/heartbeat-runs/{private_run_id}/log"),
        format!("/api/agent-runs/{private_run_id}/log"),
        format!("/api/workspace-operations/{private_operation_id}/log"),
    ] {
        let response = client
            .head(format!("{base}{path}"))
            .insert_header((header::AUTHORIZATION, format!("Bearer {owner_token}")))
            .send()
            .await
            .unwrap();
        head_observations.push((path, response.status(), format!("{:?}", response.headers())));
    }
    let before_passthrough = node_requests.load(Ordering::SeqCst);
    let (live_status, live_body) = get_json(
        &client,
        &format!("{base}/api/orgs/{org_id}/live-runs"),
        Some(&owner_token),
    )
    .await;
    let (issue_live_status, issue_live_body) = get_json(
        &client,
        &format!("{base}/api/issues/{issue_id}/live-runs"),
        Some(&owner_token),
    )
    .await;
    let mut write = client
        .post(format!("{base}/api/heartbeat-runs/{private_run_id}/retry"))
        .insert_header((header::AUTHORIZATION, format!("Bearer {owner_token}")))
        .send_json(&json!({}))
        .await
        .unwrap();
    let write_status = write.status();
    let write_body: Value = write.json().await.unwrap();
    let after_passthrough = node_requests.load(Ordering::SeqCst);

    let DatabaseState::Configured(native_pool) = &foundation.database else {
        panic!("public Run ingress must keep its configured database pool");
    };
    native_pool.close().await;
    let (database_failure_status, database_failure) =
        get_json(&client, &list_agent, Some(&owner_token)).await;
    let (log_database_failure_status, _) = get_json(
        &client,
        &format!("{base}/api/agent-runs/{private_run_id}/log"),
        Some(&owner_token),
    )
    .await;
    let after_database_failure = node_requests.load(Ordering::SeqCst);

    control.stop(true).await;
    task.await.unwrap().unwrap();
    node_handle.stop(true).await;
    node_task.await.unwrap().unwrap();

    sqlx::query("DELETE FROM board_api_keys WHERE id IN ($1::uuid, $2::uuid)")
        .bind(&owner_key_id)
        .bind(&other_key_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_api_keys WHERE id=$1::uuid")
        .bind(&agent_key_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organization_memberships WHERE org_id=$1::uuid AND principal_id=ANY($2::text[])")
        .bind(&org_id)
        .bind(vec![owner_user_id.clone(), other_user_id.clone()])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organization_issue_prefix_aliases WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&issue_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_run_events WHERE org_id IN ($1::uuid, $2::uuid)")
        .bind(&org_id)
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM workspace_operations WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE org_id IN ($1::uuid, $2::uuid)")
        .bind(&org_id)
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM chat_conversations WHERE id=$1::uuid")
        .bind(&chat_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id IN ($1::uuid, $2::uuid, $3::uuid)")
        .bind(&agent_id)
        .bind(&filter_agent_id)
        .bind(&foreign_agent_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organizations WHERE id IN ($1::uuid, $2::uuid)")
        .bind(&org_id)
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(r#"DELETE FROM "user" WHERE id=ANY($1::text[])"#)
        .bind(vec![owner_user_id, other_user_id])
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    assert_eq!(list_status, StatusCode::OK);
    assert_eq!(list_body.as_array().unwrap().len(), 1);
    assert_eq!(list_body[0]["id"], normal_run_id);
    assert_eq!(list_body[0]["status"], "succeeded");
    assert_eq!(list_body[0]["contextSnapshot"]["issueId"], issue_id);
    assert!(list_body[0]["stdoutExcerpt"].is_null());
    assert_ne!(list_body[0]["id"], filter_agent_run_id);
    assert_eq!(goal_filter_status, StatusCode::OK);
    assert_eq!(goal_filter_body, json!([]));
    assert_eq!(agent_list_status, StatusCode::OK);
    assert_eq!(agent_list_body.as_array().unwrap().len(), 2);
    assert!(
        agent_list_body
            .as_array()
            .unwrap()
            .iter()
            .any(|run| run["id"] == normal_run_id)
    );
    assert!(
        agent_list_body
            .as_array()
            .unwrap()
            .iter()
            .all(|run| run["id"] != private_run_id)
    );
    assert_eq!(other_list_status, StatusCode::OK);
    assert!(
        other_list_body
            .as_array()
            .unwrap()
            .iter()
            .all(|run| run["id"] != private_run_id)
    );
    assert_eq!(overview_status, StatusCode::OK);
    assert!(
        overview_body["latestByAgent"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|run| run["id"] == normal_run_id))
    );
    assert!(
        overview_body["recent"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|run| run["id"] == private_run_id))
    );
    assert_eq!(owner_detail_status, StatusCode::OK);
    assert_eq!(owner_detail["stdoutExcerpt"], "OWNER_PRIVATE_RUN_EXCERPT");
    assert_eq!(owner_detail["chatConversationId"], chat_id);
    assert_eq!(owner_detail["contextSnapshot"]["scene"], "side_chat");
    assert_eq!(normal_detail_status, StatusCode::OK);
    assert_eq!(normal_detail_body["id"], normal_run_id);
    assert_eq!(normal_detail_body["stdoutExcerpt"], "PUBLIC_RUN_EXCERPT");
    for (status, body) in [
        (other_detail_status, other_detail),
        (agent_detail_status, agent_detail),
    ] {
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(!body.to_string().contains("OWNER_PRIVATE"));
    }
    assert_eq!(alias_status, StatusCode::OK);
    assert_eq!(alias_detail["id"], private_run_id);
    assert_eq!(ambiguous_status, StatusCode::CONFLICT);
    assert_eq!(ambiguous_body["error"], "Run ID prefix is ambiguous");
    assert_eq!(ambiguous_body["details"]["runId"], "aabbccdd");
    assert_eq!(owner_events_status, StatusCode::OK);
    assert_eq!(owner_events.as_array().unwrap().len(), 1);
    assert_eq!(owner_events[0]["seq"], 2);
    assert_eq!(
        owner_events[0]["payload"]["value"],
        "OWNER_PRIVATE_EVENT_PAGE_TWO"
    );
    for (status, body) in [
        (other_events_status, other_events),
        (agent_events_status, agent_events),
    ] {
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(!body.to_string().contains("OWNER_PRIVATE"));
    }
    assert_eq!(normal_events_status, StatusCode::OK);
    assert_eq!(
        normal_events_body[0]["payload"]["value"],
        "PUBLIC_EVENT_SENTINEL"
    );
    assert_eq!(owner_ops_status, StatusCode::OK);
    assert_eq!(owner_ops.as_array().unwrap().len(), 1);
    assert_eq!(
        owner_ops[0]["stdoutExcerpt"],
        "OWNER_PRIVATE_OPERATION_SENTINEL"
    );
    for (status, body) in [(other_ops_status, other_ops), (agent_ops_status, agent_ops)] {
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(!body.to_string().contains("OWNER_PRIVATE"));
    }
    assert_eq!(normal_ops_status, StatusCode::OK);
    assert_eq!(
        normal_ops_body[0]["stdoutExcerpt"],
        "PUBLIC_OPERATION_SENTINEL"
    );
    assert_eq!(active_owner_status, StatusCode::OK);
    assert_eq!(active_owner["id"], private_run_id);
    assert_eq!(active_owner["agentId"], agent_id);
    assert_eq!(active_other_status, StatusCode::OK);
    assert!(active_other.is_null());
    assert_eq!(active_agent_status, StatusCode::OK);
    assert!(active_agent.is_null());
    assert_eq!(foreign_board_status, StatusCode::FORBIDDEN);
    assert_eq!(
        foreign_board["error"],
        "User does not have access to this organization"
    );
    assert_eq!(foreign_agent_status, StatusCode::FORBIDDEN);
    assert_eq!(
        foreign_agent["error"],
        "Agent key cannot access another organization"
    );
    assert_eq!(foreign_list_status, StatusCode::FORBIDDEN);
    assert_eq!(
        foreign_list["error"],
        "Agent key cannot access another organization"
    );
    assert_eq!(missing_status, StatusCode::NOT_FOUND);
    assert_eq!(missing_body["error"], "Heartbeat run not found");
    assert_eq!(anonymous_status, StatusCode::UNAUTHORIZED);
    assert_eq!(anonymous["error"], "Unauthorized");
    let failed_heads = head_observations
        .iter()
        .filter(|(_, status, _)| *status != StatusCode::OK)
        .collect::<Vec<_>>();
    assert!(
        failed_heads.is_empty(),
        "Run HEAD requests must retain their GET status; failing path/status/headers: {failed_heads:#?}"
    );
    assert_eq!(before_passthrough, 0);
    assert_eq!(live_status, StatusCode::OK);
    assert!(live_body.is_array());
    assert_eq!(issue_live_status, StatusCode::OK);
    assert!(issue_live_body.is_array());
    assert_eq!(write_status, StatusCode::OK);
    assert_eq!(
        write_body["nodePath"],
        format!("/api/heartbeat-runs/{private_run_id}/retry")
    );
    assert_eq!(after_passthrough, 1);
    for (path, actual, expected, body, content) in log_observations {
        assert_eq!(actual, expected, "{path}: {body}");
        if let Some(content) = content {
            assert_eq!(body["content"], content, "{path}");
        } else {
            assert!(!body.to_string().contains("OWNER_PRIVATE_LOG"), "{path}");
        }
    }
    assert!(log_database_failure_status.is_server_error());
    assert!(database_failure_status.is_server_error());
    assert!(database_failure.get("error").is_some());
    assert_eq!(after_database_failure, after_passthrough);
}

fn run_reads_runtime(
    database_url: Option<String>,
    upstream: &str,
) -> (Arc<AppState>, PublicIngressRuntime) {
    let foundation = Arc::new(
        AppState::new(ServerConfig {
            database_url,
            actor_envelope_key: Some(SigningKey::new(b"native-run-read-envelope-key").unwrap()),
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
            "native-run-read-agent-jwt-secret",
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

async fn get_json(client: &awc::Client, url: &str, token: Option<&str>) -> (StatusCode, Value) {
    let mut request = client.get(url);
    if let Some(token) = token {
        request = request.insert_header((header::AUTHORIZATION, format!("Bearer {token}")));
    }
    let mut response = request.send().await.unwrap();
    let status = response.status();
    let body = response.json().await.unwrap();
    (status, body)
}

async fn insert_organization(pool: &sqlx::PgPool, suffix: &str, label: &str) -> String {
    sqlx::query_scalar(
        "INSERT INTO organizations (url_key, name, issue_prefix) VALUES ($1, $2, $3) RETURNING id::text",
    )
    .bind(format!("native-run-read-{suffix}-{label}"))
    .bind(format!("Native Run read {label}"))
    .bind(format!("RR{}{}", suffix[..7].to_ascii_uppercase(), label.to_ascii_uppercase()))
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn insert_user(pool: &sqlx::PgPool, user_id: &str) {
    sqlx::query(
        r#"INSERT INTO "user" (id, name, email, created_at, updated_at)
           VALUES ($1, 'Native Run Read User', $2, now(), now())"#,
    )
    .bind(user_id)
    .bind(format!("{user_id}@invalid.test"))
    .execute(pool)
    .await
    .unwrap();
}
