mod support;
use rudder_d1_persistence::goal_run_resources::{
    load_agent_startup_resources, load_goal_started_resources,
};
use serde_json::json;
use support::{CEO, Database, ORG, OTHER, PROJECT};

#[tokio::test]
async fn startup_includes_current_issue_and_project_links_but_excludes_current_chat_and_foreign_rows()
 {
    let db = Database::start().await;
    let issue = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO issues(id,org_id,title,identifier,project_id,status) VALUES($1::uuid,$2::uuid,'Current linked issue','SCOPE-7',$3::uuid,'todo')")
        .bind(&issue).bind(ORG).bind(PROJECT).execute(&db.pool).await.unwrap();
    let current = uuid::Uuid::new_v4().to_string();
    let linked = uuid::Uuid::new_v4().to_string();
    let foreign = uuid::Uuid::new_v4().to_string();
    for (id, org, title, agent) in [
        (&current, ORG, "Current chat must be excluded", Some(CEO)),
        (&linked, ORG, "Project linked discussion", None),
        (&foreign, OTHER, "Foreign linked discussion", None),
    ] {
        sqlx::query("INSERT INTO chat_conversations(id,org_id,title,preferred_agent_id) VALUES($1::uuid,$2::uuid,$3,$4::uuid)")
            .bind(id).bind(org).bind(title).bind(agent).execute(&db.pool).await.unwrap();
    }
    for (chat, org) in [(&linked, ORG), (&foreign, OTHER)] {
        sqlx::query("INSERT INTO chat_context_links(org_id,conversation_id,entity_type,entity_id) VALUES($1::uuid,$2::uuid,'project',$3)")
            .bind(org).bind(chat).bind(PROJECT).execute(&db.pool).await.unwrap();
    }
    let memory = tempfile::tempdir().unwrap();
    let context = load_agent_startup_resources(
        &db.pool,
        ORG,
        CEO,
        memory.path(),
        &json!({"scene":"chat","issueId":issue,"projectId":PROJECT,"chatConversationId":current}),
    )
    .await
    .unwrap();
    let prompt = &context.org_resources_prompt;
    assert!(prompt.contains("SCOPE-7"));
    assert!(prompt.contains("Project linked discussion"));
    assert!(!prompt.contains("Current chat must be excluded"));
    assert!(!prompt.contains("Foreign linked discussion"));
    let goal = load_goal_started_resources(&db.pool, ORG, CEO, memory.path())
        .await
        .unwrap();
    assert!(
        goal.org_resources_prompt
            .contains("Current chat must be excluded")
    );
    assert!(
        !goal
            .org_resources_prompt
            .contains("Project linked discussion")
    );
    assert!(!goal.org_resources_prompt.contains("SCOPE-7"));
}

