#![cfg(unix)]

use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use std::{
    env, fs,
    io::{self, BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};
use tempfile::TempDir;

#[cfg(unix)]
#[test]
fn health_readiness_capabilities_and_sigterm_are_observable() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_rudder-server-foundation"))
        .env("RUDDER_NATIVE_LISTEN", "127.0.0.1:0")
        .env("RUDDER_NATIVE_DATABASE_REQUIRED", "false")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn server foundation");
    let stdout = child.stdout.take().expect("server stdout");
    let mut stdout = BufReader::new(stdout);
    let mut startup_line = String::new();
    stdout
        .read_line(&mut startup_line)
        .expect("startup receipt");
    let startup: Value = serde_json::from_str(&startup_line).expect("startup JSON");
    let bound_addr: SocketAddr = startup["boundAddr"]
        .as_str()
        .expect("bound address")
        .parse()
        .expect("socket address");
    assert_eq!(startup["publicListener"], false);
    assert_eq!(startup["productWriteAuthority"], false);
    assert_eq!(startup["databaseAuthority"], "read-only-product-data");
    assert_eq!(
        startup["readOnlyAuthorities"],
        serde_json::json!(["workspace_backup_list"])
    );

    let health = get_with_retry(bound_addr, "/healthz");
    assert!(health.starts_with("HTTP/1.1 200"), "{health}");
    assert!(health.contains("rudder.native.server.health.v1"));

    let readiness = get_with_retry(bound_addr, "/readyz");
    assert!(readiness.starts_with("HTTP/1.1 200"), "{readiness}");
    assert!(readiness.contains("\"state\":\"disabled\""));

    let capabilities = get_with_retry(bound_addr, "/v1/capabilities");
    assert!(capabilities.starts_with("HTTP/1.1 200"), "{capabilities}");
    assert!(capabilities.contains("\"effectiveEngine\":\"rust\""));
    assert!(capabilities.contains("maxQueueDepth"));
    assert!(capabilities.contains("maxDatabaseConnections"));
    assert!(capabilities.contains("workspace_backup_list"));

    let backup_list = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups",
    );
    assert!(backup_list.starts_with("HTTP/1.1 503"), "{backup_list}");
    assert!(backup_list.contains("database_disabled"), "{backup_list}");

    let pid = child.id() as i32;
    let signal_result = unsafe { libc::kill(pid, libc::SIGTERM) };
    assert_eq!(signal_result, 0, "send SIGTERM");
    let status = child.wait().expect("wait for graceful stop");
    assert!(status.success(), "server exited with {status}");

    let mut remaining = String::new();
    stdout
        .read_to_string(&mut remaining)
        .expect("shutdown receipt");
    let shutdown: Value = remaining
        .lines()
        .find_map(|line| serde_json::from_str(line).ok())
        .expect("shutdown JSON");
    assert_eq!(shutdown["schema"], "rudder.native.server.shutdown.v1");
    assert_eq!(shutdown["state"], "stopped");
    assert_eq!(shutdown["reason"], "sigterm");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn workspace_backup_list_uses_postgres_and_preserves_the_read_only_contract() {
    let postgres = PostgresHarness::start();
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&postgres.url)
        .await
        .expect("connect test PostgreSQL");
    sqlx::raw_sql(WORKSPACE_BACKUP_FIXTURE_SQL)
        .execute(&pool)
        .await
        .expect("install workspace backup fixture");
    pool.close().await;

    let (child, stdout, bound_addr) = spawn_server(&[
        ("RUDDER_NATIVE_DATABASE_URL", postgres.url.as_str()),
        ("RUDDER_NATIVE_DATABASE_REQUIRED", "true"),
        ("RUDDER_NATIVE_MAX_RESPONSE_BYTES", "4096"),
    ]);

    let org_one = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups",
    );
    assert!(org_one.starts_with("HTTP/1.1 200"), "{org_one}");
    let org_one_body = response_json(&org_one);
    let backups = org_one_body["backups"].as_array().expect("backup array");
    assert_eq!(
        backups.len(),
        2,
        "deleted and cross-org rows must be absent"
    );
    assert_eq!(backups[0]["id"], "10000000-0000-0000-0000-000000000002");
    assert_eq!(backups[1]["id"], "10000000-0000-0000-0000-000000000001");
    assert_eq!(backups[0]["orgId"], "00000000-0000-0000-0000-000000000001");
    assert_eq!(backups[0]["artifactProvider"], "local_file");
    assert_eq!(backups[0]["warnings"], serde_json::json!([]));
    assert_eq!(backups[0]["expiresAt"], "2026-09-30T12:00:00.000Z");
    assert_eq!(backups[1]["warnings"], serde_json::json!(["older"]));
    assert_eq!(backups[1]["expiresAt"], "2026-10-15T12:00:00.000Z");

    let org_two = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000002/workspace/backups",
    );
    let org_two_body = response_json(&org_two);
    assert_eq!(org_two_body["backups"].as_array().unwrap().len(), 1);
    assert_eq!(
        org_two_body["backups"][0]["orgId"],
        "00000000-0000-0000-0000-000000000002"
    );

    let unknown = get_with_retry(
        bound_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000099/workspace/backups",
    );
    assert!(unknown.starts_with("HTTP/1.1 404"), "{unknown}");
    assert!(unknown.contains("organization_not_found"), "{unknown}");

    let post = http_request(
        bound_addr,
        "POST",
        "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups",
    )
    .expect("POST backup route");
    assert!(post.starts_with("HTTP/1.1 404"), "{post}");
    stop_server(child, stdout);

    let (limited_child, limited_stdout, limited_addr) = spawn_server(&[
        ("RUDDER_NATIVE_DATABASE_URL", postgres.url.as_str()),
        ("RUDDER_NATIVE_DATABASE_REQUIRED", "true"),
        ("RUDDER_NATIVE_MAX_RESPONSE_BYTES", "128"),
    ]);
    let limited = get_with_retry(
        limited_addr,
        "/api/orgs/00000000-0000-0000-0000-000000000001/workspace/backups",
    );
    assert!(limited.starts_with("HTTP/1.1 500"), "{limited}");
    assert!(limited.contains("response_limit"), "{limited}");
    assert!(response_body_len(&limited) <= 128, "{limited}");
    stop_server(limited_child, limited_stdout);
}

