use super::*;
use serde_json::json;

fn test_scope() -> TrustedOrganizationScope {
    TrustedOrganizationScope::from_host(
        OrganizationScope::many(["org-b", "org-a"]).expect("test scope is valid"),
    )
}

fn test_page(limit: usize) -> ActivityPageRequest {
    ActivityPageRequest::new(limit).expect("test page is valid")
}

fn activity_row(details: Option<Value>) -> ActivityDbRow {
    ActivityDbRow {
        id: "11111111-1111-4111-8111-111111111111".into(),
        org_id: "org-a".into(),
        actor_type: "user".into(),
        actor_id: "actor-1".into(),
        action: "issue.updated".into(),
        entity_type: "issue".into(),
        entity_id: "22222222-2222-4222-8222-222222222222".into(),
        agent_id: None,
        run_id: None,
        details,
        issue_id: Some("22222222-2222-4222-8222-222222222222".into()),
        issue_identifier: Some("RUD-7".into()),
        issue_title: Some("Bounded read".into()),
        created_at: "2026-09-11T00:00:00.000000Z".into(),
    }
}

fn run_row() -> RunDbRow {
    RunDbRow {
        id: "33333333-3333-4333-8333-333333333333".into(),
        org_id: "org-a".into(),
        agent_id: "44444444-4444-4444-8444-444444444444".into(),
        agent_name: Some("agent".into()),
        runtime: "native".into(),
        org_name: Some("Organization".into()),
        invocation_source: "heartbeat".into(),
        trigger_detail: Some("scheduled".into()),
        status: "succeeded".into(),
        started_at: Some("2026-09-11T00:00:00.000000Z".into()),
        finished_at: Some("2026-09-11T00:00:01.250000Z".into()),
        error_summary: None,
        outcome_summary: Some("done".into()),
        source_run_id: None,
        goal_id: Some("55555555-5555-4555-8555-555555555555".into()),
        chat_conversation_id: None,
        issue_id: Some("22222222-2222-4222-8222-222222222222".into()),
        issue_identifier: Some("RUD-7".into()),
        issue_title: Some("Bounded read".into()),
        target_type: Some("issue".into()),
        target_id: Some("22222222-2222-4222-8222-222222222222".into()),
        usage_input_tokens: Some("10".into()),
        usage_cached_input_tokens: Some("2".into()),
        usage_output_tokens: Some("5".into()),
        usage_cost_usd: Some("0.25".into()),
        usage_provider: Some("provider".into()),
        usage_model: Some("model".into()),
        log_store: Some("local_file".into()),
        log_ref_present: true,
        log_bytes: Some(4096),
        log_sha256: Some("a".repeat(64)),
        log_compressed: true,
        created_at: "2026-09-11T00:00:00.000000Z".into(),
        updated_at: "2026-09-11T00:00:01.250000Z".into(),
    }
}

#[test]
fn activity_plan_is_fenced_parameterized_and_stably_ordered() {
    let filter = ActivityListFilter {
        actor_id: Some("actor'); DROP TABLE activity_log; --".into()),
        action: Some("issue.updated".into()),
        ..Default::default()
    };

    let plan = list_activity_query_plan(&test_scope(), &filter, &test_page(2)).unwrap();

    assert!(plan.sql.contains("al.org_id IN ($1::uuid, $2::uuid)"));
    assert!(plan.sql.contains("activity_issue.hidden_at IS NULL"));
    assert!(plan.sql.contains("al.action <> 'issue.read_marked'"));
    assert!(plan.sql.contains("al.action <> 'issue.execution_released'"));
    assert!(
        plan.sql
            .contains("COALESCE(jsonb_typeof(al.details) = 'object', FALSE)")
    );
    assert!(plan.sql.contains("jsonb_object_keys("));
    assert!(plan.sql.contains("ORDER BY al.created_at DESC, al.id DESC"));
    assert!(plan.sql.contains("LIMIT $5::int4"));
    assert_eq!(
        plan.binds,
        vec![
            ActivityReadBind::Text("org-a".into()),
            ActivityReadBind::Text("org-b".into()),
            ActivityReadBind::Text("actor'); DROP TABLE activity_log; --".into()),
            ActivityReadBind::Text("issue.updated".into()),
            ActivityReadBind::Limit(3),
        ]
    );
    assert!(!plan.sql.contains("DROP TABLE"));
    assert!(!plan.sql.contains("actor');"));
}

