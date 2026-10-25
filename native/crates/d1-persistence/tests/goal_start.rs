mod support;

use rudder_d1_persistence::{
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer},
    goal_start::{
        GoalStartError, GoalStartInput, GoalStartPreviewInput, apply_goal_start,
        compile_goal_start_preview,
    },
    goal_writes::GoalWriteContext,
};
use serde_json::Value;
use sqlx::PgConnection;
use std::{future::Future, pin::Pin};
use support::{CEO, Database, FOREIGN_GOAL, GOAL, ORG, OTHER};

struct Authorized;

impl NativeAgentAuthorizer for Authorized {
    fn revalidate<'a>(
        &'a self,
        _connection: &'a mut PgConnection,
        _org_id: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>> {
        Box::pin(std::future::ready(Ok(NativeAgentAccess::Authorized)))
    }
}

fn actor<'a>(org: &'a str) -> GoalWriteContext<'a> {
    GoalWriteContext {
        organization_id: org,
        actor_kind: "user",
        actor_id: "goal-start-board-user",
        actor_agent_id: None,
        run_id: None,
    }
}

fn preview_input(owner_id: &str, title: &str) -> GoalStartPreviewInput {
    GoalStartPreviewInput {
        title: title.to_owned(),
        context: Some("Keep the result inspectable.".to_owned()),
        owner_agent_id: Some(owner_id.to_owned()),
        target_time: Some("2026-08-20T10:00:00.000Z".to_owned()),
    }
}

fn start_input(
    request_key: &str,
    preview: &Value,
    draft_goal_id: Option<&str>,
    allow_capability_mismatch: bool,
) -> GoalStartInput {
    GoalStartInput {
        request_key: request_key.to_owned(),
        packet_hash: preview["packetHash"].as_str().unwrap().to_owned(),
        packet: preview["packet"].clone(),
        allow_capability_mismatch,
        draft_goal_id: draft_goal_id.map(str::to_owned),
    }
}