#[cfg(unix)]
#[test]
fn request_limits_cover_fixed_and_chunked_bodies() {
    let (child, stdout, bound_addr) = spawn_server(&[("RUDDER_NATIVE_MAX_REQUEST_BYTES", "8")]);

    let exact = http_get_with_body(bound_addr, b"12345678").expect("exact request limit");
    assert!(exact.starts_with("HTTP/1.1 200"), "{exact}");

    let fixed_over =
        http_get_with_body(bound_addr, b"123456789").expect("fixed over-limit request");
    assert!(fixed_over.starts_with("HTTP/1.1 413"), "{fixed_over}");
    assert!(fixed_over.contains("request_too_large"), "{fixed_over}");

    let chunked_over =
        http_get_chunked(bound_addr, &[b"1234", b"56789"]).expect("chunked over-limit request");
    assert!(chunked_over.starts_with("HTTP/1.1 413"), "{chunked_over}");
    assert!(chunked_over.contains("request_too_large"), "{chunked_over}");

    stop_server(child, stdout);
}

#[cfg(unix)]
#[test]
fn queue_admission_promotes_two_waiters_after_active_request_releases() {
    let (child, stdout, bound_addr) = spawn_server(&[
        ("RUDDER_NATIVE_WORKERS", "1"),
        ("RUDDER_NATIVE_MAX_QUEUE_DEPTH", "2"),
    ]);
    let mut active = open_partial_get(bound_addr).expect("open active request");
    let mut queued_one = open_get_with_body(bound_addr, b"waitwait").expect("open first waiter");
    let mut queued_two = open_get_with_body(bound_addr, b"waitwait").expect("open second waiter");

    std::thread::sleep(Duration::from_millis(100));
    active
        .write_all(b"done")
        .expect("complete active request body");
    active.flush().expect("flush active request");
    let active_response = read_response(&mut active).expect("active response");
    assert!(
        active_response.starts_with("HTTP/1.1 200"),
        "{active_response}"
    );

    let first_response = read_response(&mut queued_one).expect("first queued response");
    let second_response = read_response(&mut queued_two).expect("second queued response");
    assert!(
        first_response.starts_with("HTTP/1.1 200"),
        "{first_response}"
    );
    assert!(
        second_response.starts_with("HTTP/1.1 200"),
        "{second_response}"
    );

    stop_server(child, stdout);
}

