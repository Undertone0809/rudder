use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rudder_db_core::{
    AgentDbRow, AgentListOptions, EntityKind, GoalDbRow, OrganizationDbRow, OrganizationScope,
    PageRequest, ProjectDbRow, ProjectionError, QueryBind, ReadAdapterError, ReadError,
    get_query_plan, list_query_plan,
};
use rudder_read_surfaces_core::{OrganizationWorkspaceProjection, QueryPlan};
use serde_json::json;

fn encoded_cursor() -> String {
    URL_SAFE_NO_PAD.encode(
        br#"{"createdAt":"2026-01-02T03:04:05.000000Z","id":"00000000-0000-0000-0000-000000000001"}"#,
    )
}

fn assert_read_only(plan: &QueryPlan) {
    let sql = plan.sql.to_ascii_lowercase();
    assert!(
        sql.starts_with("select"),
        "query must be a SELECT: {}",
        plan.sql
    );
    for mutation in [
        "insert ",
        "update ",
        "delete ",
        "truncate ",
        "alter ",
        "drop ",
    ] {
        assert!(
            !sql.contains(mutation),
            "query contains mutation {mutation}"
        );
    }
}

#[test]
fn list_queries_bind_scope_and_bounded_limit_for_every_entity() {
    let scope = OrganizationScope::many(["org-a", "org-b"]).unwrap();
    let page = PageRequest::new(3).unwrap();

    for kind in [
        EntityKind::Organization,
        EntityKind::Goal,
        EntityKind::Project,
        EntityKind::Agent,
    ] {
        let plan = list_query_plan(kind, &scope, &page, AgentListOptions::default()).unwrap();
        assert_read_only(&plan);
        assert!(plan.sql.contains("IN ($1::uuid, $2::uuid)"));
        assert!(plan.sql.contains("ORDER BY created_at ASC, id ASC"));
        assert!(plan.sql.contains("LIMIT $3::int4"));
        assert_eq!(
            plan.binds,
            vec![
                QueryBind::Text("org-a".into()),
                QueryBind::Text("org-b".into()),
                QueryBind::Limit(4),
            ]
        );
        assert!(!plan.sql.contains("org-a"));
        assert!(!plan.sql.contains("org-b"));
    }
}

#[test]
fn cursor_queries_bind_cursor_values_in_stable_key_order() {
    let scope = OrganizationScope::single("org-a").unwrap();
    let page = PageRequest::with_cursor(10, encoded_cursor()).unwrap();

    let plan =
        list_query_plan(EntityKind::Goal, &scope, &page, AgentListOptions::default()).unwrap();
    assert_read_only(&plan);
    assert!(
        plan.sql
            .contains("(created_at, id) > ($2::timestamptz, $3::uuid)")
    );
    assert_eq!(
        plan.binds,
        vec![
            QueryBind::Text("org-a".into()),
            QueryBind::Text("2026-01-02T03:04:05.000000Z".into()),
            QueryBind::Text("00000000-0000-0000-0000-000000000001".into()),
            QueryBind::Limit(11),
        ]
    );
    assert!(plan.sql.contains("LIMIT $4::int4"));
}