async fn set_owner_capabilities(database: &Database, owner_id: &str, capabilities: &str) {
    sqlx::query(
        "UPDATE agents SET role='engineer',capabilities=$3 WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(owner_id)
    .bind(capabilities)
    .execute(&database.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn goal_start_preview_and_transaction_match_packet_replay_and_wakeup_contracts() {
    let database = Database::start().await;
    let capable = "Plan and execute end-to-end software releases with verifiable evidence.";
    set_owner_capabilities(&database, CEO, capable).await;
    sqlx::query(
        "INSERT INTO agents (id,org_id,name,role,status,capabilities) VALUES ($1::uuid,$2::uuid,'Foreign Goal owner','engineer','idle',$3)",
    )
    .bind("50000000-0000-4000-8000-000000000002")
    .bind(OTHER)
    .bind(capable)
    .execute(&database.pool)
    .await
    .unwrap();

    let input = preview_input(CEO, "Publish a verified Goal Workspace release candidate");
    let preview = compile_goal_start_preview(&database.pool, ORG, &input)
        .await
        .unwrap();
    assert_eq!(preview["valid"], true);
    assert_eq!(preview["packet"]["activation"]["objectiveMode"], "target");

    // A start compiled for an Agent in another organization cannot be used to
    // cross the boundary, even though the packet and hash are otherwise valid.
    let foreign_preview = compile_goal_start_preview(
        &database.pool,
        OTHER,
        &preview_input(
            "50000000-0000-4000-8000-000000000002",
            "Publish a verified release candidate",
        ),
    )
    .await
    .unwrap();
    assert_eq!(foreign_preview["valid"], true);
    let foreign_start = start_input("foreign-owner", &foreign_preview, None, false);
    assert!(matches!(
        apply_goal_start(&database.pool, &Authorized, actor(ORG), &foreign_start).await,
        Err(GoalStartError::Unprocessable {
            message: "Goal owner must belong to the same organization",
            ..
        })
    ));
    let missing_owner = compile_goal_start_preview(
        &database.pool,
        ORG,
        &preview_input(
            "50000000-0000-4000-8000-000000000002",
            "Publish a verified release candidate",
        ),
    )
    .await
    .unwrap();
    assert_eq!(missing_owner["valid"], false);
    assert_eq!(missing_owner["blockers"][0]["code"], "owner_required");

    // A stale capability warning needs explicit confirmation; rejection leaves
    // no Goal Start request behind.
    sqlx::query(
        "UPDATE agents SET role='recruiting coordinator',capabilities=$3 WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(CEO)
    .bind("Schedule interviews and manage candidate communications.")
    .execute(&database.pool)
    .await
    .unwrap();
    let not_confirmed = start_input("capability-confirmation", &preview, None, false);
    assert!(matches!(
        apply_goal_start(&database.pool, &Authorized, actor(ORG), &not_confirmed).await,
        Err(GoalStartError::Unprocessable {
            message: "Goal owner capabilities no longer match the Goal; confirm the warning before starting",
            ..
        })
    ));
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM goal_start_requests WHERE org_id=$1::uuid")
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
    set_owner_capabilities(&database, CEO, capable).await;

    // The pending request, active contract, first plan/activity, audit/outbox,
    // and durable wake intent all commit together.
    let start = start_input(" goal-start-roundtrip ", &preview, None, false);
    let result = apply_goal_start(&database.pool, &Authorized, actor(ORG), &start)
        .await
        .unwrap();
    assert!(!result.replayed);
    assert_eq!(result.goal["lifecycle"], "active");
    assert_eq!(result.goal["ownerAgentId"], CEO);
    assert_eq!(result.dispatch.reason, "goal_started");
    assert_eq!(result.dispatch.source, "on_demand");
    assert_eq!(result.dispatch.trigger_detail, "system");
    assert_eq!(result.dispatch.payload["event"], "goal_started");
    assert_eq!(
        result.dispatch.payload["goalStartRequestId"]
            .as_str()
            .is_some(),
        true
    );
    assert_eq!(
        result.dispatch.context_snapshot["goal"]["contractRevision"],
        1
    );
    assert_eq!(result.dispatch.context_snapshot["goalPlan"]["revision"], 1);

    let request_id = result.dispatch.payload["goalStartRequestId"]
        .as_str()
        .unwrap();
    let wakeup_id = result.dispatch.wakeup_request_id.clone();
    let goal_id = result.goal["id"].as_str().unwrap();
    let request = sqlx::query("SELECT status,goal_id::text FROM goal_start_requests WHERE org_id=$1::uuid AND request_key=$2")
        .bind(ORG).bind("goal-start-roundtrip").fetch_one(&database.pool).await.unwrap();
    assert_eq!(sqlx::Row::get::<String, _>(&request, "status"), "completed");
    assert_eq!(sqlx::Row::get::<String, _>(&request, "goal_id"), goal_id);
    let assignment_ref: String = sqlx::query_scalar(
        "SELECT assigned_by_authority_ref FROM goal_owner_assignments WHERE org_id=$1::uuid AND goal_id=$2::uuid AND ends_at IS NULL",
    )
    .bind(ORG)
    .bind(goal_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(assignment_ref, format!("goal_start:{request_id}"));
    let goal_activity_key: String = sqlx::query_scalar(
        "SELECT idempotency_key FROM goal_activities WHERE org_id=$1::uuid AND goal_id=$2::uuid AND activity_kind='progress'",
    )
    .bind(ORG)
    .bind(goal_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(goal_activity_key, format!("goal-start:{request_id}"));
    let activity = sqlx::query("SELECT action,idempotency_key FROM activity_log WHERE org_id=$1::uuid AND entity_type='goal' AND entity_id=$2")
        .bind(ORG).bind(goal_id).fetch_one(&database.pool).await.unwrap();
    assert_eq!(
        sqlx::Row::get::<String, _>(&activity, "action"),
        "goal.started"
    );
    assert_eq!(
        sqlx::Row::get::<String, _>(&activity, "idempotency_key"),
        "goal-start:goal-start-roundtrip"
    );
    let wakeup = sqlx::query("SELECT payload,run_id::text FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG).bind(&wakeup_id).fetch_one(&database.pool).await.unwrap();
    let stored_payload: Value = sqlx::Row::get(&wakeup, "payload");
    assert_eq!(stored_payload["event"], "goal_started");
    assert_eq!(stored_payload["_paperclipWakeContext"]["goalId"], goal_id);
    assert_eq!(sqlx::Row::get::<Option<String>, _>(&wakeup, "run_id"), None);
    let run_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid AND wakeup_request_id=$2::uuid",
    )
    .bind(ORG)
    .bind(&wakeup_id)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(run_count, 0);

    let replay = apply_goal_start(&database.pool, &Authorized, actor(ORG), &start)
        .await
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.goal["id"], result.goal["id"]);
    assert_eq!(replay.dispatch.wakeup_request_id, wakeup_id);
    let request_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM goal_start_requests WHERE org_id=$1::uuid")
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(request_count, 1);
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid AND idempotency_key='goal-start:goal-start-roundtrip'",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(audit_count, 1);
    let wakeup_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid AND idempotency_key=$2",
    )
    .bind(ORG)
    .bind(format!("goal-start:{request_id}"))
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(wakeup_count, 1);

    let reusable_draft_start = start_input("goal-start-reused-draft", &preview, Some(GOAL), false);
    let reused_draft = apply_goal_start(
        &database.pool,
        &Authorized,
        actor(ORG),
        &reusable_draft_start,
    )
    .await
    .unwrap();
    assert!(!reused_draft.replayed);
    assert_eq!(reused_draft.goal["id"], GOAL);
    assert_eq!(
        reused_draft.goal["title"],
        "Publish a verified Goal Workspace release candidate"
    );
    assert_eq!(reused_draft.goal["lifecycle"], "active");

    let changed_preview = compile_goal_start_preview(
        &database.pool,
        ORG,
        &preview_input(
            CEO,
            "Publish a verified Goal Workspace release candidate safely",
        ),
    )
    .await
    .unwrap();
    let changed_packet = start_input("goal-start-roundtrip", &changed_preview, None, false);
    assert!(matches!(
        apply_goal_start(&database.pool, &Authorized, actor(ORG), &changed_packet).await,
        Err(GoalStartError::Conflict(
            "Goal Start request key was reused with a different packet hash"
        ))
    ));

    // A bad reusable draft fails after request insertion but rolls the whole
    // transaction back, proving that no pending key or orphan intent survives.
    let bad_draft = start_input("bad-reusable-draft", &preview, Some(FOREIGN_GOAL), false);
    assert!(matches!(
        apply_goal_start(&database.pool, &Authorized, actor(ORG), &bad_draft).await,
        Err(GoalStartError::Conflict(
            "Reusable Goal Draft was not found in this organization"
        ))
    ));
    let rolled_back_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM goal_start_requests WHERE org_id=$1::uuid AND request_key='bad-reusable-draft'",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(rolled_back_count, 0);
    let stray_wakeup_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM agent_wakeup_requests WHERE org_id=$1::uuid AND reason='goal_started' AND idempotency_key='goal-start:bad-reusable-draft'",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .unwrap();
    assert_eq!(stray_wakeup_count, 0);
}