#[cfg(unix)]
#[test]
fn response_limit_fallback_obeys_one_byte_ceiling() {
    let (child, stdout, bound_addr) = spawn_server(&[("RUDDER_NATIVE_MAX_RESPONSE_BYTES", "1")]);
    let response = http_get(bound_addr, "/healthz").expect("health response");
    assert!(response.starts_with("HTTP/1.1 500"), "{response}");
    assert!(response_body_len(&response) <= 1, "{response}");
    stop_server(child, stdout);
}

#[cfg(unix)]
#[test]
fn sigterm_applies_configured_grace_to_an_inflight_request() {
    let (mut child, mut stdout, bound_addr) =
        spawn_server(&[("RUDDER_NATIVE_SHUTDOWN_GRACE_MS", "1000")]);
    let mut stream = TcpStream::connect_timeout(&bound_addr, Duration::from_millis(250))
        .expect("connect in-flight request");
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("set read timeout");
    write!(
        stream,
        "GET /healthz HTTP/1.1\r\nHost: {bound_addr}\r\nContent-Length: 64\r\nConnection: close\r\n\r\n"
    )
    .expect("write partial request headers");
    stream
        .write_all(b"hold")
        .expect("write partial request body");
    stream.flush().expect("flush partial request");

    let started = Instant::now();
    let signal_result = unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    assert_eq!(signal_result, 0, "send SIGTERM");
    let status = child.wait().expect("wait for graceful stop");
    assert!(status.success(), "server exited with {status}");
    assert!(started.elapsed() < Duration::from_secs(5));
    drop(stream);

    let mut remaining = String::new();
    stdout
        .read_to_string(&mut remaining)
        .expect("shutdown receipt");
    let shutdown: Value = remaining
        .lines()
        .find_map(|line| serde_json::from_str(line).ok())
        .expect("shutdown JSON");
    assert_eq!(shutdown["schema"], "rudder.native.server.shutdown.v1");
    assert_eq!(shutdown["state"], "stopped");
    assert_eq!(shutdown["reason"], "sigterm");
}

fn spawn_server(overrides: &[(&str, &str)]) -> (Child, BufReader<ChildStdout>, SocketAddr) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rudder-server-foundation"));
    command
        .env("RUDDER_NATIVE_LISTEN", "127.0.0.1:0")
        .env("RUDDER_NATIVE_DATABASE_REQUIRED", "false")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in [
        "RUDDER_NATIVE_MAX_REQUEST_BYTES",
        "RUDDER_NATIVE_MAX_RESPONSE_BYTES",
        "RUDDER_NATIVE_MAX_WEBSOCKET_MESSAGE_BYTES",
        "RUDDER_NATIVE_MAX_QUEUE_DEPTH",
        "RUDDER_NATIVE_MAX_DATABASE_CONNECTIONS",
        "RUDDER_NATIVE_WORKERS",
        "RUDDER_NATIVE_DATABASE_ACQUIRE_TIMEOUT_MS",
        "RUDDER_NATIVE_READINESS_TIMEOUT_MS",
        "RUDDER_NATIVE_SHUTDOWN_GRACE_MS",
        "RUDDER_NATIVE_DATABASE_URL",
    ] {
        command.env_remove(name);
    }
    command
        .env("RUDDER_NATIVE_LISTEN", "127.0.0.1:0")
        .env("RUDDER_NATIVE_DATABASE_REQUIRED", "false");
    for (name, value) in overrides {
        command.env(name, value);
    }
    let mut child = command.spawn().expect("spawn server foundation");
    let stdout = child.stdout.take().expect("server stdout");
    let mut stdout = BufReader::new(stdout);
    let mut startup_line = String::new();
    stdout
        .read_line(&mut startup_line)
        .expect("startup receipt");
    let startup: Value = serde_json::from_str(&startup_line).expect("startup JSON");
    let bound_addr: SocketAddr = startup["boundAddr"]
        .as_str()
        .expect("bound address")
        .parse()
        .expect("socket address");
    (child, stdout, bound_addr)
}

