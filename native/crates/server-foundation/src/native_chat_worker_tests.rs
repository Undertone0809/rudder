use super::*;
use std::sync::mpsc;
fn supervisor() -> Supervisor {
    Supervisor::new(
        sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/unused")
            .unwrap(),
    )
}
fn key(index: usize) -> Key {
    Key {
        organization_id: "org".into(),
        run_id: format!("run-{index}"),
        attempt_id: format!("attempt-{index}"),
    }
}
fn complete() -> Completion {
    Completion {
        status: Status::FinalizationCommitted,
        quiescent: true,
    }
}
async fn settled(worker: &Supervisor) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            {
                let mut state = worker.0.state.lock().unwrap();
                reap(&mut state);
                if state.jobs.values().all(|entry| entry.task.is_none()) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn duplicate_and_capacity_rejections_return_no_ticket_and_drop_is_observational() {
    let worker = supervisor();
    let (release, wait) = mpsc::channel();
    let (started, signal) = tokio::sync::oneshot::channel();
    let ticket = worker
        .start(key(1), move |cancelled| {
            started.send(Arc::clone(&cancelled)).unwrap();
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            assert!(!cancelled.load(Ordering::Acquire));
            complete()
        })
        .unwrap();
    let cancelled = signal.await.unwrap();
    drop(ticket);
    assert!(!cancelled.load(Ordering::Acquire));
    assert!(matches!(
        worker.start(key(1), |_| panic!("duplicate launched")),
        Err(StartError::Busy)
    ));
    let (release2, wait2) = mpsc::channel();
    let second = worker
        .start(key(2), move |_| {
            wait2.recv_timeout(Duration::from_secs(3)).unwrap();
            complete()
        })
        .unwrap();
    assert!(matches!(
        worker.start(key(3), |_| panic!("third launched")),
        Err(StartError::Busy)
    ));
    release.send(()).unwrap();
    release2.send(()).unwrap();
    assert_eq!(second.wait().await, Status::FinalizationCommitted);
    settled(&worker).await;
    assert!(worker.shutdown(Duration::from_millis(50)).await.is_ok());
}
#[tokio::test]
async fn missing_cleanup_and_panics_quarantine_capacity_across_repeated_shutdowns() {
    let worker = supervisor();
    let first = worker
        .start(key(1), |_| Completion {
            status: Status::Unresolved(UnresolvedReason::MissingCleanupProof),
            quiescent: false,
        })
        .unwrap();
    assert_eq!(
        first.wait().await,
        Status::Unresolved(UnresolvedReason::MissingCleanupProof)
    );
    let second = worker
        .start(key(2), |_| panic!("synthetic blocking-worker panic"))
        .unwrap();
    assert_eq!(
        second.wait().await,
        Status::Unresolved(UnresolvedReason::WorkerInterrupted)
    );
    settled(&worker).await;
    assert_eq!(worker.0.slots.available_permits(), 0);
    assert!(matches!(
        worker.start(key(3), |_| complete()),
        Err(StartError::Busy)
    ));
    for _ in 0..2 {
        assert!(worker.shutdown(Duration::from_millis(30)).await.is_err());
    }
    assert_eq!(worker.0.state.lock().unwrap().jobs.len(), 2);
}
#[tokio::test]
async fn concurrent_or_cancelled_shutdown_retains_the_actual_blocking_handle() {
    let worker = supervisor();
    let (release, wait) = mpsc::channel();
    let (started, signal) = tokio::sync::oneshot::channel();
    let ticket = worker
        .start(key(1), move |cancelled| {
            started.send(()).unwrap();
            wait.recv_timeout(Duration::from_secs(3)).unwrap();
            assert!(cancelled.load(Ordering::Acquire));
            complete()
        })
        .unwrap();
    signal.await.unwrap();
    assert!(
        tokio::time::timeout(
            Duration::from_millis(15),
            worker.shutdown(Duration::from_secs(2))
        )
        .await
        .is_err()
    );
    assert!(worker.0.state.lock().unwrap().jobs[&key(1)].task.is_some());
    let began = Instant::now();
    let (a, b) = tokio::join!(
        worker.shutdown(Duration::from_millis(30)),
        worker.shutdown(Duration::from_millis(30))
    );
    assert!(a.is_err() && b.is_err());
    assert!(began.elapsed() < Duration::from_millis(300));
    assert!(matches!(
        worker.start(key(2), |_| complete()),
        Err(StartError::Closed)
    ));
    release.send(()).unwrap();
    assert_eq!(ticket.wait().await, Status::FinalizationCommitted);
    assert!(worker.shutdown(Duration::from_secs(1)).await.is_ok());
}
#[tokio::test]
async fn finalization_failure_after_quiescence_releases_capacity_and_cache_is_bounded() {
    let worker = supervisor();
    for index in 0..MAX_RETAINED + 3 {
        let ticket = worker
            .start(key(index), |_| Completion {
                status: Status::Unresolved(UnresolvedReason::FinalizationUnresolved),
                quiescent: true,
            })
            .unwrap();
        assert_eq!(
            ticket.wait().await,
            Status::Unresolved(UnresolvedReason::FinalizationUnresolved)
        );
        settled(&worker).await;
    }
    assert_eq!(worker.0.state.lock().unwrap().jobs.len(), MAX_RETAINED);
    assert_eq!(worker.0.slots.available_permits(), MAX_ACTIVE);
    assert!(worker.shutdown(Duration::from_millis(30)).await.is_ok());
}
#[tokio::test]
async fn concurrent_duplicate_starts_have_one_owner_and_shutdown_closes_admission() {
    let worker = supervisor();
    let starts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut handles = Vec::new();
    for _ in 0..20 {
        let worker = worker.clone();
        let starts = starts.clone();
        handles.push(tokio::spawn(async move {
            worker
                .start(key(1), move |_| {
                    starts.fetch_add(1, Ordering::SeqCst);
                    complete()
                })
                .is_ok()
        }));
    }
    let mut accepted = 0;
    for handle in handles {
        accepted += usize::from(handle.await.unwrap());
    }
    assert_eq!(accepted, 1);
    assert!(worker.shutdown(Duration::from_secs(1)).await.is_ok());
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert!(matches!(
        worker.start(key(2), |_| complete()),
        Err(StartError::Closed)
    ));
}
#[allow(unused_imports)]
#[path = "../../native-chat-executor/tests/workflow/fixture.rs"]
mod fixture;

#[cfg(unix)]
fn job(host: &fixture::FixtureHost, actor: VerifiedActor, run: &str, attempt: &str) -> Job {
    let paths = host.paths();
    let root = paths.isolated_home.parent().unwrap();
    let context = LocalHostContext::from_rust_host(
        "native-chat-executor-fixture-host".into(),
        root.join("instance"),
        root.join("workspaces"),
        root.join("previous-documents"),
        false,
        root.join("managed-profiles"),
        root.join("operator-home"),
        root.join("bin/codex-fixture"),
    )
    .unwrap();
    Job::new(actor, context, paths, run, attempt, Duration::from_secs(30)).unwrap()
}
#[cfg(unix)]
async fn wait_file(path: &std::path::Path) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("provider reaches bounded synchronization point");
}
#[cfg(unix)]
async fn run_state(pool: &PgPool, run: &str) -> (String, bool) {
    sqlx::query_as("SELECT status,native_admission_hold FROM heartbeat_runs WHERE id=$1::uuid")
        .bind(run)
        .fetch_one(pool)
        .await
        .unwrap()
}
#[cfg(unix)]
fn runtime(database: &fixture::Database) -> crate::ServerRuntime {
    crate::ServerRuntime::bind(crate::ServerConfig {
        database_url: Some(format!(
            "postgres://postgres@127.0.0.1:{}/postgres",
            database.pool.connect_options().get_port()
        )),
        database_required: true,
        shutdown_grace: Duration::from_secs(2),
        workers: 1,
        ..Default::default()
    })
    .unwrap()
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST, disposable PostgreSQL and synthetic provider"]
async fn real_runtime_completes_after_ticket_drop_and_durable_claim_denies_replay_after_eviction() {
    let (db, host, actor, run, attempt) = fixture::database_and_admission("g6-cancel-drop").await;
    let runtime = runtime(&db);
    let control = runtime.control();
    let worker = control.native_chat_worker().unwrap();
    let server = tokio::spawn(runtime.run());
    let ticket = worker
        .try_start(job(&host, actor.clone(), &run, &attempt))
        .unwrap();
    wait_file(&host.probe_path("thread-start-pending")).await;
    drop(ticket);
    assert!(matches!(
        worker.try_start(job(&host, actor.clone(), &run, &attempt)),
        Err(StartError::Busy)
    ));
    std::fs::write(host.probe_path("release-thread-start"), "release").unwrap();
    tokio::time::timeout(Duration::from_secs(15), async {
        while run_state(&db.pool, &run).await.0 != "succeeded" {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    settled(&worker).await;
    assert_eq!(run_state(&db.pool, &run).await, ("succeeded".into(), false));
    let answer_count: i64 = sqlx::query_scalar("SELECT count(*) FROM chat_messages WHERE conversation_id=$1::uuid AND role='assistant' AND body='synthetic answer'")
        .bind(fixture::CHAT).fetch_one(&db.pool).await.unwrap();
    assert_eq!(answer_count, 1);
    // Evict completed observations, not durable attempt authority.
    for index in 0..MAX_RETAINED {
        worker
            .start(key(index), |_| complete())
            .unwrap()
            .wait()
            .await;
        settled(&worker).await;
    }
    let ticket = worker.try_start(job(&host, actor, &run, &attempt)).unwrap();
    assert_eq!(
        ticket.wait().await,
        Status::Unresolved(UnresolvedReason::ExecutionUnresolved)
    );
    settled(&worker).await;
    assert_eq!(worker.0.slots.available_permits(), MAX_ACTIVE);
    assert_eq!(
        host.events()
            .iter()
            .filter(|event| event["received"]["method"] == "turn/start")
            .count(),
        1
    );
    assert_eq!(run_state(&db.pool, &run).await, ("succeeded".into(), false));
    control.shutdown().await;
    server.await.unwrap().unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST, disposable PostgreSQL and synthetic provider"]
async fn real_shutdown_cleans_provider_but_preserves_hold_and_restart_never_resubmits() {
    let (db, host, actor, run, attempt) = fixture::database_and_admission("g6-cancel-drop").await;
    let runtime = runtime(&db);
    let control = runtime.control();
    let worker = control.native_chat_worker().unwrap();
    let server = tokio::spawn(runtime.run());
    let ticket = worker
        .try_start(job(&host, actor.clone(), &run, &attempt))
        .unwrap();
    wait_file(&host.probe_path("thread-start-pending")).await;
    assert!(worker.shutdown(Duration::from_millis(1)).await.is_err());
    assert!(matches!(
        worker.try_start(job(&host, actor.clone(), &run, &attempt)),
        Err(StartError::Closed)
    ));
    assert_eq!(
        ticket.wait().await,
        Status::Unresolved(UnresolvedReason::ExecutionUnresolved)
    );
    control.shutdown().await;
    server.await.unwrap().unwrap();
    wait_file(&host.probe_path("provider-stopped")).await;
    assert!(run_state(&db.pool, &run).await.1);
    let before = host.events();
    let restarted = Supervisor::new(db.pool.clone());
    let retry = restarted
        .try_start(job(&host, actor, &run, &attempt))
        .unwrap();
    assert_eq!(
        retry.wait().await,
        Status::Unresolved(UnresolvedReason::ExecutionUnresolved)
    );
    assert!(restarted.shutdown(Duration::from_secs(1)).await.is_ok());
    assert_eq!(host.events(), before);
    assert!(run_state(&db.pool, &run).await.1);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST, disposable PostgreSQL and synthetic provider"]
async fn real_prelaunch_rejections_do_not_exhaust_worker_capacity() {
    let (db, host, actor, run, attempt) = fixture::database_and_admission("complete").await;
    let before = run_state(&db.pool, &run).await;
    let worker = Supervisor::new(db.pool.clone());
    for _ in 0..MAX_ACTIVE + 2 {
        let missing_run = uuid::Uuid::new_v4().to_string();
        let ticket = worker
            .try_start(job(&host, actor.clone(), &missing_run, &attempt))
            .unwrap();
        assert_eq!(
            ticket.wait().await,
            Status::Unresolved(UnresolvedReason::ExecutionUnresolved)
        );
        settled(&worker).await;
        assert_eq!(worker.0.slots.available_permits(), MAX_ACTIVE);
        assert!(!host.provider_started());
    }
    assert_eq!(run_state(&db.pool, &run).await, before);
    assert_eq!(
        worker
            .try_start(job(&host, actor, &run, &attempt))
            .unwrap()
            .wait()
            .await,
        Status::FinalizationCommitted
    );
    assert!(worker.shutdown(Duration::from_secs(1)).await.is_ok());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST, disposable PostgreSQL and synthetic provider"]
async fn real_provider_failure_with_cleanup_releases_capacity_without_finalizing() {
    let (db, host, actor, run, attempt) = fixture::database_and_admission("wrong-version").await;
    let worker = Supervisor::new(db.pool.clone());
    let ticket = worker.try_start(job(&host, actor, &run, &attempt)).unwrap();
    assert_eq!(
        ticket.wait().await,
        Status::Unresolved(UnresolvedReason::ExecutionUnresolved)
    );
    settled(&worker).await;
    assert!(host.provider_started());
    let pid = std::fs::read_to_string(host.probe_path("provider-pid")).unwrap();
    assert!(
        !std::process::Command::new("kill")
            .args(["-0", pid.trim()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(worker.0.slots.available_permits(), MAX_ACTIVE);
    assert!(run_state(&db.pool, &run).await.1);
    assert!(
        !host
            .events()
            .iter()
            .any(|event| event["received"]["method"] == "turn/start")
    );
    assert!(worker.shutdown(Duration::from_secs(1)).await.is_ok());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST, disposable PostgreSQL and synthetic provider"]
async fn real_owner_loss_without_cleanup_blocks_clean_runtime_shutdown() {
    use std::os::unix::fs::PermissionsExt;
    let (db, host, actor, run, attempt) = fixture::database_and_admission("complete").await;
    // A private faulty owner exits without any lifecycle proof. It launches no
    // provider; the worker must still not invent a containment receipt.
    let faulty = tempfile::tempdir().unwrap();
    let executable = faulty.path().join("faulty-owner");
    std::fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let runtime = runtime(&db);
    let control = runtime.control();
    let worker = control.native_chat_worker().unwrap();
    let server = tokio::spawn(runtime.run());
    let mut admitted = job(&host, actor, &run, &attempt);
    admitted.paths.process_host = executable.canonicalize().unwrap();
    let ticket = worker.try_start(admitted).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(15), ticket.wait())
            .await
            .unwrap(),
        Status::Unresolved(UnresolvedReason::ExecutionUnresolved)
    );
    settled(&worker).await;
    assert_eq!(worker.0.slots.available_permits(), MAX_ACTIVE - 1);
    assert!(run_state(&db.pool, &run).await.1);
    assert!(!host.provider_started());
    assert!(worker.shutdown(Duration::from_millis(20)).await.is_err());
    control.shutdown().await;
    assert!(server.await.unwrap().is_err());
}
