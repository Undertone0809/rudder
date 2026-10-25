mod support;

use rudder_d1_persistence::{
    goal_costs,
    goal_runs::{self, GoalRunClaim},
};
use rudder_native_process_transport::{
    HostConnection, HostEvent, OwnedHost, read_durable_cleanup_receipt,
};
use rudder_native_protocol::{Command, ProtocolVersion};
use serde_json::{Value, json};
use sqlx::Row;
use std::{collections::BTreeMap, path::Path, time::Duration};
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

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST and disposable PostgreSQL; launches only a synthetic local child"]
async fn expired_native_goal_owner_recovers_from_external_host_cleanup_receipt() {
    let database = Database::start().await;
    let wakeup_id = goal_wakeup(&database, "native_rust").await;
    let mut claim = claim_wakeup(&database, &wakeup_id)
        .await
        .expect("the Goal wakeup has a native owner");
    let runtime_root = tempfile::tempdir().expect("create managed process-host runtime root");
    let runtime_path = runtime_root
        .path()
        .canonicalize()
        .expect("canonicalize process-host runtime root");
    let process_host = std::env::var_os("RUDDER_TEST_PROCESS_HOST")
        .expect("build rudder-process-host and set RUDDER_TEST_PROCESS_HOST");
    let mut host = OwnedHost::launch_external(
        HostConnection {
            request_id: claim.attempt_id.clone(),
            run_id: claim.run_id.clone(),
            attempt_id: claim.attempt_id.clone(),
            owner_token: claim.owner_token.clone(),
        },
        Path::new(&process_host),
        claim.take_connection_launch_permit(),
    )
    .expect("launch the external Rust process host with this persisted attempt claim");
    host.send(Command::StartProcess {
        protocol_version: Some(ProtocolVersion::default()),
        request_id: Some(claim.attempt_id.clone()),
        executable: "/bin/sh".to_owned(),
        argv: vec!["-c".to_owned(), "sleep 30".to_owned()],
        cwd: runtime_path.to_string_lossy().into_owned(),
        env: BTreeMap::new(),
        owner_token: Some(claim.owner_token.clone()),
        runtime_root: Some(runtime_path.to_string_lossy().into_owned()),
        stdin: None,
        interactive_stdin: true,
        grace_ms: Some(100),
    })
    .expect("send synthetic provider launch to the process host");
    let process_id = loop {
        match host
            .receive(Duration::from_secs(10))
            .expect("receive host startup lifecycle")
        {
            HostEvent::Lifecycle(event) if event["type"] == "spawned" => {
                break event["pid"].as_u64().expect("spawned child PID") as i32;
            }
            HostEvent::Lifecycle(event) if event["type"] == "terminal" => {
                panic!("synthetic child terminated before caller loss: {event}");
            }
            HostEvent::Failure => panic!("external host failed before child spawn"),
            _ => {}
        }
    };
    assert!(
        goal_runs::record_process_started(&database.pool, &claim, process_id)
            .await
            .expect("persist the started process identity"),
        "the matching claim records its child before it is lost"
    );
    let mut tx = database
        .pool
        .begin()
        .await
        .expect("begin expired-owner fixture");
    sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:goal_run',true)")
        .execute(&mut *tx)
        .await
        .expect("authorize the native Goal lease fixture update");
    sqlx::query(
        "UPDATE heartbeat_runs SET execution_lease_expires_at=statement_timestamp()-interval '1 second'
         WHERE org_id=$1::uuid AND id=$2::uuid AND execution_owner_token=$3",
    )
    .bind(ORG)
    .bind(&claim.run_id)
    .bind(&claim.owner_token)
    .execute(&mut *tx)
    .await
        .expect("expire the owner lease after simulated caller loss");
    tx.commit().await.expect("commit the expired owner fixture");

    // Dropping the original caller closes its command pipe. The real external
    // process host reaps the synthetic child and durably writes its receipt.
    drop(host);
    let operation_root = runtime_path.join(&claim.owner_token);
    let descriptor_path = operation_root.join("owner-descriptor.json");
    let receipt_path = operation_root.join("terminal-receipt.json");
    assert!(
        descriptor_path.is_file(),
        "owner identity is durably recorded"
    );
    assert!(
        receipt_path.is_file(),
        "host wrote its terminal cleanup receipt"
    );
    let original_receipt = std::fs::read(&receipt_path).expect("read cleanup receipt");

    let expired = goal_runs::list_expired_native_goal_runs(&database.pool)
        .await
        .expect("find the expired native Goal owner")
        .into_iter()
        .find(|run| run.run_id == claim.run_id)
        .expect("the linked native Goal attempt remains recoverable");
    let mut forged_identity: Value = serde_json::from_slice(&original_receipt)
        .expect("parse process-host receipt for mismatch test");
    forged_identity["opaqueOwnerToken"] =
        Value::String("ffffffff-ffff-4fff-8fff-ffffffffffff".to_owned());
    std::fs::write(&receipt_path, forged_identity.to_string())
        .expect("write mismatched receipt identity");
    assert!(
        read_durable_cleanup_receipt(
            &runtime_path,
            &expired.run_id,
            &expired.attempt_id,
            &expired.owner_token,
            expired.connection_epoch,
            &expired.connection_claim_id,
        )
        .is_err(),
        "a receipt with another owner token is not cleanup proof"
    );
    goal_runs::record_cleanup_unknown(&database.pool, &expired)
        .await
        .expect("leave an operator-visible unresolved owner warning");
    let unresolved: (String, Option<String>, bool) = sqlx::query_as(
        "SELECT status,execution_owner_token,process_exited_at IS NOT NULL
         FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&claim.run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read the mismatched-receipt run state");
    assert_eq!(
        unresolved,
        ("running".to_owned(), Some(claim.owner_token.clone()), false)
    );

    std::fs::write(&receipt_path, original_receipt).expect("restore exact host cleanup receipt");
    let receipt = read_durable_cleanup_receipt(
        &runtime_path,
        &expired.run_id,
        &expired.attempt_id,
        &expired.owner_token,
        expired.connection_epoch,
        &expired.connection_claim_id,
    )
    .expect("read matching process-host cleanup receipt")
    .expect("matching receipt exists");
    assert!(
        goal_runs::recover_expired_with_cleanup_receipt(&database.pool, &expired, &receipt)
            .await
            .expect("recover the stopped owner after proven cleanup"),
        "the exact matching cleanup receipt releases the stale claim"
    );
    assert!(
        !goal_runs::recover_expired_with_cleanup_receipt(&database.pool, &expired, &receipt)
            .await
            .expect("repeat recovery safely"),
        "recovery is idempotent and cannot finalize twice"
    );
    assert!(
        goal_costs::settle_terminal_effects(&database.pool, ORG, &claim.run_id)
            .await
            .expect("settle recovered terminal effects"),
        "terminal settlement clears the ownership hold"
    );

    let recovered: (String, Option<String>, bool, bool, Value) = sqlx::query_as(
        "SELECT r.status,r.error_code,r.process_exited_at IS NOT NULL,
                r.usage_json IS NULL,r.result_json
         FROM heartbeat_runs r WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&claim.run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read recovered native Goal run");
    assert_eq!(recovered.0, "failed");
    assert_eq!(recovered.1.as_deref(), Some("process_lost"));
    assert!(recovered.2, "process host proved the child exited");
    assert!(recovered.3, "unknown usage remains SQL NULL");
    assert_eq!(recovered.4["ownerRecovery"]["providerResult"], "unknown");
    assert_eq!(recovered.4["ownerRecovery"]["usage"], "unknown");

    let terminal: (String, String, bool, String) = sqlx::query_as(
        "SELECT r.status,w.status,r.terminal_effects_pending,a.status
         FROM heartbeat_runs r
         JOIN agent_wakeup_requests w ON w.org_id=r.org_id AND w.id=r.wakeup_request_id
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&claim.run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read settled run, wakeup and attempt");
    assert_eq!(
        terminal,
        ("failed".into(), "failed".into(), false, "failed".into())
    );
    let ledger_state: (i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT count(*) FROM heartbeat_run_attempts WHERE org_id=$1::uuid AND run_id=$2::uuid),
           (SELECT count(*) FROM cost_events WHERE org_id=$1::uuid AND heartbeat_run_id=$2::uuid)",
    )
    .bind(ORG)
    .bind(&claim.run_id)
    .fetch_one(&database.pool)
    .await
    .expect("verify no provider retry or fabricated zero-cost event");
    assert_eq!(ledger_state, (1, 0));

    let next_wakeup = sqlx::query_scalar::<_, String>(
        "INSERT INTO agent_wakeup_requests
           (org_id,agent_id,source,trigger_detail,reason,payload,execution_authority)
         VALUES($1::uuid,$2::uuid,'on_demand','system','goal_started',$3::jsonb,'native_rust')
         RETURNING id::text",
    )
    .bind(ORG)
    .bind(CEO)
    .bind(
        json!({
            "event":"goal_started",
            "goalId":GOAL,
            "taskKey":format!("goal:{GOAL}:goal_started:after-recovery"),
            "goalStartRequestId":"after-recovery",
            "_paperclipWakeContext":{"goalId":GOAL,"goal":{"id":GOAL,"title":"Synthetic goal"}}
        })
        .to_string(),
    )
    .fetch_one(&database.pool)
    .await
    .expect("queue another wakeup for the recovered Agent");
    assert!(
        claim_wakeup(&database, &next_wakeup).await.is_some(),
        "the recovered Agent can accept another run instead of remaining locked"
    );
}