fn stop_server(mut child: Child, mut stdout: BufReader<ChildStdout>) {
    let pid = child.id() as i32;
    let signal_result = unsafe { libc::kill(pid, libc::SIGTERM) };
    assert_eq!(signal_result, 0, "send SIGTERM");
    let status = child.wait().expect("wait for graceful stop");
    assert!(status.success(), "server exited with {status}");

    let mut remaining = String::new();
    stdout
        .read_to_string(&mut remaining)
        .expect("shutdown receipt");
    let shutdown: Value = remaining
        .lines()
        .find_map(|line| serde_json::from_str(line).ok())
        .expect("shutdown JSON");
    assert_eq!(shutdown["schema"], "rudder.native.server.shutdown.v1");
    assert_eq!(shutdown["state"], "stopped");
    assert_eq!(shutdown["reason"], "sigterm");
}

fn get_with_retry(addr: SocketAddr, path: &str) -> String {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match http_get(addr, path) {
            Ok(response) => return response,
            Err(error) if std::time::Instant::now() < deadline => {
                let _ = error;
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => panic!("GET {path} failed: {error}"),
        }
    }
}

fn http_get(addr: SocketAddr, path: &str) -> std::io::Result<String> {
    http_request(addr, "GET", path)
}

fn http_request(addr: SocketAddr, method: &str, path: &str) -> std::io::Result<String> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

fn response_json(response: &str) -> Value {
    let (_, body) = response.split_once("\r\n\r\n").expect("HTTP response body");
    serde_json::from_str(body).expect("JSON response body")
}

fn http_get_with_body(addr: SocketAddr, body: &[u8]) -> io::Result<String> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET /healthz HTTP/1.1\r\nHost: {addr}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

fn open_partial_get(addr: SocketAddr) -> io::Result<TcpStream> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET /healthz HTTP/1.1\r\nHost: {addr}\r\nContent-Length: 8\r\nConnection: close\r\n\r\n"
    )?;
    stream.write_all(b"hold")?;
    stream.flush()?;
    Ok(stream)
}

fn open_get_with_body(addr: SocketAddr, body: &[u8]) -> io::Result<TcpStream> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET /healthz HTTP/1.1\r\nHost: {addr}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()?;
    Ok(stream)
}

fn read_response(stream: &mut TcpStream) -> io::Result<String> {
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

fn http_get_chunked(addr: SocketAddr, chunks: &[&[u8]]) -> io::Result<String> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET /healthz HTTP/1.1\r\nHost: {addr}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    )?;
    for chunk in chunks {
        write!(stream, "{:X}\r\n", chunk.len())?;
        stream.write_all(chunk)?;
        stream.write_all(b"\r\n")?;
    }
    stream.write_all(b"0\r\n\r\n")?;
    stream.flush()?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

fn response_body_len(response: &str) -> usize {
    response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.len())
        .unwrap_or_default()
}

struct PostgresHarness {
    _temp_dir: TempDir,
    data_dir: PathBuf,
    pg_ctl: PathBuf,
    url: String,
}

