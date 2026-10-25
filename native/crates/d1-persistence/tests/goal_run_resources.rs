mod support;

use rudder_d1_persistence::{StoreError, goal_run_resources::load_goal_started_resources};
use std::fs;
use support::{CEO, Database, ORG, OTHER};
use tempfile::tempdir;
use time::{Duration, OffsetDateTime};

#[tokio::test]
async fn loads_goal_started_resources_from_agent_scoped_database_and_memory() {
    const USER: &str = "goal-context-user";
    const ISSUE: &str = "40000000-0000-4000-8000-000000000021";
    const CHAT: &str = "70000000-0000-4000-8000-000000000021";
    const AUTOMATION: &str = "80000000-0000-4000-8000-000000000021";
    const TRIGGER: &str = "80000000-0000-4000-8000-000000000022";
    const INTEGRATION: &str = "90000000-0000-4000-8000-000000000021";
    const TOOL: &str = "90000000-0000-4000-8000-000000000022";

    let database = Database::start().await;
    sqlx::query("INSERT INTO \"user\" (id,name,email,created_at,updated_at) VALUES ($1,'Yamada','goal-context@example.test',now(),now())")
        .bind(USER)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO operator_profiles (user_id,nickname) VALUES ($1,'山田 太郎')")
        .bind(USER)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO organization_memberships (org_id,principal_type,principal_id,membership_role) VALUES ($1::uuid,'agent',$2,'owner'),($1::uuid,'user',$3,'member')")
        .bind(ORG)
        .bind(CEO)
        .bind(USER)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO issues (id,org_id,title,description,status,identifier,assignee_agent_id,reviewer_user_id,created_at,updated_at) VALUES ($1::uuid,$2::uuid,'修复跨组织访问 🚧','Preserve exact role, identifier, and Unicode summary.','in_progress','RUD-42',$3::uuid,$4,'2026-10-24T01:02:03.004Z','2026-10-25T02:03:04.005Z')")
        .bind(ISSUE)
        .bind(ORG)
        .bind(CEO)
        .bind(USER)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO chat_conversations (id,org_id,title,summary,preferred_agent_id,last_message_at,updated_at) VALUES ($1::uuid,$2::uuid,'Goal context 🧭','Old summary',$3::uuid,'2026-10-25T02:30:00Z','2026-10-25T02:30:00Z')")
        .bind(CHAT)
        .bind(ORG)
        .bind(CEO)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO chat_messages (id,org_id,conversation_id,role,body,created_at) VALUES ('70000000-0000-4000-8000-000000000022'::uuid,$1::uuid,$2::uuid,'assistant','计划是：先读清楚，再做实现。','2026-10-25T02:30:00Z')")
        .bind(ORG)
        .bind(CHAT)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO automations (id,org_id,title,assignee_agent_id,output_mode,status,last_triggered_at) VALUES ($1::uuid,$2::uuid,'Morning review',$3::uuid,'track_issue','active','2026-10-25T01:02:03.004Z')")
        .bind(AUTOMATION)
        .bind(ORG)
        .bind(CEO)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO automation_triggers (id,org_id,automation_id,kind,label,enabled,next_run_at,last_fired_at,created_at) VALUES ($1::uuid,$2::uuid,$3::uuid,'schedule','Daily check',true,'2026-10-26T08:00:00Z',NULL,'2026-10-20T00:00:00Z')")
        .bind(TRIGGER)
        .bind(ORG)
        .bind(AUTOMATION)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO custom_integrations (id,org_id,scope,kind,slug,display_name,config,status) VALUES ($1::uuid,$2::uuid,'organization','mcp_server','release-hub','Release Hub','{\"apiKey\":\"secret-never-show\"}'::jsonb,'active')")
        .bind(INTEGRATION)
        .bind(ORG)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO custom_integration_tools (id,org_id,integration_id,external_tool_name,rudder_tool_name,description,status,enabled) VALUES ($1::uuid,$2::uuid,$3::uuid,'publish_release','custom.release.publish','Publish | verify releases','active',true)")
        .bind(TOOL)
        .bind(ORG)
        .bind(INTEGRATION)
        .execute(&database.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agent_custom_integration_bindings (org_id,agent_id,integration_id,status,enabled_tool_ids) VALUES ($1::uuid,$2::uuid,$3::uuid,'active',jsonb_build_array($4::text))")
        .bind(ORG)
        .bind(CEO)
        .bind(INTEGRATION)
        .bind(TOOL)
        .execute(&database.pool)
        .await
        .unwrap();

    let memory = tempdir().unwrap();
    let today = OffsetDateTime::now_utc().date();
    let yesterday = today - Duration::days(1);
    fs::write(
        memory.path().join(format!("{today}.md")),
        "- 今日：检查完成 ✅\n- owner says café; 🧭",
    )
    .unwrap();
    fs::write(
        memory.path().join(format!("{yesterday}.md")),
        "昨日恢复 — keep it short",
    )
    .unwrap();

    let context = load_goal_started_resources(&database.pool, ORG, CEO, memory.path())
        .await
        .unwrap()
        .org_resources_prompt;

    assert!(context.contains("<connected_custom_integration_tools>"));
    assert!(context.contains("custom.release.publish"));
    assert!(context.contains("Publish \\| verify releases"));
    assert!(context.contains("<current_automations>"));
    assert!(context.contains("Morning review"));
    assert!(context.contains("Daily check (schedule); enabled"));
    assert!(context.contains("#### organization members"));
    assert!(context.contains("山田 太郎"));
    assert!(context.contains("agent:agt_50000000"));
    assert!(context.contains("user:usr_goalcont"));
    assert!(context.contains("RUD-42"));
    assert!(context.contains("2026-10-24T01:02:03.004Z"));
    assert!(context.contains("cht_70000000"));
    assert!(context.contains("计划是：先读清楚，再做实现。"));
    assert!(context.contains("<recent_rudder_context>"));
    assert!(!context.contains("secret-never-show"));

    let foreign = load_goal_started_resources(&database.pool, OTHER, CEO, memory.path()).await;
    assert!(matches!(foreign, Err(StoreError::NotFound)));
}
