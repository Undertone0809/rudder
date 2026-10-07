#![cfg(unix)]

use serde_json::Value;
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const ACTOR_ENVELOPE_KEY: &str = "actor-envelope-test-key-0123456789abcdef";
const INGRESS_AUTH_KEY: &str = "private-ingress-test-key-0123456789abcdef";
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
static PROCESS_TEST_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn dual_listener_receipt_and_readiness_use_the_loopback_node_health_upstream() {
    let _serial = process_test_lock();
    let node = MockHealthServer::start();
    let upstream = format!("http://{}", node.addr());
    let child = ServerChild::spawn(&[
        ("RUDDER_NATIVE_PUBLIC_LISTEN", "127.0.0.1:0"),
        ("RUDDER_NATIVE_NODE_UPSTREAM", &upstream),
        ("RUDDER_NATIVE_INGRESS_AUTH_KEY", INGRESS_AUTH_KEY),
    ]);
    let startup = child.next_json_line("startup receipt");

    let private_addr = receipt_addr(&startup, "boundAddr");
    let public_addr = receipt_addr(&startup["publicIngress"], "boundAddr");
    assert!(
        !startup["publicListener"]
            .as_bool()
            .expect("private listener is marked non-public")
    );
    assert!(
        startup["publicIngress"]["publicListener"]
            .as_bool()
            .expect("public ingress listener is marked public")
    );
    assert!(private_addr.ip().is_loopback());
    assert!(public_addr.ip().is_loopback());
    assert_ne!(private_addr, public_addr);

    let private_health = get_http_200(private_addr, "/healthz");
    assert!(
        private_health.contains("rudder.native.server.health.v1"),
        "{private_health}"
    );
    let public_readiness = get_http_200(public_addr, "/readyz");
    assert!(
        public_readiness.contains("\"status\":\"ready\""),
        "{public_readiness}"
    );
    assert!(node.requests().iter().any(|(request, host)| {
        request == "GET /api/health HTTP/1.1" && host == &public_addr.to_string()
    }));
}

#[test]
fn partial_public_listener_configuration_fails_closed_without_leaking_private_socket() {
    let _serial = process_test_lock();
    let node = MockHealthServer::start();
    let private_addr = unused_loopback_addr();
    let upstream = format!("http://{}", node.addr());
    let mut child = ServerChild::spawn(&[
        ("RUDDER_NATIVE_LISTEN", &private_addr.to_string()),
        ("RUDDER_NATIVE_PUBLIC_LISTEN", "127.0.0.1:0"),
        ("RUDDER_NATIVE_NODE_UPSTREAM", &upstream),
    ]);

    let status = child
        .wait_for_exit(CHILD_EXIT_TIMEOUT)
        .expect("partial public listener configuration must exit");
    assert!(
        !status.success(),
        "partial public configuration must fail closed"
    );
    assert_socket_available(private_addr);
}

#[test]
fn occupied_public_socket_fails_startup_and_releases_the_private_listener() {
    let _serial = process_test_lock();
    let node = MockHealthServer::start();
    let public_socket = TcpListener::bind("127.0.0.1:0").expect("reserve public socket");
    let public_addr = public_socket.local_addr().expect("public socket address");
    let private_socket = loop {
        let socket = TcpListener::bind("127.0.0.1:0").expect("reserve private socket");
        if socket.local_addr().expect("private socket address") != public_addr {
            break socket;
        }
    };
    let private_addr = private_socket.local_addr().expect("private socket address");
    drop(private_socket);

    let upstream = format!("http://{}", node.addr());
    let mut child = ServerChild::spawn(&[
        ("RUDDER_NATIVE_LISTEN", &private_addr.to_string()),
        ("RUDDER_NATIVE_PUBLIC_LISTEN", &public_addr.to_string()),
        ("RUDDER_NATIVE_NODE_UPSTREAM", &upstream),
        ("RUDDER_NATIVE_INGRESS_AUTH_KEY", INGRESS_AUTH_KEY),
    ]);

    let status = child
        .wait_for_exit(CHILD_EXIT_TIMEOUT)
        .expect("occupied public listener must fail startup");
    assert!(!status.success(), "occupied public socket must fail closed");
    assert_socket_available(private_addr);
    assert!(
        TcpListener::bind(public_addr).is_err(),
        "fixture keeps public socket occupied"
    );
}

#[test]
fn sigterm_stops_both_listeners_emits_receipt_and_releases_both_ports() {
    let _serial = process_test_lock();
    let node = MockHealthServer::start();
    let upstream = format!("http://{}", node.addr());
    let mut child = ServerChild::spawn(&[
        ("RUDDER_NATIVE_PUBLIC_LISTEN", "127.0.0.1:0"),
        ("RUDDER_NATIVE_NODE_UPSTREAM", &upstream),
        ("RUDDER_NATIVE_INGRESS_AUTH_KEY", INGRESS_AUTH_KEY),
    ]);
    let startup = child.next_json_line("startup receipt");
    let private_addr = receipt_addr(&startup, "boundAddr");
    let public_addr = receipt_addr(&startup["publicIngress"], "boundAddr");

    get_http_200(private_addr, "/healthz");
    get_http_200(public_addr, "/readyz");
    assert!(
        !node.requests().is_empty(),
        "public readiness probes Node health"
    );

    child.send_sigterm();
    let status = child
        .wait_for_exit(CHILD_EXIT_TIMEOUT)
        .expect("SIGTERM shuts down the binary");
    assert!(status.success(), "server exited with {status}");
    let shutdown = child.next_json_line("shutdown receipt");
    assert_eq!(shutdown["schema"], "rudder.native.server.shutdown.v1");
    assert_eq!(shutdown["state"], "stopped");
    assert_eq!(shutdown["reason"], "sigterm");
    assert_socket_available(private_addr);
    assert_socket_available(public_addr);
}

