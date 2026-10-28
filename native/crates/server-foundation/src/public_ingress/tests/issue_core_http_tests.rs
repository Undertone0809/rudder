use super::*;
use actix_web::{App, HttpRequest, HttpResponse, HttpServer, web};
use reqwest::StatusCode;
use rudder_auth_core::SigningKey;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    env,
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use uuid::Uuid;

const ACTOR_ENVELOPE_KEY: &[u8] = b"native-issue-core-http-envelope-key";
const IDENTITY_ASSERTION_KEY: &str = "native-issue-core-http-identity-assertion-key";
const AGENT_JWT_SECRET: &str = "native-issue-core-http-agent-jwt-secret";

fn local_storage_file_count(path: &std::path::Path) -> usize {
    if !path.exists() {
        return 0;
    }
    std::fs::read_dir(path)
        .unwrap()
        .map(|entry| {
            let path = entry.unwrap().path();
            if path.is_dir() {
                local_storage_file_count(&path)
            } else {
                1
            }
        })
        .sum()
}

struct AutomationIssueFixture<'a> {
    org_id: &'a str,
    agent_id: &'a str,
    automation_id: &'a str,
    run_id: &'a str,
    issue_id: &'a str,
    title: &'a str,
    output_mode: &'a str,
    issue_number: i32,
    identifier: &'a str,
}

async fn insert_issue_creation_run(
    pool: &sqlx::PgPool,
    org_id: &str,
    agent_id: &str,
    run_id: &str,
    status: &str,
    context: serde_json::Value,
) {
    sqlx::query(
        "INSERT INTO heartbeat_runs (id, org_id, agent_id, status, started_at, finished_at, invocation_source, execution_authority, context_snapshot) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now(), CASE WHEN $4 IN ('succeeded','failed','cancelled','timed_out') THEN now() ELSE NULL END, 'manual', 'legacy_ts', $5::jsonb)",
    )
    .bind(run_id)
    .bind(org_id)
    .bind(agent_id)
    .bind(status)
    .bind(context.to_string())
    .execute(pool)
    .await
    .unwrap();
}

