use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    process::{Command, Stdio},
    time::Duration,
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
