//! Real PostgreSQL + owned process fixture for the assembled internal driver.
#[path = "../../../d1-persistence/tests/support/mod.rs"]
mod support;
use super::*;
use crate::native_agent_jwt::NativeAgentJwtConfig;
use rudder_d1_persistence::{
    agent_core::{NativeAgentAccess, NativeAgentAuthorizer, OrganizationWorkspaceHost},
    agent_execution::{AgentExecutionActor, AgentWakeRequest},
};
use serde_json::json;
use sqlx::{PgConnection, Row};
use std::{future::Future, path::PathBuf, pin::Pin};
struct Board;
impl NativeAgentAuthorizer for Board {
    fn revalidate<'a>(
        &'a self,
        _: &'a mut PgConnection,
        org: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<NativeAgentAccess, sqlx::Error>> + Send + 'a>> {
        Box::pin(async move {
            Ok(if org == support::ORG {
                NativeAgentAccess::Authorized
            } else {
                NativeAgentAccess::Forbidden
            })
        })
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL188 and prebuilt RUDDER_TEST_PROCESS_HOST"]
async fn assembled_process_driver_persists_live_logs_terminal_effects_and_retry() {
    let database = support::Database::start().await;
    let root = tempfile::tempdir().unwrap();
    let path = root.path();
    let operator = path.join("operator");
    let cwd = path.join("cwd");
    std::fs::create_dir_all(&operator).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    let agent = uuid::Uuid::new_v4().to_string();
    let config = json!({"command":"/bin/sh","args":["-c","printf 'driver stdout\\n'; printf 'driver stderr\\n' >&2"],"cwd":cwd});
    sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type,agent_runtime_config,runtime_config) VALUES($1::uuid,$2::uuid,'Assembled native driver','general','idle','process',$3::jsonb,'{}')").bind(&agent).bind(support::ORG).bind(config).execute(&database.pool).await.unwrap();
    let actor = AgentExecutionActor {
        actor_type: "user",
        actor_id: "native-driver-fixture".into(),
        run_id: None,
    };
    let admitted = agent_execution::admit(
        &database.pool,
        &Board,
        &actor,
        &AgentWakeRequest {
            organization_id: support::ORG.into(),
            agent_id: agent.clone(),
            source: "on_demand".into(),
            trigger_detail: Some("manual".into()),
            reason: Some("native_driver_fixture".into()),
            payload: Some(json!({})),
            idempotency_key: Some("assembled-driver".into()),
            context_snapshot: json!({}),
        },
    )
    .await
    .unwrap();
    let run = admitted.run_id.unwrap();
    let claim = agent_execution::claim_queued_run(&database.pool, support::ORG, &run)
        .await
        .unwrap()
        .unwrap();
    let host = Arc::new(AgentRunContextHost {
        workspace: OrganizationWorkspaceHost {
            instance_root: path.display().to_string(),
            workspace_home: path.join("workspaces").display().to_string(),
            previous_documents_root: path.join("old-documents").display().to_string(),
            friendly_workspace_home: false,
            hostname: "fixture".into(),
        },
        operator_home: operator,
        process_cwd: cwd,
        executable_search_path: "/usr/bin:/bin".into(),
        runtime_root: path.join("runtime"),
        rudder_cli: PathBuf::from("/usr/bin/false"),
        process_host: std::env::var_os("RUDDER_TEST_PROCESS_HOST")
            .map(PathBuf::from)
            .expect("prebuilt process host"),
        api_url: "http://127.0.0.1:1".into(),
        deployment_mode: "local_trusted".into(),
        bundled_skills_root: None,
    });
    let identity = NativeAgentJwtConfig {
        secret: "synthetic-fixture-key-not-an-operator-credential".into(),
        issuer: "rudder".into(),
        audience: "rudder-api".into(),
    };
    driver::run(
        database.pool.clone(),
        host,
        identity,
        Arc::new(AtomicBool::new(false)),
        claim,
    )
    .await;
    let row=sqlx::query("SELECT status,error,terminal_effects_pending,log_store,log_ref,log_bytes,log_sha256,stdout_excerpt,stderr_excerpt,execution_owner_token FROM heartbeat_runs WHERE org_id=$1::uuid AND id=$2::uuid").bind(support::ORG).bind(&run).fetch_one(&database.pool).await.unwrap();
    assert_eq!(
        row.get::<String, _>("status"),
        "succeeded",
        "{:?}",
        row.get::<Option<String>, _>("error")
    );
    assert!(!row.get::<bool, _>("terminal_effects_pending"));
    assert!(
        row.get::<Option<String>, _>("execution_owner_token")
            .is_none()
    );
    assert_eq!(row.get::<String, _>("log_store"), "local_file");
    assert!(row.get::<i64, _>("log_bytes") > 0);
    assert_eq!(row.get::<String, _>("log_sha256").len(), 64);
    assert!(
        row.get::<String, _>("stdout_excerpt")
            .contains("driver stdout")
    );
    assert!(
        row.get::<String, _>("stderr_excerpt")
            .contains("driver stderr")
    );
    let log = path
        .join("data/run-logs")
        .join(row.get::<String, _>("log_ref"));
    assert!(log.is_file());
    assert!(PathBuf::from(format!("{}.index.ndjson", log.display())).is_file());
    assert!(matches!(
        agent_execution::retry(&database.pool, &Board, &actor, support::ORG, &run).await,
        Err(agent_execution::AgentExecutionError::Http(409, _, _))
    ));
}