async fn seed_issue_successful_run_evidence(
    pool: &sqlx::PgPool,
    org_id: &str,
    agent_id: &str,
    issue_id: &str,
    run_id: &str,
) {
    insert_issue_creation_run(
        pool,
        org_id,
        agent_id,
        run_id,
        "succeeded",
        json!({"issueId":issue_id}),
    )
    .await;
    sqlx::query(
        r#"UPDATE heartbeat_runs SET result_summary_json='{"fixture":"structured result"}'::jsonb WHERE org_id=$1::uuid AND id=$2::uuid"#,
    )
    .bind(org_id)
    .bind(run_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE issues SET execution_run_id=$3::uuid WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(org_id)
    .bind(issue_id)
    .bind(run_id)
    .execute(pool)
    .await
    .unwrap();

    let work_cycle_id = format!("issue:{issue_id}");
    for (event_name, dedupe_key, properties) in [
        (
            "run_succeeded",
            format!("run_succeeded:{run_id}"),
            json!({"run_kind":"manual","attempt_kind":"root"}),
        ),
        (
            "output_ready",
            format!("output_ready:run:{run_id}:structured_result:{run_id}"),
            json!({"output_kind":"structured_result"}),
        ),
    ] {
        sqlx::query(
            "INSERT INTO product_analytics_events (org_id,event_name,occurred_at,source_transition,confidence,actor_type,actor_id,origin,work_surface,work_id,work_cycle_id,root_run_id,run_id,entity_type,entity_id,dedupe_key,properties) VALUES ($1::uuid,$2,clock_timestamp(),'heartbeat.run.terminal','exact','agent',$3,'human','issue',$4,$5,$6::uuid,$6::uuid,'run',$6::text,$7,$8::jsonb)",
        )
        .bind(org_id)
        .bind(event_name)
        .bind(agent_id)
        .bind(issue_id)
        .bind(&work_cycle_id)
        .bind(run_id)
        .bind(dedupe_key)
        .bind(properties.to_string())
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "UPDATE product_analytics_work_cycles SET output_ready_at=clock_timestamp() WHERE org_id=$1::uuid AND work_cycle_id=$2",
    )
    .bind(org_id)
    .bind(work_cycle_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_automation_issue_fixture(
    pool: &sqlx::PgPool,
    fixture: &AutomationIssueFixture<'_>,
) {
    sqlx::query(
        "INSERT INTO automations (id, org_id, title, description, assignee_agent_id, output_mode, status) VALUES ($1::uuid, $2::uuid, $3, 'Automation finalization fixture', $4::uuid, $5, 'active')",
    )
    .bind(fixture.automation_id)
    .bind(fixture.org_id)
    .bind(fixture.title)
    .bind(fixture.agent_id)
    .bind(fixture.output_mode)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO issues (id, org_id, title, status, priority, board_order, assignee_agent_id, created_by_agent_id, issue_number, identifier, origin_kind, origin_id, origin_run_id) VALUES ($1::uuid, $2::uuid, $3, 'todo', 'medium', 0, $4::uuid, $4::uuid, $5, $6, 'automation_execution', $7::text, $8::text)",
    )
    .bind(fixture.issue_id)
    .bind(fixture.org_id)
    .bind(format!("{} Issue", fixture.title))
    .bind(fixture.agent_id)
    .bind(fixture.issue_number)
    .bind(fixture.identifier)
    .bind(fixture.automation_id)
    .bind(fixture.run_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO automation_runs (id, org_id, automation_id, source, status, trigger_payload, linked_issue_id) VALUES ($1::uuid, $2::uuid, $3::uuid, 'manual', 'running', '{\"fixture\":\"automation-issue-finalization\"}'::jsonb, $4::uuid)",
    )
    .bind(fixture.run_id)
    .bind(fixture.org_id)
    .bind(fixture.automation_id)
    .bind(fixture.issue_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn assert_automation_failure_chat(
    pool: &sqlx::PgPool,
    fixture: &AutomationIssueFixture<'_>,
    status: &str,
) -> String {
    let expected_reason = format!("Execution issue moved to {status}");
    let run: (
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        bool,
    ) = sqlx::query_as(
        "SELECT status, failure_reason, linked_chat_conversation_id::text, terminal_chat_message_id::text, last_chat_message_id::text, completed_at IS NOT NULL FROM automation_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture.org_id)
    .bind(fixture.run_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(run.0, "failed");
    assert_eq!(run.1.as_deref(), Some(expected_reason.as_str()));
    assert!(run.5);
    let conversation_id = run.2.expect("failure should create a linked chat");
    let terminal_message_id = run.3.expect("failure should link its terminal message");
    assert_eq!(run.4.as_deref(), Some(terminal_message_id.as_str()));

    let conversation: (
        String,
        Option<String>,
        Option<String>,
        String,
        bool,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT title, preferred_agent_id::text, summary, issue_creation_mode, plan_mode, created_by_user_id FROM chat_conversations WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(fixture.org_id)
    .bind(&conversation_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(
        conversation,
        (
            fixture.title.to_owned(),
            Some(fixture.agent_id.to_owned()),
            None,
            "manual_approval".to_owned(),
            false,
            None,
        )
    );

    let messages: Vec<(String, String, String, String, String, serde_json::Value)> =
        sqlx::query_as(
            "SELECT id::text, role, kind, status, body, structured_payload FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid ORDER BY created_at,id",
        )
        .bind(fixture.org_id)
        .bind(&conversation_id)
        .fetch_all(pool)
        .await
        .unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].1.as_str(), "user");
    assert_eq!(messages[0].2.as_str(), "message");
    assert_eq!(messages[0].3.as_str(), "completed");
    assert_eq!(messages[0].5["eventType"], "automation_run_input");
    assert_eq!(messages[0].5["automationChatRun"]["runId"], fixture.run_id);
    assert_eq!(
        messages[0].5["automationChatRun"]["automationId"],
        fixture.automation_id
    );
    assert_eq!(
        messages[0].5["automationChatRun"]["automationTitle"],
        fixture.title
    );
    assert_eq!(messages[0].5["automationChatRun"]["status"], "running");
    let terminal_message = messages
        .iter()
        .find(|message| message.0 == terminal_message_id)
        .expect("terminal pointer should identify the failure message");
    assert_eq!(&terminal_message.1, "system");
    assert_eq!(&terminal_message.2, "system_event");
    assert_eq!(&terminal_message.3, "completed");
    assert_eq!(
        terminal_message.4,
        format!("{} failed: {expected_reason}", fixture.title)
    );
    assert_eq!(terminal_message.5["eventType"], "automation_run_failed");
    assert_eq!(terminal_message.5["automationId"], fixture.automation_id);
    assert_eq!(terminal_message.5["runId"], fixture.run_id);
    assert_eq!(terminal_message.5["issueId"], fixture.issue_id);
    assert_eq!(terminal_message.5["status"], "failed");
    assert_eq!(terminal_message.5["failureReason"], expected_reason);
    assert_eq!(terminal_message.5["automationTitle"], fixture.title);
    assert_eq!(
        terminal_message.5["links"]["automation"],
        format!("/automations/{}", fixture.automation_id)
    );
    assert_eq!(
        terminal_message.5["links"]["issue"],
        format!("/issues/{}", fixture.issue_id)
    );

    let chat_activity: (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE action='chat.created'), count(*) FILTER (WHERE action='chat.message_added') FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND actor_id='automation-chat-output'",
    )
    .bind(fixture.org_id)
    .bind(&conversation_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(chat_activity, (1, 1));
    let conversation_last_message_is_terminal: bool = sqlx::query_scalar(
        "SELECT conversation.last_message_at=message.created_at FROM chat_conversations conversation JOIN chat_messages message ON message.conversation_id=conversation.id AND message.id=$3::uuid WHERE conversation.org_id=$1::uuid AND conversation.id=$2::uuid",
    )
    .bind(fixture.org_id)
    .bind(&conversation_id)
    .bind(&terminal_message_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert!(conversation_last_message_is_terminal);
    let local_chat_created: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM product_analytics_events WHERE org_id=$1::uuid AND event_name='chat_created' AND source_transition='chat.automation.create' AND origin='automation' AND entity_id=$2 AND work_id=$2",
    )
    .bind(fixture.org_id)
    .bind(&conversation_id)
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(local_chat_created, 1);
    conversation_id
}

#[actix_web::test]
#[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL and isolated host workspace paths"]
async fn public_issue_reads_and_agent_board_checkout_use_rust_without_node_fallback() {
    crate::init_tracing();
    let workspace_home = env::var("RUDDER_NATIVE_HOST_ORGANIZATION_WORKSPACE_HOME")
        .expect("the test runner must supply an isolated organization workspace home");
    let host_home = env::var("RUDDER_NATIVE_HOST_HOME_DIRECTORY")
        .expect("the test runner must supply an isolated host home");
    assert!(std::path::Path::new(&workspace_home).is_absolute());
    assert_ne!(
        std::path::PathBuf::from(&workspace_home),
        std::path::PathBuf::from(&host_home).join("Documents/Rudder"),
        "attachment imports must use the isolated host workspace, not the user's default Library"
    );
    assert!(env::var("RUDDER_NATIVE_HOST_RUDDER_HOME").is_ok());
    assert!(env::var("RUDDER_NATIVE_HOST_INSTANCE_ID").is_ok());
    assert!(env::var("RUDDER_NATIVE_HOST_HOSTNAME").is_ok());
    let pool = super::disposable_native_auth_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let asset_storage_directory = tempfile::tempdir().unwrap();
    let org_id: String = sqlx::query_scalar(
        "INSERT INTO organizations (url_key, name, issue_prefix) VALUES ($1, $2, $3) RETURNING id::text",
    )
    .bind(format!("native-issue-core-{suffix}"))
    .bind(format!("Native Issue Core {suffix}"))
    .bind(format!("IC{}", suffix[..8].to_ascii_uppercase()))
    .fetch_one(&pool)
    .await
    .unwrap();
    let related_org_id: String = sqlx::query_scalar(
        "INSERT INTO organizations (url_key, name, issue_prefix) VALUES ($1, $2, $3) RETURNING id::text",
    )
    .bind(format!("native-issue-work-products-related-{suffix}"))
    .bind(format!("Native Issue Work Products Related {suffix}"))
    .bind(format!("WR{}", suffix[..8].to_ascii_uppercase()))
    .fetch_one(&pool)
    .await
    .unwrap();
    let related_project_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO projects (id, org_id, name, status) VALUES ($1::uuid, $2::uuid, $3, 'backlog')",
    )
    .bind(&related_project_id)
    .bind(&related_org_id)
    .bind(format!("Related foreign project {suffix}"))
    .execute(&pool)
    .await
    .unwrap();
    let related_execution_workspace_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO execution_workspaces (id,org_id,project_id,mode,strategy_type,name) VALUES ($1::uuid,$2::uuid,$3::uuid,'local','worktree',$4)",
    )
    .bind(&related_execution_workspace_id)
    .bind(&related_org_id)
    .bind(&related_project_id)
    .bind(format!("Related foreign workspace {suffix}"))
    .execute(&pool)
    .await
    .unwrap();
    let related_agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, $2, 'general', 'idle') RETURNING id::text",
    )
    .bind(&related_org_id)
    .bind(format!("Related foreign agent {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let related_run_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO heartbeat_runs (id,org_id,agent_id,status,started_at,invocation_source,execution_authority,context_snapshot) VALUES ($1::uuid,$2::uuid,$3::uuid,'completed',now(),'manual','legacy_ts','{}'::jsonb)",
    )
    .bind(&related_run_id)
    .bind(&related_org_id)
    .bind(&related_agent_id)
    .execute(&pool)
    .await
    .unwrap();
    let related_runtime_service_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO workspace_runtime_services (id,org_id,project_id,execution_workspace_id,scope_type,scope_id,service_name,status,lifecycle,provider) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'execution_workspace',$5,'api','running','active','custom')",
    )
    .bind(&related_runtime_service_id)
    .bind(&related_org_id)
    .bind(&related_project_id)
    .bind(&related_execution_workspace_id)
    .bind(&related_execution_workspace_id)
    .execute(&pool)
    .await
    .unwrap();
    let title_project_id = Uuid::new_v4().to_string();
    let description_project_id = Uuid::new_v4().to_string();
    let comment_project_id = Uuid::new_v4().to_string();
    let deleted_comment_project_id = Uuid::new_v4().to_string();
    for (project_id, name) in [
        (&title_project_id, "Title mention"),
        (&description_project_id, "Description mention"),
        (&comment_project_id, "Comment mention"),
        (&deleted_comment_project_id, "Deleted comment mention"),
    ] {
        sqlx::query(
            "INSERT INTO projects (id, org_id, name, status) VALUES ($1::uuid, $2::uuid, $3, 'backlog')",
        )
        .bind(project_id)
        .bind(&org_id)
        .bind(format!("{name} {suffix}"))
        .execute(&pool)
        .await
        .unwrap();
    }
    let agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, $2, 'general', 'idle') RETURNING id::text",
    )
    .bind(&org_id)
    .bind(format!("Issue Core Agent {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let other_agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, $2, 'general', 'idle') RETURNING id::text",
    )
    .bind(&org_id)
    .bind(format!("Other Issue Core Agent {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let paused_agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, $2, 'general', 'paused') RETURNING id::text",
    )
    .bind(&org_id)
    .bind(format!("Paused Issue Core Agent {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let board_user_id = format!("native-issue-board-user-{suffix}");
    let second_board_user_id = format!("native-issue-second-board-user-{suffix}");
    sqlx::query(
        r#"INSERT INTO "user" (id, name, email, created_at, updated_at)
           VALUES ($1, 'Issue Board Member', $2, now(), now())"#,
    )
    .bind(&board_user_id)
    .bind(format!("{board_user_id}@invalid.test"))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO "user" (id, name, email, created_at, updated_at)
           VALUES ($1, 'Second Issue Board Member', $2, now(), now())"#,
    )
    .bind(&second_board_user_id)
    .bind(format!("{second_board_user_id}@invalid.test"))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO organization_memberships (org_id, principal_type, principal_id, status) VALUES ($1::uuid, 'user', $2, 'active')",
    )
    .bind(&org_id)
    .bind(&board_user_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO organization_memberships (org_id, principal_type, principal_id, status) VALUES ($1::uuid, 'user', $2, 'active')",
    )
    .bind(&org_id)
    .bind(&second_board_user_id)
    .execute(&pool)
    .await
    .unwrap();
    let board_token = format!("pcp_native_issue_board_{suffix}");
    let board_key_id: String = sqlx::query_scalar(
        "INSERT INTO board_api_keys (user_id, name, key_hash) VALUES ($1, 'issue checkout HTTP test', $2) RETURNING id::text",
    )
    .bind(&board_user_id)
    .bind(crate::native_bearer_auth::hash_token(&board_token))
    .fetch_one(&pool)
    .await
    .unwrap();
    let issue_id = Uuid::new_v4().to_string();
    let work_product_issue_id = Uuid::new_v4().to_string();
    let seeded_nonprimary_work_product_id = Uuid::new_v4().to_string();
    let board_issue_id = Uuid::new_v4().to_string();
    let member_issue_id = Uuid::new_v4().to_string();
    let paused_issue_id = Uuid::new_v4().to_string();
    let comment_wakeup_issue_id = Uuid::new_v4().to_string();
    let reopen_wakeup_issue_id = Uuid::new_v4().to_string();
    let prefix: String =
        sqlx::query_scalar("SELECT issue_prefix FROM organizations WHERE id=$1::uuid")
            .bind(&org_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query(
        "INSERT INTO issues (id, org_id, title, status, priority, issue_number, identifier) VALUES ($1::uuid, $2::uuid, 'Checkout through Rust', 'todo', 'medium', 1, $3)",
    )
    .bind(&issue_id)
    .bind(&org_id)
    .bind(format!("{prefix}-1"))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO issues (id, org_id, title, status, priority, issue_number, identifier) VALUES ($1::uuid, $2::uuid, 'Member Board checkout through Rust', 'todo', 'medium', 4, $3)",
    )
    .bind(&member_issue_id)
    .bind(&org_id)
    .bind(format!("{prefix}-4"))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO issues (id, org_id, title, status, priority, issue_number, identifier) VALUES ($1::uuid, $2::uuid, 'Paused Board checkout through Rust', 'todo', 'medium', 3, $3)",
    )
    .bind(&paused_issue_id)
    .bind(&org_id)
    .bind(format!("{prefix}-3"))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO issues (id, org_id, title, status, priority, issue_number, identifier) VALUES ($1::uuid, $2::uuid, 'Board checkout through Rust', 'todo', 'medium', 2, $3)",
    )
    .bind(&board_issue_id)
    .bind(&org_id)
    .bind(format!("{prefix}-2"))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO issues (id,org_id,project_id,title,status,priority,issue_number,identifier) VALUES ($1::uuid,$2::uuid,$3::uuid,'Work Product CRUD target','todo','medium',900009,$4)",
    )
    .bind(&work_product_issue_id)
    .bind(&org_id)
    .bind(&title_project_id)
    .bind(format!("{prefix}-900009"))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO issue_work_products (id,org_id,issue_id,type,provider,title,status,is_primary,created_at,updated_at) VALUES ($1::uuid,$2::uuid,$3::uuid,'preview_url','custom','Older non-primary preview','active',false,now()-interval '2 days',now()-interval '2 days')",
    )
    .bind(&seeded_nonprimary_work_product_id)
    .bind(&org_id)
    .bind(&work_product_issue_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO issues (id, org_id, title, status, priority, issue_number, identifier, assignee_agent_id) VALUES ($1::uuid, $2::uuid, 'Comment wake admission through Rust', 'todo', 'medium', 900005, $3, $4::uuid)",
    )
    .bind(&comment_wakeup_issue_id)
    .bind(&org_id)
    .bind(format!("{prefix}-900005"))
    .bind(&other_agent_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE organizations SET issue_counter=4 WHERE id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
        .await
        .unwrap();
    let run_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO heartbeat_runs (id, org_id, agent_id, status, started_at, invocation_source, execution_authority, context_snapshot) VALUES ($1::uuid, $2::uuid, $3::uuid, 'running', now(), 'manual', 'legacy_ts', $4::jsonb)",
    )
    .bind(&run_id)
    .bind(&org_id)
    .bind(&agent_id)
    .bind(json!({"issueId":issue_id}).to_string())
    .execute(&pool)
    .await
    .unwrap();
    let agent_token = format!("pcp_native_issue_core_{suffix}");
    let agent_key_id: String = sqlx::query_scalar(
        "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash) VALUES ($1::uuid, $2::uuid, 'issue core HTTP test', $3) RETURNING id::text",
    )
    .bind(&agent_id)
    .bind(&org_id)
    .bind(crate::native_bearer_auth::hash_token(&agent_token))
    .fetch_one(&pool)
    .await
    .unwrap();

    let node_requests = Arc::new(AtomicUsize::new(0));
    let node_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let node_upstream = format!("http://{}", node_listener.local_addr().unwrap());
    let node = HttpServer::new({
        let node_requests = node_requests.clone();
        move || {
            let node_requests = node_requests.clone();
            App::new().default_service(web::to(move |request: HttpRequest| {
                let node_requests = node_requests.clone();
                async move {
                    node_requests.fetch_add(1, Ordering::SeqCst);
                    HttpResponse::Ok().json(json!({
                        "nodePath":request.path(),
                        "nodeMethod":request.method().as_str()
                    }))
                }
            }))
        }
    })
    .workers(1)
    .disable_signals()
    .listen(node_listener)
    .unwrap()
    .run();
    let node_control = node.handle();
    let node_task = actix_web::rt::spawn(node);

    let database_url = env::var("RUDDER_NATIVE_AUTH_TEST_DATABASE_URL").unwrap();
    let foundation = Arc::new(
        crate::AppState::new(crate::ServerConfig {
            database_url: Some(database_url),
            actor_envelope_key: Some(SigningKey::new(ACTOR_ENVELOPE_KEY).unwrap()),
            workers: 1,
            ..crate::ServerConfig::default()
        })
        .unwrap(),
    );
    let mut ingress = crate::PublicIngressConfig::new(
        "127.0.0.1:0".parse().unwrap(),
        &node_upstream,
        "native-issue-core-http-forwarding-key",
    )
    .unwrap();
    ingress.issue_asset_storage = Some(
        crate::issue_asset_storage::NativeIssueAssetStorage::from_config(
            crate::issue_asset_storage::IssueAssetStorageConfig::LocalDisk {
                local_disk_base_dir: asset_storage_directory
                    .path()
                    .to_string_lossy()
                    .into_owned(),
            },
        )
        .unwrap(),
    );
    ingress.deployment_mode = "local_trusted".to_owned();
    ingress.identity_auth = Some(
        crate::public_ingress_config::NativeIdentityAuthConfig::new(
            IDENTITY_ASSERTION_KEY,
            AGENT_JWT_SECRET,
            "rudder-test",
            "rudder-api",
            true,
        )
        .unwrap(),
    );
    let runtime = PublicIngressRuntime::bind(ingress, foundation.clone()).unwrap();
    let base = format!("http://{}", runtime.bound_addr());
    let control = runtime.control();
    let task = actix_web::rt::spawn(runtime.run());
    let client = reqwest::Client::new();

    let metadata = client
        .get(format!("{base}/api/issues/{issue_id}/attachments"))
        .bearer_auth(&agent_token)
        .send()
        .await
        .unwrap();
    assert_eq!(metadata.status(), StatusCode::OK);
    assert_eq!(
        metadata.json::<serde_json::Value>().await.unwrap(),
        json!([])
    );

    assert_eq!(node_requests.load(Ordering::SeqCst), 0);
    for reference in [
        format!("{prefix}-1"),
        format!("iss_{}", &issue_id.replace('-', "")[..8]),
    ] {
        for suffix in ["attachments", "work-products"] {
            let response = client
                .get(format!("{base}/api/issues/{reference}/{suffix}"))
                .bearer_auth(&agent_token)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.json::<serde_json::Value>().await.unwrap(),
                json!([])
            );
        }
    }
    for (reference, status) in [
        ("not-a-uuid", StatusCode::NOT_FOUND),
        ("agt_abcd", StatusCode::UNPROCESSABLE_ENTITY),
    ] {
        let response = client
            .get(format!("{base}/api/issues/{reference}/attachments"))
            .bearer_auth(&agent_token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), status);
    }
    let work_products = client
        .get(format!("{base}/api/issues/{issue_id}/work-products"))
        .bearer_auth(&agent_token)
        .send()
        .await
        .unwrap();
    assert_eq!(work_products.status(), StatusCode::OK);
    assert_eq!(node_requests.load(Ordering::SeqCst), 0);
    let seeded_nonprimary_timestamp: String = sqlx::query_scalar(
        "SELECT updated_at::text FROM issue_work_products WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&seeded_nonprimary_work_product_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    let first_work_product = client
        .post(format!("{base}/api/issues/{prefix}-900009/work-products"))
        .bearer_auth(&board_token)
        .json(&json!({
            "type":"preview_url",
            "provider":"custom",
            "title":"Preview first",
            "isPrimary":true,
            "projectId":null,
            "runWorkspaceId":null,
            "metadata":{"revision":1}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(first_work_product.status(), StatusCode::CREATED);
    let first_work_product: serde_json::Value = first_work_product.json().await.unwrap();
    let first_work_product_id = first_work_product["id"].as_str().unwrap().to_owned();
    assert_eq!(first_work_product["issueId"], work_product_issue_id);
    assert_eq!(first_work_product["projectId"], title_project_id);
    assert_eq!(
        first_work_product["runWorkspaceId"],
        serde_json::Value::Null
    );
    assert_eq!(
        first_work_product["executionWorkspaceId"],
        serde_json::Value::Null
    );
    assert_eq!(first_work_product["isPrimary"], true);
    assert_eq!(first_work_product["metadata"]["revision"], 1);
    let seeded_nonprimary_refreshed: bool = sqlx::query_scalar(
        "SELECT updated_at > $3::timestamptz FROM issue_work_products WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&seeded_nonprimary_work_product_id)
    .bind(&seeded_nonprimary_timestamp)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(seeded_nonprimary_refreshed);

    let second_work_product = client
        .post(format!(
            "{base}/api/issues/{work_product_issue_id}/work-products"
        ))
        .bearer_auth(&board_token)
        .json(&json!({
            "type":"preview_url",
            "provider":"custom",
            "title":"Preview second",
            "isPrimary":true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(second_work_product.status(), StatusCode::CREATED);
    let second_work_product: serde_json::Value = second_work_product.json().await.unwrap();
    let second_work_product_id = second_work_product["id"].as_str().unwrap().to_owned();
    assert_eq!(second_work_product["projectId"], title_project_id);

    let work_product_state_before_failed_create: Vec<(String, bool, String)> = sqlx::query_as(
        "SELECT id::text,is_primary,updated_at::text FROM issue_work_products WHERE org_id=$1::uuid AND issue_id=$2::uuid ORDER BY id",
    )
    .bind(&org_id)
    .bind(&work_product_issue_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    let work_product_created_activity_before_failure: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.work_product_created'",
    )
    .bind(&org_id)
    .bind(&work_product_issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    for (field, foreign_id) in [
        ("projectId", related_project_id.as_str()),
        (
            "executionWorkspaceId",
            related_execution_workspace_id.as_str(),
        ),
        ("runtimeServiceId", related_runtime_service_id.as_str()),
        ("createdByRunId", related_run_id.as_str()),
    ] {
        let mut create_input = json!({
            "type":"preview_url",
            "provider":"custom",
            "title":"Reject cross-organization Work Product reference",
            "isPrimary":true
        });
        create_input
            .as_object_mut()
            .unwrap()
            .insert(field.to_owned(), json!(foreign_id));
        let foreign_reference_create = client
            .post(format!(
                "{base}/api/issues/{work_product_issue_id}/work-products"
            ))
            .bearer_auth(&board_token)
            .json(&create_input)
            .send()
            .await
            .unwrap();
        assert_eq!(
            foreign_reference_create.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "POST must reject foreign {field}"
        );
        assert_eq!(
            foreign_reference_create
                .json::<serde_json::Value>()
                .await
                .unwrap(),
            json!({
                "error":"Invalid work product reference",
                "code":"field_reference_error",
                "field":field
            })
        );

        let mut update_input = json!({
            "title":"Must not update through foreign reference",
            "isPrimary":true
        });
        update_input
            .as_object_mut()
            .unwrap()
            .insert(field.to_owned(), json!(foreign_id));
        let foreign_reference_update = client
            .patch(format!("{base}/api/work-products/{first_work_product_id}"))
            .bearer_auth(&board_token)
            .json(&update_input)
            .send()
            .await
            .unwrap();
        assert_eq!(
            foreign_reference_update.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "PATCH must reject foreign {field}"
        );
        assert_eq!(
            foreign_reference_update
                .json::<serde_json::Value>()
                .await
                .unwrap(),
            json!({
                "error":"Invalid work product reference",
                "code":"field_reference_error",
                "field":field
            })
        );
    }
    let missing_reference = client
        .post(format!(
            "{base}/api/issues/{work_product_issue_id}/work-products"
        ))
        .bearer_auth(&board_token)
        .json(&json!({
            "type":"preview_url",
            "provider":"custom",
            "title":"Reject missing Work Product reference",
            "isPrimary":true,
            "projectId":"99999999-9999-4999-8999-999999999999"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_reference.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        missing_reference.json::<serde_json::Value>().await.unwrap(),
        json!({
            "error":"Invalid work product reference",
            "code":"field_reference_error",
            "field":"projectId"
        })
    );
    let foreign_related_reference_counts: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM projects WHERE org_id=$1::uuid AND id=$2::uuid), (SELECT count(*) FROM execution_workspaces WHERE org_id=$1::uuid AND id=$3::uuid), (SELECT count(*) FROM workspace_runtime_services WHERE org_id=$1::uuid AND id=$4::uuid), (SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$5::uuid)",
    )
    .bind(&related_org_id)
    .bind(&related_project_id)
    .bind(&related_execution_workspace_id)
    .bind(&related_runtime_service_id)
    .bind(&related_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(foreign_related_reference_counts, (1, 1, 1, 1));
    let work_product_state_after_reference_rejections: Vec<(String, bool, String)> =
        sqlx::query_as(
            "SELECT id::text,is_primary,updated_at::text FROM issue_work_products WHERE org_id=$1::uuid AND issue_id=$2::uuid ORDER BY id",
        )
        .bind(&org_id)
        .bind(&work_product_issue_id)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(
        work_product_state_after_reference_rejections,
        work_product_state_before_failed_create
    );
    let work_product_created_activity_after_reference_rejections: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.work_product_created'",
    )
    .bind(&org_id)
    .bind(&work_product_issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        work_product_created_activity_after_reference_rejections,
        work_product_created_activity_before_failure
    );
    sqlx::query(
        "ALTER TABLE issue_work_products ADD CONSTRAINT issue_work_products_author_failure_check CHECK (title <> 'Force SQL failure after primary demotion')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let failed_primary_create = client
        .post(format!(
            "{base}/api/issues/{work_product_issue_id}/work-products"
        ))
        .bearer_auth(&board_token)
        .json(&json!({
            "type":"preview_url",
            "provider":"custom",
            "title":"Force SQL failure after primary demotion",
            "isPrimary":true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        failed_primary_create.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    let work_product_state_after_failed_create: Vec<(String, bool, String)> = sqlx::query_as(
        "SELECT id::text,is_primary,updated_at::text FROM issue_work_products WHERE org_id=$1::uuid AND issue_id=$2::uuid ORDER BY id",
    )
    .bind(&org_id)
    .bind(&work_product_issue_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        work_product_state_after_failed_create,
        work_product_state_before_failed_create
    );
    let work_product_created_activity_after_failure: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.work_product_created'",
    )
    .bind(&org_id)
    .bind(&work_product_issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        work_product_created_activity_after_failure,
        work_product_created_activity_before_failure
    );
    sqlx::query(
        "ALTER TABLE issue_work_products DROP CONSTRAINT issue_work_products_author_failure_check",
    )
    .execute(&pool)
    .await
    .unwrap();

    let conflicting_workspace_aliases = client
        .post(format!(
            "{base}/api/issues/{work_product_issue_id}/work-products"
        ))
        .bearer_auth(&board_token)
        .json(&json!({
            "type":"preview_url",
            "provider":"custom",
            "title":"Invalid alias conflict",
            "runWorkspaceId":"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
            "executionWorkspaceId":"bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        conflicting_workspace_aliases.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        conflicting_workspace_aliases
            .json::<serde_json::Value>()
            .await
            .unwrap(),
        json!({"error":"runWorkspaceId conflicts with deprecated executionWorkspaceId"})
    );

    let patched_work_product = client
        .patch(format!("{base}/api/work-products/{second_work_product_id}"))
        .bearer_auth(&board_token)
        .json(&json!({
            "title":"Preview polished",
            "status":"ready_for_review",
            "summary":null,
            "metadata":{"revision":2}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(patched_work_product.status(), StatusCode::OK);
    let patched_work_product: serde_json::Value = patched_work_product.json().await.unwrap();
    assert_eq!(patched_work_product["title"], "Preview polished");
    assert_eq!(patched_work_product["status"], "ready_for_review");
    assert_eq!(patched_work_product["summary"], serde_json::Value::Null);
    assert_eq!(patched_work_product["metadata"]["revision"], 2);

    let work_product_readback = client
        .get(format!(
            "{base}/api/issues/{work_product_issue_id}/work-products"
        ))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(work_product_readback.status(), StatusCode::OK);
    let work_product_readback: serde_json::Value = work_product_readback.json().await.unwrap();
    assert_eq!(work_product_readback.as_array().unwrap().len(), 3);
    let primary_product = work_product_readback
        .as_array()
        .unwrap()
        .iter()
        .find(|product| product["isPrimary"] == true)
        .unwrap();
    assert_eq!(primary_product["id"], second_work_product_id);
    let demoted_product = work_product_readback
        .as_array()
        .unwrap()
        .iter()
        .find(|product| product["id"] == first_work_product_id)
        .unwrap();
    assert_eq!(demoted_product["isPrimary"], false);
    let seeded_nonprimary = work_product_readback
        .as_array()
        .unwrap()
        .iter()
        .find(|product| product["id"] == seeded_nonprimary_work_product_id)
        .unwrap();
    assert_eq!(seeded_nonprimary["isPrimary"], false);

    let removed_work_product = client
        .delete(format!("{base}/api/work-products/{first_work_product_id}"))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(removed_work_product.status(), StatusCode::OK);
    let removed_work_product: serde_json::Value = removed_work_product.json().await.unwrap();
    assert_eq!(removed_work_product["id"], first_work_product_id);
    assert_eq!(removed_work_product["isPrimary"], false);
    let remaining_work_products: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM issue_work_products WHERE org_id=$1::uuid AND issue_id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&work_product_issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining_work_products, 2);
    let work_product_activity: (i64, i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE action='issue.work_product_created'), count(*) FILTER (WHERE action='issue.work_product_updated'), count(*) FILTER (WHERE action='issue.work_product_deleted') FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2",
    )
    .bind(&org_id)
    .bind(&work_product_issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(work_product_activity, (2, 1, 1));
    assert_eq!(node_requests.load(Ordering::SeqCst), 0);

    let node_owned_retired_document = client
        .get(format!("{base}/api/issues/{issue_id}/documents"))
        .bearer_auth(&agent_token)
        .send()
        .await
        .unwrap();
    assert_eq!(node_owned_retired_document.status(), StatusCode::OK);
    let node_owned_retired_document: serde_json::Value =
        node_owned_retired_document.json().await.unwrap();
    assert_eq!(
        node_owned_retired_document,
        json!({"nodePath":format!("/api/issues/{issue_id}/documents"),"nodeMethod":"GET"})
    );
    assert_eq!(node_requests.load(Ordering::SeqCst), 1);

    let issue_short_ref = format!("iss_{}", issue_id.replace('-', "")[..8].to_owned());
    let checkout = client
        .post(format!("{base}/api/issues/{issue_short_ref}/checkout"))
        .bearer_auth(&agent_token)
        .header("x-rudder-run-id", &run_id)
        .json(&json!({"agentId":agent_id,"expectedStatuses":["todo"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(checkout.status(), StatusCode::OK);
    let checkout_body: serde_json::Value = checkout.json().await.unwrap();
    assert_eq!(checkout_body["id"], issue_id);
    assert_eq!(checkout_body["status"], "in_progress");
    assert_eq!(checkout_body["assigneeAgentId"], agent_id);
    assert_eq!(checkout_body["checkoutRunId"], run_id);

    let persisted = sqlx::query_as::<_, (String, String, Option<String>, Option<String>)>(
        "SELECT status, assignee_agent_id::text, checkout_run_id::text, execution_run_id::text FROM issues WHERE id=$1::uuid",
    )
    .bind(&issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        persisted,
        (
            "in_progress".to_owned(),
            agent_id.clone(),
            Some(run_id.clone()),
            Some(run_id.clone())
        )
    );

    let agent_comment = client
        .post(format!("{base}/api/issues/{issue_id}/comments"))
        .bearer_auth(&agent_token)
        .header("x-rudder-run-id", &run_id)
        .json(&json!({"body":"Agent comment from the public Rust route."}))
        .send()
        .await
        .unwrap();
    assert_eq!(agent_comment.status(), StatusCode::CREATED);
    let agent_comment: serde_json::Value = agent_comment.json().await.unwrap();
    let agent_comment_id = agent_comment["id"].as_str().unwrap().to_owned();
    let agent_comment_short_ref = agent_comment["shortRef"].as_str().unwrap().to_owned();
    assert_eq!(agent_comment["authorAgentId"], agent_id);
    let board_comment = client
        .post(format!("{base}/api/issues/{issue_short_ref}/comments"))
        .bearer_auth(&board_token)
        .json(&json!({"body":"Board response."}))
        .send()
        .await
        .unwrap();
    assert_eq!(board_comment.status(), StatusCode::CREATED);
    let board_comment: serde_json::Value = board_comment.json().await.unwrap();
    let board_comment_id = board_comment["id"].as_str().unwrap().to_owned();
    let agent_interrupt = client
        .post(format!("{base}/api/issues/{issue_id}/comments"))
        .bearer_auth(&agent_token)
        .header("x-rudder-run-id", &run_id)
        .json(&json!({"body":"Agents cannot interrupt from comments.","interrupt":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(agent_interrupt.status(), StatusCode::FORBIDDEN);
    let run_after_rejected_agent_interrupt: Option<String> = sqlx::query_scalar(
        "SELECT error_code FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(run_after_rejected_agent_interrupt, None);
    let invalid_reopen = client
        .post(format!("{base}/api/issues/{issue_id}/comments"))
        .bearer_auth(&board_token)
        .json(&json!({"body":"Invalid reopen flag.","reopen":"true"}))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_reopen.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let listed_comments = client
        .get(format!(
            "{base}/api/issues/{issue_short_ref}/comments?order=asc&limit=10"
        ))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(listed_comments.status(), StatusCode::OK);
    let listed_comments: serde_json::Value = listed_comments.json().await.unwrap();
    assert_eq!(listed_comments.as_array().unwrap().len(), 2);
    assert_eq!(listed_comments[0]["id"], agent_comment_id);
    let read_by_short_ref = client
        .get(format!(
            "{base}/api/issues/{issue_short_ref}/comments/{agent_comment_short_ref}"
        ))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(read_by_short_ref.status(), StatusCode::OK);
    assert_eq!(
        read_by_short_ref.json::<serde_json::Value>().await.unwrap()["id"],
        agent_comment_id
    );
    let missing_cursor = client
        .get(format!(
            "{base}/api/issues/{issue_id}/comments?after=cmt_ffffffff"
        ))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(missing_cursor.status(), StatusCode::NOT_FOUND);
    let missing_uuid_cursor = client
        .get(format!(
            "{base}/api/issues/{issue_short_ref}/comments?after={}",
            Uuid::new_v4()
        ))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(missing_uuid_cursor.status(), StatusCode::OK);
    assert_eq!(
        missing_uuid_cursor
            .json::<serde_json::Value>()
            .await
            .unwrap(),
        json!([])
    );
    let edited_board_comment = client
        .patch(format!(
            "{base}/api/issues/{issue_short_ref}/comments/{board_comment_id}"
        ))
        .bearer_auth(&board_token)
        .json(&json!({"body":"Board response edited."}))
        .send()
        .await
        .unwrap();
    assert_eq!(edited_board_comment.status(), StatusCode::OK);
    assert_eq!(
        edited_board_comment
            .json::<serde_json::Value>()
            .await
            .unwrap()["body"],
        "Board response edited."
    );
    let deleted_board_comment = client
        .delete(format!(
            "{base}/api/issues/{issue_short_ref}/comments/{board_comment_id}"
        ))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted_board_comment.status(), StatusCode::OK);
    let deleted_board_comment: serde_json::Value = deleted_board_comment.json().await.unwrap();
    assert_eq!(deleted_board_comment["body"], "");
    assert!(deleted_board_comment["deletedAt"].is_string());
    let forged_comment_activity = client
        .patch(format!("{base}/api/issues/{issue_id}"))
        .bearer_auth(&board_token)
        .json(&json!({
            "comment":"Public clients cannot forge internal comment audit details.",
            "commentActivityDetails":{
                "interruptedRunId":run_id,
                "steerRunId":run_id,
                "reopened":true
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(forged_comment_activity.status(), StatusCode::OK);
    let forged_comment_activity: serde_json::Value = forged_comment_activity.json().await.unwrap();
    let forged_comment_id = forged_comment_activity["comment"]["id"].as_str().unwrap();
    let forged_comment_activity_details: serde_json::Value = sqlx::query_scalar(
        "SELECT details FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.comment_added' AND details->>'commentId'=$3",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .bind(forged_comment_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        forged_comment_activity_details
            .get("interruptedRunId")
            .is_none()
    );
    assert!(forged_comment_activity_details.get("steerRunId").is_none());
    assert!(forged_comment_activity_details.get("reopened").is_none());
    let node_fallback_comments = node_requests.load(Ordering::SeqCst);
    assert_eq!(node_fallback_comments, 1);

    let trigger_suffix = Uuid::new_v4().simple().to_string();
    let trigger_function = format!("test_reject_issue_comment_wakeup_{trigger_suffix}");
    let trigger_name = format!("test_reject_issue_comment_wakeup_{trigger_suffix}");
    sqlx::query(&format!(
        "CREATE FUNCTION {trigger_function}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.reason='issue_comment_mentioned'
              AND NEW.payload->>'issueId'='{comment_wakeup_issue_id}' THEN
             RAISE EXCEPTION 'forced Issue comment wake admission failure';
           END IF;
           RETURN NEW;
         END; $$"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(&format!(
        "CREATE TRIGGER {trigger_name} BEFORE INSERT ON agent_wakeup_requests
         FOR EACH ROW EXECUTE FUNCTION {trigger_function}()"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let wake_comment_body =
        format!("[Other agent](agent://{other_agent_id}?intent=wake) please review this Issue.");
    let failed_wakeup_comment = client
        .post(format!(
            "{base}/api/issues/{comment_wakeup_issue_id}/comments"
        ))
        .bearer_auth(&board_token)
        .json(&json!({"body":wake_comment_body}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        failed_wakeup_comment.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    sqlx::query(&format!(
        "DROP TRIGGER {trigger_name} ON agent_wakeup_requests"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(&format!("DROP FUNCTION {trigger_function}()"))
        .execute(&pool)
        .await
        .unwrap();
    let failed_wakeup_state: (i64, i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid),
           (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.comment_added'),
           (SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid AND reason='issue_comment_mentioned' AND payload->>'issueId'=$2)",
    )
    .bind(&org_id)
    .bind(&comment_wakeup_issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(failed_wakeup_state, (0, 0, 0));

    let normal_steer_failure_agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, $2, 'general', 'idle') RETURNING id::text",
    )
    .bind(&org_id)
    .bind(format!("Normal Steer Failure Agent {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let normal_steer_failure_issue_id = Uuid::new_v4().to_string();
    let normal_steer_failure_run_id = Uuid::new_v4().to_string();
    let normal_steer_failure_prior_work: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid),
           (SELECT count(*) FROM agent_task_sessions WHERE agent_id=$2::uuid),
           (SELECT count(*) FROM goal_owner_assignments WHERE org_id=$1::uuid AND agent_id=$2::uuid),
           (SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid)",
    )
    .bind(&org_id)
    .bind(&normal_steer_failure_agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(normal_steer_failure_prior_work, (0, 0, 0, 0));
    sqlx::query(
        "INSERT INTO heartbeat_runs (id, org_id, agent_id, status, started_at, invocation_source, execution_authority, context_snapshot) VALUES ($1::uuid, $2::uuid, $3::uuid, 'running', now(), 'manual', 'legacy_ts', $4::jsonb)",
    )
    .bind(&normal_steer_failure_run_id)
    .bind(&org_id)
    .bind(&normal_steer_failure_agent_id)
    .bind(json!({"issueId":normal_steer_failure_issue_id}).to_string())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO issues (id, org_id, title, status, priority, issue_number, identifier, assignee_agent_id, execution_run_id) VALUES ($1::uuid, $2::uuid, 'Normal Steer wake admission failure', 'in_progress', 'medium', 900007, $3, $4::uuid, $5::uuid)",
    )
    .bind(&normal_steer_failure_issue_id)
    .bind(&org_id)
    .bind(format!("{prefix}-900007"))
    .bind(&normal_steer_failure_agent_id)
    .bind(&normal_steer_failure_run_id)
    .execute(&pool)
    .await
    .unwrap();
    let normal_steer_failure_row_before: (
        String,
        Option<String>,
        Option<String>,
        String,
        String,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT i.status,i.execution_run_id::text,i.execution_cancellation_at::text,i.updated_at::text,r.status,r.error_code FROM issues i JOIN heartbeat_runs r ON r.org_id=i.org_id AND r.id=$3::uuid WHERE i.org_id=$1::uuid AND i.id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&normal_steer_failure_issue_id)
    .bind(&normal_steer_failure_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let normal_steer_failure_counts_before: (i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid),
           (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=($2::uuid)::text AND action='issue.comment_added'),
           (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=($2::uuid)::text AND action='issue.updated'),
           (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=($3::uuid)::text AND action='heartbeat.cancelled' AND details->>'source'='issue_comment_steer'),
           (SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$4::uuid AND payload->>'issueId'=($2::uuid)::text)",
    )
    .bind(&org_id)
    .bind(&normal_steer_failure_issue_id)
    .bind(&normal_steer_failure_run_id)
    .bind(&normal_steer_failure_agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(normal_steer_failure_counts_before, (0, 0, 0, 0, 0));
    let normal_steer_trigger_suffix = Uuid::new_v4().simple().to_string();
    let normal_steer_trigger_function =
        format!("test_reject_normal_issue_steer_{normal_steer_trigger_suffix}");
    let normal_steer_trigger_name =
        format!("test_reject_normal_issue_steer_{normal_steer_trigger_suffix}");
    sqlx::query(&format!(
        "CREATE FUNCTION {normal_steer_trigger_function}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.agent_id='{normal_steer_failure_agent_id}'::uuid
              AND NEW.payload->>'issueId'='{normal_steer_failure_issue_id}' THEN
             RAISE EXCEPTION 'forced normal Issue Steer wake admission failure (attempted reason=%)', NEW.reason;
           END IF;
           RETURN NEW;
         END; $$"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(&format!(
        "CREATE TRIGGER {normal_steer_trigger_name} BEFORE INSERT ON agent_wakeup_requests
         FOR EACH ROW EXECUTE FUNCTION {normal_steer_trigger_function}()"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let failed_normal_steer = client
        .post(format!(
            "{base}/api/issues/{normal_steer_failure_issue_id}/comments"
        ))
        .bearer_auth(&board_token)
        .json(&json!({
            "body":"A wake admission error must roll back this normal Steer comment.",
            "steer":{"expectedRunId":normal_steer_failure_run_id}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        failed_normal_steer.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    sqlx::query(&format!(
        "DROP TRIGGER {normal_steer_trigger_name} ON agent_wakeup_requests"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(&format!("DROP FUNCTION {normal_steer_trigger_function}()"))
        .execute(&pool)
        .await
        .unwrap();
    let normal_steer_failure_row_after: (
        String,
        Option<String>,
        Option<String>,
        String,
        String,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT i.status,i.execution_run_id::text,i.execution_cancellation_at::text,i.updated_at::text,r.status,r.error_code FROM issues i JOIN heartbeat_runs r ON r.org_id=i.org_id AND r.id=$3::uuid WHERE i.org_id=$1::uuid AND i.id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&normal_steer_failure_issue_id)
    .bind(&normal_steer_failure_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let normal_steer_failure_counts_after: (i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid),
           (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=($2::uuid)::text AND action='issue.comment_added'),
           (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=($2::uuid)::text AND action='issue.updated'),
           (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=($3::uuid)::text AND action='heartbeat.cancelled' AND details->>'source'='issue_comment_steer'),
           (SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$4::uuid AND payload->>'issueId'=($2::uuid)::text)",
    )
    .bind(&org_id)
    .bind(&normal_steer_failure_issue_id)
    .bind(&normal_steer_failure_run_id)
    .bind(&normal_steer_failure_agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        normal_steer_failure_row_after,
        normal_steer_failure_row_before
    );
    assert_eq!(
        normal_steer_failure_counts_after,
        normal_steer_failure_counts_before
    );

    let paused_steer_agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, $2, 'general', 'paused') RETURNING id::text",
    )
    .bind(&org_id)
    .bind(format!("Paused Steer Admission Agent {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let paused_steer_issue_id = Uuid::new_v4().to_string();
    let paused_steer_run_id = Uuid::new_v4().to_string();
    let paused_steer_prior_work: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid),
           (SELECT count(*) FROM agent_task_sessions WHERE agent_id=$2::uuid),
           (SELECT count(*) FROM goal_owner_assignments WHERE org_id=$1::uuid AND agent_id=$2::uuid),
           (SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid)",
    )
    .bind(&org_id)
    .bind(&paused_steer_agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(paused_steer_prior_work, (0, 0, 0, 0));
    sqlx::query(
        "INSERT INTO heartbeat_runs (id, org_id, agent_id, status, started_at, invocation_source, execution_authority, context_snapshot) VALUES ($1::uuid, $2::uuid, $3::uuid, 'running', now(), 'manual', 'legacy_ts', $4::jsonb)",
    )
    .bind(&paused_steer_run_id)
    .bind(&org_id)
    .bind(&paused_steer_agent_id)
    .bind(json!({"issueId":paused_steer_issue_id}).to_string())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO issues (id, org_id, title, status, priority, issue_number, identifier, assignee_agent_id, execution_run_id) VALUES ($1::uuid, $2::uuid, 'Paused Steer policy conflict', 'in_progress', 'medium', 900008, $3, $4::uuid, $5::uuid)",
    )
    .bind(&paused_steer_issue_id)
    .bind(&org_id)
    .bind(format!("{prefix}-900008"))
    .bind(&paused_steer_agent_id)
    .bind(&paused_steer_run_id)
    .execute(&pool)
    .await
    .unwrap();
    let saved_steer_conflict = client
        .post(format!(
            "{base}/api/issues/{paused_steer_issue_id}/comments"
        ))
        .bearer_auth(&board_token)
        .json(&json!({
            "body":"Keep this comment when the paused Agent cannot accept a continuation.",
            "steer":{"expectedRunId":paused_steer_run_id}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(saved_steer_conflict.status(), StatusCode::CONFLICT);
    let saved_steer_conflict: serde_json::Value = saved_steer_conflict.json().await.unwrap();
    assert_eq!(
        saved_steer_conflict["error"],
        "Steer could not reserve a continuation; feedback was saved as a comment"
    );
    assert_eq!(
        saved_steer_conflict["comment"]["body"],
        "Keep this comment when the paused Agent cannot accept a continuation."
    );
    let saved_steer_comment_id = saved_steer_conflict["comment"]["id"]
        .as_str()
        .expect("saved Steer conflict returns its persisted comment ID");
    let saved_steer_comment_body: String = sqlx::query_scalar(
        "SELECT body FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid AND id=$3::uuid",
    )
    .bind(&org_id)
    .bind(&paused_steer_issue_id)
    .bind(saved_steer_comment_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        saved_steer_comment_body,
        "Keep this comment when the paused Agent cannot accept a continuation."
    );
    let saved_steer_state: (String, Option<String>, Option<String>, i64, i64, i64, i64) =
        sqlx::query_as(
            "SELECT i.status,i.execution_run_id::text,i.execution_cancellation_at::text,
               (SELECT count(*) FROM issue_comments c WHERE c.org_id=i.org_id AND c.issue_id=i.id),
               (SELECT count(*) FROM activity_log a WHERE a.org_id=i.org_id AND a.entity_id=i.id::text AND a.action='issue.comment_added'),
               (SELECT count(*) FROM activity_log a WHERE a.org_id=i.org_id AND a.entity_id=r.id::text AND a.action='heartbeat.cancelled' AND a.details->>'source'='issue_comment_steer'),
               (SELECT count(*) FROM agent_wakeup_requests w WHERE w.org_id=i.org_id AND w.agent_id=i.assignee_agent_id AND w.payload->>'issueId'=i.id::text)
             FROM issues i JOIN heartbeat_runs r ON r.org_id=i.org_id AND r.id=$3::uuid
             WHERE i.org_id=$1::uuid AND i.id=$2::uuid",
        )
        .bind(&org_id)
        .bind(&paused_steer_issue_id)
        .bind(&paused_steer_run_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        saved_steer_state,
        (
            "in_progress".to_owned(),
            Some(paused_steer_run_id.clone()),
            None,
            1,
            1,
            0,
            0,
        )
    );
    let paused_steer_agent_status: String =
        sqlx::query_scalar("SELECT status FROM agents WHERE org_id=$1::uuid AND id=$2::uuid")
            .bind(&org_id)
            .bind(&paused_steer_agent_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(paused_steer_agent_status, "paused");

    let admitted_wakeup_comment = client
        .post(format!(
            "{base}/api/issues/{comment_wakeup_issue_id}/comments"
        ))
        .bearer_auth(&board_token)
        .json(&json!({"body":wake_comment_body}))
        .send()
        .await
        .unwrap();
    assert_eq!(admitted_wakeup_comment.status(), StatusCode::CREATED);
    let admitted_wakeup_comment: serde_json::Value = admitted_wakeup_comment.json().await.unwrap();
    let admitted_comment_id = admitted_wakeup_comment["id"].as_str().unwrap();
    let admitted_wakeup: (String, String, String, String, serde_json::Value, String) =
        sqlx::query_as(
            "SELECT w.id::text,w.status,w.reason,w.run_id::text,w.payload,r.execution_authority
             FROM agent_wakeup_requests w JOIN heartbeat_runs r
               ON r.org_id=w.org_id AND r.wakeup_request_id=w.id AND r.id=w.run_id
             WHERE w.org_id=$1::uuid AND w.agent_id=$2::uuid AND w.payload->>'issueId'=$3",
        )
        .bind(&org_id)
        .bind(&other_agent_id)
        .bind(&comment_wakeup_issue_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(admitted_wakeup.1, "queued");
    assert_eq!(admitted_wakeup.2, "issue_comment_mentioned");
    assert_eq!(admitted_wakeup.4["issueId"], comment_wakeup_issue_id);
    assert_eq!(admitted_wakeup.4["commentId"], admitted_comment_id);
    assert_eq!(admitted_wakeup.5, "native_rust");
    let comment_wakeup_request_id = admitted_wakeup.0;
    let comment_wakeup_run_id = admitted_wakeup.3;

    let block_claim = client
        .patch(format!("{base}/api/issues/{issue_id}"))
        .bearer_auth(&agent_token)
        .header("x-rudder-run-id", &run_id)
        .json(&json!({
            "status":"blocked",
            "comment":"Blocked by missing credentials; the organization owner must provide access."
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(block_claim.status(), StatusCode::OK);
    let block_claim: serde_json::Value = block_claim.json().await.unwrap();
    assert_eq!(block_claim["status"], "in_progress");
    assert_eq!(block_claim["blockAudit"]["attempt"], 1);
    assert_eq!(block_claim["blockAudit"]["requiredAttempts"], 3);
    assert_eq!(block_claim["blockAudit"]["blocked"], false);
    assert_eq!(
        block_claim["comment"]["body"],
        "Blocked by missing credentials; the organization owner must provide access."
    );
    let block_request: (String, String, String, i32) = sqlx::query_as(
        "SELECT r.id::text,r.status,r.prompt,(SELECT count(*)::int FROM issue_block_audit_attempts a WHERE a.org_id=r.org_id AND a.request_id=r.id)
         FROM requests r WHERE r.org_id=$1::uuid AND r.issue_id=$2::uuid AND r.kind='assistance' AND r.subtype='issue_blocker'",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(block_request.1, "open");
    assert_eq!(
        block_request.2,
        "Blocked by missing credentials; the organization owner must provide access."
    );
    assert_eq!(block_request.3, 1);
    let block_audit_activity_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.block_audit_attempted' AND run_id=$3::uuid",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(block_audit_activity_count, 1);
    let block_audit_event_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid AND event_type='issue.block_audit_attempted'",
    )
    .bind(&org_id)
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(block_audit_event_count, 1);
    let activity_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.checked_out' AND run_id=$3::uuid",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(activity_count, 1);

    let nonself_checkout = client
        .post(format!("{base}/api/issues/{board_issue_id}/checkout"))
        .bearer_auth(&agent_token)
        .json(&json!({"agentId":other_agent_id,"expectedStatuses":["todo"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(nonself_checkout.status(), StatusCode::FORBIDDEN);
    let untouched: (String, Option<String>) =
        sqlx::query_as("SELECT status,assignee_agent_id::text FROM issues WHERE id=$1::uuid")
            .bind(&board_issue_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(untouched, ("todo".to_owned(), None));

    let board_checkout = client
        .post(format!("{base}/api/issues/{board_issue_id}/checkout"))
        .json(&json!({"agentId":agent_id,"expectedStatuses":["todo"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(board_checkout.status(), StatusCode::OK);
    let board_body: serde_json::Value = board_checkout.json().await.unwrap();
    assert_eq!(board_body["status"], "in_progress");
    assert_eq!(board_body["assigneeAgentId"], agent_id);
    assert_eq!(board_body["checkoutRunId"], serde_json::Value::Null);
    assert_eq!(board_body["executionRunId"], serde_json::Value::Null);
    let board_run_id: String = sqlx::query_scalar(
        "SELECT execution_run_id::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&board_issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    let queue_row = sqlx::query_as::<_, (String, String, String, String, String)>(
        "SELECT w.status,w.source,w.reason,w.execution_authority,r.status
         FROM agent_wakeup_requests w JOIN heartbeat_runs r
           ON r.org_id=w.org_id AND r.wakeup_request_id=w.id AND r.id=w.run_id
         WHERE w.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&board_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        queue_row,
        (
            "queued".to_owned(),
            "assignment".to_owned(),
            "issue_checked_out".to_owned(),
            "native_rust".to_owned(),
            "queued".to_owned(),
        )
    );
    let board_activity_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.checked_out' AND actor_type='user' AND actor_id='local-board' AND run_id IS NULL",
    )
    .bind(&org_id)
    .bind(&board_issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(board_activity_count, 1);

    let member_checkout = client
        .post(format!("{base}/api/issues/{member_issue_id}/checkout"))
        .bearer_auth(&board_token)
        .json(&json!({"agentId":agent_id,"expectedStatuses":["todo"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(member_checkout.status(), StatusCode::OK);
    let member_body: serde_json::Value = member_checkout.json().await.unwrap();
    assert_eq!(member_body["assigneeAgentId"], agent_id);
    assert_eq!(member_body["executionRunId"], serde_json::Value::Null);
    let member_can_assign_tasks: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM principal_permission_grants WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2 AND permission_key='tasks:assign')",
    )
    .bind(&org_id)
    .bind(&board_user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!member_can_assign_tasks);
    let member_activity_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.checked_out' AND actor_type='user' AND actor_id=$3 AND run_id IS NULL",
    )
    .bind(&org_id)
    .bind(&member_issue_id)
    .bind(&board_user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(member_activity_count, 1);
    let member_run_id: String = sqlx::query_scalar(
        "SELECT execution_run_id::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&member_issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let member_queue_authority: String = sqlx::query_scalar(
        "SELECT w.execution_authority FROM agent_wakeup_requests w JOIN heartbeat_runs r ON r.org_id=w.org_id AND r.wakeup_request_id=w.id AND r.id=w.run_id WHERE w.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&member_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(member_queue_authority, "native_rust");

    let paused_checkout = client
        .post(format!("{base}/api/issues/{paused_issue_id}/checkout"))
        .json(&json!({"agentId":paused_agent_id,"expectedStatuses":["todo"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(paused_checkout.status(), StatusCode::OK);
    let paused_body: serde_json::Value = paused_checkout.json().await.unwrap();
    assert_eq!(paused_body["executionRunId"], serde_json::Value::Null);
    let paused_request_id: String = sqlx::query_scalar(
        "SELECT id::text FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid AND status='deferred_agent_paused' AND payload->>'issueId'=$3",
    )
    .bind(&org_id)
    .bind(&paused_agent_id)
    .bind(&paused_issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let paused_retry = client
        .post(format!("{base}/api/issues/{paused_issue_id}/checkout"))
        .json(&json!({"agentId":paused_agent_id,"expectedStatuses":["in_progress"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(paused_retry.status(), StatusCode::OK);
    let paused_wakeup: (i32, serde_json::Value) = sqlx::query_as(
        "SELECT coalesced_count,payload FROM agent_wakeup_requests WHERE id=$1::uuid",
    )
    .bind(&paused_request_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(paused_wakeup.0, 1);
    assert_eq!(
        paused_wakeup.1["_paperclipWakeContext"]["issueId"],
        paused_issue_id
    );

    let budget_issue_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO issues (id, org_id, title, status, priority, issue_number, identifier) VALUES ($1::uuid, $2::uuid, 'Budget blocked checkout', 'todo', 'medium', 900001, $3)",
    )
    .bind(&budget_issue_id)
    .bind(&org_id)
    .bind(format!("{prefix}-900001"))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO budget_policies (org_id, scope_type, scope_id, metric, window_kind, amount, hard_stop_enabled, is_active) VALUES ($1::uuid, 'agent', $2::uuid, 'billed_cents', 'calendar_month_utc', 1, true, true)",
    )
    .bind(&org_id)
    .bind(&other_agent_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO cost_events (org_id, agent_id, provider, model, cost_cents, occurred_at) VALUES ($1::uuid, $2::uuid, 'test', 'test', 1, now())",
    )
    .bind(&org_id)
    .bind(&other_agent_id)
    .execute(&pool)
    .await
    .unwrap();
    let budget_checkout = client
        .post(format!("{base}/api/issues/{budget_issue_id}/checkout"))
        .bearer_auth(&board_token)
        .json(&json!({"agentId":other_agent_id,"expectedStatuses":["todo"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(budget_checkout.status(), StatusCode::OK);
    let budget_checkout: serde_json::Value = budget_checkout.json().await.unwrap();
    assert_eq!(budget_checkout["status"], "in_progress");
    assert_eq!(budget_checkout["executionRunId"], serde_json::Value::Null);
    let skipped_wakeup: (String, String, Option<String>, bool) = sqlx::query_as(
        "SELECT status, reason, run_id::text, finished_at IS NOT NULL FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid AND payload->>'issueId'=$3",
    )
    .bind(&org_id)
    .bind(&other_agent_id)
    .bind(&budget_issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        skipped_wakeup,
        (
            "skipped".to_owned(),
            "budget.blocked".to_owned(),
            None,
            true
        )
    );
    let budget_issue_run: Option<String> = sqlx::query_scalar(
        "SELECT execution_run_id::text FROM issues WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&budget_issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(budget_issue_run, None);

    let source_asset_id = Uuid::new_v4().to_string();
    let source_asset_object_key = format!("{org_id}/uploads/source-image.png");
    let source_asset_bytes = b"native issue description image bytes";
    let source_asset_path = asset_storage_directory
        .path()
        .join(&source_asset_object_key);
    std::fs::create_dir_all(source_asset_path.parent().unwrap()).unwrap();
    std::fs::write(&source_asset_path, source_asset_bytes).unwrap();
    sqlx::query(
        "INSERT INTO assets (id,org_id,provider,object_key,content_type,byte_size,sha256,original_filename,created_by_user_id) VALUES ($1::uuid,$2::uuid,'local_disk',$3,'image/png',$4,$5,'source image.png',$6)",
    )
    .bind(&source_asset_id)
    .bind(&org_id)
    .bind(&source_asset_object_key)
    .bind(source_asset_bytes.len() as i32)
    .bind(format!("{:x}", Sha256::digest(source_asset_bytes)))
    .bind(&board_user_id)
    .execute(&pool)
    .await
    .unwrap();

    let issue_counter_before_invalid_create: i32 =
        sqlx::query_scalar("SELECT issue_counter FROM organizations WHERE id=$1::uuid")
            .bind(&org_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let invalid_create_title = format!("Invalid nested Issue create {suffix}");
    let invalid_create = client
        .post(format!("{base}/api/orgs/{org_id}/issues"))
        .bearer_auth(&board_token)
        .json(&json!({
            "title":invalid_create_title.clone(),
            "runWorkspaceSettings":{"workspaceStrategy":{"unknown":true}}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_create.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let invalid_create_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM issues WHERE org_id=$1::uuid AND title=$2")
            .bind(&org_id)
            .bind(&invalid_create_title)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(invalid_create_count, 0);
    let issue_counter_after_invalid_create: i32 =
        sqlx::query_scalar("SELECT issue_counter FROM organizations WHERE id=$1::uuid")
            .bind(&org_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        issue_counter_after_invalid_create,
        issue_counter_before_invalid_create
    );

    let created = client
        .post(format!("{base}/api/orgs/{org_id}/issues"))
        .json(&json!({
            "title":format!("Native Issue CRUD workflow [@Title](project://{title_project_id})"),
            "description":format!("Initial description [@Description](project://{description_project_id}) ![First](/api/assets/{source_asset_id}/content) ![Again](/api/assets/{source_asset_id}/content)"),
            "status":"todo"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let created: serde_json::Value = created.json().await.unwrap();
    let created_id = created["id"].as_str().unwrap().to_owned();
    let issue_before_invalid_update: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(i) FROM issues i WHERE i.org_id=$1::uuid AND i.id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&created_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let invalid_update = client
        .patch(format!("{base}/api/issues/{created_id}"))
        .bearer_auth(&board_token)
        .json(&json!({
            "title":"This title must not persist",
            "assigneeAgentRuntimeOverrides":{"agentRuntimeConfig":null}
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(invalid_update.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let issue_after_invalid_update: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(i) FROM issues i WHERE i.org_id=$1::uuid AND i.id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&created_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(issue_after_invalid_update, issue_before_invalid_update);
    assert_eq!(
        created["title"],
        format!("Native Issue CRUD workflow [@Title](project://{title_project_id})")
    );
    assert_eq!(created["identifier"], format!("{prefix}-5"));
    let issue_created_analytics_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM product_analytics_events WHERE org_id=$1::uuid AND dedupe_key=$2",
    )
    .bind(&org_id)
    .bind(format!("issue_created:{created_id}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(issue_created_analytics_count, 1);
    let issue_created_analytics: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM product_analytics_events e WHERE org_id=$1::uuid AND dedupe_key=$2",
    )
    .bind(&org_id)
    .bind(format!("issue_created:{created_id}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(issue_created_analytics["event_name"], "issue_created");
    assert_eq!(issue_created_analytics["source_transition"], "issue.create");
    assert_eq!(issue_created_analytics["confidence"], "exact");
    assert_eq!(issue_created_analytics["actor_type"], "human");
    assert_eq!(
        issue_created_analytics["actor_id"],
        created["createdByUserId"]
    );
    assert_eq!(
        issue_created_analytics["local_user_id"],
        created["createdByUserId"]
    );
    assert_eq!(issue_created_analytics["origin"], "human");
    assert_eq!(issue_created_analytics["work_surface"], "issue");
    assert_eq!(issue_created_analytics["work_id"], created_id);
    assert_eq!(issue_created_analytics["entity_type"], "issue");
    assert_eq!(issue_created_analytics["entity_id"], created_id);
    assert_eq!(
        issue_created_analytics["properties"],
        json!({
            "creation_path":"manual",
            "has_goal_link":false,
            "has_project_link":false,
            "is_sub_issue":false
        })
    );
    assert_eq!(
        issue_created_analytics["dedupe_key"],
        format!("issue_created:{created_id}")
    );
    type CopiedDescriptionAttachment = (
        String,
        String,
        String,
        String,
        String,
        String,
        i32,
        String,
        Option<String>,
        Option<String>,
    );
    let copied_attachment: CopiedDescriptionAttachment = sqlx::query_as(
        "SELECT ia.id::text,ia.asset_id::text,ia.usage,a.provider,a.object_key,a.content_type,a.byte_size,a.sha256,a.original_filename,a.created_by_user_id FROM issue_attachments ia JOIN assets a ON a.org_id=ia.org_id AND a.id=ia.asset_id WHERE ia.org_id=$1::uuid AND ia.issue_id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&created_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(copied_attachment.2, "description_inline");
    assert_eq!(copied_attachment.3, "local_disk");
    assert_eq!(copied_attachment.5, "image/png");
    assert_eq!(copied_attachment.6, source_asset_bytes.len() as i32);
    assert_eq!(
        copied_attachment.7,
        format!("{:x}", Sha256::digest(source_asset_bytes))
    );
    assert_eq!(copied_attachment.8.as_deref(), Some("source image.png"));
    assert_eq!(
        copied_attachment.9.as_deref(),
        created["createdByUserId"].as_str()
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM issue_attachments WHERE org_id=$1::uuid AND issue_id=$2::uuid",
        )
        .bind(&org_id)
        .bind(&created_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1,
        "duplicate source URLs should create one copied attachment"
    );
    let rewritten_attachment_url = format!("/api/attachments/{}/content", copied_attachment.0);
    let expected_description = format!(
        "Initial description [@Description](project://{description_project_id}) ![First]({rewritten_attachment_url}) ![Again]({rewritten_attachment_url})"
    );
    assert_eq!(created["description"], expected_description);
    let copied_object_path = asset_storage_directory.path().join(&copied_attachment.4);
    assert_eq!(
        std::fs::read(&copied_object_path).unwrap(),
        source_asset_bytes
    );
    assert!(
        copied_attachment
            .4
            .starts_with(&format!("{org_id}/issues/{created_id}/description/"))
    );
    let copied_asset_path = copied_object_path;
    for (project_id, deleted) in [
        (&comment_project_id, false),
        (&deleted_comment_project_id, true),
    ] {
        let comment_id = Uuid::new_v4().to_string();
        let body = format!("[@Mention](project://{project_id})");
        if deleted {
            sqlx::query(
                "INSERT INTO issue_comments (id, org_id, issue_id, author_user_id, body, deleted_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, now())",
            )
            .bind(&comment_id)
            .bind(&org_id)
            .bind(&created_id)
            .bind(&board_user_id)
            .bind(body)
            .execute(&pool)
            .await
            .unwrap();
        } else {
            sqlx::query(
                "INSERT INTO issue_comments (id, org_id, issue_id, author_user_id, body) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)",
            )
            .bind(&comment_id)
            .bind(&org_id)
            .bind(&created_id)
            .bind(&board_user_id)
            .bind(body)
            .execute(&pool)
            .await
            .unwrap();
        }
    }

    let listed = client
        .get(format!(
            "{base}/api/orgs/{org_id}/issues?status=todo&q=Native%20Issue%20CRUD"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    let listed: serde_json::Value = listed.json().await.unwrap();
    assert!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| issue["id"] == created_id)
    );

    let agent_short_ref = format!("agt_{}", agent_id.replace('-', "")[..8].to_owned());
    let participant_list = client
        .get(format!(
            "{base}/api/orgs/{org_id}/issues?participantAgentId={agent_short_ref}"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(participant_list.status(), StatusCode::OK);
    let participant_list: serde_json::Value = participant_list.json().await.unwrap();
    assert!(
        participant_list
            .as_array()
            .unwrap()
            .iter()
            .any(|issue| issue["id"] == board_issue_id)
    );

    let detail = client
        .get(format!("{base}/api/issues/{created_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(detail.status(), StatusCode::OK);
    let detail: serde_json::Value = detail.json().await.unwrap();
    assert_eq!(detail["id"], created_id);
    assert_eq!(detail["description"], expected_description);
    let mentioned_ids = detail["mentionedProjects"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|project| project["id"].as_str().map(ToOwned::to_owned))
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        mentioned_ids,
        [
            title_project_id.clone(),
            description_project_id.clone(),
            comment_project_id.clone(),
        ]
        .into_iter()
        .collect()
    );

    let unchanged = client
        .patch(format!("{base}/api/issues/{created_id}"))
        .json(&json!({"title":detail["title"].clone()}))
        .send()
        .await
        .unwrap();
    assert_eq!(unchanged.status(), StatusCode::OK);
    let unchanged: serde_json::Value = unchanged.json().await.unwrap();
    assert_eq!(unchanged["updatedAt"], detail["updatedAt"]);

    let child = client
        .post(format!("{base}/api/orgs/{org_id}/issues"))
        .json(&json!({"title":"Native Issue child","parentId":created_id,"status":"todo"}))
        .send()
        .await
        .unwrap();
    assert_eq!(child.status(), StatusCode::CREATED);
    let child: serde_json::Value = child.json().await.unwrap();
    let child_id = child["id"].as_str().unwrap().to_owned();
    let cycle = client
        .patch(format!("{base}/api/issues/{created_id}"))
        .json(&json!({"parentId":child_id}))
        .send()
        .await
        .unwrap();
    assert_eq!(cycle.status(), StatusCode::UNPROCESSABLE_ENTITY);

    let updated = client
        .patch(format!("{base}/api/issues/{created_id}"))
        .json(&json!({
            "title":"Native Issue CRUD updated",
            "description":null,
            "status":"in_progress",
            "assigneeUserId":board_user_id
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);
    let updated: serde_json::Value = updated.json().await.unwrap();
    assert_eq!(updated["title"], "Native Issue CRUD updated");
    assert_eq!(updated["description"], serde_json::Value::Null);
    assert_eq!(updated["status"], "in_progress");
    assert_eq!(updated["assigneeUserId"], board_user_id);
    let human_work_started_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM product_analytics_events WHERE org_id=$1::uuid AND dedupe_key=$2",
    )
    .bind(&org_id)
    .bind(format!("human_work_started:issue:{created_id}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(human_work_started_count, 1);
    let human_work_started: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM product_analytics_events e WHERE org_id=$1::uuid AND dedupe_key=$2",
    )
    .bind(&org_id)
    .bind(format!("human_work_started:issue:{created_id}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(human_work_started["event_name"], "human_work_started");
    assert_eq!(human_work_started["source_transition"], "issue.update");
    assert_eq!(human_work_started["confidence"], "exact");
    assert_eq!(human_work_started["actor_type"], "human");
    assert_eq!(human_work_started["actor_id"], created["createdByUserId"]);
    assert_eq!(
        human_work_started["local_user_id"],
        created["createdByUserId"]
    );
    assert_eq!(human_work_started["origin"], "human");
    assert_eq!(
        human_work_started["work_cycle_id"],
        format!("issue:{created_id}")
    );
    assert_eq!(
        human_work_started["properties"],
        json!({"work_surface":"issue","origin":"human"})
    );
    let issue_work_cycle: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(c) FROM product_analytics_work_cycles c WHERE org_id=$1::uuid AND work_cycle_id=$2",
    )
    .bind(&org_id)
    .bind(format!("issue:{created_id}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(issue_work_cycle["work_surface"], "issue");
    assert_eq!(issue_work_cycle["work_id"], created_id);
    assert_eq!(issue_work_cycle["actor_id"], created["createdByUserId"]);
    assert_eq!(issue_work_cycle["state"], "open");
    assert_eq!(issue_work_cycle["completion_revision"], 0);
    assert!(issue_work_cycle["started_at"].is_string());

    let reordered = client
        .post(format!("{base}/api/orgs/{org_id}/issues/reorder"))
        .json(&json!({"issueId":created_id,"targetStatus":"todo","position":"start"}))
        .send()
        .await
        .unwrap();
    assert_eq!(reordered.status(), StatusCode::OK);
    let reordered: serde_json::Value = reordered.json().await.unwrap();
    assert_eq!(reordered["id"], created_id);
    assert_eq!(reordered["status"], "todo");

    let lifecycle_actions: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action IN ('issue.created','issue.updated','issue.reordered') ORDER BY created_at",
    )
    .bind(&org_id)
    .bind(&created_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        lifecycle_actions,
        vec![
            "issue.created".to_owned(),
            "issue.updated".to_owned(),
            "issue.reordered".to_owned()
        ]
    );

    let lifecycle_run_id = Uuid::new_v4().to_string();
    seed_issue_successful_run_evidence(&pool, &org_id, &agent_id, &created_id, &lifecycle_run_id)
        .await;
    let successful_run: (String, bool) = sqlx::query_as(
        "SELECT status,result_summary_json IS NOT NULL FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&lifecycle_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(successful_run, ("succeeded".to_owned(), true));
    let run_output_evidence_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM product_analytics_events WHERE org_id=$1::uuid AND work_cycle_id=$2 AND event_name IN ('run_succeeded','output_ready')",
    )
    .bind(&org_id)
    .bind(format!("issue:{created_id}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(run_output_evidence_count, 2);

    let first_completion = client
        .patch(format!("{base}/api/issues/{created_id}"))
        .bearer_auth(&board_token)
        .json(&json!({"status":"done"}))
        .send()
        .await
        .unwrap();
    assert_eq!(first_completion.status(), StatusCode::OK);
    let first_completion: serde_json::Value = first_completion.json().await.unwrap();
    assert_eq!(first_completion["status"], "done");
    let first_completion_readback = client
        .get(format!("{base}/api/issues/{created_id}"))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(first_completion_readback.status(), StatusCode::OK);
    let first_completion_readback: serde_json::Value =
        first_completion_readback.json().await.unwrap();
    assert_eq!(first_completion_readback["status"], "done");

    let work_cycle_id = format!("issue:{created_id}");
    let completion_one_dedupe_key = format!("work_loop_completed:{work_cycle_id}:1");
    let completion_one: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM product_analytics_events e WHERE org_id=$1::uuid AND dedupe_key=$2",
    )
    .bind(&org_id)
    .bind(&completion_one_dedupe_key)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(completion_one["event_name"], "work_loop_completed");
    assert_eq!(completion_one["source_transition"], "issue.complete");
    assert_eq!(completion_one["actor_type"], "human");
    assert_eq!(completion_one["actor_id"], board_user_id);
    assert_eq!(completion_one["completion_revision"], 1);
    assert_eq!(completion_one["work_cycle_id"], work_cycle_id);
    assert_eq!(completion_one["properties"]["review_required"], false);
    let cycle_after_completion_one: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(c) FROM product_analytics_work_cycles c WHERE org_id=$1::uuid AND work_cycle_id=$2",
    )
    .bind(&org_id)
    .bind(&work_cycle_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(cycle_after_completion_one["state"], "completed");
    assert_eq!(cycle_after_completion_one["completion_revision"], 1);
    assert!(cycle_after_completion_one["invalidated_at"].is_null());
    assert!(
        cycle_after_completion_one["root_run_ids"]
            .as_array()
            .unwrap()
            .contains(&json!(lifecycle_run_id))
    );
    let revision_one: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(r) FROM product_analytics_work_cycle_revisions r WHERE org_id=$1::uuid AND work_cycle_id=$2 AND completion_revision=1",
    )
    .bind(&org_id)
    .bind(&work_cycle_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(revision_one["completion_event_id"], completion_one["id"]);
    assert!(revision_one["invalidated_at"].is_null());

    let replayed_completion = client
        .patch(format!("{base}/api/issues/{created_id}"))
        .bearer_auth(&board_token)
        .json(&json!({"status":"done"}))
        .send()
        .await
        .unwrap();
    assert_eq!(replayed_completion.status(), StatusCode::OK);
    let replayed_completion: serde_json::Value = replayed_completion.json().await.unwrap();
    assert_eq!(replayed_completion["status"], "done");
    let completion_one_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM product_analytics_events WHERE org_id=$1::uuid AND dedupe_key=$2",
    )
    .bind(&org_id)
    .bind(&completion_one_dedupe_key)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(completion_one_count, 1);

    let reopened = client
        .patch(format!("{base}/api/issues/{created_id}"))
        .bearer_auth(&board_token)
        .json(&json!({"comment":"Reopen for another work pass","reopen":true}))
        .send()
        .await
        .unwrap();
    assert_eq!(reopened.status(), StatusCode::OK);
    let reopened: serde_json::Value = reopened.json().await.unwrap();
    assert_eq!(reopened["status"], "todo");
    let reopened_readback = client
        .get(format!("{base}/api/issues/{created_id}"))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(reopened_readback.status(), StatusCode::OK);
    let reopened_readback: serde_json::Value = reopened_readback.json().await.unwrap();
    assert_eq!(reopened_readback["status"], "todo");

    let invalidation_dedupe_key = format!("work_loop_invalidated:{work_cycle_id}:1:reopened");
    let invalidation: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM product_analytics_events e WHERE org_id=$1::uuid AND dedupe_key=$2",
    )
    .bind(&org_id)
    .bind(&invalidation_dedupe_key)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(invalidation["event_name"], "work_loop_invalidated");
    assert_eq!(invalidation["completion_revision"], 1);
    assert_eq!(invalidation["properties"]["reason_code"], "reopened");
    let invalidated_revision_one: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(r) FROM product_analytics_work_cycle_revisions r WHERE org_id=$1::uuid AND work_cycle_id=$2 AND completion_revision=1",
    )
    .bind(&org_id)
    .bind(&work_cycle_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(invalidated_revision_one["invalidated_at"].is_string());
    assert_eq!(
        invalidated_revision_one["invalidation_event_id"],
        invalidation["id"]
    );
    let invalidated_cycle: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(c) FROM product_analytics_work_cycles c WHERE org_id=$1::uuid AND work_cycle_id=$2",
    )
    .bind(&org_id)
    .bind(&work_cycle_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(invalidated_cycle["state"], "invalidated");
    assert!(invalidated_cycle["invalidated_at"].is_string());

    let recompleted = client
        .patch(format!("{base}/api/issues/{created_id}"))
        .bearer_auth(&board_token)
        .json(&json!({"status":"done"}))
        .send()
        .await
        .unwrap();
    assert_eq!(recompleted.status(), StatusCode::OK);
    let recompleted: serde_json::Value = recompleted.json().await.unwrap();
    assert_eq!(recompleted["status"], "done");
    let recompleted_readback = client
        .get(format!("{base}/api/issues/{created_id}"))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(recompleted_readback.status(), StatusCode::OK);
    let recompleted_readback: serde_json::Value = recompleted_readback.json().await.unwrap();
    assert_eq!(recompleted_readback["status"], "done");
    let completion_two_dedupe_key = format!("work_loop_completed:{work_cycle_id}:2");
    let completion_two: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM product_analytics_events e WHERE org_id=$1::uuid AND dedupe_key=$2",
    )
    .bind(&org_id)
    .bind(&completion_two_dedupe_key)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(completion_two["event_name"], "work_loop_completed");
    assert_eq!(completion_two["completion_revision"], 2);
    let cycle_after_recompletion: serde_json::Value = sqlx::query_scalar(
        "SELECT to_jsonb(c) FROM product_analytics_work_cycles c WHERE org_id=$1::uuid AND work_cycle_id=$2",
    )
    .bind(&org_id)
    .bind(&work_cycle_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(cycle_after_recompletion["state"], "completed");
    assert_eq!(cycle_after_recompletion["completion_revision"], 2);
    assert!(cycle_after_recompletion["invalidated_at"].is_null());
    let lifecycle_completion_counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE event_name='work_loop_completed'), count(*) FILTER (WHERE event_name='work_loop_invalidated'), count(*) FILTER (WHERE event_name IN ('run_succeeded','output_ready')) FROM product_analytics_events WHERE org_id=$1::uuid AND work_cycle_id=$2",
    )
    .bind(&org_id)
    .bind(&work_cycle_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(lifecycle_completion_counts, (2, 1, 2));

    sqlx::query(
        "INSERT INTO cost_events (org_id,agent_id,issue_id,provider,model,cost_cents,occurred_at) VALUES ($1::uuid,$2::uuid,$3::uuid,'test','test-model',1,clock_timestamp())",
    )
    .bind(&org_id)
    .bind(&agent_id)
    .bind(&created_id)
    .execute(&pool)
    .await
    .unwrap();
    let blocked_delete = client
        .delete(format!("{base}/api/issues/{created_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(blocked_delete.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(copied_asset_path.exists());
    let remains_after_blocked_delete: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM issues WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(&org_id)
    .bind(&created_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(remains_after_blocked_delete);
    let premature_delete_activity: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.deleted'",
    )
    .bind(&org_id)
    .bind(&created_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(premature_delete_activity, 0);
    sqlx::query("DELETE FROM cost_events WHERE org_id=$1::uuid AND issue_id=$2::uuid")
        .bind(&org_id)
        .bind(&created_id)
        .execute(&pool)
        .await
        .unwrap();
    let deleted_child = client
        .delete(format!("{base}/api/issues/{child_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(deleted_child.status(), StatusCode::OK);

    let deleted = client
        .delete(format!("{base}/api/issues/{created_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);
    let deleted: serde_json::Value = deleted.json().await.unwrap();
    assert_eq!(deleted["id"], created_id);
    assert!(!copied_asset_path.exists());
    let copied_asset_remains: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM assets WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(&org_id)
    .bind(&copied_attachment.1)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!copied_asset_remains);
    let still_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM issues WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(&org_id)
    .bind(&created_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!still_exists);
    let deleted_activity: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.deleted'",
    )
    .bind(&org_id)
    .bind(&created_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(deleted_activity, 1);
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=$1::uuid")
        .bind(&lifecycle_run_id)
        .execute(&pool)
        .await
        .unwrap();

    let creation_request_id = Uuid::new_v4().to_string();
    let creation_run_id = Uuid::new_v4().to_string();
    insert_issue_creation_run(
        &pool,
        &org_id,
        &agent_id,
        &creation_run_id,
        "running",
        json!({"agentIssueCreationRequestId":creation_request_id}),
    )
    .await;
    sqlx::query(
        "INSERT INTO agent_issue_creation_requests (id, org_id, requested_by_user_id, agent_id, instruction, idempotency_key, run_id, status, started_at) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'Create a follow-up issue', $5, $6::uuid, 'running', now())",
    )
    .bind(&creation_request_id)
    .bind(&org_id)
    .bind(&board_user_id)
    .bind(&agent_id)
    .bind(format!("issue-create-{suffix}"))
    .bind(&creation_run_id)
    .execute(&pool)
    .await
    .unwrap();
    let requested_issue = client
        .post(format!("{base}/api/orgs/{org_id}/issues"))
        .bearer_auth(&agent_token)
        .header("x-rudder-run-id", &creation_run_id)
        .json(&json!({"title":"Agent request creates a todo Issue","status":"backlog"}))
        .send()
        .await
        .unwrap();
    assert_eq!(requested_issue.status(), StatusCode::CREATED);
    let requested_issue: serde_json::Value = requested_issue.json().await.unwrap();
    let requested_issue_id = requested_issue["id"].as_str().unwrap().to_owned();
    assert_eq!(requested_issue["status"], "todo");
    assert_eq!(requested_issue["assigneeAgentId"], agent_id);
    assert_eq!(requested_issue["createdByAgentId"], agent_id);
    assert_eq!(requested_issue["originKind"], "agent_issue_creation");
    assert_eq!(requested_issue["originId"], creation_request_id);
    assert_eq!(requested_issue["originRunId"], creation_run_id);
    let settled_request: (String, Option<String>, Option<String>, bool) = sqlx::query_as(
        "SELECT status, created_issue_id::text, run_id::text, finished_at IS NOT NULL FROM agent_issue_creation_requests WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&creation_request_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        settled_request,
        (
            "succeeded".to_owned(),
            Some(requested_issue_id.clone()),
            Some(creation_run_id.clone()),
            true,
        )
    );
    let notification_counts: (i64, i64) = sqlx::query_as(
        "SELECT count(*), count(outbox.id) FROM activity_log activity LEFT JOIN organization_mutation_outbox outbox ON outbox.org_id=activity.org_id AND outbox.activity_id=activity.id AND outbox.event_type='activity.logged' WHERE activity.org_id=$1::uuid AND activity.action='agent.issue_created_notification' AND activity.entity_id=$2 AND activity.idempotency_key=$3",
    )
    .bind(&org_id)
    .bind(&requested_issue_id)
    .bind(format!("agent-issue-created-notification:{creation_request_id}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(notification_counts, (1, 1));

    let wakeup_count_before_retry: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid AND run_id=$3::uuid",
    )
    .bind(&org_id)
    .bind(&agent_id)
    .bind(&creation_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let retried_issue = client
        .post(format!("{base}/api/orgs/{org_id}/issues"))
        .bearer_auth(&agent_token)
        .header("x-rudder-run-id", &creation_run_id)
        .json(&json!({"title":"Agent request creates a todo Issue","status":"backlog"}))
        .send()
        .await
        .unwrap();
    assert_eq!(retried_issue.status(), StatusCode::CREATED);
    let retried_issue: serde_json::Value = retried_issue.json().await.unwrap();
    assert_eq!(retried_issue["id"], requested_issue_id);
    let issue_origin_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM issues WHERE org_id=$1::uuid AND origin_kind='agent_issue_creation' AND origin_id=$2",
    )
    .bind(&org_id)
    .bind(&creation_request_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(issue_origin_count, 1);
    let notification_counts_after_retry: (i64, i64) = sqlx::query_as(
        "SELECT count(*), count(outbox.id) FROM activity_log activity LEFT JOIN organization_mutation_outbox outbox ON outbox.org_id=activity.org_id AND outbox.activity_id=activity.id AND outbox.event_type='activity.logged' WHERE activity.org_id=$1::uuid AND activity.action='agent.issue_created_notification' AND activity.entity_id=$2 AND activity.idempotency_key=$3",
    )
    .bind(&org_id)
    .bind(&requested_issue_id)
    .bind(format!("agent-issue-created-notification:{creation_request_id}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(notification_counts_after_retry, (1, 1));
    let wakeup_count_after_retry: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid AND run_id=$3::uuid",
    )
    .bind(&org_id)
    .bind(&agent_id)
    .bind(&creation_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(wakeup_count_after_retry, wakeup_count_before_retry);

    let rejected_issue_counter: i32 =
        sqlx::query_scalar("SELECT issue_counter FROM organizations WHERE id=$1::uuid")
            .bind(&org_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let ambiguous_run_id = Uuid::new_v4().to_string();
    insert_issue_creation_run(
        &pool,
        &org_id,
        &agent_id,
        &ambiguous_run_id,
        "running",
        json!({
            "agentIssueCreationRequestId":Uuid::new_v4().to_string(),
            "agentIssueCreationRequest":{"id":Uuid::new_v4().to_string()}
        }),
    )
    .await;
    let ambiguous_create = client
        .post(format!("{base}/api/orgs/{org_id}/issues"))
        .bearer_auth(&agent_token)
        .header("x-rudder-run-id", &ambiguous_run_id)
        .json(&json!({"title":"Ambiguous Agent request must not create"}))
        .send()
        .await
        .unwrap();
    assert_eq!(ambiguous_create.status(), StatusCode::FORBIDDEN);

    let terminal_run_id = Uuid::new_v4().to_string();
    insert_issue_creation_run(
        &pool,
        &org_id,
        &agent_id,
        &terminal_run_id,
        "succeeded",
        json!({"agentIssueCreationRequestId":Uuid::new_v4().to_string()}),
    )
    .await;
    let terminal_create = client
        .post(format!("{base}/api/orgs/{org_id}/issues"))
        .bearer_auth(&agent_token)
        .header("x-rudder-run-id", &terminal_run_id)
        .json(&json!({"title":"Terminal Agent request must not create"}))
        .send()
        .await
        .unwrap();
    assert_eq!(terminal_create.status(), StatusCode::CONFLICT);

    let foreign_org_id: String = sqlx::query_scalar(
        "INSERT INTO organizations (url_key, name, issue_prefix) VALUES ($1, $2, $3) RETURNING id::text",
    )
    .bind(format!("native-issue-core-foreign-{suffix}"))
    .bind(format!("Native Issue Core Foreign {suffix}"))
    .bind(format!("IF{}", suffix[..8].to_ascii_uppercase()))
    .fetch_one(&pool)
    .await
    .unwrap();
    let foreign_issue_id = Uuid::new_v4().to_string();
    let foreign_issue_prefix: String =
        sqlx::query_scalar("SELECT issue_prefix FROM organizations WHERE id=$1::uuid")
            .bind(&foreign_org_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query(
        "INSERT INTO issues (id, org_id, title, status, priority, issue_number, identifier) VALUES ($1::uuid, $2::uuid, 'Foreign organization comment isolation', 'todo', 'medium', 1, $3)",
    )
    .bind(&foreign_issue_id)
    .bind(&foreign_org_id)
    .bind(format!("{foreign_issue_prefix}-1"))
    .execute(&pool)
    .await
    .unwrap();
    let foreign_work_product_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO issue_work_products (id,org_id,issue_id,type,provider,title,status) VALUES ($1::uuid,$2::uuid,$3::uuid,'preview_url','custom','Foreign preview','active')",
    )
    .bind(&foreign_work_product_id)
    .bind(&foreign_org_id)
    .bind(&foreign_issue_id)
    .execute(&pool)
    .await
    .unwrap();
    let agent_foreign_work_product_update = client
        .patch(format!(
            "{base}/api/work-products/{foreign_work_product_id}"
        ))
        .bearer_auth(&agent_token)
        .json(&json!({"title":"Must remain foreign"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        agent_foreign_work_product_update.status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        agent_foreign_work_product_update
            .json::<serde_json::Value>()
            .await
            .unwrap(),
        json!({"error":"Agent key cannot access another organization"})
    );
    let foreign_work_product_title: String = sqlx::query_scalar(
        "SELECT title FROM issue_work_products WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&foreign_org_id)
    .bind(&foreign_work_product_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(foreign_work_product_title, "Foreign preview");
    let foreign_comment_read = client
        .get(format!("{base}/api/issues/{foreign_issue_id}/comments"))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign_comment_read.status(), StatusCode::FORBIDDEN);
    let foreign_issue_short_ref = format!("iss_{}", &foreign_issue_id.replace('-', "")[..8]);
    let agent_foreign_comment_read = client
        .get(format!(
            "{base}/api/issues/{foreign_issue_short_ref}/comments"
        ))
        .bearer_auth(&agent_token)
        .send()
        .await
        .unwrap();
    assert_eq!(agent_foreign_comment_read.status(), StatusCode::NOT_FOUND);
    let messenger_issue_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO issues (id, org_id, title, status, priority, issue_number, identifier) VALUES ($1::uuid, $2::uuid, 'Messenger cleanup target', 'todo', 'medium', 950001, $3)",
    )
    .bind(&messenger_issue_id)
    .bind(&org_id)
    .bind(format!("{prefix}-950001"))
    .execute(&pool)
    .await
    .unwrap();

    let empty_group_id = Uuid::new_v4().to_string();
    let mixed_group_id = Uuid::new_v4().to_string();
    let foreign_group_id = Uuid::new_v4().to_string();
    for (group_id, group_org, group_user_id, name) in [
        (&empty_group_id, &org_id, &board_user_id, "Issue entry only"),
        (
            &mixed_group_id,
            &org_id,
            &second_board_user_id,
            "Issue and other entry",
        ),
        (
            &foreign_group_id,
            &foreign_org_id,
            &board_user_id,
            "Foreign org issue entry",
        ),
    ] {
        sqlx::query(
            "INSERT INTO messenger_custom_groups (id, org_id, user_id, name) VALUES ($1::uuid, $2::uuid, $3, $4)",
        )
        .bind(group_id)
        .bind(group_org)
        .bind(group_user_id)
        .bind(format!("{name} {suffix}"))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO messenger_custom_group_entries (org_id, user_id, group_id, thread_key) VALUES ($1::uuid, $2, $3::uuid, $4)",
        )
        .bind(group_org)
        .bind(group_user_id)
        .bind(group_id)
        .bind(format!("issue:{messenger_issue_id}"))
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO messenger_custom_group_entries (org_id, user_id, group_id, thread_key) VALUES ($1::uuid, $2, $3::uuid, $4)",
    )
    .bind(&org_id)
    .bind(&second_board_user_id)
    .bind(&mixed_group_id)
    .bind(format!("issue:preserved-item-{suffix}"))
    .execute(&pool)
    .await
    .unwrap();

    let messenger_delete = client
        .delete(format!("{base}/api/issues/{messenger_issue_id}"))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(messenger_delete.status(), StatusCode::OK);
    let local_target_entries: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM messenger_custom_group_entries WHERE org_id=$1::uuid AND thread_key=$2",
    )
    .bind(&org_id)
    .bind(format!("issue:{messenger_issue_id}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(local_target_entries, 0);
    let foreign_target_entries: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM messenger_custom_group_entries WHERE org_id=$1::uuid AND thread_key=$2",
    )
    .bind(&foreign_org_id)
    .bind(format!("issue:{messenger_issue_id}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(foreign_target_entries, 1);
    let empty_group_remains: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM messenger_custom_groups WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(&org_id)
    .bind(&empty_group_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(!empty_group_remains);
    let mixed_group_preserved: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM messenger_custom_groups WHERE org_id=$1::uuid AND user_id=$2 AND id=$3::uuid)",
    )
    .bind(&org_id)
    .bind(&second_board_user_id)
    .bind(&mixed_group_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(mixed_group_preserved);
    let other_item_preserved: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM messenger_custom_group_entries WHERE org_id=$1::uuid AND user_id=$2 AND group_id=$3::uuid AND thread_key=$4)",
    )
    .bind(&org_id)
    .bind(&second_board_user_id)
    .bind(&mixed_group_id)
    .bind(format!("issue:preserved-item-{suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(other_item_preserved);
    let foreign_group_preserved: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM messenger_custom_groups WHERE org_id=$1::uuid AND id=$2::uuid)",
    )
    .bind(&foreign_org_id)
    .bind(&foreign_group_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(foreign_group_preserved);

    let foreign_asset_id = Uuid::new_v4().to_string();
    let foreign_asset_object_key = format!("{foreign_org_id}/uploads/private-image.png");
    let foreign_asset_bytes = b"private foreign organization image";
    let foreign_asset_path = asset_storage_directory
        .path()
        .join(&foreign_asset_object_key);
    std::fs::create_dir_all(foreign_asset_path.parent().unwrap()).unwrap();
    std::fs::write(&foreign_asset_path, foreign_asset_bytes).unwrap();
    sqlx::query(
        "INSERT INTO assets (id,org_id,provider,object_key,content_type,byte_size,sha256,original_filename) VALUES ($1::uuid,$2::uuid,'local_disk',$3,'image/png',$4,$5,'private image.png')",
    )
    .bind(&foreign_asset_id)
    .bind(&foreign_org_id)
    .bind(&foreign_asset_object_key)
    .bind(foreign_asset_bytes.len() as i32)
    .bind(format!("{:x}", Sha256::digest(foreign_asset_bytes)))
    .execute(&pool)
    .await
    .unwrap();
    let organization_issue_object_root =
        asset_storage_directory.path().join(&org_id).join("issues");
    let issue_object_count_before_foreign_asset_rejection =
        local_storage_file_count(&organization_issue_object_root);
    let issue_counter_before_foreign_asset_rejection: i32 =
        sqlx::query_scalar("SELECT issue_counter FROM organizations WHERE id=$1::uuid")
            .bind(&org_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let foreign_asset_issue = client
        .post(format!("{base}/api/orgs/{org_id}/issues"))
        .bearer_auth(&board_token)
        .json(&json!({
            "title":"Foreign organization description asset must not copy",
            "description":format!("![First](/api/assets/{source_asset_id}/content) ![Private](/api/assets/{foreign_asset_id}/content)"),
            "status":"todo"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        foreign_asset_issue.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let foreign_asset_issue_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM issues WHERE org_id=$1::uuid AND title='Foreign organization description asset must not copy'",
    )
    .bind(&org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let issue_counter_after_foreign_asset_rejection: i32 =
        sqlx::query_scalar("SELECT issue_counter FROM organizations WHERE id=$1::uuid")
            .bind(&org_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(foreign_asset_issue_count, 0);
    assert_eq!(
        issue_counter_after_foreign_asset_rejection,
        issue_counter_before_foreign_asset_rejection
    );
    assert!(foreign_asset_path.exists());
    assert_eq!(
        local_storage_file_count(&organization_issue_object_root),
        issue_object_count_before_foreign_asset_rejection,
        "a valid asset staged before a later foreign-org asset rejection must be removed"
    );
    let copied_asset_count_after_foreign_rejection: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM assets WHERE org_id=$1::uuid AND object_key LIKE $2",
    )
    .bind(&org_id)
    .bind(format!("{org_id}/issues/%"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(copied_asset_count_after_foreign_rejection, 0);

    let foreign_agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, $2, 'general', 'idle') RETURNING id::text",
    )
    .bind(&foreign_org_id)
    .bind(format!("Foreign Issue Core Agent {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let foreign_agent_token = format!("pcp_native_issue_attachment_foreign_{suffix}");
    let foreign_agent_key_id: String = sqlx::query_scalar(
        "INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash) VALUES ($1::uuid, $2::uuid, 'foreign attachment HTTP test', $3) RETURNING id::text",
    )
    .bind(&foreign_agent_id)
    .bind(&foreign_org_id)
    .bind(crate::native_bearer_auth::hash_token(&foreign_agent_token))
    .fetch_one(&pool)
    .await
    .unwrap();

    let attachments_node_requests_before = node_requests.load(Ordering::SeqCst);
    let boundary = format!("----RudderIssueAttachment{suffix}");
    let upload_bytes = b"Issue attachment bytes";
    let multipart_body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"attachment-note.txt\"\r\nContent-Type: text/plain\r\n\r\n{}\r\n--{boundary}--\r\n",
        String::from_utf8_lossy(upload_bytes)
    );
    let uploaded = client
        .post(format!(
            "{base}/api/orgs/{org_id}/issues/{issue_id}/attachments"
        ))
        .bearer_auth(&board_token)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(multipart_body)
        .send()
        .await
        .unwrap();
    assert_eq!(uploaded.status(), StatusCode::CREATED);
    let uploaded: serde_json::Value = uploaded.json().await.unwrap();
    let uploaded_attachment_id = uploaded["id"].as_str().unwrap().to_owned();
    let uploaded_asset_id = uploaded["assetId"].as_str().unwrap().to_owned();
    let uploaded_object_key = uploaded["objectKey"].as_str().unwrap().to_owned();
    assert_eq!(uploaded["issueId"], issue_id);
    assert_eq!(uploaded["usage"], "issue");
    assert_eq!(uploaded["contentType"], "text/plain");
    assert_eq!(uploaded["byteSize"], upload_bytes.len());
    assert_eq!(uploaded["originalFilename"], "attachment-note.txt");
    assert_eq!(
        uploaded["contentPath"],
        format!("/api/attachments/{uploaded_attachment_id}/content")
    );
    let uploaded_object_path = asset_storage_directory.path().join(&uploaded_object_key);
    assert_eq!(std::fs::read(&uploaded_object_path).unwrap(), upload_bytes);

    let attachment_metadata = client
        .get(format!("{base}/api/issues/{issue_id}/attachments"))
        .bearer_auth(&agent_token)
        .send()
        .await
        .unwrap();
    assert_eq!(attachment_metadata.status(), StatusCode::OK);
    let attachment_metadata: serde_json::Value = attachment_metadata.json().await.unwrap();
    assert_eq!(attachment_metadata.as_array().unwrap().len(), 1);
    assert_eq!(attachment_metadata[0]["id"], uploaded_attachment_id);

    let uploaded_content = client
        .get(format!(
            "{base}{}",
            uploaded["contentPath"].as_str().unwrap()
        ))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(uploaded_content.status(), StatusCode::OK);
    assert_eq!(
        uploaded_content.headers()[reqwest::header::CONTENT_TYPE],
        "text/plain"
    );
    assert_eq!(
        uploaded_content.headers()[reqwest::header::CACHE_CONTROL],
        "private, max-age=60"
    );
    assert_eq!(
        uploaded_content.headers()[reqwest::header::CONTENT_DISPOSITION],
        "inline; filename=\"attachment-note.txt\""
    );
    assert_eq!(
        uploaded_content.bytes().await.unwrap().as_ref(),
        upload_bytes
    );
    let uploaded_head = client
        .head(format!(
            "{base}/api/attachments/{uploaded_attachment_id}/content"
        ))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(uploaded_head.status(), StatusCode::OK);
    assert_eq!(
        uploaded_head
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok()),
        Some(upload_bytes.len() as u64)
    );
    assert!(uploaded_head.bytes().await.unwrap().is_empty());
    let foreign_attachment_content = client
        .get(format!(
            "{base}/api/attachments/{uploaded_attachment_id}/content"
        ))
        .bearer_auth(&foreign_agent_token)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign_attachment_content.status(), StatusCode::FORBIDDEN);
    let foreign_attachment_delete = client
        .delete(format!("{base}/api/attachments/{uploaded_attachment_id}"))
        .bearer_auth(&foreign_agent_token)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign_attachment_delete.status(), StatusCode::FORBIDDEN);
    assert!(uploaded_object_path.exists());

    let object_count_before_rejected_uploads =
        local_storage_file_count(&organization_issue_object_root);
    let unsupported_boundary = format!("----RudderIssueAttachmentUnsupported{suffix}");
    let unsupported_body = format!(
        "--{unsupported_boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"unsupported.bin\"\r\nContent-Type: application/x-rudder-test\r\n\r\nunsupported bytes\r\n--{unsupported_boundary}--\r\n"
    );
    let unsupported_upload = client
        .post(format!(
            "{base}/api/orgs/{org_id}/issues/{issue_id}/attachments"
        ))
        .bearer_auth(&board_token)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={unsupported_boundary}"),
        )
        .body(unsupported_body)
        .send()
        .await
        .unwrap();
    assert_eq!(
        unsupported_upload.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let attachment_max_bytes = env::var("RUDDER_ATTACHMENT_MAX_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(10 * 1024 * 1024);
    let oversized_boundary = format!("----RudderIssueAttachmentOversized{suffix}");
    let mut oversized_body = format!(
        "--{oversized_boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"oversized.txt\"\r\nContent-Type: text/plain\r\n\r\n"
    )
    .into_bytes();
    oversized_body.extend(std::iter::repeat_n(b'x', attachment_max_bytes + 1));
    oversized_body.extend_from_slice(format!("\r\n--{oversized_boundary}--\r\n").as_bytes());
    let oversized_upload = client
        .post(format!(
            "{base}/api/orgs/{org_id}/issues/{issue_id}/attachments"
        ))
        .bearer_auth(&board_token)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={oversized_boundary}"),
        )
        .body(oversized_body)
        .send()
        .await
        .unwrap();
    assert_eq!(oversized_upload.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        local_storage_file_count(&organization_issue_object_root),
        object_count_before_rejected_uploads,
        "unsupported and oversized uploads must not create storage objects"
    );

    let workspace_root = std::path::PathBuf::from(
        super::super::agent_core::ensure_organization_workspace_root(&org_id).unwrap(),
    );
    let oversized_workspace_relative_path = format!("attachment-fixtures/oversized-{suffix}.txt");
    let oversized_workspace_file = workspace_root.join(&oversized_workspace_relative_path);
    std::fs::create_dir_all(oversized_workspace_file.parent().unwrap()).unwrap();
    std::fs::write(
        &oversized_workspace_file,
        vec![b'x'; attachment_max_bytes + 1],
    )
    .unwrap();
    let oversized_import_state = sqlx::query_as::<_, (i64, i64, i64)>(
        "SELECT (SELECT count(*) FROM assets WHERE org_id=$1::uuid AND original_filename=$3), (SELECT count(*) FROM issue_attachments WHERE org_id=$1::uuid AND issue_id=$2::uuid), (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.attachment_added')",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .bind(format!("oversized-{suffix}.txt"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let objects_before_oversized_import = local_storage_file_count(&organization_issue_object_root);
    let oversized_workspace_import = client
        .post(format!(
            "{base}/api/orgs/{org_id}/issues/{issue_id}/attachments/workspace-file"
        ))
        .bearer_auth(&board_token)
        .json(&json!({"path":oversized_workspace_relative_path}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        oversized_workspace_import.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        oversized_workspace_import
            .json::<serde_json::Value>()
            .await
            .unwrap(),
        json!({"error":format!("Attachment exceeds {} bytes", attachment_max_bytes)})
    );
    let oversized_import_state_after = sqlx::query_as::<_, (i64, i64, i64)>(
        "SELECT (SELECT count(*) FROM assets WHERE org_id=$1::uuid AND original_filename=$3), (SELECT count(*) FROM issue_attachments WHERE org_id=$1::uuid AND issue_id=$2::uuid), (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.attachment_added')",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .bind(format!("oversized-{suffix}.txt"))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(oversized_import_state_after, oversized_import_state);
    assert_eq!(
        local_storage_file_count(&organization_issue_object_root),
        objects_before_oversized_import
    );

    let workspace_relative_path = format!("attachment-fixtures/{suffix}.txt");
    let workspace_file_path = workspace_root.join(&workspace_relative_path);
    std::fs::create_dir_all(workspace_file_path.parent().unwrap()).unwrap();
    let workspace_bytes = b"workspace Library attachment bytes";
    std::fs::write(&workspace_file_path, workspace_bytes).unwrap();
    let workspace_import = client
        .post(format!(
            "{base}/api/orgs/{org_id}/issues/{issue_id}/attachments/workspace-file"
        ))
        .bearer_auth(&board_token)
        .json(&json!({"path":workspace_relative_path}))
        .send()
        .await
        .unwrap();
    assert_eq!(workspace_import.status(), StatusCode::CREATED);
    let workspace_import: serde_json::Value = workspace_import.json().await.unwrap();
    let workspace_attachment_id = workspace_import["id"].as_str().unwrap().to_owned();
    let workspace_asset_id = workspace_import["assetId"].as_str().unwrap().to_owned();
    let workspace_object_key = workspace_import["objectKey"].as_str().unwrap().to_owned();
    assert_eq!(
        workspace_import["originalFilename"],
        format!("{}.txt", suffix)
    );
    assert_eq!(workspace_import["contentType"], "text/plain");
    assert_eq!(
        std::fs::read(asset_storage_directory.path().join(&workspace_object_key)).unwrap(),
        workspace_bytes
    );
    let workspace_content = client
        .get(format!(
            "{base}{}",
            workspace_import["contentPath"].as_str().unwrap()
        ))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(workspace_content.status(), StatusCode::OK);
    assert_eq!(
        workspace_content.bytes().await.unwrap().as_ref(),
        workspace_bytes
    );
    let both_attachments = client
        .get(format!("{base}/api/issues/{issue_id}/attachments"))
        .bearer_auth(&agent_token)
        .send()
        .await
        .unwrap();
    assert_eq!(both_attachments.status(), StatusCode::OK);
    let both_attachments: serde_json::Value = both_attachments.json().await.unwrap();
    assert_eq!(both_attachments.as_array().unwrap().len(), 2);
    assert!(
        both_attachments
            .as_array()
            .unwrap()
            .iter()
            .any(|attachment| attachment["id"] == uploaded_attachment_id)
    );
    assert!(
        both_attachments
            .as_array()
            .unwrap()
            .iter()
            .any(|attachment| attachment["id"] == workspace_attachment_id)
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let object_directory = uploaded_object_path.parent().unwrap();
        let original_permissions = std::fs::metadata(object_directory).unwrap().permissions();
        let mut read_only_permissions = original_permissions.clone();
        read_only_permissions.set_mode(original_permissions.mode() & !0o222);
        std::fs::set_permissions(object_directory, read_only_permissions).unwrap();
        let object_count_before_storage_failure =
            local_storage_file_count(&organization_issue_object_root);
        let activity_count_before_storage_failure: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.attachment_added'",
        )
        .bind(&org_id)
        .bind(&issue_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let storage_failure_boundary = format!("----RudderIssueAttachmentStorageFailure{suffix}");
        let storage_failure_body = format!(
            "--{storage_failure_boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"attachment-storage-failure.txt\"\r\nContent-Type: text/plain\r\n\r\nforce attachment storage failure\r\n--{storage_failure_boundary}--\r\n"
        );
        let storage_failure = client
            .post(format!(
                "{base}/api/orgs/{org_id}/issues/{issue_id}/attachments"
            ))
            .bearer_auth(&board_token)
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={storage_failure_boundary}"),
            )
            .body(storage_failure_body)
            .send()
            .await;
        std::fs::set_permissions(object_directory, original_permissions).unwrap();
        let storage_failure = storage_failure.unwrap();
        assert_eq!(storage_failure.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let storage_failure_rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM assets WHERE org_id=$1::uuid AND original_filename='attachment-storage-failure.txt'",
        )
        .bind(&org_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let activity_count_after_storage_failure: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.attachment_added'",
        )
        .bind(&org_id)
        .bind(&issue_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(storage_failure_rows, 0);
        assert_eq!(
            activity_count_after_storage_failure,
            activity_count_before_storage_failure
        );
        assert_eq!(
            local_storage_file_count(&organization_issue_object_root),
            object_count_before_storage_failure,
            "a storage failure must not leave a partial object"
        );
    }

    let escaped_workspace_import = client
        .post(format!(
            "{base}/api/orgs/{org_id}/issues/{issue_id}/attachments/workspace-file"
        ))
        .bearer_auth(&board_token)
        .json(&json!({"path":"../outside.txt"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        escaped_workspace_import.status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    #[cfg(unix)]
    {
        let protected_file = workspace_root.join("agents").join("fixture");
        std::fs::create_dir_all(&protected_file).unwrap();
        let protected_file = protected_file.join("private.txt");
        std::fs::write(&protected_file, b"protected workspace content").unwrap();
        let public_alias = workspace_root
            .join("attachment-fixtures")
            .join("protected-alias.txt");
        std::os::unix::fs::symlink(&protected_file, &public_alias).unwrap();
        let alias_import = client
            .post(format!(
                "{base}/api/orgs/{org_id}/issues/{issue_id}/attachments/workspace-file"
            ))
            .bearer_auth(&board_token)
            .json(&json!({"path":"attachment-fixtures/protected-alias.txt"}))
            .send()
            .await
            .unwrap();
        assert_eq!(alias_import.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    sqlx::query(
        "ALTER TABLE assets ADD CONSTRAINT issue_attachment_upload_rollback_test CHECK (original_filename IS DISTINCT FROM 'attachment-database-failure.txt')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let object_count_before_failed_attachment =
        local_storage_file_count(&organization_issue_object_root);
    let attachment_added_activity_before_failure: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.attachment_added'",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let failure_boundary = format!("----RudderIssueAttachmentFailure{suffix}");
    let failed_upload_body = format!(
        "--{failure_boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"attachment-database-failure.txt\"\r\nContent-Type: text/plain\r\n\r\nforce attachment SQL rollback\r\n--{failure_boundary}--\r\n"
    );
    let failed_upload = client
        .post(format!(
            "{base}/api/orgs/{org_id}/issues/{issue_id}/attachments"
        ))
        .bearer_auth(&board_token)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={failure_boundary}"),
        )
        .body(failed_upload_body)
        .send()
        .await
        .unwrap();
    assert_eq!(failed_upload.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let failed_attachment_rows: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM assets WHERE org_id=$1::uuid AND original_filename='attachment-database-failure.txt'), (SELECT count(*) FROM issue_attachments WHERE org_id=$1::uuid AND issue_id=$2::uuid AND asset_id IN (SELECT id FROM assets WHERE original_filename='attachment-database-failure.txt'))",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let attachment_added_activity_after_failure: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.attachment_added'",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(failed_attachment_rows, (0, 0));
    assert_eq!(
        attachment_added_activity_after_failure,
        attachment_added_activity_before_failure
    );
    assert_eq!(
        local_storage_file_count(&organization_issue_object_root),
        object_count_before_failed_attachment,
        "a failed attachment transaction must remove its staged object"
    );
    sqlx::query("ALTER TABLE assets DROP CONSTRAINT issue_attachment_upload_rollback_test")
        .execute(&pool)
        .await
        .unwrap();

    let foreign_org_upload = client
        .post(format!(
            "{base}/api/orgs/{foreign_org_id}/issues/{foreign_issue_id}/attachments"
        ))
        .bearer_auth(&agent_token)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign_org_upload.status(), StatusCode::FORBIDDEN);
    let imported_activity_workspace_path: Option<String> = sqlx::query_scalar(
        "SELECT details->>'workspacePath' FROM activity_log WHERE org_id=$1::uuid AND action='issue.attachment_added' AND entity_id=$2 AND details->>'attachmentId'=$3",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .bind(&workspace_attachment_id)
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert_eq!(
        imported_activity_workspace_path.as_deref(),
        Some(workspace_relative_path.as_str())
    );

    for attachment_id in [&uploaded_attachment_id, &workspace_attachment_id] {
        let removed = client
            .delete(format!("{base}/api/attachments/{attachment_id}"))
            .bearer_auth(&board_token)
            .send()
            .await
            .unwrap();
        assert_eq!(removed.status(), StatusCode::OK);
        assert_eq!(
            removed.json::<serde_json::Value>().await.unwrap(),
            json!({"ok":true})
        );
    }
    let remaining_issue_attachments: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM issue_attachments WHERE org_id=$1::uuid AND issue_id=$2::uuid AND id::text=ANY($3::text[])",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .bind(vec![uploaded_attachment_id.clone(), workspace_attachment_id.clone()])
    .fetch_one(&pool)
    .await
    .unwrap();
    let remaining_assets: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM assets WHERE org_id=$1::uuid AND id::text=ANY($2::text[])",
    )
    .bind(&org_id)
    .bind(vec![uploaded_asset_id, workspace_asset_id])
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((remaining_issue_attachments, remaining_assets), (0, 0));
    assert!(!uploaded_object_path.exists());
    assert!(
        !asset_storage_directory
            .path()
            .join(&workspace_object_key)
            .exists()
    );
    let deleted_attachment_content = client
        .get(format!(
            "{base}/api/attachments/{uploaded_attachment_id}/content"
        ))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted_attachment_content.status(), StatusCode::NOT_FOUND);
    let no_issue_attachments = client
        .get(format!("{base}/api/issues/{issue_id}/attachments"))
        .bearer_auth(&agent_token)
        .send()
        .await
        .unwrap();
    assert_eq!(no_issue_attachments.status(), StatusCode::OK);
    assert_eq!(
        no_issue_attachments
            .json::<serde_json::Value>()
            .await
            .unwrap(),
        json!([])
    );
    std::fs::remove_dir_all(workspace_root.join("attachment-fixtures")).unwrap();
    #[cfg(unix)]
    std::fs::remove_dir_all(workspace_root.join("agents/fixture")).unwrap();
    let attachment_activity_counts: (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE action='issue.attachment_added'), count(*) FILTER (WHERE action='issue.attachment_removed') FROM activity_log WHERE org_id=$1::uuid AND entity_type='issue' AND entity_id=$2 AND details->>'attachmentId'=ANY($3::text[])",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .bind(vec![uploaded_attachment_id, workspace_attachment_id])
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(attachment_activity_counts, (2, 2));
    assert_eq!(
        node_requests.load(Ordering::SeqCst),
        attachments_node_requests_before,
        "the Rust attachment workflow must not call the legacy Node routes"
    );

    let foreign_run_id = Uuid::new_v4().to_string();
    insert_issue_creation_run(
        &pool,
        &foreign_org_id,
        &foreign_agent_id,
        &foreign_run_id,
        "running",
        json!({"agentIssueCreationRequestId":Uuid::new_v4().to_string()}),
    )
    .await;
    let cross_scope_create = client
        .post(format!("{base}/api/orgs/{org_id}/issues"))
        .bearer_auth(&agent_token)
        .header("x-rudder-run-id", &foreign_run_id)
        .json(&json!({"title":"Cross organization Agent request must not create"}))
        .send()
        .await
        .unwrap();
    assert_eq!(cross_scope_create.status(), StatusCode::FORBIDDEN);
    let rejected_issue_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM issues WHERE org_id=$1::uuid AND title IN ('Ambiguous Agent request must not create','Terminal Agent request must not create','Cross organization Agent request must not create')",
    )
    .bind(&org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let issue_counter_after_rejections: i32 =
        sqlx::query_scalar("SELECT issue_counter FROM organizations WHERE id=$1::uuid")
            .bind(&org_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(rejected_issue_count, 0);
    assert_eq!(issue_counter_after_rejections, rejected_issue_counter);

    let foreign_scope_before: (String, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT status, (SELECT count(*) FROM automation_runs WHERE org_id=$1::uuid), (SELECT count(*) FROM chat_conversations WHERE org_id=$1::uuid), (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid), (SELECT count(*) FROM product_analytics_events WHERE org_id=$1::uuid) FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&foreign_org_id)
    .bind(&foreign_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let done_automation_id = Uuid::new_v4().to_string();
    let done_run_id = Uuid::new_v4().to_string();
    let done_issue_id = Uuid::new_v4().to_string();
    let done_automation_title = format!("Done Automation {suffix}");
    let done_identifier = format!("{prefix}-920001");
    let done_fixture = AutomationIssueFixture {
        org_id: &org_id,
        agent_id: &agent_id,
        automation_id: &done_automation_id,
        run_id: &done_run_id,
        issue_id: &done_issue_id,
        title: &done_automation_title,
        output_mode: "chat_output",
        issue_number: 920001,
        identifier: &done_identifier,
    };
    insert_automation_issue_fixture(&pool, &done_fixture).await;
    let done_patch = client
        .patch(format!("{base}/api/issues/{done_issue_id}"))
        .bearer_auth(&board_token)
        .json(&json!({"status":"done"}))
        .send()
        .await
        .unwrap();
    assert_eq!(done_patch.status(), StatusCode::OK);
    let done_patch: serde_json::Value = done_patch.json().await.unwrap();
    assert_eq!(done_patch["status"], "done");
    let done_run: (String, Option<String>, Option<String>, Option<String>, bool) =
        sqlx::query_as(
            "SELECT status, failure_reason, linked_chat_conversation_id::text, terminal_chat_message_id::text, completed_at IS NOT NULL FROM automation_runs WHERE org_id=$1::uuid AND id=$2::uuid",
        )
        .bind(&org_id)
        .bind(&done_run_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(done_run, ("completed".to_owned(), None, None, None, true));
    let done_chat_message_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND (structured_payload->>'runId'=$2 OR structured_payload#>>'{automationChatRun,runId}'=$2)",
    )
    .bind(&org_id)
    .bind(&done_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(done_chat_message_count, 0);

    let blocked_automation_id = Uuid::new_v4().to_string();
    let blocked_run_id = Uuid::new_v4().to_string();
    let blocked_issue_id = Uuid::new_v4().to_string();
    let cancelled_automation_id = Uuid::new_v4().to_string();
    let cancelled_run_id = Uuid::new_v4().to_string();
    let cancelled_issue_id = Uuid::new_v4().to_string();
    for (status, automation_id, run_id, issue_id, issue_number) in [
        (
            "blocked",
            blocked_automation_id.as_str(),
            blocked_run_id.as_str(),
            blocked_issue_id.as_str(),
            920002,
        ),
        (
            "cancelled",
            cancelled_automation_id.as_str(),
            cancelled_run_id.as_str(),
            cancelled_issue_id.as_str(),
            920003,
        ),
    ] {
        let title = format!("{} Automation {suffix}", status.to_ascii_uppercase());
        let identifier = format!("{prefix}-{issue_number}");
        let fixture = AutomationIssueFixture {
            org_id: &org_id,
            agent_id: &agent_id,
            automation_id,
            run_id,
            issue_id,
            title: &title,
            output_mode: "chat_output",
            issue_number,
            identifier: &identifier,
        };
        insert_automation_issue_fixture(&pool, &fixture).await;
        let patch = client
            .patch(format!("{base}/api/issues/{issue_id}"))
            .bearer_auth(&board_token)
            .json(&json!({"status":status}))
            .send()
            .await
            .unwrap();
        assert_eq!(patch.status(), StatusCode::OK);
        let patch: serde_json::Value = patch.json().await.unwrap();
        assert_eq!(patch["status"], status);
        let conversation_id = assert_automation_failure_chat(&pool, &fixture, status).await;
        let failure_event_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=$2::uuid AND structured_payload->>'eventType'='automation_run_failed' AND structured_payload->>'runId'=$3",
        )
        .bind(&org_id)
        .bind(&conversation_id)
        .bind(run_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(failure_event_count, 1);
    }
    let foreign_scope_after: (String, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT status, (SELECT count(*) FROM automation_runs WHERE org_id=$1::uuid), (SELECT count(*) FROM chat_conversations WHERE org_id=$1::uuid), (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid), (SELECT count(*) FROM product_analytics_events WHERE org_id=$1::uuid) FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&foreign_org_id)
    .bind(&foreign_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(foreign_scope_after, foreign_scope_before);

    sqlx::query("UPDATE issues SET status='done' WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&org_id)
        .bind(&issue_id)
        .execute(&pool)
        .await
        .unwrap();
    let reopen_agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, $2, 'general', 'idle') RETURNING id::text",
    )
    .bind(&org_id)
    .bind(format!("Reopen Wake Agent {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let reopen_agent_prior_ownership: (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid),
           (SELECT count(*) FROM agent_task_sessions WHERE agent_id=$2::uuid),
           (SELECT count(*) FROM goal_owner_assignments WHERE org_id=$1::uuid AND agent_id=$2::uuid),
           (SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid)",
    )
    .bind(&org_id)
    .bind(&reopen_agent_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(reopen_agent_prior_ownership, (0, 0, 0, 0));
    sqlx::query(
        "INSERT INTO issues (id, org_id, title, status, priority, issue_number, identifier, assignee_agent_id) VALUES ($1::uuid, $2::uuid, 'Reopen wake admission through Rust', 'todo', 'medium', 900006, $3, $4::uuid)",
    )
    .bind(&reopen_wakeup_issue_id)
    .bind(&org_id)
    .bind(format!("{prefix}-900006"))
    .bind(&reopen_agent_id)
    .execute(&pool)
    .await
    .unwrap();
    let reopen_interrupt_run_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO heartbeat_runs (id, org_id, agent_id, status, started_at, invocation_source, execution_authority, context_snapshot) VALUES ($1::uuid, $2::uuid, $3::uuid, 'running', now(), 'manual', 'legacy_ts', $4::jsonb)",
    )
    .bind(&reopen_interrupt_run_id)
    .bind(&org_id)
    .bind(&reopen_agent_id)
    .bind(json!({"issueId":reopen_wakeup_issue_id}).to_string())
    .execute(&pool)
    .await
    .unwrap();
    let unrelated_active_reopen_agent_runs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid AND agent_id=$2::uuid AND status='running' AND id<>$3::uuid",
    )
    .bind(&org_id)
    .bind(&reopen_agent_id)
    .bind(&reopen_interrupt_run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(unrelated_active_reopen_agent_runs, 0);
    sqlx::query(
        "UPDATE issues SET status='done',execution_run_id=$3::uuid WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&reopen_wakeup_issue_id)
    .bind(&reopen_interrupt_run_id)
    .execute(&pool)
    .await
    .unwrap();
    let comments_before_reopen_wakeup: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&reopen_wakeup_issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let comments_before_reopen_failure: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let wake_trigger_suffix = Uuid::new_v4().simple().to_string();
    let wake_trigger_function = format!("test_reject_issue_reopen_wakeup_{wake_trigger_suffix}");
    let wake_trigger_name = format!("test_reject_issue_reopen_wakeup_{wake_trigger_suffix}");
    sqlx::query(&format!(
        "CREATE FUNCTION {wake_trigger_function}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.agent_id='{reopen_agent_id}'::uuid
              AND NEW.payload->>'issueId'='{reopen_wakeup_issue_id}' THEN
             RAISE EXCEPTION 'forced Issue reopen wake admission failure (attempted reason=%)', NEW.reason;
           END IF;
           RETURN NEW;
         END; $$"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(&format!(
        "CREATE TRIGGER {wake_trigger_name} BEFORE INSERT ON agent_wakeup_requests
         FOR EACH ROW EXECUTE FUNCTION {wake_trigger_function}()"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let failed_reopen_wakeup = client
        .post(format!(
            "{base}/api/issues/{reopen_wakeup_issue_id}/comments"
        ))
        .bearer_auth(&board_token)
        .json(&json!({
            "body":"This wake failure must roll back the reopen and interruption.",
            "reopen":true,
            "interrupt":true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        failed_reopen_wakeup.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    sqlx::query(&format!(
        "DROP TRIGGER {wake_trigger_name} ON agent_wakeup_requests"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(&format!("DROP FUNCTION {wake_trigger_function}()"))
        .execute(&pool)
        .await
        .unwrap();
    let failed_reopen_wakeup_state: (String, Option<String>, Option<String>, i64, i64, i64) =
        sqlx::query_as(
            "SELECT i.status,i.execution_cancellation_at::text,r.error_code,
               (SELECT count(*) FROM issue_comments c WHERE c.org_id=i.org_id AND c.issue_id=i.id),
               (SELECT count(*) FROM activity_log a WHERE a.org_id=i.org_id AND a.entity_id=r.id::text AND a.action='heartbeat.cancelled' AND a.details->>'source'='issue_comment_interrupt'),
               (SELECT count(*) FROM agent_wakeup_requests w WHERE w.org_id=i.org_id AND w.agent_id=i.assignee_agent_id AND w.payload->>'issueId'=i.id::text)
             FROM issues i JOIN heartbeat_runs r ON r.org_id=i.org_id AND r.id=$3::uuid
             WHERE i.org_id=$1::uuid AND i.id=$2::uuid",
        )
        .bind(&org_id)
        .bind(&reopen_wakeup_issue_id)
        .bind(&reopen_interrupt_run_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        failed_reopen_wakeup_state,
        (
            "done".to_owned(),
            None,
            None,
            comments_before_reopen_wakeup,
            0,
            0,
        )
    );
    let interrupt_trigger_suffix = Uuid::new_v4().simple().to_string();
    let interrupt_trigger_function = format!("test_reject_issue_reopen_{interrupt_trigger_suffix}");
    let interrupt_trigger_name = format!("test_reject_issue_reopen_{interrupt_trigger_suffix}");
    sqlx::query(&format!(
        "CREATE FUNCTION {interrupt_trigger_function}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.action='issue.updated' AND NEW.entity_id='{issue_id}'
              AND NEW.details->>'reopened'='true' THEN
             RAISE EXCEPTION 'forced Issue reopen activity failure';
           END IF;
           RETURN NEW;
         END; $$"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(&format!(
        "CREATE TRIGGER {interrupt_trigger_name} BEFORE INSERT ON activity_log
         FOR EACH ROW EXECUTE FUNCTION {interrupt_trigger_function}()"
    ))
    .execute(&pool)
    .await
    .unwrap();
    let failed_reopen_interrupt = client
        .post(format!("{base}/api/issues/{issue_id}/comments"))
        .bearer_auth(&board_token)
        .json(&json!({
            "body":"This reopen and interruption must roll back together.",
            "reopen":true,
            "interrupt":true
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        failed_reopen_interrupt.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    sqlx::query(&format!(
        "DROP TRIGGER {interrupt_trigger_name} ON activity_log"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(&format!("DROP FUNCTION {interrupt_trigger_function}()"))
        .execute(&pool)
        .await
        .unwrap();
    let failed_reopen_state: (String, Option<String>, Option<String>, i64, i64) = sqlx::query_as(
        "SELECT i.status,i.execution_cancellation_at::text,r.error_code,
           (SELECT count(*) FROM issue_comments c WHERE c.org_id=i.org_id AND c.issue_id=i.id),
           (SELECT count(*) FROM activity_log a WHERE a.org_id=i.org_id AND a.entity_id=r.id::text AND a.action='heartbeat.cancelled' AND a.details->>'source'='issue_comment_interrupt')
         FROM issues i JOIN heartbeat_runs r ON r.org_id=i.org_id AND r.id=$3::uuid
         WHERE i.org_id=$1::uuid AND i.id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        failed_reopen_state,
        (
            "done".to_owned(),
            None,
            None,
            comments_before_reopen_failure,
            0,
        )
    );
    let steered_comment = client
        .post(format!("{base}/api/issues/{issue_id}/comments"))
        .bearer_auth(&board_token)
        .json(&json!({
            "body":"Please continue with this feedback.",
            "reopen":true,
            "steer":{"expectedRunId":run_id}
        }))
        .send()
        .await
        .unwrap();
    let steered_status = steered_comment.status();
    let steered_comment: serde_json::Value = steered_comment.json().await.unwrap();
    assert_eq!(steered_status, StatusCode::CREATED, "{steered_comment}");
    assert!(
        steered_comment["body"]
            .as_str()
            .unwrap()
            .contains("Please continue with this feedback.")
    );
    assert!(
        steered_comment["body"]
            .as_str()
            .unwrap()
            .contains(&format!("agent://{agent_id}?intent=wake"))
    );
    let reopened_issue = client
        .get(format!("{base}/api/issues/{issue_id}"))
        .bearer_auth(&board_token)
        .send()
        .await
        .unwrap();
    assert_eq!(reopened_issue.status(), StatusCode::OK);
    let reopened_issue: serde_json::Value = reopened_issue.json().await.unwrap();
    assert_eq!(reopened_issue["status"], "todo");
    let reopened_activity_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND entity_id=$2 AND action='issue.updated' AND details->>'reopened'='true' AND details->>'source'='comment'",
    )
    .bind(&org_id)
    .bind(&issue_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(reopened_activity_count, 1);
    let (steer_request_status, steer_request_reason, steer_request_run_id, steer_request_payload):
        (String, String, Option<String>, serde_json::Value) = sqlx::query_as(
            "SELECT status,reason,run_id::text,payload FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=$2::uuid AND payload->>'issueId'=$3 AND reason='issue_execution_deferred' ORDER BY requested_at DESC LIMIT 1",
        )
        .bind(&org_id)
        .bind(&agent_id)
        .bind(&issue_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(steer_request_status, "deferred_issue_execution");
    assert_eq!(steer_request_reason, "issue_execution_deferred");
    assert_eq!(steer_request_run_id, None);
    assert_eq!(steer_request_payload["steerRunId"], run_id);
    let steered_run: (String, Option<String>) = sqlx::query_as(
        "SELECT status,error_code FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(&org_id)
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        steered_run,
        ("running".to_owned(), Some("cancel_requested".to_owned()))
    );
    let steer_cancel_activity_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND action='heartbeat.cancelled' AND entity_id=$2 AND details->>'source'='issue_comment_steer'",
    )
    .bind(&org_id)
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(steer_cancel_activity_count, 1);

    let DatabaseState::Configured(native_pool) = &foundation.database else {
        panic!("the public API must have a configured database");
    };
    native_pool.close().await;
    let outage = client
        .get(format!("{base}/api/issues/{issue_id}/attachments"))
        .send()
        .await
        .unwrap();
    assert_eq!(outage.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        outage.json::<serde_json::Value>().await.unwrap(),
        json!({"error":"Internal server error"})
    );
    assert_eq!(node_requests.load(Ordering::SeqCst), 1);
    control.stop(true).await;
    task.await.unwrap().unwrap();
    node_control.stop(true).await;
    node_task.await.unwrap().unwrap();

    // Teardown also deletes Rust-owned wakeups and runs; keep its marker local.
    let mut cleanup = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:test_cleanup',true)")
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organization_mutation_outbox WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM activity_log WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    let board_wakeup_id: String =
        sqlx::query_scalar("SELECT wakeup_request_id::text FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(&board_run_id)
            .fetch_one(&mut *cleanup)
            .await
            .unwrap();
    let member_wakeup_id: String =
        sqlx::query_scalar("SELECT wakeup_request_id::text FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(&member_run_id)
            .fetch_one(&mut *cleanup)
            .await
            .unwrap();
    sqlx::query("DELETE FROM agent_wakeup_requests WHERE id=$1::uuid")
        .bind(&paused_request_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=$1::uuid")
        .bind(&member_run_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_wakeup_requests WHERE id=$1::uuid")
        .bind(&member_wakeup_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=$1::uuid")
        .bind(&board_run_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_wakeup_requests WHERE id=$1::uuid")
        .bind(&board_wakeup_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&member_issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&board_issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&work_product_issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid")
        .bind(&org_id)
        .bind(&comment_wakeup_run_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=$1::uuid")
        .bind(&comment_wakeup_run_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_wakeup_requests WHERE id=$1::uuid")
        .bind(&comment_wakeup_request_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("UPDATE issues SET execution_run_id=NULL WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(&org_id)
        .bind(&reopen_wakeup_issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid")
        .bind(&org_id)
        .bind(&reopen_interrupt_run_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=$1::uuid")
        .bind(&reopen_interrupt_run_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid")
        .bind(&org_id)
        .bind(&reopen_wakeup_issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&reopen_wakeup_issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid")
        .bind(&org_id)
        .bind(&comment_wakeup_issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&comment_wakeup_issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE issues SET execution_run_id=NULL WHERE org_id=$1::uuid AND id=ANY($2::uuid[])",
    )
    .bind(&org_id)
    .bind(vec![
        normal_steer_failure_issue_id.clone(),
        paused_steer_issue_id.clone(),
    ])
    .execute(&mut *cleanup)
    .await
    .unwrap();
    sqlx::query(
        "DELETE FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=ANY($2::uuid[])",
    )
    .bind(&org_id)
    .bind(vec![
        normal_steer_failure_run_id.clone(),
        paused_steer_run_id.clone(),
    ])
    .execute(&mut *cleanup)
    .await
    .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE org_id=$1::uuid AND id=ANY($2::uuid[])")
        .bind(&org_id)
        .bind(vec![
            normal_steer_failure_run_id.clone(),
            paused_steer_run_id.clone(),
        ])
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM agent_wakeup_requests WHERE org_id=$1::uuid AND agent_id=ANY($2::uuid[])",
    )
    .bind(&org_id)
    .bind(vec![
        normal_steer_failure_agent_id.clone(),
        paused_steer_agent_id.clone(),
    ])
    .execute(&mut *cleanup)
    .await
    .unwrap();
    sqlx::query("DELETE FROM issue_comments WHERE org_id=$1::uuid AND issue_id=ANY($2::uuid[])")
        .bind(&org_id)
        .bind(vec![
            normal_steer_failure_issue_id.clone(),
            paused_steer_issue_id.clone(),
        ])
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE org_id=$1::uuid AND id=ANY($2::uuid[])")
        .bind(&org_id)
        .bind(vec![
            normal_steer_failure_issue_id.clone(),
            paused_steer_issue_id.clone(),
        ])
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid")
        .bind(&org_id)
        .bind(&issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&paused_issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&budget_issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid")
        .bind(&org_id)
        .bind(&run_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=$1::uuid")
        .bind(&run_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_issue_creation_requests WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&requested_issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=ANY($1::uuid[])")
        .bind(vec![
            done_issue_id.clone(),
            blocked_issue_id.clone(),
            cancelled_issue_id.clone(),
        ])
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=ANY($1::uuid[])")
        .bind(vec![
            creation_run_id.clone(),
            ambiguous_run_id.clone(),
            terminal_run_id.clone(),
        ])
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=$1::uuid")
        .bind(&foreign_run_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM heartbeat_run_events e USING heartbeat_runs r, agent_wakeup_requests w
         WHERE e.org_id=$1::uuid AND r.org_id=$1::uuid AND w.org_id=$1::uuid
           AND e.run_id=r.id AND r.wakeup_request_id=w.id",
    )
    .bind(&org_id)
    .execute(&mut *cleanup)
    .await
    .unwrap();
    sqlx::query(
        "DELETE FROM heartbeat_runs r USING agent_wakeup_requests w
         WHERE r.org_id=$1::uuid AND w.org_id=$1::uuid AND r.wakeup_request_id=w.id",
    )
    .bind(&org_id)
    .execute(&mut *cleanup)
    .await
    .unwrap();
    sqlx::query("DELETE FROM agent_wakeup_requests WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_wakeup_requests WHERE org_id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM cost_events WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM budget_policies WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    let automation_chat_ids: Vec<String> = sqlx::query_scalar(
        "SELECT linked_chat_conversation_id::text FROM automation_runs WHERE org_id=$1::uuid AND id=ANY($2::uuid[]) AND linked_chat_conversation_id IS NOT NULL",
    )
    .bind(&org_id)
    .bind(vec![
        done_run_id.clone(),
        blocked_run_id.clone(),
        cancelled_run_id.clone(),
    ])
    .fetch_all(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM automation_runs WHERE org_id=$1::uuid AND id=ANY($2::uuid[])")
        .bind(&org_id)
        .bind(vec![
            done_run_id.clone(),
            blocked_run_id.clone(),
            cancelled_run_id.clone(),
        ])
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM automations WHERE org_id=$1::uuid AND id=ANY($2::uuid[])")
        .bind(&org_id)
        .bind(vec![
            done_automation_id.clone(),
            blocked_automation_id.clone(),
            cancelled_automation_id.clone(),
        ])
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=ANY($2::uuid[])",
    )
    .bind(&org_id)
    .bind(automation_chat_ids.clone())
    .execute(&mut *cleanup)
    .await
    .unwrap();
    sqlx::query("DELETE FROM chat_conversations WHERE org_id=$1::uuid AND id=ANY($2::uuid[])")
        .bind(&org_id)
        .bind(automation_chat_ids)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM product_analytics_events WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM projects WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM workspace_runtime_services WHERE id=$1::uuid")
        .bind(&related_runtime_service_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM execution_workspaces WHERE id=$1::uuid")
        .bind(&related_execution_workspace_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=$1::uuid")
        .bind(&related_run_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=$1::uuid")
        .bind(&related_agent_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM projects WHERE id=$1::uuid")
        .bind(&related_project_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_api_keys WHERE id=$1::uuid")
        .bind(&agent_key_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_api_keys WHERE id=$1::uuid")
        .bind(&foreign_agent_key_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM board_api_keys WHERE id=$1::uuid")
        .bind(&board_key_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM organization_memberships WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2",
    )
    .bind(&org_id)
    .bind(&board_user_id)
    .execute(&mut *cleanup)
    .await
    .unwrap();
    sqlx::query(
        "DELETE FROM organization_memberships WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2",
    )
    .bind(&org_id)
    .bind(&second_board_user_id)
    .execute(&mut *cleanup)
    .await
    .unwrap();
    sqlx::query(r#"DELETE FROM "user" WHERE id=$1"#)
        .bind(&board_user_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query(r#"DELETE FROM "user" WHERE id=$1"#)
        .bind(&second_board_user_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=$1::uuid")
        .bind(&agent_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=$1::uuid")
        .bind(&other_agent_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=$1::uuid")
        .bind(&paused_agent_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=$1::uuid")
        .bind(&reopen_agent_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=ANY($1::uuid[])")
        .bind(vec![normal_steer_failure_agent_id, paused_steer_agent_id])
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=$1::uuid")
        .bind(&foreign_agent_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM assets WHERE id=$1::uuid")
        .bind(&source_asset_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM assets WHERE id=$1::uuid")
        .bind(&foreign_asset_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&foreign_issue_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organizations WHERE id=$1::uuid")
        .bind(&org_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organizations WHERE id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organizations WHERE id=$1::uuid")
        .bind(&related_org_id)
        .execute(&mut *cleanup)
        .await
        .unwrap();
    cleanup.commit().await.unwrap();
    pool.close().await;
}
