use rudder_postgres_lifecycle::{OwnerSession, StartRequest};
use sqlx::Connection;
use std::{fs, net::TcpListener, path::PathBuf, str::FromStr};
use tokio::sync::watch;

#[tokio::test]
async fn missing_runtime_does_not_create_profile_directories() {
    let root = tempfile::tempdir().unwrap();
    let parent = root.path().join("instances/untouched");
    let request = StartRequest {
        schema: "rudder.postgres-owner.v1".into(),
        op: "start".into(),
        instance_id: "invalid-runtime".into(),
        data_dir: parent.join("db"),
        port: 0,
        bin_dir: root.path().join("missing-runtime"),
        database: "rudder_test".into(),
        user: "rudder".into(),
        password: "password".into(),
        fallback_passwords: vec![],
        parent_pid: None,
    };
    let error = match OwnerSession::start(request, watch::channel(false).1).await {
        Ok(_) => panic!("missing runtime unexpectedly started"),
        Err(error) => error,
    };
    assert_eq!(error.code, "invalid_runtime");
    assert!(!parent.exists());
}

/// Abruptly stop only the PID read from this test's private, owned PGDATA.
fn crash_owned_postgres(pid: u32) {
    #[cfg(unix)]
    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGKILL) }, 0);

    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, WAIT_OBJECT_0},
            System::Threading::{
                OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess,
                WaitForSingleObject,
            },
        };
        let handle = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(
            !handle.is_null(),
            "open owned PostgreSQL process: {}",
            std::io::Error::last_os_error()
        );
        let terminated = unsafe { TerminateProcess(handle, 1) };
        let error = std::io::Error::last_os_error();
        let waited = if terminated != 0 {
            Some(unsafe { WaitForSingleObject(handle, 10_000) })
        } else {
            None
        };
        unsafe { CloseHandle(handle) };
        assert_ne!(terminated, 0, "terminate owned PostgreSQL process: {error}");
        assert_eq!(waited, Some(WAIT_OBJECT_0), "owned PostgreSQL did not exit");
    }

    #[cfg(not(any(unix, windows)))]
    panic!("unsupported PostgreSQL test platform for PID {pid}");
}