use rudder_d1_persistence::{
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    agent_execution::{self, AgentExecutionActor, AgentWakeRequest},
    agent_run_context,
};
use std::{future::Future, pin::Pin};
struct Board;
impl NativeAgentAuthorizer for Board {
    fn revalidate<'a>(
        &'a self,
        _: &'a mut sqlx::PgConnection,
        org: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>> {
        Box::pin(async move {
            Ok(if org == ORG {
                NativeAgentAccess::Authorized
            } else {
                NativeAgentAccess::Forbidden
            })
        })
    }
}
#[tokio::test]
async fn claimed_preparation_seeds_bundle_migrates_legacy_and_rechecks_package_source() {
    let db = Database::start().await;
    let key = format!("organization/{ORG}/reviewer");
    let skill = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO organization_skills(id,org_id,key,slug,name,markdown,source_type,source_locator) VALUES($1::uuid,$2::uuid,$3,'reviewer','Review package','# Reviewer','github','https://github.com/example/skills/tree/pinned/reviewer')")
        .bind(&skill).bind(ORG).bind(&key).execute(&db.pool).await.unwrap();
    let agent = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type,agent_runtime_config,runtime_config) VALUES($1::uuid,$2::uuid,'Legacy runtime fixture','general','idle','claude_local',$3,'{}')")
        .bind(&agent).bind(ORG).bind(json!({"command":"/bin/true","promptTemplate":"Legacy persona","bootstrapPromptTemplate":"Legacy bootstrap","paperclipSkillSync":{"desiredSkills":["reviewer","rudder/rudder"]}})).execute(&db.pool).await.unwrap();
    let wake = agent_execution::admit(
        &db.pool,
        &Board,
        &AgentExecutionActor {
            actor_type: "user",
            actor_id: "context-fixture".into(),
            run_id: None,
        },
        &AgentWakeRequest {
            organization_id: ORG.into(),
            agent_id: agent.clone(),
            source: "on_demand".into(),
            trigger_detail: Some("manual".into()),
            reason: Some("context_fixture".into()),
            payload: Some(json!({})),
            idempotency_key: Some("context-prep".into()),
            context_snapshot: json!({}),
        },
    )
    .await
    .unwrap();
    let claim = agent_execution::claim_queued_run(&db.pool, ORG, &wake.run_id.unwrap())
        .await
        .unwrap()
        .unwrap();
    agent_run_context::reconcile_agent_run_skills(&db.pool,&claim,&[json!({"key":"rudder/rudder-docs","slug":"rudder-docs","name":"Rudder","markdown":"# Rudder docs","sourceLocator":"/fixture/bundled/rudder-docs","fileInventory":[{"path":"SKILL.md","kind":"skill"}],"metadata":{"sourceKind":"rudder_bundled","skillKey":"rudder/rudder-docs"}})]).await.unwrap();
    sqlx::query("INSERT INTO agent_instruction_bundles(agent_id,org_id,entry_file,files,clear_legacy_prompt_template,state,attempts,next_attempt_at) VALUES($1::uuid,$2::uuid,'SOUL.md',$3,true,'pending',0,statement_timestamp())")
        .bind(&agent).bind(ORG).bind(json!({"SOUL.md":"# Current managed persona"})).execute(&db.pool).await.unwrap();
    let paths = tempfile::tempdir().unwrap();
    let cwd = paths.path().join("cwd");
    let home = paths.path().join("operator");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    let host = rudder_d1_persistence::agent_core::OrganizationWorkspaceHost {
        instance_root: paths.path().to_string_lossy().into_owned(),
        workspace_home: paths
            .path()
            .join("workspaces")
            .to_string_lossy()
            .into_owned(),
        previous_documents_root: paths
            .path()
            .join("old-documents")
            .to_string_lossy()
            .into_owned(),
        friendly_workspace_home: false,
        hostname: "fixture".into(),
    };
    let materialized =
        agent_run_context::materialize_agent_run_instructions(&db.pool, &claim, &host, &home, &cwd)
            .await
            .unwrap();
    assert_eq!(materialized["instructionsBundleMode"], "managed");
    assert!(std::path::Path::new(materialized["instructionsFilePath"].as_str().unwrap()).is_file());
    let projected: serde_json::Value = sqlx::query_scalar(
        "SELECT agent_runtime_config FROM agents WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&agent)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(projected.get("promptTemplate").is_none());
    assert!(projected.get("bootstrapPromptTemplate").is_none());
    assert_eq!(projected["rudderSkillSync"]["desiredSkills"], json!([]));
    let bundle_state: String = sqlx::query_scalar(
        "SELECT state FROM agent_instruction_bundles WHERE org_id=$1::uuid AND agent_id=$2::uuid",
    )
    .bind(ORG)
    .bind(&agent)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(bundle_state, "materialized");
    let resources = agent_run_context::load_agent_run_resources(&db.pool, ORG, &agent, &json!({}))
        .await
        .unwrap();
    assert!(
        resources
            .skills
            .iter()
            .any(|s| s["key"] == "rudder/rudder-docs")
    );
    assert_eq!(
        resources.enabled_skill_keys,
        std::collections::BTreeSet::from([format!("org:{key}")])
    );
    let config: serde_json::Value =
        sqlx::query_scalar("SELECT agent_runtime_config FROM agents WHERE id=$1::uuid")
            .bind(&agent)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(config["rudderSkillSync"]["desiredSkills"], json!([]));
    let snapshot = resources.skills.iter().find(|s| s["id"] == skill).unwrap();
    let root = tempfile::tempdir().unwrap();
    let installed_root = root.path().join("__installed__");
    std::fs::create_dir(&installed_root).unwrap();
    let prepared = installed_root.join(".prepared");
    std::fs::create_dir(&prepared).unwrap();
    std::fs::write(prepared.join("SKILL.md"), "# Restored full package").unwrap();
    let installed = installed_root.join("reviewer--fixture");
    sqlx::query("UPDATE organization_skills SET source_ref='changed-source' WHERE org_id=$1::uuid AND id=$2::uuid").bind(ORG).bind(&skill).execute(&db.pool).await.unwrap();
    assert!(
        agent_run_context::publish_skill_installation(
            &db.pool, &claim, snapshot, &prepared, &installed
        )
        .await
        .is_err()
    );
    assert!(prepared.join("SKILL.md").is_file());
    assert!(!installed.exists());
    let current = agent_run_context::load_agent_run_resources(&db.pool, ORG, &agent, &json!({}))
        .await
        .unwrap();
    let snapshot = current.skills.iter().find(|s| s["id"] == skill).unwrap();
    agent_run_context::publish_skill_installation(
        &db.pool, &claim, snapshot, &prepared, &installed,
    )
    .await
    .unwrap();
    assert!(installed.join("SKILL.md").is_file());
    assert!(!prepared.exists());
    assert!(
        rudder_d1_persistence::agent_run_workspace::persist_workspace(
            &db.pool,
            &claim,
            &json!({"projectId":support::FOREIGN_PROJECT,"cwd":"/fixture/current-org"})
        )
        .await
        .is_err()
    );
    agent_run_context::persist_prepared_policy(&db.pool, &claim, &[])
        .await
        .unwrap();
    let context: serde_json::Value = sqlx::query_scalar(
        "SELECT context_snapshot FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&claim.run_id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(context["managedMcpPolicySnapshot"], json!([]));
}

#[tokio::test]
async fn primary_project_workspace_order_and_goal_owner_overrides_remain_scoped() {
    let db = Database::start().await;
    let old = uuid::Uuid::new_v4().to_string();
    let primary = uuid::Uuid::new_v4().to_string();
    for (id, is_primary, created) in [
        (&old, false, "2026-01-01T00:00:00Z"),
        (&primary, true, "2026-02-01T00:00:00Z"),
    ] {
        sqlx::query("INSERT INTO project_workspaces(id,org_id,project_id,name,cwd,is_primary,created_at) VALUES($1::uuid,$2::uuid,$3::uuid,'Workspace fixture',$4,$5,$6::timestamptz)")
            .bind(id).bind(ORG).bind(PROJECT).bind(format!("/fixture/{id}")).bind(is_primary).bind(created).execute(&db.pool).await.unwrap();
    }
    sqlx::query("UPDATE goals SET owner_agent_id=$3::uuid,owner_agent_runtime_overrides=$4 WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG).bind(support::GOAL).bind(CEO).bind(json!({"agentRuntimeConfig":{"model":"goal-owner-model"}})).execute(&db.pool).await.unwrap();
    let resources = agent_run_context::load_agent_run_resources(
        &db.pool,
        ORG,
        CEO,
        &json!({"projectId":PROJECT,"goalId":support::GOAL}),
    )
    .await
    .unwrap();
    assert_eq!(resources.project_workspaces[0]["id"], primary);
    assert_eq!(resources.project_workspaces[1]["id"], old);
    assert_eq!(
        resources.goal.unwrap()["ownerAgentRuntimeOverrides"]["agentRuntimeConfig"]["model"],
        "goal-owner-model"
    );
    let foreign = agent_run_context::load_agent_run_resources(
        &db.pool,
        ORG,
        CEO,
        &json!({"projectId":support::FOREIGN_PROJECT,"goalId":support::FOREIGN_GOAL}),
    )
    .await
    .unwrap();
    assert!(foreign.project.is_none());
    assert!(foreign.goal.is_none());
    assert!(foreign.project_workspaces.is_empty());
}
