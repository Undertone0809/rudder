use super::fixture::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires prebuilt RUDDER_TEST_PROCESS_HOST and disposable PostgreSQL including migration188"]
async fn durable_cancel_reaps_the_owned_process_group_before_settlement() {
    let database = Database::start().await;
    let workspace = Workspace::new();
    let child = workspace.cwd.join("child.pid");
    let ticks = workspace.cwd.join("ticks");
    let script = "/bin/sh -c 'trap \"\" TERM; echo $$ > child.pid; while :; do printf . >> ticks; /bin/sleep 0.05; done' & wait";
    let config = json!({"command":"/bin/sh","args":["-c",script],"cwd":workspace.cwd,"graceSec":0.2,"timeoutSec":10});
    let claim = claim(&database, "process", &config, json!({})).await;
    let run = claim.run_id.clone();
    let request = workspace.request(config, json!({}));
    let pool = database.pool.clone();
    let worker = tokio::spawn(execute_agent_run(pool, claim, request));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if child.is_file()
                && ticks.is_file()
                && snapshot(&database.pool, &run).await["process_pid"]
                    .as_i64()
                    .is_some()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let before = snapshot(&database.pool, &run).await;
    assert_eq!(before["status"], "running");
    assert!(before["process_pid"].as_i64().is_some_and(|pid| pid > 0));
    cancel(&database, &run).await;
    let requested = snapshot(&database.pool, &run).await;
    assert_eq!(requested["status"], "running");
    assert_eq!(requested["error_code"], "cancel_requested");
    assert!(requested["process_exited_at"].is_null());
    let (claim, mut observation) = tokio::time::timeout(Duration::from_secs(8), worker)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(observation.state, AgentRunExecutionState::Cancelled);
    assert!(matches!(
        observation.cleanup_proof,
        Some(AgentRunCleanupProof::Process(_))
    ));
    let stopped = std::fs::metadata(&ticks).unwrap().len();
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(
        std::fs::metadata(&ticks).unwrap().len(),
        stopped,
        "TERM-ignoring descendant must not survive a cleanup receipt"
    );
    settle(&database, &claim, &mut observation).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires prebuilt RUDDER_TEST_PROCESS_HOST and disposable PostgreSQL including migration188"]
async fn codex_provider_auth_401_stops_a_retrying_cli_without_the_configured_timeout() {
    let database = Database::start().await;
    let workspace = Workspace::new();
    let script = workspace.cwd.join("codex-fixture");
    std::fs::write(&script,"#!/bin/sh\nprintf '%s\\n' 'unexpected status 401 Unauthorized: INVALID_API_KEY https://provider.invalid/v1/responses' >&2\n/bin/sleep 300\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let config = json!({"command":script,"cwd":workspace.cwd,"timeoutSec":0});
    let claim = claim(&database, "codex_local", &config, json!({})).await;
    let started = tokio::time::Instant::now();
    let (claim, mut observation) = tokio::time::timeout(
        Duration::from_secs(7),
        execute_agent_run(
            database.pool.clone(),
            claim,
            workspace.request(config, json!({})),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(started.elapsed() < Duration::from_secs(7));
    assert_eq!(observation.state, AgentRunExecutionState::Failed);
    assert_eq!(
        observation.error_code.as_deref(),
        Some("codex_provider_auth_required")
    );
    assert_eq!(
        observation.result["providerFailure"]["shortCircuited"],
        true
    );
    assert_eq!(observation.result["providerFailure"]["retryable"], false);
    settle(&database, &claim, &mut observation).await;
}