/// Run the complete process lifecycle against a real supported PostgreSQL
/// runtime when CI or a developer explicitly provides one. This test avoids
/// probing or mutating any ambient PostgreSQL installation.
#[tokio::test]
async fn creates_attaches_and_stops_only_its_owned_cluster() {
    let Some(bin_dir) = std::env::var_os("RUDDER_TEST_POSTGRES_BIN_DIR") else {
        eprintln!("skipping real PostgreSQL lifecycle: RUDDER_TEST_POSTGRES_BIN_DIR is unset");
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("instances/Rudder 用户 fresh profile/db");
    assert!(!data_dir.parent().unwrap().exists());
    let port_probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let requested_port = port_probe.local_addr().unwrap().port();
    drop(port_probe);
    let request = |password: &str| StartRequest {
        schema: "rudder.postgres-owner.v1".into(),
        op: "start".into(),
        instance_id: "postgres-lifecycle-test".into(),
        data_dir: data_dir.clone(),
        port: requested_port,
        // Windows canonicalize produces the verbatim path that broke initdb's child lookup.
        bin_dir: fs::canonicalize(PathBuf::from(&bin_dir)).unwrap(),
        database: "rudder_test".into(),
        user: "rudder".into(),
        password: password.into(),
        fallback_passwords: vec!["password".into()],
        parent_pid: None,
    };

    let mut owner = OwnerSession::start(request("password"), watch::channel(false).1)
        .await
        .unwrap();
    assert!(owner.ready().owned);
    assert!(owner.ready().cluster_created);
    assert!(owner.ready().database_created);

    let mut attached = OwnerSession::start(request("password"), watch::channel(false).1)
        .await
        .unwrap();
    assert!(!attached.ready().owned);
    assert!(!attached.ready().cluster_created);
    assert!(!attached.ready().database_created);
    attached
        .stop(&attached.ready().lease_id.clone())
        .await
        .unwrap();

    let mut connection = sqlx::PgConnection::connect_with(
        &sqlx::postgres::PgConnectOptions::from_str(&owner.ready().connection_string).unwrap(),
    )
    .await
    .unwrap();
    let actual_dir: String = sqlx::query_scalar("SELECT current_setting('data_directory')")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(
        std::fs::canonicalize(actual_dir).unwrap(),
        std::fs::canonicalize(&data_dir).unwrap()
    );
    drop(connection);

    let first_port = owner.ready().port;
    owner.stop(&owner.ready().lease_id.clone()).await.unwrap();
    assert!(data_dir.join("PG_VERSION").is_file());
    TcpListener::bind(("127.0.0.1", first_port)).unwrap();

    let mut restarted =
        OwnerSession::start(request("lifecycle-test-password"), watch::channel(false).1)
            .await
            .unwrap();
    assert!(!restarted.ready().cluster_created);
    assert!(restarted.ready().owned);
    assert!(!restarted.ready().database_created);
    let mut connection = sqlx::PgConnection::connect_with(
        &sqlx::postgres::PgConnectOptions::from_str(&restarted.ready().connection_string).unwrap(),
    )
    .await
    .unwrap();
    let database: String = sqlx::query_scalar("SELECT current_database()")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(database, "rudder_test");
    sqlx::query("CREATE TABLE crash_marker(value TEXT NOT NULL)")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO crash_marker(value) VALUES ('preserved')")
        .execute(&mut connection)
        .await
        .unwrap();
    drop(connection);
    let restarted_port = restarted.ready().port;

    // Simulate an abrupt crash of the owner-managed PostgreSQL process. The
    // stale PID file and committed user row must survive, then PostgreSQL's
    // own startup path must recover the canonical cluster.
    let pid_file = data_dir.join("postmaster.pid");
    let crashed_pid = fs::read_to_string(&pid_file)
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .parse::<u32>()
        .unwrap();
    crash_owned_postgres(crashed_pid);
    restarted
        .stop(&restarted.ready().lease_id.clone())
        .await
        .unwrap();
    let stale_identity = fs::read_to_string(&pid_file).unwrap();
    assert_eq!(
        stale_identity.lines().next().unwrap(),
        crashed_pid.to_string()
    );
    TcpListener::bind(("127.0.0.1", restarted_port)).unwrap();

    let recovery =
        OwnerSession::start(request("lifecycle-test-password"), watch::channel(false).1).await;
    if let Err(error) = &recovery {
        let log_path = PathBuf::from(format!("{}.postgres.log", data_dir.display()));
        eprintln!(
            "stale-PID recovery failed ({}) with PostgreSQL log:\n{}",
            error.code,
            fs::read_to_string(log_path).unwrap_or_default()
        );
    }
    let mut recovered =
        recovery.expect("matching-major PostgreSQL should recover a dead postmaster PID");
    assert!(recovered.ready().owned);
    assert!(!recovered.ready().cluster_created);
    let mut connection = sqlx::PgConnection::connect_with(
        &sqlx::postgres::PgConnectOptions::from_str(&recovered.ready().connection_string).unwrap(),
    )
    .await
    .unwrap();
    let marker: String = sqlx::query_scalar("SELECT value FROM crash_marker")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(marker, "preserved");
    drop(connection);
    assert!(data_dir.join("PG_VERSION").is_file());
    recovered
        .stop(&recovered.ready().lease_id.clone())
        .await
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn live_foreign_pid_is_not_stopped_or_removed() {
    use std::process::Command;

    let Some(bin_dir) = std::env::var_os("RUDDER_TEST_POSTGRES_BIN_DIR") else {
        eprintln!("skipping foreign PID protection test: RUDDER_TEST_POSTGRES_BIN_DIR is unset");
        return;
    };
    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("cluster");
    let request = || StartRequest {
        schema: "rudder.postgres-owner.v1".into(),
        op: "start".into(),
        instance_id: "postgres-foreign-pid-test".into(),
        data_dir: data_dir.clone(),
        port: 0,
        bin_dir: PathBuf::from(&bin_dir),
        database: "rudder_test".into(),
        user: "rudder".into(),
        password: "foreign-pid-test-password".into(),
        fallback_passwords: vec![],
        parent_pid: None,
    };
    let mut owner = OwnerSession::start(request(), watch::channel(false).1)
        .await
        .unwrap();
    owner.stop(&owner.ready().lease_id.clone()).await.unwrap();

    let mut foreign = Command::new("/bin/sleep").arg("60").spawn().unwrap();
    let foreign_pid = foreign.id();
    let probe = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    let canonical_data_dir = fs::canonicalize(&data_dir).unwrap();
    let pid_file = data_dir.join("postmaster.pid");
    let foreign_identity = format!(
        "{foreign_pid}\n{}\n\n{port}\n",
        canonical_data_dir.display()
    );
    fs::write(&pid_file, &foreign_identity).unwrap();

    let result = OwnerSession::start(request(), watch::channel(false).1).await;
    let foreign_still_running = foreign.try_wait().unwrap().is_none();
    let identity_unchanged = fs::read_to_string(&pid_file).unwrap() == foreign_identity;
    let _ = foreign.kill();
    let _ = foreign.wait();

    let error = match result {
        Ok(mut unexpected_owner) => {
            let _ = unexpected_owner
                .stop(&unexpected_owner.ready().lease_id.clone())
                .await;
            panic!("an active foreign PID must prevent PostgreSQL recovery");
        }
        Err(error) => error,
    };
    assert_eq!(error.code, "unverified_postmaster");
    assert!(foreign_still_running);
    assert!(identity_unchanged);
    assert!(data_dir.join("PG_VERSION").is_file());
}