#[test]
fn run_plan_only_projects_safe_log_metadata_and_fences_links() {
    let filter = RunListFilter {
        agent_id: Some("66666666-6666-4666-8666-666666666666".into()),
        status: Some("succeeded".into()),
        invocation_source: Some("heartbeat".into()),
        issue_id: Some("22222222-2222-4222-8222-222222222222".into()),
        goal_id: Some("55555555-5555-4555-8555-555555555555".into()),
    };

    let plan = list_run_query_plan(&test_scope(), &filter, &test_page(4)).unwrap();

    assert!(plan.sql.contains("r.org_id IN ($1::uuid, $2::uuid)"));
    assert!(plan.sql.contains("a.org_id = r.org_id"));
    assert!(plan.sql.contains("run_issue.org_id = r.org_id"));
    assert!(plan.sql.contains("run_issue.hidden_at IS NULL"));
    assert!(plan.sql.contains("run_goal.org_id = r.org_id"));
    assert!(plan.sql.contains("source_run.org_id = r.org_id"));
    assert!(plan.sql.contains("run_chat.org_id = r.org_id"));
    assert!(
        plan.sql
            .contains("(r.log_ref IS NOT NULL) AS log_ref_present")
    );
    assert!(!plan.sql.contains("r.log_ref AS"));
    assert!(!plan.sql.contains("r.log_ref,"));
    assert!(plan.sql.contains("ORDER BY r.created_at DESC, r.id DESC"));
    assert!(matches!(
        plan.binds.last(),
        Some(ActivityReadBind::Limit(5))
    ));
    assert_eq!(plan.binds.len(), 8);
}

#[test]
fn cursor_is_canonical_and_keeps_values_out_of_sql() {
    let cursor = encode_created_cursor(&CreatedCursor {
        created_at: "2026-09-11T00:00:00.000000Z".into(),
        id: "11111111-1111-4111-8111-111111111111".into(),
    });
    let page = ActivityPageRequest::with_cursor(3, cursor.clone()).unwrap();
    assert_eq!(page.cursor(), Some(cursor));

    let plan =
        list_activity_query_plan(&test_scope(), &ActivityListFilter::default(), &page).unwrap();
    assert!(
        plan.sql
            .contains("al.created_at < $3::timestamptz OR (al.created_at = $3::timestamptz")
    );
    assert!(plan.sql.contains("al.id < $4::uuid"));
    assert_eq!(
        plan.binds[2],
        ActivityReadBind::Text("2026-09-11T00:00:00.000000Z".into())
    );
    assert_eq!(
        plan.binds[3],
        ActivityReadBind::Text("11111111-1111-4111-8111-111111111111".into())
    );
    assert_eq!(plan.binds[4], ActivityReadBind::Limit(4));
}

#[test]
fn activity_projection_redacts_nested_secrets_and_keeps_visible_issue_context() {
    let projection = activity_row(Some(json!({
        "title": "updated",
        "api_key": "secret-value",
        "nested": {"password": "another-secret"},
        "authorization": "Bearer very-secret-token",
    })))
    .into_projection()
    .unwrap();
    let details = projection.details.unwrap();
    let serialized = details.to_string();

    assert!(!serialized.contains("secret-value"));
    assert!(!serialized.contains("another-secret"));
    assert!(!serialized.contains("very-secret-token"));
    assert_eq!(details["api_key"], REDACTED_VALUE);
    assert_eq!(details["issueIdentifier"], "RUD-7");
    assert_eq!(details["issueTitle"], "Bounded read");
    assert_eq!(
        projection.issue.unwrap().id,
        "22222222-2222-4222-8222-222222222222"
    );
}

#[test]
fn activity_projection_does_not_expose_secret_reference_ids() {
    let projection = activity_row(Some(json!({
        "credential": {
            "type": "secret_ref",
            "secretId": "concrete-secret-id",
        },
    })))
    .into_projection()
    .unwrap();
    let details = projection.details.unwrap();

    assert!(!details.to_string().contains("concrete-secret-id"));
    assert_eq!(details["credential"], json!({"type": "secret_ref"}));
}

#[test]
fn run_projection_reuses_safe_log_metadata_and_bounds_invalid_bytes() {
    let projection = run_row().into_projection().unwrap();
    assert_eq!(projection.duration_ms, Some(1_250));
    assert_eq!(projection.usage.unwrap().total_tokens, 17);
    assert_eq!(projection.log.bytes, 4_096);
    assert!(projection.log.available);
    assert_eq!(projection.log.store.as_deref(), Some("local_file"));
    assert_eq!(projection.log.sha256.as_deref().map(str::len), Some(64));

    let mut invalid = run_row();
    invalid.log_bytes = Some(-1);
    assert!(matches!(
        invalid.into_projection(),
        Err(ProjectionError::InvalidObject {
            entity: "run",
            field: "log_bytes"
        })
    ));
}

#[test]
fn oversized_json_is_replaced_after_redaction() {
    let details = redact_bounded_json(Some(json!({"data": "x".repeat(MAX_JSON_BYTES)}))).unwrap();
    assert_eq!(details, json!({"_truncated": true}));
}
