use crate::fixture::*;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn unsupported_initialized_version_and_project_config_fail_before_thread_or_turn_dispatch() {
    assert_ignored_external_dependencies();
    for mode in ["wrong-version", "project-layer"] {
        let (database, host, actor, run_id, attempt_id) = database_and_admission(mode).await;
        let (result, host) =
            execute_on_worker(&database, host, actor, run_id.clone(), attempt_id.clone()).await;
        assert!(
            matches!(result, Err(ExecutorError::UnsupportedConfiguration)),
            "{mode} must fail the provider configuration gate"
        );
        assert!(host.provider_started());
        assert!(
            !host.events().iter().any(|event| {
                matches!(
                    event["received"]["method"].as_str(),
                    Some("thread/start" | "thread/resume" | "turn/start")
                )
            }),
            "{mode} must be rejected before any Thread or turn dispatch"
        );
        let (phase, run_hold, generation_hold, provider_thread): (
            String,
            bool,
            bool,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT a.protocol_phase, r.native_admission_hold,
                        g.native_admission_hold, g.provider_thread_id
                 FROM heartbeat_runs r
                 JOIN heartbeat_run_attempts a
                   ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=$3::uuid
                 JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
                 WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
        )
        .bind(ORG)
        .bind(&run_id)
        .bind(&attempt_id)
        .fetch_one(&database.pool)
        .await
        .expect("read held state after config rejection");
        assert_eq!(phase, "no_thread_request");
        assert!(run_hold && generation_hold);
        assert_eq!(provider_thread, None);
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn cancellation_before_executor_entry_neither_claims_nor_launches_provider() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) = database_and_admission("complete").await;
    let (result, host) =
        execute_cancelled_on_worker(&database, host, actor, run_id.clone(), attempt_id).await;
    assert!(matches!(result, Err(ExecutorError::Cancelled)));
    assert!(!host.provider_started());
    assert!(host.events().is_empty());
    let (run_hold, generation_hold): (bool, bool) = sqlx::query_as(
        "SELECT r.native_admission_hold, g.native_admission_hold
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read untouched admission after pre-cancellation");
    assert!(!run_hold && !generation_hold);
}
