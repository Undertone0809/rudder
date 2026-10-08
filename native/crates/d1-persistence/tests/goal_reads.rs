mod support;
use rudder_d1_persistence::{
    StoreError,
    goal_reads::{GoalReadError, GoalReadRequest, GoalReadView, read_goals as read_goal_json},
};
use serde_json::{Value, json};
use support::{
    ASSET, CEO, Database, FOREIGN_ASSET, FOREIGN_GOAL, FOREIGN_PROJECT, GOAL, GOAL_TWO, ORG, OTHER,
    PROJECT,
};
async fn read_goals(
    pool: &sqlx::PgPool,
    org: &str,
    request: &GoalReadRequest,
) -> Result<Value, GoalReadError> {
    Ok(serde_json::from_str(&read_goal_json(pool, org, request).await?).unwrap())
}

fn input(view: GoalReadView, id: Option<&str>) -> GoalReadRequest {
    GoalReadRequest {
        view,
        goal_id: id.map(str::to_owned),
        cursor: None,
        limit: None,
        agent_id: None,
        lifecycle: None,
        focus: None,
        facet: None,
    }
}

#[tokio::test]
async fn goal_reads_sql_public_projection_scope_history_and_dependencies() {
    let db = Database::start().await;
    let before = db.counts().await;
    let before_name = db.name().await;
    let before_brand_color = db.brand_color().await;
    db.sql(&format!(r#"
        UPDATE organization_mutation_state SET owner='node',fence_epoch=fence_epoch+1,fence_token=gen_random_uuid();
        UPDATE goals SET created_at='2026-10-01T12:00:00.123456Z',updated_at='2026-10-01T12:00:00.123456Z',plan_revision=2,
          owner_agent_id='{CEO}',outcome_statement='Goal contract continuation artifact://private',
          criteria='[{{"id":"ok","label":"evaluator evidence requirement","hidden":"private"}},{{"id":"","label":"skip"}}]',
          evaluation_result='{{"outcome":"achieved","secret":"private"}}',owner_agent_runtime_overrides='{{"model":"synthetic"}}',description=repeat('long text ',15000)
          WHERE id='{GOAL}';
        INSERT INTO goal_owner_assignments(org_id,goal_id,agent_id,starts_at) VALUES ('{ORG}','{GOAL}','{CEO}','2026-10-01T12:00:00.123456Z');
        INSERT INTO goal_plans(org_id,goal_id,revision,summary) VALUES ('{ORG}','{GOAL}',1,'old'),('{ORG}','{GOAL}',2,'Contract revision plan');
        INSERT INTO goal_activities(id,org_id,goal_id,contract_revision,submitted_by_agent_id,activity_kind,summary,evidence_refs,occurred_at,created_at)
          SELECT ('60000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'{ORG}','{GOAL}',1,'{CEO}','progress','Contract revision '||i,'["artifact://private","run://run-1","issue://ISS-1"]','2026-10-08T12:00:00.123Z','2026-10-08T12:00:00.123Z'::timestamptz+i*interval '1 second' FROM generate_series(1,120) i;
        INSERT INTO goal_activities(org_id,goal_id,contract_revision,summary) VALUES ('{OTHER}','{GOAL}',1,'FOREIGN CHILD MUST NOT LEAK');
        INSERT INTO "user"(id,name,email,created_at,updated_at) VALUES ('reader','Reader','synthetic@example.test',now(),now());
        INSERT INTO goal_feedback_entries(org_id,goal_id,actor_type,actor_id,body,attachments,content_hash,idempotency_key,created_at)
          VALUES ('{ORG}','{GOAL}','user','reader','Feedback stays literal contract',
          '[{{"uri":"asset://{ASSET}","name":"local","mimeType":"image/png","size":1}},{{"uri":"asset://{FOREIGN_ASSET}","name":"foreign"}},{{"uri":"https://private","name":"external"}}]','hash','feedback','2026-10-08T12:00:00.123Z');
        INSERT INTO approvals(id,org_id,type,payload) VALUES ('70000000-0000-4000-8000-000000000001','{ORG}','goal_change','{{}}');
        INSERT INTO goal_change_proposals(org_id,goal_id,expected_contract_revision,before_contract,after_contract,rationale,approval_id,idempotency_key,proposed_by_agent_id,created_at)
          VALUES ('{ORG}','{GOAL}',1,'{{}}','{{}}','Change proposal backed by runtime evidence','70000000-0000-4000-8000-000000000001','change','{CEO}','2026-10-08T12:00:00.123Z');
        INSERT INTO goal_result_proposals(org_id,goal_id,contract_revision,candidate,candidate_hash,preflight,risk_summary,idempotency_key,proposed_by_agent_id,created_at)
          VALUES ('{ORG}','{GOAL}',1,'{{"evidenceRefs":["library-file://file?p=notes%2Fready.md"]}}','hash','{{"outcome":"achieved"}}','Evaluator complete','result','{CEO}','2026-10-08T12:00:00.123Z');
        UPDATE goals SET parent_id='{GOAL}' WHERE id='{GOAL_TWO}';
        UPDATE projects SET goal_id='{GOAL}' WHERE id IN ('{PROJECT}','{FOREIGN_PROJECT}');
        INSERT INTO project_goals(org_id,project_id,goal_id) VALUES ('{ORG}','{PROJECT}','{GOAL}');
    "#)).await;
    let list = read_goals(&db.pool, ORG, &input(GoalReadView::List, None))
        .await
        .unwrap();
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert!(!list.to_string().contains(FOREIGN_GOAL));
    let detail = read_goals(&db.pool, ORG, &input(GoalReadView::Detail, Some(GOAL)))
        .await
        .unwrap();
    assert_eq!(detail["description"].as_str().unwrap().len(), 150000);
    assert_eq!(detail["createdAt"], "2026-10-01T12:00:00.123Z");
    assert_eq!(detail["outcomeStatement"], "Goal next step supporting work");
    assert_eq!(detail["evaluationResult"], json!({"outcome":"achieved"}));
    assert_eq!(detail["actionDeadline"], Value::Null);
    assert_eq!(
        detail["plan"],
        json!({"revision":2,"summary":"Goal update plan"})
    );
    assert_eq!(detail["ownerAssignment"]["agentId"], CEO);
    assert_eq!(detail["activities"].as_array().unwrap().len(), 100);
    assert_eq!(detail["activities"][0]["summary"], "Goal update 120");
    assert!(!detail.to_string().contains("private"));
    assert!(!detail.to_string().contains("FOREIGN CHILD"));
    let activities = read_goals(&db.pool, ORG, &input(GoalReadView::Activities, Some(GOAL)))
        .await
        .unwrap();
    assert_eq!(activities, detail["activities"]);
    for view in [
        GoalReadView::Detail,
        GoalReadView::Activities,
        GoalReadView::History,
        GoalReadView::Dependencies,
    ] {
        assert!(matches!(
            read_goals(&db.pool, ORG, &input(view, Some(FOREIGN_GOAL))).await,
            Err(GoalReadError::Store(StoreError::NotFound))
        ));
    }
    let mut request = input(GoalReadView::History, Some(GOAL));
    request.limit = Some("7".to_owned());
    let mut items = Vec::new();
    loop {
        let page = read_goals(&db.pool, ORG, &request).await.unwrap();
        let page_items = page["items"].as_array().unwrap();
        assert!(page_items.len() <= 7);
        items.extend(page_items.clone());
        request.cursor = page["nextCursor"].as_str().map(str::to_owned);
        if request.cursor.is_none() {
            break;
        }
        assert!(items.len() < 130);
    }
    assert_eq!(items.len(), 123);
    assert_eq!(
        items
            .iter()
            .map(|i| i["id"].as_str().unwrap())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        123
    );
    assert_eq!(items[0]["summary"], "Goal update 1");
    assert_eq!(items[119]["summary"], "Goal update 120");
    assert_eq!(items[120]["kind"], "change_proposal");
    assert_eq!(items[121]["kind"], "feedback");
    assert_eq!(items[122]["kind"], "result_proposal");
    assert_eq!(items[121]["actorName"], "Reader");
    assert_eq!(items[121]["summary"], "Feedback stays literal contract");
    assert_eq!(
        items[121]["attachments"][0]["contentPath"],
        format!("/api/assets/{ASSET}/content")
    );
    assert_eq!(items[121]["attachments"][1]["contentPath"], Value::Null);
    assert_eq!(
        items[0]["evidence"][1]["href"],
        format!("/A/agents/{CEO}/runs/run-1")
    );
    let deps = read_goals(
        &db.pool,
        ORG,
        &input(GoalReadView::Dependencies, Some(GOAL)),
    )
    .await
    .unwrap();
    assert_eq!(deps["counts"]["childGoals"], 1);
    assert_eq!(deps["counts"]["linkedProjects"], 1);
    assert_eq!(deps["blockers"], json!(["child_goals", "linked_projects"]));
    assert!(!deps.to_string().contains(FOREIGN_PROJECT));
    let mut context_request = input(GoalReadView::AgentContext, Some(GOAL));
    context_request.agent_id = Some(CEO.to_owned());
    let context = read_goals(&db.pool, ORG, &context_request).await;
    assert!(context.is_ok(), "agent-context read failed: {context:?}");
    assert_eq!(context.as_ref().unwrap()["goal"]["ownerAgentId"], CEO);
    let empty = read_goals(
        &db.pool,
        OTHER,
        &input(GoalReadView::Detail, Some(FOREIGN_GOAL)),
    )
    .await
    .unwrap();
    assert_eq!(empty["plan"], Value::Null);
    assert_eq!(empty["ownerAssignment"], Value::Null);
    assert_eq!(empty["activities"], json!([]));
    request.limit = Some("101".to_owned());
    assert!(matches!(
        read_goals(&db.pool, ORG, &request).await,
        Err(GoalReadError::Limit)
    ));
    request.limit = None;
    request.cursor = Some("bad".to_owned());
    assert!(matches!(
        read_goals(&db.pool, ORG, &request).await,
        Err(GoalReadError::Cursor)
    ));
    assert_eq!(
        db.counts().await,
        before,
        "reads never claim mutation ownership or write receipts/activity"
    );
    assert_eq!(
        db.name().await,
        before_name,
        "reads preserve organization name"
    );
    assert_eq!(
        db.brand_color().await,
        before_brand_color,
        "reads preserve organization branding"
    );
}