impl PostgresHarness {
    fn start() -> Self {
        let initdb = postgres_binary("initdb");
        let pg_ctl = postgres_binary("pg_ctl");
        let temp_dir = tempfile::tempdir().expect("create PostgreSQL temp directory");
        let data_dir = temp_dir.path().join("data");
        let log_path = temp_dir.path().join("postgres.log");
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("reserve PostgreSQL port")
            .local_addr()
            .unwrap()
            .port();

        run_checked(
            Command::new(&initdb).arg("-D").arg(&data_dir).args([
                "--encoding=UTF8",
                "--locale=C",
                "--auth=trust",
                "--username=postgres",
                "--no-sync",
            ]),
            "initdb",
        );
        run_checked(
            Command::new(&pg_ctl)
                .arg("-D")
                .arg(&data_dir)
                .arg("-l")
                .arg(&log_path)
                .arg("-o")
                .arg(format!("-h 127.0.0.1 -p {port} -F"))
                .args(["-w", "start"]),
            "pg_ctl start",
        );

        Self {
            _temp_dir: temp_dir,
            data_dir,
            pg_ctl,
            url: format!("postgresql://postgres@127.0.0.1:{port}/postgres"),
        }
    }
}

impl Drop for PostgresHarness {
    fn drop(&mut self) {
        let _ = Command::new(&self.pg_ctl)
            .arg("-D")
            .arg(&self.data_dir)
            .args(["-m", "immediate", "-w", "stop"])
            .status();
    }
}

fn postgres_binary(name: &str) -> PathBuf {
    let executable = format!("{name}{}", env::consts::EXE_SUFFIX);
    let mut candidates = Vec::new();
    if let Some(bin_dir) = env::var_os("RUDDER_POSTGRES_BIN_DIR") {
        candidates.push(PathBuf::from(bin_dir).join(&executable));
    }
    if let Some(path) = env::var_os("PATH") {
        candidates.extend(env::split_paths(&path).map(|dir| dir.join(&executable)));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin").join(&executable));
    candidates.push(PathBuf::from("/usr/local/bin").join(&executable));
    if let Ok(versions) = fs::read_dir("/usr/lib/postgresql") {
        candidates.extend(
            versions
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("bin").join(&executable)),
        );
    }
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| panic!("PostgreSQL test binary {name} was not found"))
}

fn run_checked(command: &mut Command, label: &str) {
    let output = command
        .output()
        .unwrap_or_else(|error| panic!("run {label}: {error}"));
    assert!(
        output.status.success(),
        "{label} failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

const WORKSPACE_BACKUP_FIXTURE_SQL: &str = r#"
CREATE TABLE organizations (id uuid PRIMARY KEY);
CREATE TABLE workspace_backups (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  status text NOT NULL,
  trigger_source text NOT NULL,
  artifact_ref text NOT NULL,
  archive_sha256 text,
  tree_sha256 text,
  file_count integer,
  byte_size bigint,
  compressed_size bigint,
  manifest jsonb,
  warnings jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz,
  restored_from_backup_id uuid,
  created_by_user_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
INSERT INTO organizations (id) VALUES
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002');
INSERT INTO workspace_backups (
  id, org_id, status, trigger_source, artifact_ref, file_count, byte_size,
  compressed_size, manifest, warnings, expires_at, created_at, updated_at
) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'completed', 'manual', '/backups/older.tar.zst', 2, 20, 10, '{"version":1}', '["older"]',
   '2026-10-15T12:00:00Z', '2026-08-30T12:00:00Z', '2026-08-30T12:00:00Z'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'completed', 'scheduled', '/backups/newer.tar.zst', 3, 30, 15, '{"version":1}', '{}',
   NULL, '2026-08-31T12:00:00Z', '2026-08-31T12:00:00Z'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
   'deleted', 'manual', '/backups/deleted.tar.zst', 1, 10, 5, '{}', '[]',
   NULL, '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z'),
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
   'completed', 'manual', '/backups/org-two.tar.zst', 1, 10, 5, '{}', '[]',
   NULL, '2026-08-31T12:00:00Z', '2026-08-31T12:00:00Z');
"#;
