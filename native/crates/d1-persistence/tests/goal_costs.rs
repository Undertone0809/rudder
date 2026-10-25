mod support;

use rudder_d1_persistence::{goal_costs, goal_runs};
use serde_json::{Value, json};
use sqlx::Row;
use support::{CEO, Database, GOAL, GOAL_TWO, ORG};

const SECOND_AGENT: &str = "50000000-0000-4000-8000-000000000002";

async fn insert_native_wakeup(
    database: &Database,
    agent_id: &str,
    goal_id: &str,
    task_key: &str,
) -> String {
    sqlx::query(
        "INSERT INTO agents (id,org_id,name,role,status,agent_runtime_type)
         VALUES ($1::uuid,$2::uuid,'Cost test Agent','general','idle','claude_local')
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(agent_id)
    .bind(ORG)
    .execute(&database.pool)
    .await
    .expect("seed the native Claude Agent");
    sqlx::query(
        "UPDATE agents SET agent_runtime_type='claude_local' WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(agent_id)
    .execute(&database.pool)
    .await
    .expect("select the supported Goal owner runtime");
    sqlx::query(
        "UPDATE goals SET owner_agent_id=$2::uuid,lifecycle='active',status='active',
           plan_revision=1 WHERE org_id=$1::uuid AND id=$3::uuid",
    )
    .bind(ORG)
    .bind(agent_id)
    .bind(goal_id)
    .execute(&database.pool)
    .await
    .expect("set the active Goal owner");
    sqlx::query_scalar(
        "INSERT INTO agent_wakeup_requests
           (org_id,agent_id,source,trigger_detail,reason,payload,execution_authority)
         VALUES($1::uuid,$2::uuid,'on_demand','system','goal_started',$3::jsonb,'native_rust')
         RETURNING id::text",
    )
    .bind(ORG)
    .bind(agent_id)
    .bind(
        json!({
            "event":"goal_started",
            "goalId":goal_id,
            "taskKey":format!("goal:{goal_id}:goal_started:{task_key}"),
            "goalStartRequestId":task_key,
            "_paperclipWakeContext":{
                "goalId":goal_id,
                "goal":{"id":goal_id,"title":"Cost settlement Goal"},
                "plan":{"revision":1},
                "continuation":{"summary":"Continue the Goal"}
            }
        })
        .to_string(),
    )
    .fetch_one(&database.pool)
    .await
    .expect("persist a native Goal wakeup")
}

async fn finalize_unlaunched_costed_goal(
    database: &Database,
    agent_id: &str,
    goal_id: &str,
) -> String {
    let wakeup_id = insert_native_wakeup(database, agent_id, goal_id, "cost-test").await;
    let claim = goal_runs::claim_wakeup(&database.pool, ORG, &wakeup_id)
        .await
        .expect("claim native Goal wakeup")
        .expect("owner has an unspent launch permit");
    let usage = json!({
        "rawInputTokens":100,
        "rawCachedInputTokens":10,
        "rawOutputTokens":50,
        "billingType":"metered_api",
        "costUsd":0.25,
        "provider":"anthropic",
        "biller":"anthropic",
        "model":"claude-test"
    });
    let result = json!({
        "provider":"anthropic",
        "biller":"anthropic",
        "model":"claude-test",
        "sessionId":"synthetic-session"
    });
    assert!(
        goal_runs::finalize_unlaunched(&database.pool, &claim, "succeeded", None, &usage, &result,)
            .await
            .expect("finalize a no-process Goal result")
    );
    claim.run_id
}

async fn insert_budget_policy(
    database: &Database,
    scope_type: &str,
    scope_id: &str,
    amount: i32,
    warn_percent: i32,
    hard_stop: bool,
    notify: bool,
) -> String {
    sqlx::query_scalar(
        "INSERT INTO budget_policies
           (org_id,scope_type,scope_id,metric,window_kind,amount,warn_percent,
            hard_stop_enabled,notify_enabled,is_active)
         VALUES($1::uuid,$2,$3::uuid,'billed_cents','calendar_month_utc',$4,$5,$6,$7,true)
         RETURNING id::text",
    )
    .bind(ORG)
    .bind(scope_type)
    .bind(scope_id)
    .bind(amount)
    .bind(warn_percent)
    .bind(hard_stop)
    .bind(notify)
    .fetch_one(&database.pool)
    .await
    .expect("insert budget policy")
}

async fn scalar<T>(database: &Database, query: &str, run_id: &str) -> T
where
    for<'row> T: sqlx::Decode<'row, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + Unpin,
{
    sqlx::query_scalar(query)
        .bind(run_id)
        .fetch_one(&database.pool)
        .await
        .expect("read Goal settlement result")
}

async fn make_terminal_effects_due(database: &Database, run_id: &str) {
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin marker transaction");
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:goal_run_cost',true)")
        .execute(&mut *tx)
        .await
        .expect("set native Goal write marker");
    sqlx::query(
        "UPDATE heartbeat_runs SET terminal_effects_next_attempt_at=statement_timestamp()-interval '1 second'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(run_id)
    .execute(&mut *tx)
    .await
    .expect("make the recorded retry immediately eligible");
    tx.commit().await.expect("commit due retry marker");
}

#[tokio::test(flavor = "multi_thread")]
async fn native_goal_cost_event_rollups_runtime_totals_and_replay_are_exact_once() {
    let database = Database::start().await;
    let run_id = finalize_unlaunched_costed_goal(&database, CEO, GOAL).await;

    assert_eq!(
        goal_costs::list_due_terminal_effects(&database.pool)
            .await
            .expect("list unsettled terminal effects")
            .len(),
        1
    );
    assert!(
        goal_costs::settle_terminal_effects(&database.pool, ORG, &run_id)
            .await
            .expect("settle cost and budget effects")
    );
    assert!(
        !goal_costs::settle_terminal_effects(&database.pool, ORG, &run_id)
            .await
            .expect("completed terminal effects are not claimable")
    );

    let event = sqlx::query(
        "SELECT agent_id::text AS agent_id,goal_id::text AS goal_id,
                heartbeat_run_id::text AS run_id,idempotency_key,provider,biller,
                billing_type,input_tokens,cached_input_tokens,output_tokens,cost_cents,
                budget_evaluated_at IS NOT NULL AS budget_evaluated
         FROM cost_events WHERE org_id=$1::uuid AND heartbeat_run_id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read the unique finalizer cost event");
    assert_eq!(event.try_get::<String, _>("agent_id").unwrap(), CEO);
    assert_eq!(event.try_get::<String, _>("goal_id").unwrap(), GOAL);
    assert_eq!(event.try_get::<String, _>("run_id").unwrap(), run_id);
    assert_eq!(
        event.try_get::<String, _>("idempotency_key").unwrap(),
        format!("heartbeat-run-finalizer:{run_id}")
    );
    assert_eq!(event.try_get::<String, _>("provider").unwrap(), "anthropic");
    assert_eq!(event.try_get::<String, _>("biller").unwrap(), "anthropic");
    assert_eq!(
        event.try_get::<String, _>("billing_type").unwrap(),
        "metered_api"
    );
    assert_eq!(event.try_get::<i32, _>("input_tokens").unwrap(), 100);
    assert_eq!(event.try_get::<i32, _>("cached_input_tokens").unwrap(), 10);
    assert_eq!(event.try_get::<i32, _>("output_tokens").unwrap(), 50);
    assert_eq!(event.try_get::<i32, _>("cost_cents").unwrap(), 25);
    assert!(event.try_get::<bool, _>("budget_evaluated").unwrap());

    let (agent_spend, org_spend): (i32, i32) = sqlx::query_as(
        "SELECT a.spent_monthly_cents,o.spent_monthly_cents
         FROM agents a CROSS JOIN organizations o
         WHERE a.org_id=$1::uuid AND a.id=$2::uuid AND o.id=$1::uuid",
    )
    .bind(ORG)
    .bind(CEO)
    .fetch_one(&database.pool)
    .await
    .expect("read current spend totals");
    assert_eq!((agent_spend, org_spend), (25, 25));
    let runtime = sqlx::query(
        "SELECT last_run_id::text AS last_run_id,last_run_status,total_input_tokens,
                total_cached_input_tokens,total_output_tokens,total_cost_cents,session_id
         FROM agent_runtime_state WHERE org_id=$1::uuid AND agent_id=$2::uuid",
    )
    .bind(ORG)
    .bind(CEO)
    .fetch_one(&database.pool)
    .await
    .expect("read runtime usage totals");
    assert_eq!(runtime.try_get::<String, _>("last_run_id").unwrap(), run_id);
    assert_eq!(
        runtime.try_get::<String, _>("last_run_status").unwrap(),
        "succeeded"
    );
    assert_eq!(
        runtime.try_get::<i64, _>("total_input_tokens").unwrap(),
        110
    );
    assert_eq!(
        runtime
            .try_get::<i64, _>("total_cached_input_tokens")
            .unwrap(),
        10
    );
    assert_eq!(
        runtime.try_get::<i64, _>("total_output_tokens").unwrap(),
        50
    );
    assert_eq!(runtime.try_get::<i64, _>("total_cost_cents").unwrap(), 25);
    assert_eq!(
        runtime.try_get::<String, _>("session_id").unwrap(),
        "synthetic-session"
    );
    let count: i64 = scalar(
        &database,
        "SELECT count(*)::bigint FROM cost_events WHERE heartbeat_run_id=$1::uuid",
        &run_id,
    )
    .await;
    assert_eq!(count, 1);
    let settled: bool = scalar(
        &database,
        "SELECT NOT terminal_effects_pending FROM heartbeat_runs WHERE id=$1::uuid",
        &run_id,
    )
    .await;
    assert!(settled);
}

#[tokio::test(flavor = "multi_thread")]
async fn native_goal_audit_failure_keeps_ledger_and_replays_budget_without_double_charge() {
    let database = Database::start().await;
    insert_budget_policy(&database, "organization", ORG, 20, 50, false, true).await;
    let run_id = finalize_unlaunched_costed_goal(&database, CEO, GOAL).await;
    database
        .sql(
            "CREATE FUNCTION fail_native_goal_budget_audit() RETURNS trigger LANGUAGE plpgsql AS $$
               BEGIN IF NEW.action='budget.soft_threshold_crossed' THEN
                 RAISE EXCEPTION 'synthetic budget audit failure';
               END IF; RETURN NEW; END; $$;
             CREATE TRIGGER fail_native_goal_budget_audit_trigger BEFORE INSERT ON activity_log
               FOR EACH ROW EXECUTE FUNCTION fail_native_goal_budget_audit();",
        )
        .await;

    assert!(
        goal_costs::settle_terminal_effects(&database.pool, ORG, &run_id)
            .await
            .is_err()
    );
    let after_failure = sqlx::query(
        "SELECT terminal_effects_pending,terminal_effects_last_error IS NOT NULL AS has_error
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read retryable run state");
    assert!(
        after_failure
            .try_get::<bool, _>("terminal_effects_pending")
            .unwrap()
    );
    assert!(after_failure.try_get::<bool, _>("has_error").unwrap());
    let ledger = sqlx::query(
        "SELECT count(*)::bigint AS event_count,coalesce(max(cost_cents),0)::int AS cost_cents,
                bool_and(budget_evaluated_at IS NULL) AS unevaluated
         FROM cost_events WHERE org_id=$1::uuid AND heartbeat_run_id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read committed ledger after audit failure");
    assert_eq!(ledger.try_get::<i64, _>("event_count").unwrap(), 1);
    assert_eq!(ledger.try_get::<i32, _>("cost_cents").unwrap(), 25);
    assert!(ledger.try_get::<bool, _>("unevaluated").unwrap());
    database
        .sql(
            "DROP TRIGGER fail_native_goal_budget_audit_trigger ON activity_log;
             DROP FUNCTION fail_native_goal_budget_audit();",
        )
        .await;
    make_terminal_effects_due(&database, &run_id).await;

    assert!(
        goal_costs::settle_terminal_effects(&database.pool, ORG, &run_id)
            .await
            .expect("replay and complete the failed budget effect")
    );
    let count: i64 = scalar(
        &database,
        "SELECT count(*)::bigint FROM cost_events WHERE heartbeat_run_id=$1::uuid",
        &run_id,
    )
    .await;
    let (cost, evaluated): (i32, bool) = sqlx::query_as(
        "SELECT cost_cents,budget_evaluated_at IS NOT NULL FROM cost_events
         WHERE org_id=$1::uuid AND heartbeat_run_id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read replayed cost event");
    let (rollup, spent, runtime_cost): (i32, i32, i64) = sqlx::query_as(
        "SELECT r.spend_cents,a.spent_monthly_cents,s.total_cost_cents
         FROM cost_monthly_spend_rollups r JOIN agents a ON a.id=$2::uuid
         JOIN agent_runtime_state s ON s.agent_id=a.id
         WHERE r.org_id=$1::uuid AND r.scope_type='organization' AND r.scope_id=$1::text
           AND r.month_start=date_trunc('month',statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",
    )
    .bind(ORG)
    .bind(CEO)
    .fetch_one(&database.pool)
    .await
    .expect("read totals after retry");
    assert_eq!(count, 1);
    assert_eq!(cost, 25);
    assert!(evaluated);
    assert_eq!((rollup, spent, runtime_cost), (25, 25, 25));
    let (incidents, audits): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM budget_incidents WHERE org_id=$1::uuid),
                (SELECT count(*) FROM activity_log WHERE org_id=$1::uuid
                   AND action='budget.soft_threshold_crossed')",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .expect("read recovered budget audit");
    assert_eq!((incidents, audits), (1, 1));
}

#[tokio::test(flavor = "multi_thread")]
async fn hard_budget_pause_cancels_pending_wakeups_and_requests_owned_run_stop() {
    let database = Database::start().await;
    insert_budget_policy(&database, "organization", ORG, 10, 80, true, true).await;
    let active_wakeup =
        insert_native_wakeup(&database, SECOND_AGENT, GOAL_TWO, "active-second-run").await;
    let active_claim = goal_runs::claim_wakeup(&database.pool, ORG, &active_wakeup)
        .await
        .expect("claim the other Agent's Goal run")
        .expect("a different Agent can be active while the billed run settles");
    let pending_wakeup = insert_native_wakeup(
        &database,
        SECOND_AGENT,
        GOAL_TWO,
        "pending-after-active-run",
    )
    .await;
    let billed_run = finalize_unlaunched_costed_goal(&database, CEO, GOAL).await;

    assert!(
        goal_costs::settle_terminal_effects(&database.pool, ORG, &billed_run)
            .await
            .expect("evaluate hard threshold and settle finalizer")
    );
    let (org_status, pause_reason): (String, Option<String>) =
        sqlx::query_as("SELECT status,pause_reason FROM organizations WHERE id=$1::uuid")
            .bind(ORG)
            .fetch_one(&database.pool)
            .await
            .expect("read organization pause");
    assert_eq!(
        (org_status.as_str(), pause_reason.as_deref()),
        ("paused", Some("budget"))
    );
    let (status, error_code, finished_at): (String, Option<String>, Option<String>) =
        sqlx::query_as(
            "SELECT status,error_code,finished_at::text FROM heartbeat_runs WHERE id=$1::uuid",
        )
        .bind(&active_claim.run_id)
        .fetch_one(&database.pool)
        .await
        .expect("read active run's nonterminal stop intent");
    assert_eq!(status, "running");
    assert_eq!(error_code.as_deref(), Some("cancel_requested"));
    assert!(finished_at.is_none());
    let pending_status: String = sqlx::query_scalar(
        "SELECT status FROM agent_wakeup_requests WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(pending_wakeup)
    .fetch_one(&database.pool)
    .await
    .expect("read cancelled pending Goal wakeup");
    assert_eq!(pending_status, "cancelled");
    let incident = sqlx::query(
        "SELECT i.threshold_type,i.status,i.amount_observed,i.approval_id::text AS approval_id,
                a.type AS approval_type,a.status AS approval_status,a.payload
         FROM budget_incidents i JOIN approvals a ON a.id=i.approval_id
         WHERE i.org_id=$1::uuid AND i.policy_id=(SELECT id FROM budget_policies
           WHERE org_id=$1::uuid AND scope_type='organization' LIMIT 1)
           AND i.threshold_type='hard'",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .expect("read hard-stop incident and approval");
    assert_eq!(incident.try_get::<String, _>("status").unwrap(), "open");
    assert_eq!(incident.try_get::<i32, _>("amount_observed").unwrap(), 25);
    assert_eq!(
        incident.try_get::<String, _>("approval_type").unwrap(),
        "budget_override_required"
    );
    assert_eq!(
        incident.try_get::<String, _>("approval_status").unwrap(),
        "pending"
    );
    let payload: Value = incident.try_get("payload").unwrap();
    assert_eq!(payload["thresholdType"], "hard");
    assert_eq!(payload["budgetAmount"], 10);
    assert_eq!(payload["observedAmount"], 25);
    let audit_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM activity_log WHERE org_id=$1::uuid
           AND action IN ('budget.soft_threshold_crossed','budget.hard_threshold_crossed')",
    )
    .bind(ORG)
    .fetch_one(&database.pool)
    .await
    .expect("read budget audit actions");
    assert_eq!(audit_count, 2);
}