async fn fresh_request_claim(database: &support::Database) -> agent_execution::AgentRunClaim {
    let agent = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type,agent_runtime_config,runtime_config) VALUES($1::uuid,$2::uuid,'Native request lifecycle','general','idle','http','{}','{}')").bind(&agent).bind(support::ORG).execute(&database.pool).await.unwrap();
    let admitted = agent_execution::admit(
        &database.pool,
        &Board,
        &AgentExecutionActor {
            actor_type: "user",
            actor_id: "request-lifecycle-fixture".into(),
            run_id: None,
        },
        &AgentWakeRequest {
            organization_id: support::ORG.into(),
            agent_id: agent,
            source: "on_demand".into(),
            trigger_detail: Some("manual".into()),
            reason: Some("native_request_fixture".into()),
            payload: Some(json!({})),
            idempotency_key: None,
            context_snapshot: json!({}),
        },
    )
    .await
    .unwrap();
    agent_execution::claim_queued_run(&database.pool, support::ORG, &admitted.run_id.unwrap())
        .await
        .unwrap()
        .unwrap()
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL188"]
async fn request_owner_loss_is_failed_unknown_without_process_exit_or_automatic_retry() {
    let database = support::Database::start().await;
    let claim = fresh_request_claim(&database).await;
    assert!(
        agent_execution::record_request_started(&database.pool, &claim.owned, "http")
            .await
            .unwrap()
    );
    let mut mutation = database.pool.begin().await.unwrap();
    sqlx::query(
        "SELECT set_config('rudder.native_chat_write','native_chat:agent_execution_fixture',true)",
    )
    .execute(&mut *mutation)
    .await
    .unwrap();
    sqlx::query("UPDATE heartbeat_runs SET execution_lease_expires_at=statement_timestamp()-interval '1 second' WHERE id=$1::uuid").bind(&claim.run_id).execute(&mut *mutation).await.unwrap();
    mutation.commit().await.unwrap();
    let expired = agent_execution::recovery::list_expired(&database.pool)
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.run_id == claim.run_id)
        .unwrap();
    assert!(expired.request_started());
    assert!(
        agent_execution::recovery::recover_request_owner_lost(&database.pool, &expired)
            .await
            .unwrap()
    );
    assert!(
        !agent_execution::recovery::recover_request_owner_lost(&database.pool, &expired)
            .await
            .unwrap()
    );
    let row=sqlx::query("SELECT status,error_code,process_exited_at IS NULL AS no_exit,process_pid IS NULL AS no_pid,result_json,terminal_effects_pending FROM heartbeat_runs WHERE id=$1::uuid").bind(&claim.run_id).fetch_one(&database.pool).await.unwrap();
    assert_eq!(row.get::<String, _>("status"), "failed");
    assert_eq!(row.get::<String, _>("error_code"), "runtime_owner_lost");
    assert!(row.get::<bool, _>("no_exit"));
    assert!(row.get::<bool, _>("no_pid"));
    assert_eq!(
        row.get::<serde_json::Value, _>("result_json")["ownerRecovery"]["remoteState"],
        "unknown"
    );
    assert!(row.get::<bool, _>("terminal_effects_pending"));
    assert!(
        agent_execution::settlement::list_due(&database.pool)
            .await
            .unwrap()
            .iter()
            .any(|r| r.run_id == claim.run_id)
    );
    assert!(
        agent_execution::settlement::settle_terminal_effects(
            &database.pool,
            support::ORG,
            &claim.run_id
        )
        .await
        .unwrap()
    );
    let retries: i64 =
        sqlx::query_scalar("SELECT count(*) FROM heartbeat_runs WHERE retry_of_run_id=$1::uuid")
            .bind(&claim.run_id)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(retries, 0);
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL188"]
async fn same_run_network_resume_requires_safe_checkpoint_and_preserves_attempt_evidence() {
    let database = support::Database::start().await;
    for (safe, count, expected) in [
        (true, 1, None),
        (false, 1, Some("network_resume_unsafe")),
        (true, 6, Some("network_retry_exhausted")),
    ] {
        let mut claim = fresh_request_claim(&database).await;
        let original_attempt = claim.attempt_id.clone();
        assert!(
            agent_execution::record_request_started(&database.pool, &claim.owned, "http")
                .await
                .unwrap()
        );
        let (_, proof) = claim
            .owned
            .take_request_execution()
            .unwrap()
            .settle(async {})
            .await;
        let checkpoint = json!({"kind":"network","code":"provider_transport_unavailable","transport":"http","continuation":"fresh_if_pristine","submissionPhase":if safe{"pre_submission"}else{"post_submission"},"modelOutputObserved":false,"toolActivityObserved":false,"sideEffectRisk":"none"});
        assert!(
            agent_execution::network::suspend_request(
                &database.pool,
                &claim.owned,
                &checkpoint,
                &json!({}),
                None,
                None,
                &proof
            )
            .await
            .unwrap()
        );
        let mut mutation = database.pool.begin().await.unwrap();
        sqlx::query("SELECT set_config('rudder.native_chat_write','native_chat:agent_execution_fixture',true)").execute(&mut *mutation).await.unwrap();
        sqlx::query("UPDATE heartbeat_runs SET network_wait_attempt_count=$2,network_wait_next_retry_at=statement_timestamp()-interval '1 second' WHERE id=$1::uuid").bind(&claim.run_id).bind(count).execute(&mut *mutation).await.unwrap();
        mutation.commit().await.unwrap();
        let resumed =
            agent_execution::claim_network_waiting_run(&database.pool, support::ORG, &claim.run_id)
                .await
                .unwrap();
        if let Some(code) = expected {
            assert!(resumed.is_none());
            let row=sqlx::query("SELECT status,error_code,terminal_effects_pending FROM heartbeat_runs WHERE id=$1::uuid").bind(&claim.run_id).fetch_one(&database.pool).await.unwrap();
            assert_eq!(row.get::<String, _>("status"), "failed");
            assert_eq!(row.get::<String, _>("error_code"), code);
            assert!(row.get::<bool, _>("terminal_effects_pending"));
        } else {
            let resumed = resumed.expect("safe wait claims same Run");
            assert_eq!(resumed.run_id, claim.run_id);
            assert_ne!(resumed.attempt_id, original_attempt);
            assert_eq!(resumed.attempt_epoch, claim.attempt_epoch + 1);
            assert!(
                !agent_execution::lifecycle::renew_lease(
                    &database.pool,
                    &claim.owned,
                    Duration::from_secs(30)
                )
                .await
                .unwrap()
            );
            let actor = AgentExecutionActor {
                actor_type: "user",
                actor_id: "network-cancel-fixture".into(),
                run_id: None,
            };
            assert!(
                agent_execution::cancel(
                    &database.pool,
                    &Board,
                    &actor,
                    support::ORG,
                    &resumed.run_id
                )
                .await
                .unwrap()
            );
            assert!(
                agent_execution::lifecycle::finalize_unlaunched(
                    &database.pool,
                    &resumed.owned,
                    "cancelled",
                    Some("fixture cancellation"),
                    &json!({}),
                    &json!({"errorCode":"cancelled"})
                )
                .await
                .unwrap()
            );
        }
        let old_status: String =
            sqlx::query_scalar("SELECT status FROM heartbeat_run_attempts WHERE id=$1::uuid")
                .bind(original_attempt)
                .fetch_one(&database.pool)
                .await
                .unwrap();
        assert_eq!(old_status, "waiting_for_network");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires disposable PostgreSQL188, explicit synthetic secrets key and prebuilt process host"]
async fn failed_and_unlaunched_primary_attempts_advance_once_with_fresh_authority_and_secret_refs()
{
    let database = support::Database::start().await;
    let actor = AgentExecutionActor {
        actor_type: "user",
        actor_id: "model-fallback-fixture".into(),
        run_id: None,
    };
    let(_,secret)=rudder_d1_persistence::secrets::execute_secrets_for_actor(&database.pool,support::ORG,"model-fallback-fixture",&json!({"operation":"create","input":{"name":"fallback-synthetic-secret","value":"synthetic-token-split-across-chunks"}}),&Board).await.unwrap();
    for unlaunched in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path();
        let operator = path.join("operator");
        let cwd = path.join("cwd");
        std::fs::create_dir_all(&operator).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        let agent = uuid::Uuid::new_v4().to_string();
        let config = json!({"command":if unlaunched{""}else{"/bin/sh"},"args":["-c","printf 'primary failed\\n'; exit 7"],"cwd":cwd,"model":"primary","env":{"TOKEN":{"type":"secret_ref","secretId":secret["id"]}},"modelFallbacks":[{"agentRuntimeType":"process","model":"fallback","config":{"command":"/bin/sh","args":["-c","printf 'fallback succeeded %s\\n' \"$TOKEN\""]}}]});
        sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type,agent_runtime_config,runtime_config) VALUES($1::uuid,$2::uuid,'Persisted fallback fixture','general','idle','process',$3::jsonb,'{}')").bind(&agent).bind(support::ORG).bind(config).execute(&database.pool).await.unwrap();
        let admission = agent_execution::admit(
            &database.pool,
            &Board,
            &actor,
            &AgentWakeRequest {
                organization_id: support::ORG.into(),
                agent_id: agent,
                source: "on_demand".into(),
                trigger_detail: Some("manual".into()),
                reason: Some("fallback_fixture".into()),
                payload: Some(json!({})),
                idempotency_key: None,
                context_snapshot: json!({}),
            },
        )
        .await
        .unwrap();
        let run = admission.run_id.unwrap();
        let claim = agent_execution::claim_queued_run(&database.pool, support::ORG, &run)
            .await
            .unwrap()
            .unwrap();
        let host = Arc::new(AgentRunContextHost {
            workspace: OrganizationWorkspaceHost {
                instance_root: path.display().to_string(),
                workspace_home: path.join("workspaces").display().to_string(),
                previous_documents_root: path.join("previous-documents").display().to_string(),
                friendly_workspace_home: false,
                hostname: "fixture".into(),
            },
            operator_home: operator,
            process_cwd: cwd,
            executable_search_path: "/usr/bin:/bin".into(),
            runtime_root: path.join("runtime"),
            rudder_cli: PathBuf::from("/usr/bin/false"),
            process_host: std::env::var_os("RUDDER_TEST_PROCESS_HOST")
                .map(PathBuf::from)
                .unwrap(),
            api_url: "http://127.0.0.1:1".into(),
            deployment_mode: "local_trusted".into(),
            bundled_skills_root: None,
        });
        driver::run(
            database.pool.clone(),
            host,
            NativeAgentJwtConfig {
                secret: "synthetic-fallback-jwt-key".into(),
                issuer: "rudder".into(),
                audience: "rudder-api".into(),
            },
            Arc::new(AtomicBool::new(false)),
            claim,
        )
        .await;
        let row=sqlx::query("SELECT status,error,terminal_effects_pending,log_ref FROM heartbeat_runs WHERE id=$1::uuid").bind(&run).fetch_one(&database.pool).await.unwrap();
        assert_eq!(
            row.get::<String, _>("status"),
            "succeeded",
            "{:?}",
            row.get::<Option<String>, _>("error")
        );
        assert!(!row.get::<bool, _>("terminal_effects_pending"));
        let attempts=sqlx::query("SELECT status,attempt_epoch,model,is_fallback,checkpoint_json FROM heartbeat_run_attempts WHERE run_id=$1::uuid ORDER BY attempt_index").bind(&run).fetch_all(&database.pool).await.unwrap();
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0].get::<String, _>("status"), "failed");
        assert_eq!(attempts[1].get::<String, _>("status"), "succeeded");
        assert_eq!(attempts[1].get::<String, _>("model"), "fallback");
        assert!(attempts[1].get::<bool, _>("is_fallback"));
        assert_eq!(
            attempts[1].get::<i32, _>("attempt_epoch"),
            attempts[0].get::<i32, _>("attempt_epoch") + 1
        );
        if unlaunched {
            assert_eq!(
                attempts[0].get::<serde_json::Value, _>("checkpoint_json")["cleanup"]["kind"],
                "unlaunched"
            );
        }
        let log = std::fs::read_to_string(
            path.join("data/run-logs")
                .join(row.get::<String, _>("log_ref")),
        )
        .unwrap();
        assert!(log.contains("fallback succeeded"));
        assert!(!log.contains("synthetic-token-split-across-chunks"));
        assert!(log.contains("REDACTED"));
    }
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL188"]
async fn timer_without_actionable_work_skips_and_paused_same_scope_wakes_resume_once() {
    let database = support::Database::start().await;
    let agent = uuid::Uuid::new_v4().to_string();
    let actor = AgentExecutionActor {
        actor_type: "user",
        actor_id: "timer-paused-fixture".into(),
        run_id: None,
    };
    sqlx::query("INSERT INTO agents(id,org_id,name,role,status,agent_runtime_type,agent_runtime_config,runtime_config) VALUES($1::uuid,$2::uuid,'Timer and paused native fixture','general','idle','process','{}','{}')").bind(&agent).bind(support::ORG).execute(&database.pool).await.unwrap();
    let request = |source: &str, key: &str| AgentWakeRequest {
        organization_id: support::ORG.into(),
        agent_id: agent.clone(),
        source: source.into(),
        trigger_detail: Some("system".into()),
        reason: Some("timer_pause_fixture".into()),
        payload: Some(json!({})),
        idempotency_key: Some(key.into()),
        context_snapshot: json!({}),
    };
    let skipped = agent_execution::admit(
        &database.pool,
        &Board,
        &actor,
        &request("timer", "timer-no-work"),
    )
    .await
    .unwrap();
    assert!(skipped.run_id.is_none());
    assert_eq!(skipped.status, "skipped");
    let reason: String =
        sqlx::query_scalar("SELECT reason FROM agent_wakeup_requests WHERE id=$1::uuid")
            .bind(&skipped.wakeup_request_id)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(reason, "heartbeat.preflight.no_actionable_work");
    let checked: bool =
        sqlx::query_scalar("SELECT last_heartbeat_at IS NOT NULL FROM agents WHERE id=$1::uuid")
            .bind(&agent)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert!(checked);
    sqlx::query("UPDATE agents SET status='paused' WHERE id=$1::uuid")
        .bind(&agent)
        .execute(&database.pool)
        .await
        .unwrap();
    let first = agent_execution::admit(
        &database.pool,
        &Board,
        &actor,
        &request("on_demand", "paused-one"),
    )
    .await
    .unwrap();
    let second = agent_execution::admit(
        &database.pool,
        &Board,
        &actor,
        &request("on_demand", "paused-two"),
    )
    .await
    .unwrap();
    assert_eq!(first.status, "deferred_agent_paused");
    assert_eq!(first.wakeup_request_id, second.wakeup_request_id);
    assert!(first.run_id.is_none());
    sqlx::query("UPDATE agents SET status='idle' WHERE id=$1::uuid")
        .bind(&agent)
        .execute(&database.pool)
        .await
        .unwrap();
    assert_eq!(
        agent_execution::resume_pending(&database.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        agent_execution::resume_pending(&database.pool)
            .await
            .unwrap(),
        0
    );
    let runs: i64 =
        sqlx::query_scalar("SELECT count(*) FROM heartbeat_runs WHERE agent_id=$1::uuid")
            .bind(&agent)
            .fetch_one(&database.pool)
            .await
            .unwrap();
    assert_eq!(runs, 1);
}
