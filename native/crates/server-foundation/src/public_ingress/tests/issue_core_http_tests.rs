use super::*;
use reqwest::StatusCode;
use rudder_auth_core::SigningKey;
use serde_json::json;
use std::{env, sync::Arc};
use uuid::Uuid;

const ACTOR_ENVELOPE_KEY: &[u8] = b"native-issue-core-http-envelope-key";
const IDENTITY_ASSERTION_KEY: &str = "native-issue-core-http-identity-assertion-key";
const AGENT_JWT_SECRET: &str = "native-issue-core-http-agent-jwt-secret";

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
#[ignore = "requires RUDDER_NATIVE_AUTH_TEST_DATABASE_URL pointing at a migrated disposable DB"]
async fn public_issue_reads_and_agent_board_checkout_use_rust_without_node_fallback() {
    crate::init_tracing();
    let pool = super::disposable_native_auth_pool().await;
    let suffix = Uuid::new_v4().simple().to_string();
    let org_id: String = sqlx::query_scalar(
        "INSERT INTO organizations (url_key, name, issue_prefix) VALUES ($1, $2, $3) RETURNING id::text",
    )
    .bind(format!("native-issue-core-{suffix}"))
    .bind(format!("Native Issue Core {suffix}"))
    .bind(format!("IC{}", suffix[..8].to_ascii_uppercase()))
    .fetch_one(&pool)
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
        "INSERT INTO organization_memberships (org_id, principal_type, principal_id, status) VALUES ($1::uuid, 'user', $2, 'active')",
    )
    .bind(&org_id)
    .bind(&board_user_id)
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
    let board_issue_id = Uuid::new_v4().to_string();
    let member_issue_id = Uuid::new_v4().to_string();
    let paused_issue_id = Uuid::new_v4().to_string();
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
        "http://127.0.0.1:9",
        "native-issue-core-http-forwarding-key",
    )
    .unwrap();
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
    let runtime = PublicIngressRuntime::bind(ingress, foundation).unwrap();
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
            "legacy_ts".to_owned(),
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
    assert_eq!(member_queue_authority, "legacy_ts");

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

    let created = client
        .post(format!("{base}/api/orgs/{org_id}/issues"))
        .json(&json!({
            "title":format!("Native Issue CRUD workflow [@Title](project://{title_project_id})"),
            "description":format!("Initial description [@Description](project://{description_project_id})"),
            "status":"todo"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);
    let created: serde_json::Value = created.json().await.unwrap();
    let created_id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(
        created["title"],
        format!("Native Issue CRUD workflow [@Title](project://{title_project_id})")
    );
    assert_eq!(created["identifier"], format!("{prefix}-5"));
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
    assert_eq!(
        detail["description"],
        format!("Initial description [@Description](project://{description_project_id})")
    );
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
        .json(&json!({"title":"Native Issue CRUD updated","description":null}))
        .send()
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);
    let updated: serde_json::Value = updated.json().await.unwrap();
    assert_eq!(updated["title"], "Native Issue CRUD updated");
    assert_eq!(updated["description"], serde_json::Value::Null);

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
    let foreign_agent_id: String = sqlx::query_scalar(
        "INSERT INTO agents (org_id, name, role, status) VALUES ($1::uuid, $2, 'general', 'idle') RETURNING id::text",
    )
    .bind(&foreign_org_id)
    .bind(format!("Foreign Issue Core Agent {suffix}"))
    .fetch_one(&pool)
    .await
    .unwrap();
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

    control.stop(true).await;
    task.await.unwrap().unwrap();

    sqlx::query("DELETE FROM organization_mutation_outbox WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM activity_log WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
        .await
        .unwrap();
    let board_wakeup_id: String =
        sqlx::query_scalar("SELECT wakeup_request_id::text FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(&board_run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let member_wakeup_id: String =
        sqlx::query_scalar("SELECT wakeup_request_id::text FROM heartbeat_runs WHERE id=$1::uuid")
            .bind(&member_run_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    sqlx::query("DELETE FROM agent_wakeup_requests WHERE id=$1::uuid")
        .bind(&paused_request_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=$1::uuid")
        .bind(&member_run_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_wakeup_requests WHERE id=$1::uuid")
        .bind(&member_wakeup_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=$1::uuid")
        .bind(&board_run_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_wakeup_requests WHERE id=$1::uuid")
        .bind(&board_wakeup_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&member_issue_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&board_issue_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issue_comments WHERE org_id=$1::uuid AND issue_id=$2::uuid")
        .bind(&org_id)
        .bind(&issue_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&issue_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&paused_issue_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&budget_issue_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_run_events WHERE org_id=$1::uuid AND run_id=$2::uuid")
        .bind(&org_id)
        .bind(&run_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=$1::uuid")
        .bind(&run_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_issue_creation_requests WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=$1::uuid")
        .bind(&requested_issue_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM issues WHERE id=ANY($1::uuid[])")
        .bind(vec![
            done_issue_id.clone(),
            blocked_issue_id.clone(),
            cancelled_issue_id.clone(),
        ])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=ANY($1::uuid[])")
        .bind(vec![
            creation_run_id.clone(),
            ambiguous_run_id.clone(),
            terminal_run_id.clone(),
        ])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM heartbeat_runs WHERE id=$1::uuid")
        .bind(&foreign_run_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM heartbeat_run_events e USING heartbeat_runs r, agent_wakeup_requests w
         WHERE e.org_id=$1::uuid AND r.org_id=$1::uuid AND w.org_id=$1::uuid
           AND e.run_id=r.id AND r.wakeup_request_id=w.id",
    )
    .bind(&org_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "DELETE FROM heartbeat_runs r USING agent_wakeup_requests w
         WHERE r.org_id=$1::uuid AND w.org_id=$1::uuid AND r.wakeup_request_id=w.id",
    )
    .bind(&org_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM agent_wakeup_requests WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_wakeup_requests WHERE org_id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM cost_events WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM budget_policies WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
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
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM automations WHERE org_id=$1::uuid AND id=ANY($2::uuid[])")
        .bind(&org_id)
        .bind(vec![
            done_automation_id.clone(),
            blocked_automation_id.clone(),
            cancelled_automation_id.clone(),
        ])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM chat_messages WHERE org_id=$1::uuid AND conversation_id=ANY($2::uuid[])",
    )
    .bind(&org_id)
    .bind(automation_chat_ids.clone())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM chat_conversations WHERE org_id=$1::uuid AND id=ANY($2::uuid[])")
        .bind(&org_id)
        .bind(automation_chat_ids)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM product_analytics_events WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM projects WHERE org_id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_api_keys WHERE id=$1::uuid")
        .bind(&agent_key_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM board_api_keys WHERE id=$1::uuid")
        .bind(&board_key_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "DELETE FROM organization_memberships WHERE org_id=$1::uuid AND principal_type='user' AND principal_id=$2",
    )
    .bind(&org_id)
    .bind(&board_user_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(r#"DELETE FROM "user" WHERE id=$1"#)
        .bind(&board_user_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=$1::uuid")
        .bind(&agent_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=$1::uuid")
        .bind(&other_agent_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=$1::uuid")
        .bind(&paused_agent_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM agents WHERE id=$1::uuid")
        .bind(&foreign_agent_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organizations WHERE id=$1::uuid")
        .bind(&org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM organizations WHERE id=$1::uuid")
        .bind(&foreign_org_id)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
}
