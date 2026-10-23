#[cfg(unix)]
use rudder_postgres_lifecycle::{OwnerSession, StartRequest};
use serde_json::{Value, json};
#[cfg(unix)]
use sqlx::{Connection, postgres::PgConnectOptions};
#[cfg(unix)]
use std::{
    fs,
    net::TcpListener as StdTcpListener,
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};
use std::{
    io::Write,
    process::{Command, Stdio},
};
#[cfg(unix)]
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command as AsyncCommand,
    time::{Instant, sleep, timeout},
};

fn owner_binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_rudder-postgres-owner"))
}

#[cfg(unix)]
fn lease_metadata_path(data_dir: &Path) -> PathBuf {
    let mut name = std::ffi::OsString::from(".");
    name.push(data_dir.file_name().unwrap());
    name.push(".rudder-postgres-owner.lock");
    data_dir.parent().unwrap().join(name)
}

#[cfg(unix)]
fn assert_signal_cleanup_ack(response: &Value, ready: &Value, owner_pid: u32) {
    assert_eq!(response["schema"], "rudder.postgres-owner.v1");
    assert_eq!(response["op"], "signal_stopped");
    assert_eq!(response["signal"], "SIGTERM");
    assert_eq!(response["instance_id"], ready["instance_id"]);
    assert_eq!(response["lease_id"], ready["lease_id"]);
    assert_eq!(response["data_dir"], ready["data_dir"]);
    assert_eq!(response["port"], ready["port"]);
    assert_eq!(response["owner_pid"], owner_pid);
}

#[cfg(unix)]
fn real_postgres_bin_dir() -> Option<PathBuf> {
    std::env::var_os("RUDDER_TEST_POSTGRES_BIN_DIR").map(PathBuf::from)
}

#[cfg(unix)]
struct ExternalPostgres {
    pg_ctl: PathBuf,
    data_dir: PathBuf,
    started: bool,
}

