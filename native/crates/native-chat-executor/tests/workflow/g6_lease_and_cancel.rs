use crate::fixture::*;
use std::{
    fs,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn delayed_provider_renews_both_leases_and_replaced_owner_cannot_dispatch_turn() {
    assert_ignored_external_dependencies();
    let (database, host, actor, run_id, attempt_id) =
        database_and_admission("g6-lease-revoke").await;
    let waiting = host.probe_path("thread-start-pending");
    let release = host.probe_path("release-thread-start");
    let pool = database.pool.clone();
    let worker =
        spawn_executor_worker(pool.clone(), host, actor, run_id.clone(), attempt_id, false);

    wait_for_file(&waiting, Duration::from_secs(10)).await;
    let initial = lease_expiries(&pool, &run_id).await;
    let observed_at = Instant::now();
    tokio::time::sleep(Duration::from_millis(5_500)).await;
    let renewed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let current = lease_expiries(&pool, &run_id).await;
            if current.0 > initial.0 && current.1 > initial.1 && current.2 {
                break current;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("both independent lease expiries must advance while response is pending");
    assert!(observed_at.elapsed() >= Duration::from_secs(5));
    assert!(renewed.0 > initial.0);
    assert!(renewed.1 > initial.1);

    let mut tx = database
        .pool
        .begin()
        .await
        .expect("start owner replacement");
    sqlx::query("SELECT set_config('rudder.native_chat_write', 'native_chat:execution', true)")
        .execute(&mut *tx)
        .await
        .expect("authorize test-only owner replacement");
    sqlx::query(
        "UPDATE heartbeat_runs SET execution_owner_token='g6-replaced-run-owner'
         WHERE org_id=$1::uuid AND id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .execute(&mut *tx)
    .await
    .expect("revoke the active Run owner before the next checkpoint authorization");
    tx.commit().await.expect("commit owner replacement");
    fs::write(&release, "release").expect("release delayed thread/start response");

    let (result, host) = tokio::time::timeout(Duration::from_secs(12), worker)
        .await
        .expect("executor must stop after the replaced owner is observed")
        .expect("executor worker must join");
    assert!(
        matches!(result, Err(ExecutorError::Persistence(_))),
        "the checkpoint after thread/start must reject the replaced owner"
    );
    let events = host.events();
    assert_eq!(
        events
            .iter()
            .filter(|event| event["received"]["method"] == "thread/start")
            .count(),
        1,
        "the already authorized Thread start is observed exactly once"
    );
    assert!(
        !events
            .iter()
            .any(|event| event["received"]["method"] == "turn/start"),
        "a replaced owner must not dispatch the admitted input"
    );

    let (run_hold, generation_hold, generation_thread, run_thread, owner): (
        bool,
        bool,
        Option<String>,
        Option<String>,
        String,
    ) = sqlx::query_as(
        "SELECT r.native_admission_hold, g.native_admission_hold,
                g.provider_thread_id, r.session_id_after, r.execution_owner_token
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read durable holds after owner replacement");
    assert!(run_hold && generation_hold);
    assert_eq!(generation_thread, None);
    assert_eq!(run_thread, None);
    assert_eq!(owner, "g6-replaced-run-owner");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires RUDDER_TEST_PROCESS_HOST; uses disposable PostgreSQL and a synthetic local provider only"]
async fn dropping_active_execute_future_signals_cancel_and_waits_for_owned_provider_exit() {
    assert_ignored_external_dependencies();
    let (database, mut host, actor, run_id, attempt_id) =
        database_and_admission("g6-cancel-drop").await;
    let waiting = host.probe_path("thread-start-pending");
    let stopped = host.probe_path("provider-stopped");
    let pid_path = host.probe_path("provider-pid");
    let release = host.probe_path("release-thread-start");
    let cancelled = Arc::new(AtomicBool::new(false));
    let context = host.take_context();
    let paths = host.paths();
    let task = spawn_owned_executor_task(
        database.pool.clone(),
        actor,
        context,
        paths,
        run_id.clone(),
        attempt_id,
        Arc::clone(&cancelled),
    );

    wait_for_file(&waiting, Duration::from_secs(10)).await;
    let pid: u32 = fs::read_to_string(&pid_path)
        .expect("provider wrote its own PID")
        .parse()
        .expect("provider PID is numeric");
    assert!(pid > 1);
    task.abort();
    assert!(task.await.is_err(), "the active execute future was dropped");
    assert!(
        cancelled.load(Ordering::Acquire),
        "CancelOnDrop must signal the still-running blocking worker"
    );

    wait_for_file(&stopped, Duration::from_secs(12)).await;
    wait_for_process_exit(pid, Duration::from_secs(5)).await;
    assert!(
        !release.exists(),
        "provider exited through owned Stop/cleanup, not test response release"
    );
    let events = host.events();
    assert_eq!(
        events
            .iter()
            .filter(|event| event["received"]["method"] == "thread/start")
            .count(),
        1,
        "the provider had received exactly one Thread start before cancellation"
    );
    assert!(
        !events
            .iter()
            .any(|event| event["received"]["method"] == "turn/start"),
        "dropping the active executor must prevent turn dispatch"
    );

    let (run_hold, generation_hold, generation_thread, run_thread): (
        bool,
        bool,
        Option<String>,
        Option<String>,
    ) = sqlx::query_as(
        "SELECT r.native_admission_hold, g.native_admission_hold,
                g.provider_thread_id, r.session_id_after
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(&run_id)
    .fetch_one(&database.pool)
    .await
    .expect("read held state after cancelling the active executor");
    assert!(run_hold && generation_hold);
    assert_eq!(generation_thread, None);
    assert_eq!(run_thread, None);
}

async fn lease_expiries(pool: &sqlx::PgPool, run_id: &str) -> (i64, i64, bool) {
    sqlx::query_as(
        "SELECT floor(extract(epoch FROM g.control_lease_expires_at) * 1000)::bigint,
                floor(extract(epoch FROM r.execution_lease_expires_at) * 1000)::bigint,
                COALESCE(g.control_lease_expires_at > clock_timestamp(), false)
                  AND COALESCE(r.execution_lease_expires_at > clock_timestamp(), false)
         FROM heartbeat_runs r
         JOIN chat_generations g ON g.org_id=r.org_id AND g.id=r.chat_generation_id
         WHERE r.org_id=$1::uuid AND r.id=$2::uuid",
    )
    .bind(ORG)
    .bind(run_id)
    .fetch_one(pool)
    .await
    .expect("read both current lease expiry timestamps")
}

async fn wait_for_file(path: &std::path::Path, timeout: Duration) {
    tokio::time::timeout(timeout, async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for fixture marker {}", path.display()));
}

async fn wait_for_process_exit(pid: u32, timeout: Duration) {
    tokio::time::timeout(timeout, async {
        loop {
            let pid_string = pid.to_string();
            let status = tokio::task::spawn_blocking(move || {
                Command::new("/bin/kill")
                    .args(["-0", pid_string.as_str()])
                    .stderr(std::process::Stdio::null())
                    .status()
            })
            .await
            .expect("poll provider process existence")
            .expect("run kill -0 for provider process");
            if !status.success() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("owned provider process must exit within the cleanup bound");
}
