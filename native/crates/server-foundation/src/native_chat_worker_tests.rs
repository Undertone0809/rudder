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

#[test]
fn finalization_diagnostics_never_return_error_payloads() {
    use rudder_d1_persistence::runtime_bindings::Error;
    let private = "synthetic-private-provider-and-owner-details";
    for (status, context) in [
        (403, "authorization"),
        (404, "scope"),
        (409, "lease"),
        (409, "Segment"),
        (409, "binding"),
        (409, "checkpoint"),
        (409, "cleanup"),
        (409, "provider receipt"),
        (409, "owner epoch"),
        (409, "other"),
        (500, "other"),
    ] {
        let code = finalization_error_code(&Error::Http(status, format!("{context}: {private}")));
        assert!(code.starts_with("native_finalize_"));
        assert!(code.len() <= 64);
        assert!(
            code.bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        );
        assert!(!code.contains(private));
    }
    assert_eq!(
        finalization_error_code(&Error::Database(sqlx::Error::PoolTimedOut)),
        "native_finalize_database_timeout"
    );
}

#[test]
fn pi_missing_receipt_is_classified_without_codex_projection() {
    assert_eq!(
        classify_pi_observation(true, false, false),
        UnresolvedReason::ProviderCleanupUnknown
    );
}

#[test]
fn pi_missing_cleanup_or_terminal_receipt_remains_unknown() {
    for (provider_terminal, turn_receipt, cleanup_proven) in [
        (false, false, false),
        (true, false, true),
        (true, true, false),
    ] {
        assert_eq!(
            classify_pi_observation(provider_terminal, turn_receipt, cleanup_proven),
            UnresolvedReason::ProviderCleanupUnknown
        );
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
async fn tracked_admission_survives_request_disconnect_and_blocks_shutdown_until_handoff() {
    let worker = supervisor();
    let reservation = worker.reserve_before_admission().unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let receiver = worker
        .spawn_reserved_admission(reservation, move |reservation| async move {
            // Keep the reservation alive while admission is in flight.
            let _reservation = reservation;
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
            42_u8
        })
        .unwrap();

    entered_rx.await.unwrap();
    drop(receiver);
    assert_eq!(worker.0.state.lock().unwrap().reservations, 1);
    assert_eq!(worker.0.state.lock().unwrap().admission_tasks.len(), 1);

    worker.begin_shutdown();
    assert!(worker.shutdown(Duration::from_millis(20)).await.is_err());
    assert_eq!(worker.0.state.lock().unwrap().admission_tasks.len(), 1);

    release_tx.send(()).unwrap();
    assert!(worker.shutdown(Duration::from_secs(1)).await.is_ok());
    assert_eq!(worker.0.slots.available_permits(), MAX_ACTIVE);
}

#[tokio::test]
async fn tracked_admission_panic_is_not_reported_as_a_clean_shutdown() {
    let worker = supervisor();
    let reservation = worker.reserve_before_admission().unwrap();
    let receiver = worker
        .spawn_reserved_admission::<(), _, _>(reservation, |_reservation| async move {
            panic!("synthetic admission-to-dispatch panic");
        })
        .unwrap();
    assert!(receiver.await.is_err());

    assert!(worker.shutdown(Duration::from_secs(1)).await.is_err());
    let state = worker.0.state.lock().unwrap();
    assert!(state.admission_failure);
    assert!(state.admission_tasks.is_empty());
    assert_eq!(state.reservations, 0);
}

#[tokio::test]
async fn tracked_admission_disconnect_before_or_after_commit_hands_off_once() {
    let worker = supervisor();
    let starts = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    for (index, disconnect_after_commit) in [(41, false), (42, true)] {
        let reservation = worker.reserve_before_admission().unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (committed_tx, mut committed_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let (handed_off_tx, handed_off_rx) = tokio::sync::oneshot::channel();
        let task_starts = Arc::clone(&starts);
        let response = worker
            .spawn_reserved_admission(reservation, move |reservation| async move {
                entered_tx.send(()).unwrap();
                if disconnect_after_commit {
                    committed_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                } else {
                    release_rx.await.unwrap();
                    committed_tx.send(()).unwrap();
                }
                let ticket = reservation
                    .start_with(key(index), move |_| {
                        task_starts.fetch_add(1, Ordering::SeqCst);
                        complete()
                    })
                    .unwrap();
                drop(ticket);
                handed_off_tx.send(()).unwrap();
            })
            .unwrap();
        entered_rx.await.unwrap();
        if disconnect_after_commit {
            (&mut committed_rx).await.unwrap();
        }
        // This models the HTTP response future being dropped either before
        // D1 commit or after commit but before the reserved worker handoff.
        drop(response);
        release_tx.send(()).unwrap();
        if !disconnect_after_commit {
            (&mut committed_rx).await.unwrap();
        }
        tokio::time::timeout(Duration::from_secs(3), handed_off_rx)
            .await
            .unwrap()
            .unwrap();
        settled(&worker).await;

        assert_eq!(starts.load(Ordering::SeqCst), index - 40);
        assert!(matches!(
            worker.start(key(index), |_| panic!("exact retry dispatched twice")),
            Err(StartError::Busy)
        ));
    }
    assert!(worker.shutdown(Duration::from_secs(1)).await.is_ok());
}

#[tokio::test]
async fn admission_reservations_consume_capacity_and_block_clean_shutdown_until_released() {
    let worker = supervisor();
    let first = worker.reserve_before_admission().unwrap();
    let second = worker.reserve_before_admission().unwrap();
    assert_eq!(worker.0.slots.available_permits(), 0);
    assert!(matches!(
        worker.reserve_before_admission(),
        Err(StartError::Busy)
    ));

    worker.begin_shutdown();
    assert!(matches!(
        worker.reserve_before_admission(),
        Err(StartError::Closed)
    ));
    assert!(
        tokio::time::timeout(
            Duration::from_millis(20),
            worker.shutdown(Duration::from_secs(1))
        )
        .await
        .is_err()
    );

    drop(first);
    drop(second);
    assert!(worker.shutdown(Duration::from_secs(1)).await.is_ok());
    assert_eq!(worker.0.slots.available_permits(), MAX_ACTIVE);
}

#[tokio::test]
async fn admission_reservation_transfers_its_slot_to_exactly_one_owned_job() {
    let worker = supervisor();
    let reservation = worker.reserve_before_admission().unwrap();
    let ticket = reservation
        .start_with(key(1), |_| complete())
        .expect("turn reservation into one owned job");
    assert_eq!(ticket.wait().await, Status::FinalizationCommitted);
    settled(&worker).await;
    assert_eq!(worker.0.slots.available_permits(), MAX_ACTIVE);
    assert!(worker.shutdown(Duration::from_secs(1)).await.is_ok());
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
#[cfg(unix)]
use crate::native_chat_test_fixture as fixture;

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
#[test]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; covered by Rust D1 real-entry smoke"]
fn browser_job_derives_organization_from_authenticated_principal() {
    use rudder_d1_persistence::native_chat::{BrowserCredentialBinding, BrowserPrincipal};

    let host = fixture::FixtureHost::new("complete");
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
    let session_id = "browser-session-worker-test";
    let actor = BrowserPrincipal::from_trusted_browser_auth(
        "native-chat-executor-owner",
        fixture::ORG,
        session_id,
        BrowserCredentialBinding::session(session_id, [7; 32]),
    )
    .unwrap();

    let job = Job::new_browser(
        actor,
        context,
        paths,
        "21000000-0000-4000-8000-000000000391",
        "22000000-0000-4000-8000-000000000391",
        Duration::from_secs(30),
    )
    .unwrap();

    assert_eq!(job.key.organization_id, fixture::ORG);
    assert!(matches!(job.actor, RequestActor::Browser(_)));
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
async fn real_provider_failure_with_cleanup_finalizes_failed_run() {
    let (db, host, actor, run, attempt) = fixture::database_and_admission("wrong-version").await;
    let worker = Supervisor::new(db.pool.clone());
    let ticket = worker.try_start(job(&host, actor, &run, &attempt)).unwrap();
    assert_eq!(ticket.wait().await, Status::FinalizationCommitted);
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
    assert_eq!(run_state(&db.pool, &run).await, ("failed".into(), false));
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

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST, disposable PostgreSQL and synthetic provider"]
async fn worker_resolves_pre_submission_stop_only_after_owned_cleanup() {
    use rudder_d1_persistence::native_chat::control::{StopOutcome, StopRequest, request_stop};

    let (db, host, actor, run, attempt) =
        fixture::database_and_admission("live-stop-late-thread").await;
    let runtime = runtime(&db);
    let control = runtime.control();
    let worker = control.native_chat_worker().unwrap();
    let server = tokio::spawn(runtime.run());
    let ticket = worker
        .try_start(job(&host, actor.clone(), &run, &attempt))
        .unwrap();
    wait_file(&host.probe_path("thread-start-pending")).await;
    let (generation_id, control_version): (String, i32) = sqlx::query_as(
        "SELECT g.id::text,g.control_version FROM chat_generations g
         JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let stop = StopRequest {
        conversation_id: fixture::CHAT.into(),
        generation_id,
        control_action_id: "72000000-0000-4000-8000-000000000001".into(),
        expected_attempt_epoch: 1,
        expected_control_version: control_version,
        requested_render_seq: 0,
        requested_body_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            .into(),
    };
    assert_eq!(
        request_stop(&db.pool, &actor, &stop).await.unwrap().outcome,
        StopOutcome::StopIntentRecorded
    );
    std::fs::write(host.probe_path("release-thread-start"), "release").unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(20), ticket.wait())
            .await
            .unwrap(),
        Status::FinalizationCommitted
    );
    assert_eq!(run_state(&db.pool, &run).await, ("cancelled".into(), false));
    assert_eq!(
        host.events()
            .iter()
            .filter(|event| matches!(
                event["received"]["method"].as_str(),
                Some("turn/start" | "turn/interrupt")
            ))
            .count(),
        0
    );
    let no_turn_projection: (i64, String, Option<String>) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM chat_messages WHERE run_id=r.id AND role='assistant'),
                a.protocol_phase,a.provider_turn_id
         FROM heartbeat_runs r
         JOIN heartbeat_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id
         WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        no_turn_projection,
        (0, "execution_terminal_committed".into(), None)
    );
    control.shutdown().await;
    server.await.unwrap().unwrap();
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST, disposable PostgreSQL and synthetic provider"]
async fn worker_binds_cleanup_before_resolving_config_pending_stop() {
    use rudder_d1_persistence::native_chat::control::{StopOutcome, StopRequest, request_stop};

    let (db, host, actor, run, attempt) =
        fixture::database_and_admission("live-stop-config-pending").await;
    let runtime = runtime(&db);
    let control = runtime.control();
    let worker = control.native_chat_worker().unwrap();
    let server = tokio::spawn(runtime.run());
    let ticket = worker
        .try_start(job(&host, actor.clone(), &run, &attempt))
        .unwrap();
    wait_file(&host.probe_path("config-read-pending")).await;

    let (generation_id, control_version): (String, i32) = sqlx::query_as(
        "SELECT g.id::text,g.control_version FROM chat_generations g
         JOIN heartbeat_runs r ON r.org_id=g.org_id AND r.chat_generation_id=g.id
         WHERE r.id=$1::uuid",
    )
    .bind(&run)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let stop = StopRequest {
        conversation_id: fixture::CHAT.into(),
        generation_id,
        control_action_id: "72000000-0000-4000-8000-000000000002".into(),
        expected_attempt_epoch: 1,
        expected_control_version: control_version,
        requested_render_seq: 0,
        requested_body_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
            .into(),
    };
    assert_eq!(
        request_stop(&db.pool, &actor, &stop).await.unwrap().outcome,
        StopOutcome::StopIntentRecorded
    );
    std::fs::write(host.probe_path("release-config-read"), "release").unwrap();

    assert_eq!(
        tokio::time::timeout(Duration::from_secs(20), ticket.wait())
            .await
            .unwrap(),
        Status::FinalizationCommitted
    );
    assert_eq!(run_state(&db.pool, &run).await, ("cancelled".into(), false));
    let action: (String, bool, Option<String>) = sqlx::query_as(
        "SELECT local_disposition,
                provider_evidence ? 'stoppingConnectionProof',
                provider_evidence->'stopResolution'->>'inputDisposition'
         FROM chat_control_actions WHERE id=$1::uuid",
    )
    .bind(&stop.control_action_id)
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        action,
        ("stopped".into(), true, Some("not_submitted".into()))
    );
    assert!(host.events().iter().all(|event| {
        !matches!(
            event["received"]["method"].as_str(),
            Some("thread/start" | "turn/start")
        )
    }));

    control.shutdown().await;
    server.await.unwrap().unwrap();
}