fn process_test_lock() -> std::sync::MutexGuard<'static, ()> {
    PROCESS_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn receipt_addr(receipt: &Value, field: &str) -> SocketAddr {
    receipt[field]
        .as_str()
        .expect("listener address in startup receipt")
        .parse()
        .expect("valid listener socket address")
}

fn unused_loopback_addr() -> SocketAddr {
    TcpListener::bind("127.0.0.1:0")
        .expect("reserve ephemeral loopback socket")
        .local_addr()
        .expect("ephemeral loopback address")
}

fn assert_socket_available(addr: SocketAddr) {
    let listener = TcpListener::bind(addr).expect("listener port released after child exit");
    drop(listener);
}

fn get_http_200(addr: SocketAddr, path: &str) -> String {
    let deadline = Instant::now() + CHILD_EXIT_TIMEOUT;
    loop {
        let last_response = match http_get(addr, path) {
            Ok(response) if response.starts_with("HTTP/1.1 200") => return response,
            Ok(response) => response,
            Err(error) => error.to_string(),
        };
        assert!(
            Instant::now() < deadline,
            "GET {path} on {addr} did not become healthy: {last_response}"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn http_get(addr: SocketAddr, path: &str) -> io::Result<String> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(250))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
    )?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

struct MockHealthServer {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<(String, String)>>>,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MockHealthServer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock Node health upstream");
        listener
            .set_nonblocking(true)
            .expect("make mock health listener nonblocking");
        let addr = listener.local_addr().expect("mock health address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let running = Arc::new(AtomicBool::new(true));
        let server_requests = requests.clone();
        let server_running = running.clone();
        let thread = thread::spawn(move || {
            while server_running.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => serve_health_request(stream, &server_requests),
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            addr,
            requests,
            running,
            thread: Some(thread),
        }
    }

    fn addr(&self) -> SocketAddr {
        self.addr
    }

    fn requests(&self) -> Vec<(String, String)> {
        self.requests.lock().expect("mock request lock").clone()
    }
}

impl Drop for MockHealthServer {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn serve_health_request(mut stream: TcpStream, requests: &Mutex<Vec<(String, String)>>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let Ok(reader_stream) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(reader_stream);
    let mut request = String::new();
    if reader.read_line(&mut request).is_err() {
        return;
    }
    let mut host = String::new();
    loop {
        let mut header = String::new();
        match reader.read_line(&mut header) {
            Ok(0) | Err(_) => break,
            Ok(_) if header == "\r\n" => break,
            Ok(_) => {
                if let Some((name, value)) = header.split_once(':')
                    && name.eq_ignore_ascii_case("host")
                {
                    host = value.trim().to_owned();
                }
            }
        }
    }
    requests
        .lock()
        .expect("mock request lock")
        .push((request.trim().to_owned(), host));
    let _ = stream.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
    );
}

struct ServerChild {
    child: Child,
    stdout_lines: Receiver<String>,
    stdout_thread: Option<JoinHandle<()>>,
}

impl ServerChild {
    fn spawn(overrides: &[(&str, &str)]) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_rudder-server-foundation"));
        command
            .env_clear()
            .env("RUDDER_NATIVE_LISTEN", "127.0.0.1:0")
            .env("RUDDER_NATIVE_DATABASE_REQUIRED", "false")
            .env("RUDDER_NATIVE_ACTOR_ENVELOPE_KEY", ACTOR_ENVELOPE_KEY)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (name, value) in overrides {
            command.env(name, value);
        }
        let mut child = command.spawn().expect("spawn server-foundation binary");
        let stdout = child.stdout.take().expect("child stdout pipe");
        let (sender, stdout_lines) = mpsc::channel();
        let stdout_thread = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) if sender.send(line).is_err() => break,
                    Ok(_) => {}
                }
            }
        });
        Self {
            child,
            stdout_lines,
            stdout_thread: Some(stdout_thread),
        }
    }

    fn next_json_line(&self, description: &str) -> Value {
        let line = self
            .stdout_lines
            .recv_timeout(CHILD_EXIT_TIMEOUT)
            .unwrap_or_else(|error| panic!("read {description} from child stdout: {error}"));
        serde_json::from_str(&line)
            .unwrap_or_else(|error| panic!("parse {description} JSON ({error}): {line}"))
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().expect("poll child status") {
                return Some(status);
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn send_sigterm(&mut self) {
        let result = unsafe { libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM) };
        assert_eq!(result, 0, "send SIGTERM to server-foundation child");
    }
}

impl Drop for ServerChild {
    fn drop(&mut self) {
        if self
            .child
            .try_wait()
            .map_or(true, |status| status.is_none())
        {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        if let Some(thread) = self.stdout_thread.take() {
            let _ = thread.join();
        }
    }
}
