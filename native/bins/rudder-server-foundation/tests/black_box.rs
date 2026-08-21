use serde_json::Value;
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    process::{Child, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};

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
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
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
