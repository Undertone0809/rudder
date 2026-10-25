mod support;

use rudder_d1_persistence::goal_runs::{self, GoalRunClaim};
use serde_json::json;
use sqlx::Row;
use support::{CEO, Database, GOAL, ORG};

const SECOND_AGENT: &str = "50000000-0000-4000-8000-000000000002";
const SECOND_GOAL: &str = "30000000-0000-4000-8000-000000000002";

async fn goal_wakeup(database: &Database, execution_authority: &str) -> String {
    sqlx::query("UPDATE agents SET agent_runtime_type='claude_local', status='idle' WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG)
        .bind(CEO)
        .execute(&database.pool)
        .await
        .expect("select the supported Goal owner runtime");
    sqlx::query("UPDATE goals SET owner_agent_id=$2::uuid, lifecycle='active', status='active', plan_revision=1 WHERE org_id=$1::uuid AND id=$3::uuid")
        .bind(ORG)
        .bind(CEO)
        .bind(GOAL)
        .execute(&database.pool)
        .await
        .expect("activate the Goal for its owner");
    sqlx::query_scalar(
        "INSERT INTO agent_wakeup_requests
           (org_id,agent_id,source,trigger_detail,reason,payload,execution_authority)
         VALUES($1::uuid,$2::uuid,'on_demand','system','goal_started',$3::jsonb,$4)
         RETURNING id::text",
    )
    .bind(ORG)
    .bind(CEO)
    .bind(
        json!({
            "event": "goal_started",
            "goalId": GOAL,
            "taskKey": format!("goal:{GOAL}:goal_started:request"),
            "goalStartRequestId": "request",
            "_paperclipWakeContext": {
                "goalId": GOAL,
                "goal": { "id": GOAL, "title": "Synthetic goal" },
                "plan": { "revision": 1 },
                "continuation": { "summary": "Continue the goal" }
            }
        })
        .to_string(),
    )
    .bind(execution_authority)
    .fetch_one(&database.pool)
    .await
    .expect("insert Goal wake intent")
}

async fn second_goal_wakeup(database: &Database) -> String {
    sqlx::query(
        "INSERT INTO agents (id,org_id,name,role,status,agent_runtime_type)
         VALUES ($1::uuid,$2::uuid,'Second synthetic Agent','general','idle','claude_local')",
    )
    .bind(SECOND_AGENT)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("seed a second native Claude Agent");
    sqlx::query(
        "UPDATE goals SET owner_agent_id=$2::uuid,lifecycle='active',status='active',
           focus=false,plan_revision=1 WHERE org_id=$1::uuid AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(SECOND_AGENT)
    .bind(SECOND_GOAL)
    .execute(&database.pool)
    .await
    .expect("activate a second Goal under its Agent");
    sqlx::query_scalar(
        "INSERT INTO agent_wakeup_requests
           (org_id,agent_id,source,trigger_detail,reason,payload,execution_authority)
         VALUES($1::uuid,$2::uuid,'on_demand','system','goal_started',$3::jsonb,'native_rust')
         RETURNING id::text",
    )
    .bind(ORG)
    .bind(SECOND_AGENT)
    .bind(
        json!({
            "event": "goal_started",
            "goalId": SECOND_GOAL,
            "taskKey": format!("goal:{SECOND_GOAL}:goal_started:request"),
            "goalStartRequestId": "request",
            "_paperclipWakeContext": {
                "goalId": SECOND_GOAL,
                "goal": { "id": SECOND_GOAL, "title": "Second synthetic goal" },
                "plan": { "revision": 1 },
                "continuation": { "summary": "Continue the second goal" }
            }
        })
        .to_string(),
    )
    .fetch_one(&database.pool)
    .await
    .expect("insert the second Goal wake intent")
}

async fn run_snapshot(pool: &sqlx::PgPool, run_id: &str) -> (String, String, String, String) {
    let row = sqlx::query(
        "SELECT execution_authority,scene,target_type,target_id,status
         FROM heartbeat_runs WHERE id=$1::uuid",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await
    .expect("read native Goal Run");
    (
        row.try_get("execution_authority").unwrap(),
        row.try_get("scene").unwrap(),
        row.try_get("target_type").unwrap(),
        row.try_get("status").unwrap(),
    )
}

async fn claim_wakeup(database: &Database, wakeup_id: &str) -> Option<GoalRunClaim> {
    goal_runs::claim_wakeup(&database.pool, ORG, wakeup_id)
        .await
        .expect("claim one native Goal wakeup")
}

#[tokio::test(flavor = "multi_thread")]
async fn native_goal_wakeup_has_one_atomic_owner_and_cleanup_gated_cancel_projection() {
    let database = Database::start().await;
    let wakeup_id = goal_wakeup(&database, "native_rust").await;
    let pending = goal_runs::list_due_native_goal_wakeups(&database.pool)
        .await
        .expect("list due native Goal wakeups");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].organization_id, ORG);
    assert_eq!(pending[0].wakeup_request_id, wakeup_id);

    let (left, right) = tokio::join!(
        goal_runs::claim_wakeup(&database.pool, ORG, &wakeup_id),
        goal_runs::claim_wakeup(&database.pool, ORG, &wakeup_id),
    );
    let mut claims = [left.expect("first claim"), right.expect("second claim")]
        .into_iter()
        .flatten();
    let mut owned = claims.next().expect("one worker owns the wakeup");
    assert!(
        claims.next().is_none(),
        "only one worker may claim this wakeup"
    );
    assert!(owned.owner_token.len() >= 32);
    assert_eq!(owned.goal_id, GOAL);
    assert_eq!(owned.agent_context["id"], CEO);
    assert_eq!(owned.agent_context["orgId"], ORG);
    assert_eq!(owned.agent_context["name"], owned.agent_name);
    assert_eq!(owned.agent_context["role"], "ceo");
    assert_eq!(owned.agent_context["agentRuntimeType"], "claude_local");
    assert!(owned.agent_context["agentRuntimeConfig"].is_object());
    assert_eq!(owned.context_snapshot["goalId"], GOAL);
    assert_eq!(
        owned.context_snapshot["goal"]["title"], "Synthetic goal",
        "the legacy _paperclipWakeContext payload is preserved for the worker"
    );
    assert_eq!(owned.context_snapshot["plan"]["revision"], 1);
    assert_eq!(owned.attempt_epoch, 1);
    assert_eq!(
        run_snapshot(&database.pool, &owned.run_id).await,
        (
            "native_rust".into(),
            "heartbeat".into(),
            "wakeup_request".into(),
            "running".into(),
        )
    );
    let row = sqlx::query(
        "SELECT w.execution_authority,w.status,w.run_id::text AS run_id,
                a.status AS attempt_status,a.owner_token,a.attempt_epoch
         FROM agent_wakeup_requests w
         JOIN heartbeat_run_attempts a ON a.org_id=w.org_id AND a.run_id=w.run_id
         WHERE w.org_id=$1::uuid AND w.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&wakeup_id)
    .fetch_one(&database.pool)
    .await
    .expect("read atomic run and attempt link");
    assert_eq!(
        row.try_get::<String, _>("execution_authority").unwrap(),
        "native_rust"
    );
    assert_eq!(row.try_get::<String, _>("status").unwrap(), "claimed");
    assert_eq!(row.try_get::<String, _>("run_id").unwrap(), owned.run_id);
    assert_eq!(
        row.try_get::<String, _>("attempt_status").unwrap(),
        "started"
    );
    assert_eq!(
        row.try_get::<String, _>("owner_token").unwrap(),
        owned.owner_token
    );
    assert_eq!(row.try_get::<i32, _>("attempt_epoch").unwrap(), 1);
    assert!(claim_wakeup(&database, &wakeup_id).await.is_none());
    assert!(owned.take_connection_launch_permit().is_some());
    assert!(owned.take_connection_launch_permit().is_none());
    assert!(
        !goal_runs::cancellation_requested(&database.pool, &owned)
            .await
            .expect("an active Goal Run has no stop intent yet")
    );

    assert!(
        goal_runs::request_cancel(
            &database.pool,
            ORG,
            &owned.run_id,
            "Cancelled in the native Goal owner test",
        )
        .await
        .expect("request native cancellation")
    );
    assert!(
        goal_runs::cancellation_requested(&database.pool, &owned)
            .await
            .expect("observe the durable cancellation request")
    );
    assert!(
        !goal_runs::renew_lease(&database.pool, &owned, std::time::Duration::from_secs(30),)
            .await
            .expect("stopped work cannot renew its lease")
    );
    let cancelled_without_cleanup: (String, Option<String>) = sqlx::query_as(
        "SELECT status,process_exited_at::text FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&owned.run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read cancellation before host cleanup");
    assert_eq!(cancelled_without_cleanup.0, "running");
    assert!(cancelled_without_cleanup.1.is_none());
    let stop_intent: (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT error_code,error,finished_at::text FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&owned.run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read the visible nonterminal stop intent");
    assert_eq!(stop_intent.0.as_deref(), Some("cancel_requested"));
    assert_eq!(
        stop_intent.1.as_deref(),
        Some("Cancelled in the native Goal owner test")
    );
    assert!(stop_intent.2.is_none());
    let attempt_before_cleanup: (String, Option<String>) = sqlx::query_as(
        "SELECT status,finished_at::text FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND run_id=$2::uuid",
    )
    .bind(ORG)
    .bind(&owned.run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read the still-running provider attempt");
    assert_eq!(attempt_before_cleanup.0, "started");
    assert!(attempt_before_cleanup.1.is_none());
    let wakeup_status: String = sqlx::query_scalar(
        "SELECT status FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&wakeup_id)
    .fetch_one(&database.pool)
    .await
    .expect("read wakeup before cleanup proof");
    assert_eq!(wakeup_status, "claimed");
    assert!(
        goal_runs::renew_cleanup_lease(&database.pool, &owned, std::time::Duration::from_secs(30),)
            .await
            .expect("cleanup owner can retain its live lease without authorizing work")
    );
    let still_active_after_missing_cleanup: (String, Option<String>) = sqlx::query_as(
        "SELECT status,process_exited_at::text FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&owned.run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read the nonterminal Run after missing cleanup evidence");
    assert_eq!(still_active_after_missing_cleanup.0, "running");
    assert!(still_active_after_missing_cleanup.1.is_none());
    let wakeup_status_after_missing_cleanup: String = sqlx::query_scalar(
        "SELECT status FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&wakeup_id)
    .fetch_one(&database.pool)
    .await
    .expect("read wakeup after missing cleanup evidence");
    assert_eq!(wakeup_status_after_missing_cleanup, "claimed");
}

#[tokio::test(flavor = "multi_thread")]
async fn native_goal_owner_does_not_consume_legacy_wakeups() {
    let database = Database::start().await;
    let wakeup_id = goal_wakeup(&database, "legacy_ts").await;
    assert!(claim_wakeup(&database, &wakeup_id).await.is_none());
    assert!(
        goal_runs::list_due_native_goal_wakeups(&database.pool)
            .await
            .expect("list due native Goal wakeups")
            .is_empty(),
        "legacy-owned wakeups are not visible to the native queue scan"
    );
    let counts: (i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid),
           (SELECT count(*) FROM heartbeat_run_attempts WHERE org_id=$1::uuid)",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .expect("verify legacy ownership has no Rust effects");
    assert_eq!(counts, (0, 0));
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_currently_focused_goal_is_claimed_across_agents() {
    let database = Database::start().await;
    let focused_wakeup = goal_wakeup(&database, "native_rust").await;
    sqlx::query("UPDATE goals SET focus=true WHERE org_id=$1::uuid AND id=$2::uuid")
        .bind(ORG)
        .bind(GOAL)
        .execute(&database.pool)
        .await
        .expect("focus the first Goal");
    let other_wakeup = second_goal_wakeup(&database).await;

    let due = goal_runs::list_due_native_goal_wakeups(&database.pool)
        .await
        .expect("scan eligible native Goal wakeups");
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].wakeup_request_id, focused_wakeup);

    let focused_claim = claim_wakeup(&database, &focused_wakeup).await;
    assert!(
        focused_claim.is_some(),
        "the focused Goal can claim its run"
    );
    assert!(
        claim_wakeup(&database, &other_wakeup).await.is_none(),
        "a different Agent cannot start work for a Goal while another Goal is focused"
    );
    let other_run_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM heartbeat_runs WHERE org_id=$1::uuid AND goal_id=$2::uuid",
    )
    .bind(ORG)
    .bind(SECOND_GOAL)
    .fetch_one(&database.pool)
    .await
    .expect("verify the unfocused Goal did not create a Run");
    assert_eq!(other_run_count, 0);
}