#[test]
fn cursor_queries_reject_invalid_timestamp_or_uuid_before_sql_execution() {
    let scope = OrganizationScope::single("org-a").unwrap();
    let invalid_timestamp = URL_SAFE_NO_PAD
        .encode(br#"{"createdAt":"not-a-timestamp","id":"00000000-0000-0000-0000-000000000001"}"#);
    let timestamp_page = PageRequest::with_cursor(10, invalid_timestamp).unwrap();
    assert!(matches!(
        list_query_plan(
            EntityKind::Goal,
            &scope,
            &timestamp_page,
            AgentListOptions::default()
        ),
        Err(ReadAdapterError::Contract(ReadError::InvalidCursor))
    ));

    let invalid_uuid =
        URL_SAFE_NO_PAD.encode(br#"{"createdAt":"2026-01-02T03:04:05.000000Z","id":"not-a-uuid"}"#);
    let uuid_page = PageRequest::with_cursor(10, invalid_uuid).unwrap();
    assert!(matches!(
        list_query_plan(
            EntityKind::Goal,
            &scope,
            &uuid_page,
            AgentListOptions::default()
        ),
        Err(ReadAdapterError::Contract(ReadError::InvalidCursor))
    ));
}

#[test]
fn get_queries_bind_both_organization_fence_and_entity_id() {
    let scope = OrganizationScope::single("org-a").unwrap();

    for kind in [
        EntityKind::Organization,
        EntityKind::Goal,
        EntityKind::Project,
        EntityKind::Agent,
    ] {
        let plan = get_query_plan(kind, &scope, "entity-id").unwrap();
        assert_read_only(&plan);
        assert!(plan.sql.contains("= $1::uuid"));
        assert!(plan.sql.contains("= $2::uuid"));
        assert!(plan.sql.contains("LIMIT $3::int4"));
        assert_eq!(
            plan.binds,
            vec![
                QueryBind::Text("org-a".into()),
                QueryBind::Text("entity-id".into()),
                QueryBind::Limit(1),
            ]
        );
        assert!(!plan.sql.contains("entity-id"));
    }
}

#[test]
fn typed_rows_project_without_leaking_unselected_fields() {
    let organization = OrganizationDbRow {
        id: "org-1".into(),
        url_key: "org-one".into(),
        name: "Organization One".into(),
        description: Some("description".into()),
        status: "active".into(),
        issue_prefix: "ORG".into(),
        issue_prefix_aliases: json!(["OLD"]),
        workspace_config: Some(json!({
            "sourceType": "local_path",
            "cwd": "/tmp/workspace",
            "repoUrl": "https://example.invalid/repo.git",
            "repoRef": "main",
            "defaultRef": "main"
        })),
        created_at: "2026-01-01T00:00:00.000000Z".into(),
        updated_at: "2026-01-02T00:00:00.000000Z".into(),
    }
    .into_projection()
    .unwrap();
    assert_eq!(organization.issue_prefix_aliases, ["OLD"]);
    assert_eq!(
        organization.workspace,
        Some(OrganizationWorkspaceProjection {
            source_type: Some("local_path".into()),
            cwd: Some("/tmp/workspace".into()),
            repo_url: Some("https://example.invalid/repo.git".into()),
            repo_ref: Some("main".into()),
            default_ref: Some("main".into()),
        })
    );

    let goal = GoalDbRow {
        id: "goal-1".into(),
        org_id: "org-1".into(),
        title: "Ship it".into(),
        description: Some("goal".into()),
        alignment_question: None,
        outcome_statement: Some("done".into()),
        level: "objective".into(),
        status: "planned".into(),
        objective_mode: "target".into(),
        lifecycle: "draft".into(),
        criteria: json!([
            {"id": "c1", "label": "Ship the adapter"},
            {"id": "malformed"},
        ]),
        autonomy_envelope: json!({"max": 1}),
        human_authorities: json!({}),
        evaluation_policy: json!({}),
        evaluation_result: Some(json!({"outcome": "achieved", "private": "omit"})),
        result_payload: Some(json!({"private": "omit"})),
        created_at: "2026-01-01T00:00:00.000000Z".into(),
        updated_at: "2026-01-02T00:00:00.000000Z".into(),
    }
    .into_projection()
    .unwrap();
    assert_eq!(goal.criteria.len(), 1);
    assert_eq!(goal.criteria[0].label, "Ship the adapter");
    assert_eq!(goal.evaluation_result.unwrap().outcome, "achieved");

    let project = ProjectDbRow {
        id: "project-1".into(),
        org_id: "org-1".into(),
        name: "Build Platform".into(),
        description: None,
        status: "active".into(),
        goal_id: Some("goal-1".into()),
        goal_refs: json!([{"id": "goal-1", "title": "Ship it"}]),
        color: Some("#fff".into()),
        icon: Some("box".into()),
        created_at: "2026-01-01T00:00:00.000000Z".into(),
        updated_at: "2026-01-02T00:00:00.000000Z".into(),
    }
    .into_projection()
    .unwrap();
    assert_eq!(project.url_key, "build-platform");
    assert_eq!(project.goal_ids, ["goal-1"]);

    let agent = AgentDbRow {
        id: "agent-1".into(),
        org_id: "org-1".into(),
        name: "Terminated Agent".into(),
        role: "general".into(),
        title: None,
        status: "terminated".into(),
        readiness_state: "unknown".into(),
        readiness_result_code: None,
        capabilities: None,
        agent_runtime_type: "process".into(),
        agent_runtime_config: json!(["not-an-object"]),
        runtime_config: json!({"private": "omit"}),
        metadata: Some(json!({"hidden": true})),
        created_at: "2026-01-01T00:00:00.000000Z".into(),
        updated_at: "2026-01-02T00:00:00.000000Z".into(),
    }
    .into_projection()
    .unwrap();
    assert_eq!(agent.status, "terminated");
    assert_eq!(agent.url_key, "terminated-agent");
    assert_eq!(agent.agent_runtime_config, json!({}));
    assert!(
        serde_json::to_string(&agent)
            .unwrap()
            .contains("agentRuntimeConfig")
    );
    assert!(!serde_json::to_string(&agent).unwrap().contains("private"));
}

#[test]
fn malformed_typed_json_maps_to_a_projection_error() {
    let error = GoalDbRow {
        criteria: json!("not-an-array"),
        ..GoalDbRow::default()
    }
    .into_projection()
    .unwrap_err();
    assert!(matches!(error, ProjectionError::ArrayRequired { .. }));
}

#[test]
fn default_agent_list_fences_terminated_and_hidden_rows_but_get_does_not() {
    let scope = OrganizationScope::single("org-a").unwrap();
    let list = list_query_plan(
        EntityKind::Agent,
        &scope,
        &PageRequest::new(10).unwrap(),
        AgentListOptions::default(),
    )
    .unwrap();
    assert!(list.sql.contains("status <> 'terminated'"));
    assert!(
        list.sql
            .contains("COALESCE(a.metadata->>'hidden', 'false') <> 'true'")
    );
    assert!(
        list.sql
            .contains("COALESCE(a.metadata->>'systemManaged', '') <> 'rudder_copilot'")
    );

    let include_hidden = list_query_plan(
        EntityKind::Agent,
        &scope,
        &PageRequest::new(10).unwrap(),
        AgentListOptions {
            include_hidden: true,
            ..AgentListOptions::default()
        },
    )
    .unwrap();
    assert!(!include_hidden.sql.contains("metadata->>'hidden'"));
    assert!(!include_hidden.sql.contains("metadata->>'systemManaged'"));

    let get = get_query_plan(EntityKind::Agent, &scope, "agent-id").unwrap();
    assert!(!get.sql.contains("terminated"));
    assert!(!get.sql.contains("hidden"));
}