#[cfg(unix)]
impl ExternalPostgres {
    fn stop(&mut self) -> std::process::ExitStatus {
        let output = Command::new(&self.pg_ctl)
            .args([
                "-D",
                self.data_dir.to_str().unwrap(),
                "-m",
                "fast",
                "-w",
                "stop",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        if output.success() {
            self.started = false;
        }
        output
    }
}

#[cfg(unix)]
impl Drop for ExternalPostgres {
    fn drop(&mut self) {
        if self.started {
            let _ = self.stop();
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn sigterm_is_registered_before_waiting_for_the_start_request() {
    let mut owner = AsyncCommand::new(env!("CARGO_BIN_EXE_rudder-postgres-owner"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let owner_pid = owner.id().unwrap();
    // Allow the freshly spawned owner to enter its Tokio runtime and register
    // the SIGTERM handler before exercising the pre-request cancellation path.
    // A shorter window races process startup on slower CI/macOS hosts.
    sleep(Duration::from_secs(2)).await;
    assert_eq!(unsafe { libc::kill(owner_pid as i32, libc::SIGTERM) }, 0);

    let mut stdout = BufReader::new(owner.stdout.take().unwrap());
    let mut line = String::new();
    timeout(Duration::from_secs(5), stdout.read_line(&mut line))
        .await
        .expect("registered SIGTERM handler should report cancellation before any start request")
        .unwrap();
    let response: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(response["op"], "error");
    assert_eq!(response["code"], "protocol_start_cancelled");
    assert_eq!(unsafe { libc::kill(std::process::id() as i32, 0) }, 0);
    let status = timeout(Duration::from_secs(5), owner.wait())
        .await
        .expect("owner should exit after acknowledging pre-request SIGTERM")
        .unwrap();
    assert_eq!(status.code(), Some(1));
}

#[cfg(unix)]
fn signal_test_request(data_dir: &Path, bin_dir: &Path, instance_id: &str, port: u16) -> Value {
    json!({
        "schema": "rudder.postgres-owner.v1",
        "op": "start",
        "instance_id": instance_id,
        "data_dir": data_dir,
        "port": port,
        "bin_dir": bin_dir,
        "database": "rudder_signal_test",
        "user": "rudder",
        "password": "signal-test-password",
        "fallback_passwords": [],
        "parent_pid": std::process::id()
    })
}

#[cfg(unix)]
#[tokio::test]
async fn sigterm_cleans_the_exact_owned_postgres_session_and_releases_its_lease() {
    use tokio::net::TcpStream;

    let Some(bin_dir) = real_postgres_bin_dir() else {
        eprintln!(
            "skipping real PostgreSQL SIGTERM cleanup: RUDDER_TEST_POSTGRES_BIN_DIR is unset"
        );
        return;
    };
    let bin_dir = fs::canonicalize(bin_dir).unwrap();
    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("owned-cluster");
    let mut cleanup = ExternalPostgres {
        pg_ctl: bin_dir.join("pg_ctl"),
        data_dir: data_dir.clone(),
        started: true,
    };
    let request = signal_test_request(&data_dir, &bin_dir, "signal-owned-test", 0);
    let mut owner = AsyncCommand::new(env!("CARGO_BIN_EXE_rudder-postgres-owner"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let owner_pid = owner.id().unwrap();
    let mut frame = serde_json::to_vec(&request).unwrap();
    frame.push(b'\n');
    owner
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&frame)
        .await
        .unwrap();

    let stdout = owner.stdout.take().unwrap();
    let mut stdout = BufReader::new(stdout);
    let mut ready_line = String::new();
    timeout(Duration::from_secs(90), stdout.read_line(&mut ready_line))
        .await
        .expect("owner should become ready with PostgreSQL 18.4")
        .unwrap();
    let ready: Value = serde_json::from_str(ready_line.trim()).unwrap();
    assert_eq!(ready["op"], "ready");
    assert_eq!(ready["instance_id"], "signal-owned-test");
    assert_eq!(ready["owned"], true);
    assert_eq!(unsafe { libc::kill(std::process::id() as i32, 0) }, 0);
    let pg_port = ready["port"].as_u64().unwrap() as u16;
    assert!(TcpStream::connect(("127.0.0.1", pg_port)).await.is_ok());
    let lease_path = lease_metadata_path(&data_dir);
    let lease: Value = serde_json::from_slice(&fs::read(&lease_path).unwrap()).unwrap();
    assert_eq!(lease["lease_id"], ready["lease_id"]);
    assert_eq!(lease["owner_pid"], owner_pid);
    assert_eq!(lease["owned"], true);

    assert_eq!(unsafe { libc::kill(owner_pid as i32, libc::SIGTERM) }, 0);
    let mut response_line = String::new();
    timeout(
        Duration::from_secs(30),
        stdout.read_line(&mut response_line),
    )
    .await
    .expect("owner should acknowledge SIGTERM only after PostgreSQL cleanup")
    .unwrap();
    let response: Value = serde_json::from_str(response_line.trim()).unwrap();
    assert_signal_cleanup_ack(&response, &ready, owner_pid);
    let status = timeout(Duration::from_secs(10), owner.wait())
        .await
        .expect("owner should exit after acknowledging cleanup")
        .unwrap();
    assert_eq!(status.code(), Some(0));
    assert!(!data_dir.join("postmaster.pid").exists());
    assert!(TcpStream::connect(("127.0.0.1", pg_port)).await.is_err());
    StdTcpListener::bind(("127.0.0.1", pg_port)).unwrap();
    assert!(fs::read(&lease_path).unwrap().is_empty());

    let mut restarted = OwnerSession::start(
        StartRequest {
            schema: "rudder.postgres-owner.v1".into(),
            op: "start".into(),
            instance_id: "signal-owned-restart-test".into(),
            data_dir: data_dir.clone(),
            port: 0,
            bin_dir,
            database: "rudder_signal_test".into(),
            user: "rudder".into(),
            password: "signal-test-password".into(),
            fallback_passwords: vec![],
            parent_pid: None,
        },
        tokio::sync::watch::channel(false).1,
    )
    .await
    .expect("the signal cleanup must release the exact data-directory lease");
    restarted
        .stop(&restarted.ready().lease_id.clone())
        .await
        .unwrap();
    cleanup.started = false;
}

#[cfg(unix)]
#[tokio::test]
async fn sigterm_releases_a_reused_postgres_lease_without_stopping_the_server() {
    use sqlx::PgConnection;

    let Some(bin_dir) = real_postgres_bin_dir() else {
        eprintln!("skipping reused PostgreSQL SIGTERM test: RUDDER_TEST_POSTGRES_BIN_DIR is unset");
        return;
    };
    let bin_dir = fs::canonicalize(bin_dir).unwrap();
    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("reused-cluster");
    let pg_ctl = bin_dir.join("pg_ctl");
    let port_probe = StdTcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = port_probe.local_addr().unwrap().port();
    drop(port_probe);

    let mut initial = OwnerSession::start(
        StartRequest {
            schema: "rudder.postgres-owner.v1".into(),
            op: "start".into(),
            instance_id: "signal-reused-create-test".into(),
            data_dir: data_dir.clone(),
            port: 0,
            bin_dir: bin_dir.clone(),
            database: "rudder_signal_test".into(),
            user: "rudder".into(),
            password: "signal-test-password".into(),
            fallback_passwords: vec![],
            parent_pid: None,
        },
        tokio::sync::watch::channel(false).1,
    )
    .await
    .unwrap();
    initial
        .stop(&initial.ready().lease_id.clone())
        .await
        .unwrap();

    let start = Command::new(&pg_ctl)
        .args(["-D", data_dir.to_str().unwrap(), "-o"])
        .arg(format!("-h 127.0.0.1 -p {port}"))
        .args(["-w", "start"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    let mut external = ExternalPostgres {
        pg_ctl: pg_ctl.clone(),
        data_dir: data_dir.clone(),
        started: start.success(),
    };
    assert!(start.success(), "pg_ctl start failed with {start}");

    let reused_request = signal_test_request(&data_dir, &bin_dir, "signal-reused-test", 0);
    let mut owner = AsyncCommand::new(env!("CARGO_BIN_EXE_rudder-postgres-owner"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let owner_pid = owner.id().unwrap();
    let mut frame = serde_json::to_vec(&reused_request).unwrap();
    frame.push(b'\n');
    owner
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&frame)
        .await
        .unwrap();
    let mut stdout = BufReader::new(owner.stdout.take().unwrap());
    let mut ready_line = String::new();
    timeout(Duration::from_secs(30), stdout.read_line(&mut ready_line))
        .await
        .expect("owner should attach to the exact pre-existing PostgreSQL cluster")
        .unwrap();
    let ready: Value = serde_json::from_str(ready_line.trim()).unwrap();
    assert_eq!(ready["op"], "ready");
    assert_eq!(ready["instance_id"], "signal-reused-test");
    assert_eq!(ready["owned"], false);
    assert_eq!(ready["port"], port);
    let lease_path = lease_metadata_path(&data_dir);
    let lease: Value = serde_json::from_slice(&fs::read(&lease_path).unwrap()).unwrap();
    assert_eq!(lease["lease_id"], ready["lease_id"]);
    assert_eq!(lease["owner_pid"], owner_pid);
    assert_eq!(lease["owned"], false);

    assert_eq!(unsafe { libc::kill(owner_pid as i32, libc::SIGTERM) }, 0);
    let mut response_line = String::new();
    timeout(
        Duration::from_secs(15),
        stdout.read_line(&mut response_line),
    )
    .await
    .expect("reused lease cleanup should be acknowledged")
    .unwrap();
    let response: Value = serde_json::from_str(response_line.trim()).unwrap();
    assert_signal_cleanup_ack(&response, &ready, owner_pid);
    let status = timeout(Duration::from_secs(10), owner.wait())
        .await
        .expect("owner should exit after releasing the reused lease")
        .unwrap();
    assert_eq!(status.code(), Some(0));
    assert!(StdTcpListener::bind(("127.0.0.1", port)).is_err());
    assert!(fs::read(&lease_path).unwrap().is_empty());

    let mut connection = PgConnection::connect_with(
        &PgConnectOptions::from_str(ready["connection_string"].as_str().unwrap()).unwrap(),
    )
    .await
    .expect("the pre-existing PostgreSQL must remain reachable after owner SIGTERM");
    let value: i32 = sqlx::query_scalar("SELECT 1")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(value, 1);
    drop(connection);

    let mut reattached = OwnerSession::start(
        StartRequest {
            schema: "rudder.postgres-owner.v1".into(),
            op: "start".into(),
            instance_id: "signal-reused-reattach-test".into(),
            data_dir: data_dir.clone(),
            port: 0,
            bin_dir: bin_dir.clone(),
            database: "rudder_signal_test".into(),
            user: "rudder".into(),
            password: "signal-test-password".into(),
            fallback_passwords: vec![],
            parent_pid: None,
        },
        tokio::sync::watch::channel(false).1,
    )
    .await
    .expect("the exact reused lease must be available again");
    assert!(!reattached.ready().owned);
    reattached
        .stop(&reattached.ready().lease_id.clone())
        .await
        .unwrap();
    assert!(StdTcpListener::bind(("127.0.0.1", port)).is_err());

    let stop = external.stop();
    assert!(stop.success(), "pg_ctl stop failed with {stop}");
    assert!(StdTcpListener::bind(("127.0.0.1", port)).is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn sigterm_during_pre_ready_runtime_probe_drains_the_probe_without_creating_a_lease() {
    use std::{fs, os::unix::fs::PermissionsExt};

    let root = tempfile::tempdir().unwrap();
    let bin_dir = root.path().join("bin");
    fs::create_dir(&bin_dir).unwrap();
    let probe_pid_path = root.path().join("initdb-probe.pid");
    let initdb = bin_dir.join("initdb");
    fs::write(
        &initdb,
        format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo $$ > {}; exec /bin/sleep 30; fi\necho 'initdb (PostgreSQL) 18.4'\n",
            probe_pid_path.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&initdb, fs::Permissions::from_mode(0o755)).unwrap();
    for name in ["postgres", "pg_ctl"] {
        let binary = bin_dir.join(name);
        fs::write(&binary, "#!/bin/sh\necho 'PostgreSQL 18.4'\n").unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let data_dir = root.path().join("cluster");
    let request = json!({
        "schema": "rudder.postgres-owner.v1",
        "op": "start",
        "instance_id": "signal-startup-cancel-test",
        "data_dir": data_dir,
        "port": 0,
        "bin_dir": bin_dir,
        "database": "rudder",
        "user": "rudder",
        "password": "signal-startup-test-password",
        "fallback_passwords": [],
        "parent_pid": std::process::id()
    });
    let mut owner = AsyncCommand::new(env!("CARGO_BIN_EXE_rudder-postgres-owner"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let owner_pid = owner.id().unwrap();
    let mut frame = serde_json::to_vec(&request).unwrap();
    frame.push(b'\n');
    owner
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&frame)
        .await
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    let probe_pid = loop {
        if let Ok(value) = fs::read_to_string(&probe_pid_path)
            && let Ok(pid) = value.trim().parse::<u32>()
        {
            break pid;
        }
        assert!(
            Instant::now() < deadline,
            "initdb version probe did not start"
        );
        sleep(Duration::from_millis(10)).await;
    };
    assert_ne!(probe_pid, owner_pid);
    assert_eq!(unsafe { libc::kill(owner_pid as i32, libc::SIGTERM) }, 0);

    let mut stdout = BufReader::new(owner.stdout.take().unwrap());
    let mut line = String::new();
    timeout(Duration::from_secs(10), stdout.read_line(&mut line))
        .await
        .expect("owner should acknowledge pre-ready cancellation after draining the probe")
        .unwrap();
    let response: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(response["op"], "error");
    assert_eq!(response["code"], "protocol_start_cancelled");
    let status = timeout(Duration::from_secs(5), owner.wait())
        .await
        .expect("owner should exit after startup cancellation")
        .unwrap();
    assert_eq!(status.code(), Some(1));
    assert!(unsafe { libc::kill(probe_pid as i32, 0) } == -1);
    assert!(unsafe { libc::kill(-(probe_pid as i32), 0) } == -1);
    assert!(!data_dir.exists());
    assert!(!lease_metadata_path(&data_dir).exists());
    assert_eq!(unsafe { libc::kill(std::process::id() as i32, 0) }, 0);
}

#[test]
fn version_flag_is_available_without_a_protocol_frame() {
    let output = owner_binary().arg("--version").output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        format!("rudder-postgres-owner {}", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn startup_failure_is_structured_and_does_not_echo_credentials() {
    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("cluster");
    let missing_bin_dir = root.path().join("missing-runtime");
    let request = json!({
        "schema": "rudder.postgres-owner.v1",
        "op": "start",
        "instance_id": "protocol-test",
        "data_dir": data_dir,
        "port": 54329,
        "bin_dir": missing_bin_dir,
        "database": "rudder",
        "user": "rudder",
        "password": "protocol-secret-must-not-be-echoed",
        "fallback_passwords": ["legacy-secret"],
        "parent_pid": null
    });
    let mut child = owner_binary()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    serde_json::to_writer(child.stdin.as_mut().unwrap(), &request).unwrap();
    child.stdin.as_mut().unwrap().write_all(b"\n").unwrap();
    drop(child.stdin.take());
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    let line = String::from_utf8(output.stdout).unwrap();
    let response: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(response["schema"], "rudder.postgres-owner.v1");
    assert_eq!(response["op"], "error");
    assert_eq!(response["code"], "invalid_runtime");
    assert!(!line.contains("protocol-secret-must-not-be-echoed"));
    assert!(!line.contains("legacy-secret"));
    assert!(!data_dir.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn eof_during_startup_cancels_the_runtime_probe_before_data_changes() {
    use std::{fs, os::unix::fs::PermissionsExt, time::Duration};
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        process::Command,
        time::timeout,
    };

    let root = tempfile::tempdir().unwrap();
    let bin_dir = root.path().join("bin");
    fs::create_dir(&bin_dir).unwrap();
    for name in ["initdb", "postgres", "pg_ctl"] {
        let path = bin_dir.join(name);
        fs::write(&path, "#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let data_dir = root.path().join("cluster");
    let request = json!({
        "schema": "rudder.postgres-owner.v1",
        "op": "start",
        "instance_id": "cancel-test",
        "data_dir": data_dir,
        "port": 54329,
        "bin_dir": bin_dir,
        "database": "rudder",
        "user": "rudder",
        "password": "cancel-test-secret",
        "parent_pid": null
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_rudder-postgres-owner"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut frame = serde_json::to_vec(&request).unwrap();
    frame.push(b'\n');
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&frame)
        .await
        .unwrap();
    drop(child.stdin.take());

    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    timeout(Duration::from_secs(5), reader.read_line(&mut line))
        .await
        .expect("startup cancellation should respond promptly")
        .unwrap();
    let response: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(response["op"], "error");
    assert_eq!(response["code"], "protocol_start_cancelled");
    assert!(!line.contains("cancel-test-secret"));
    assert!(
        !timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("owner should exit after cancelling startup")
            .unwrap()
            .success()
    );
    assert!(!root.path().join("cluster").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn eof_during_real_postgres_start_waits_for_owned_process_and_lease_cleanup() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    use tokio::net::TcpStream;

    let Some(real_bin_dir) = std::env::var_os("RUDDER_TEST_POSTGRES_BIN_DIR") else {
        eprintln!("skipping real PostgreSQL cancellation: RUDDER_TEST_POSTGRES_BIN_DIR is unset");
        return;
    };
    let real_bin_dir = fs::canonicalize(real_bin_dir).unwrap();
    let requested_port = std::env::var("RUDDER_TEST_POSTGRES_CANCEL_PORT")
        .ok()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(0);
    if requested_port != 0 {
        let probe = std::net::TcpListener::bind(("127.0.0.1", requested_port))
            .expect("configured cancellation-test PostgreSQL port must be free");
        drop(probe);
    }
    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("cluster");
    let database = "rudder_cancel_test";
    let user = "rudder";
    let password = "cancel-real-pg-password";

    let request = |bin_dir: PathBuf, parent_pid: Option<u32>| StartRequest {
        schema: "rudder.postgres-owner.v1".into(),
        op: "start".into(),
        instance_id: "real-pg-cancel-test".into(),
        data_dir: data_dir.clone(),
        port: 0,
        bin_dir,
        database: database.into(),
        user: user.into(),
        password: password.into(),
        fallback_passwords: vec![],
        parent_pid,
    };

    let mut initial = OwnerSession::start(
        request(real_bin_dir.clone(), None),
        tokio::sync::watch::channel(false).1,
    )
    .await
    .unwrap();
    let mut connection = sqlx::PgConnection::connect_with(
        &PgConnectOptions::from_str(&initial.ready().connection_string).unwrap(),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TABLE cancellation_marker(value TEXT NOT NULL)")
        .execute(&mut connection)
        .await
        .unwrap();
    sqlx::query("INSERT INTO cancellation_marker(value) VALUES ('preserved')")
        .execute(&mut connection)
        .await
        .unwrap();
    drop(connection);
    initial
        .stop(&initial.ready().lease_id.clone())
        .await
        .unwrap();

    let runtime_root = root.path().join("wrapped-runtime");
    let wrapped_bin_dir = runtime_root.join("bin");
    let wrapped_share = runtime_root.join("share");
    fs::create_dir_all(&wrapped_bin_dir).unwrap();
    fs::create_dir_all(&wrapped_share).unwrap();
    let real_postgres = fs::canonicalize(real_bin_dir.join("postgres")).unwrap();
    for entry in fs::read_dir(&real_bin_dir).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() == "postgres" {
            continue;
        }
        let target = fs::canonicalize(entry.path()).unwrap_or(entry.path());
        symlink(target, wrapped_bin_dir.join(entry.file_name())).unwrap();
    }
    let real_share = fs::canonicalize(real_bin_dir.join("../share/postgresql")).unwrap();
    symlink(real_share, wrapped_share.join("postgresql")).unwrap();
    let hba_file = root.path().join("reject-host-connections.conf");
    fs::write(
        &hba_file,
        "local all all trust\nhost all all 127.0.0.1/32 reject\nhost all all ::1/128 reject\n",
    )
    .unwrap();
    let postgres_wrapper = wrapped_bin_dir.join("postgres");
    let wrapper = format!(
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exec {} \"$@\"; fi\nexec {} \"$@\" -c {}\n",
        shell_quote(&real_postgres),
        shell_quote(&real_postgres),
        shell_quote(Path::new(&format!("hba_file={}", hba_file.display()))),
    );
    fs::write(&postgres_wrapper, wrapper).unwrap();
    fs::set_permissions(&postgres_wrapper, fs::Permissions::from_mode(0o755)).unwrap();

    let protocol_request = json!({
        "schema": "rudder.postgres-owner.v1",
        "op": "start",
        "instance_id": "real-pg-cancel-test",
        "data_dir": data_dir,
        "port": requested_port,
        "bin_dir": wrapped_bin_dir,
        "database": database,
        "user": user,
        "password": password,
        "fallback_passwords": [],
        "parent_pid": std::process::id()
    });
    let mut owner = AsyncCommand::new(env!("CARGO_BIN_EXE_rudder-postgres-owner"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut frame = serde_json::to_vec(&protocol_request).unwrap();
    frame.push(b'\n');
    owner
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&frame)
        .await
        .unwrap();

    let deadline = Instant::now() + Duration::from_secs(20);
    let (pid, port) = loop {
        let pid_file = data_dir.join("postmaster.pid");
        if let Ok(contents) = fs::read_to_string(&pid_file) {
            let lines = contents.lines().collect::<Vec<_>>();
            if let (Some(pid), Some(port)) = (
                lines.first().and_then(|value| value.parse::<u32>().ok()),
                lines.get(3).and_then(|value| value.parse::<u16>().ok()),
            ) && TcpStream::connect(("127.0.0.1", port)).await.is_ok()
            {
                break (pid, port);
            }
        }
        assert!(
            Instant::now() < deadline,
            "real PostgreSQL did not start listening"
        );
        assert!(
            owner.try_wait().unwrap().is_none(),
            "owner exited before cancellation"
        );
        sleep(Duration::from_millis(25)).await;
    };
    let mut stdout = BufReader::new(owner.stdout.take().unwrap());
    let mut unexpected_ready = vec![0; 1];
    assert!(
        timeout(
            Duration::from_millis(100),
            stdout.read(&mut unexpected_ready)
        )
        .await
        .is_err(),
        "rejecting HBA should keep startup pre-ready"
    );
    drop(owner.stdin.take());

    let mut line = String::new();
    timeout(Duration::from_secs(10), stdout.read_line(&mut line))
        .await
        .expect("owner should acknowledge cancellation after process cleanup")
        .unwrap();
    let response: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(response["schema"], "rudder.postgres-owner.v1");
    assert_eq!(response["op"], "error");
    assert_eq!(response["code"], "protocol_start_cancelled");
    let status = timeout(Duration::from_secs(5), owner.wait())
        .await
        .expect("owner should exit after cancellation")
        .unwrap();
    assert_eq!(status.code(), Some(1));
    assert!(!data_dir.join("postmaster.pid").exists());
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    assert_eq!(unsafe { libc::kill(-(pid as i32), 0) }, -1);
    std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
    let after_ack = data_dir_fingerprint(&data_dir);
    sleep(Duration::from_millis(300)).await;
    assert_eq!(
        after_ack,
        data_dir_fingerprint(&data_dir),
        "PGDATA must stop changing before the cancellation acknowledgement"
    );

    let mut resumed = OwnerSession::start(
        request(real_bin_dir, None),
        tokio::sync::watch::channel(false).1,
    )
    .await
    .expect("cancellation must release the lease and preserve a reusable cluster");
    let mut connection = sqlx::PgConnection::connect_with(
        &PgConnectOptions::from_str(&resumed.ready().connection_string).unwrap(),
    )
    .await
    .unwrap();
    let value: String = sqlx::query_scalar("SELECT value FROM cancellation_marker")
        .fetch_one(&mut connection)
        .await
        .unwrap();
    assert_eq!(value, "preserved");
    drop(connection);
    resumed
        .stop(&resumed.ready().lease_id.clone())
        .await
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn eof_during_real_initdb_cleans_staging_and_allows_first_start_retry() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let Some(real_bin_dir) = std::env::var_os("RUDDER_TEST_POSTGRES_BIN_DIR") else {
        eprintln!("skipping real initdb cancellation: RUDDER_TEST_POSTGRES_BIN_DIR is unset");
        return;
    };
    let real_bin_dir = fs::canonicalize(real_bin_dir).unwrap();
    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("cluster");
    let runtime_root = root.path().join("wrapped-runtime");
    let wrapped_bin_dir = runtime_root.join("bin");
    let wrapped_share = runtime_root.join("share");
    fs::create_dir_all(&wrapped_bin_dir).unwrap();
    fs::create_dir_all(&wrapped_share).unwrap();

    let real_initdb = fs::canonicalize(real_bin_dir.join("initdb")).unwrap();
    for entry in fs::read_dir(&real_bin_dir).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() == "initdb" {
            continue;
        }
        let target = fs::canonicalize(entry.path()).unwrap_or(entry.path());
        symlink(target, wrapped_bin_dir.join(entry.file_name())).unwrap();
    }
    let real_share = fs::canonicalize(real_bin_dir.join("../share/postgresql")).unwrap();
    symlink(real_share, wrapped_share.join("postgresql")).unwrap();
    let initdb_wrapper = wrapped_bin_dir.join("initdb");
    let quoted_initdb = shell_quote(&real_initdb);
    let wrapper = format!(
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then exec {quoted_initdb} \"$@\"; fi\n\
data_dir=\nprevious=\nfor argument do\n  if [ \"$previous\" = \"-D\" ]; then data_dir=\"$argument\"; break; fi\n  if [ \"$argument\" = \"-D\" ]; then previous=\"-D\"; else previous=; fi\ndone\n\
{quoted_initdb} \"$@\" &\nchild=$!\nwhile [ ! -f \"$data_dir/PG_VERSION\" ]; do sleep 0.01; done\nkill -STOP \"$child\"\nwait \"$child\"\n"
    );
    fs::write(&initdb_wrapper, wrapper).unwrap();
    fs::set_permissions(&initdb_wrapper, fs::Permissions::from_mode(0o755)).unwrap();

    let request = json!({
        "schema": "rudder.postgres-owner.v1",
        "op": "start",
        "instance_id": "real-initdb-cancel-test",
        "data_dir": data_dir,
        "port": 0,
        "bin_dir": wrapped_bin_dir,
        "database": "rudder_initdb_cancel_test",
        "user": "rudder",
        "password": "initdb-cancel-test-password",
        "fallback_passwords": [],
        "parent_pid": std::process::id()
    });
    let mut owner = AsyncCommand::new(env!("CARGO_BIN_EXE_rudder-postgres-owner"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut frame = serde_json::to_vec(&request).unwrap();
    frame.push(b'\n');
    owner
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&frame)
        .await
        .unwrap();

    let staging_prefix = ".rudder-postgres-initdb-";
    let deadline = Instant::now() + Duration::from_secs(30);
    let staging_dir = loop {
        let candidate = fs::read_dir(root.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(staging_prefix))
                    && path.join("PG_VERSION").is_file()
            });
        if let Some(staging_dir) = candidate {
            break staging_dir;
        }
        assert!(
            Instant::now() < deadline,
            "real initdb did not write PG_VERSION into its private staging directory"
        );
        assert!(
            owner.try_wait().unwrap().is_none(),
            "owner exited before initdb cancellation"
        );
        sleep(Duration::from_millis(10)).await;
    };
    assert!(
        !data_dir.exists(),
        "canonical PGDATA must remain unpublished"
    );
    assert!(staging_dir.join("PG_VERSION").is_file());
    drop(owner.stdin.take());

    let mut stdout = BufReader::new(owner.stdout.take().unwrap());
    let mut line = String::new();
    timeout(Duration::from_secs(10), stdout.read_line(&mut line))
        .await
        .expect("owner should acknowledge cancellation after initdb child cleanup")
        .unwrap();
    let response: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(response["op"], "error");
    assert_eq!(response["code"], "protocol_start_cancelled");
    let status = timeout(Duration::from_secs(5), owner.wait())
        .await
        .expect("owner should exit after initdb cancellation")
        .unwrap();
    assert_eq!(status.code(), Some(1));
    assert!(
        !data_dir.exists(),
        "cancelled initdb must not publish PGDATA"
    );
    assert!(
        !staging_dir.exists(),
        "verified cancellation cleanup should remove only this owner's staging directory"
    );

    let mut retried = OwnerSession::start(
        StartRequest {
            schema: "rudder.postgres-owner.v1".into(),
            op: "start".into(),
            instance_id: "real-initdb-retry-test".into(),
            data_dir: data_dir.clone(),
            port: 0,
            bin_dir: real_bin_dir,
            database: "rudder_initdb_cancel_test".into(),
            user: "rudder".into(),
            password: "initdb-cancel-test-password".into(),
            fallback_passwords: vec![],
            parent_pid: None,
        },
        tokio::sync::watch::channel(false).1,
    )
    .await
    .expect("first initialization must succeed on retry after cancellation");
    assert!(retried.ready().cluster_created);
    assert!(retried.ready().database_created);
    retried
        .stop(&retried.ready().lease_id.clone())
        .await
        .unwrap();
}

#[cfg(unix)]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

#[cfg(unix)]
fn data_dir_fingerprint(root: &Path) -> Vec<(PathBuf, u64, Option<std::time::SystemTime>)> {
    fn collect(
        root: &Path,
        current: &Path,
        files: &mut Vec<(PathBuf, u64, Option<std::time::SystemTime>)>,
    ) {
        for entry in fs::read_dir(current).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).unwrap();
            if metadata.is_dir() {
                collect(root, &path, files);
            } else if metadata.is_file() {
                files.push((
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    metadata.len(),
                    metadata.modified().ok(),
                ));
            }
        }
    }
    let mut files = Vec::new();
    collect(root, root, &mut files);
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}
