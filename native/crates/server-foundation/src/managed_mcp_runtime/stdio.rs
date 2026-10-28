//! External MCP stdio children use the existing process host ownership path.
//! A provider response alone is not sufficient: EOF/stop must reap its group.
use super::{
    Host,
    d1::{Error, Identity},
    http,
    security::Launch,
};
use rudder_native_process_transport::{HostConnection, HostError, HostEvent, OwnedHost};
use rudder_native_protocol::{Command, PROTOCOL_MAJOR, PROTOCOL_MINOR, ProtocolVersion};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
fn version() -> Option<ProtocolVersion> {
    Some(ProtocolVersion {
        major: PROTOCOL_MAJOR,
        minor: PROTOCOL_MINOR,
    })
}
fn failed() -> Error {
    Error::Runtime("mcp_transport_failed")
}
struct Client {
    host: OwnedHost,
    request: String,
    owner: String,
    pending: Vec<u8>,
    stderr: usize,
    terminal: bool,
}
impl Client {
    fn launch(
        launch: &Launch,
        host_executable: &std::path::Path,
        runtime_root: &std::path::Path,
        run: &str,
    ) -> Result<Self, Error> {
        let request = uuid::Uuid::new_v4().to_string();
        let owner = uuid::Uuid::new_v4().to_string();
        let host = OwnedHost::launch_external(
            HostConnection {
                request_id: request.clone(),
                run_id: run.into(),
                attempt_id: request.clone(),
                owner_token: owner.clone(),
            },
            host_executable,
            None,
        )
        .map_err(|_| failed())?;
        let client = Self {
            host,
            request,
            owner,
            pending: Vec::new(),
            stderr: 0,
            terminal: false,
        };
        client
            .host
            .send(Command::StartProcess {
                protocol_version: version(),
                request_id: Some(client.request.clone()),
                executable: launch.executable.clone(),
                argv: launch.args.clone(),
                cwd: launch.cwd.to_string_lossy().into_owned(),
                env: launch.env.clone(),
                owner_token: Some(client.owner.clone()),
                runtime_root: Some(runtime_root.to_string_lossy().into_owned()),
                stdin: None,
                interactive_stdin: true,
                grace_ms: Some(2000),
            })
            .map_err(|_| failed())?;
        Ok(client)
    }
    fn send(&self, message: Value) -> Result<(), Error> {
        let mut data = serde_json::to_string(&message).map_err(|_| failed())?;
        data.push('\n');
        if data.len() > 2 * 1024 * 1024 {
            return Err(Error::Runtime("mcp_result_too_large"));
        }
        self.host
            .send(Command::WriteStdin {
                protocol_version: version(),
                request_id: Some(self.request.clone()),
                owner_token: Some(self.owner.clone()),
                write_id: Some(uuid::Uuid::new_v4().to_string()),
                data,
            })
            .map_err(|_| failed())
    }
    fn response(&mut self, id: u64, timeout: Duration) -> Result<Value, Error> {
        let deadline = Instant::now() + timeout;
        loop {
            while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
                let line = self.pending.drain(..=end).collect::<Vec<_>>();
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let message: Value = serde_json::from_slice(&line).map_err(|_| failed())?;
                if message["id"] == id
                    && (message.get("result").is_some() || message.get("error").is_some())
                {
                    return Ok(message);
                }
            }
            if Instant::now() >= deadline {
                return Err(Error::Runtime("mcp_request_timeout"));
            }
            match self.host.receive(Duration::from_millis(25)) {
                Ok(HostEvent::Stdout(bytes)) => {
                    if self.pending.len().saturating_add(bytes.len()) > 10 * 1024 * 1024 {
                        return Err(Error::Runtime("mcp_result_too_large"));
                    }
                    self.pending.extend(bytes);
                }
                Ok(HostEvent::Stderr(bytes)) => {
                    self.stderr = self.stderr.saturating_add(bytes.len());
                    if self.stderr > 10 * 1024 * 1024 {
                        return Err(Error::Runtime("mcp_result_too_large"));
                    }
                }
                Ok(HostEvent::Lifecycle(event)) if event["type"] == "terminal" => {
                    self.terminal = true;
                    return Err(failed());
                }
                Ok(HostEvent::Failure) => return Err(failed()),
                Err(HostError::Timeout) => {}
                Err(_) => return Err(failed()),
                _ => {}
            }
        }
    }
    fn shutdown(&mut self, probe: bool) -> Result<(), Error> {
        let _ = self.host.send(Command::CloseStdin {
            protocol_version: version(),
            request_id: Some(self.request.clone()),
            owner_token: Some(self.owner.clone()),
            close_id: Some(uuid::Uuid::new_v4().to_string()),
        });
        let deadline = Instant::now()
            + if probe {
                Duration::ZERO
            } else {
                Duration::from_secs(2)
            };
        let mut stopped = false;
        loop {
            if self.terminal {
                break;
            }
            if !stopped && Instant::now() >= deadline {
                self.host
                    .send(Command::Stop {
                        protocol_version: version(),
                        request_id: Some(self.request.clone()),
                        grace_ms: Some(2000),
                    })
                    .map_err(|_| failed())?;
                stopped = true;
            }
            match self.host.receive(Duration::from_millis(25)) {
                Ok(HostEvent::Lifecycle(event)) if event["type"] == "terminal" => {
                    self.terminal = true
                }
                Err(HostError::Timeout) => {}
                Err(_) | Ok(HostEvent::Failure) => {
                    self.host.close();
                    return Err(failed());
                }
                _ => {}
            }
        }
        // Unbound auxiliary MCP connection: evidence is consumed locally and
        // can never settle the parent Agent Run's execution permit.
        let cleaned = self.host.take_cleanup_proof().is_some();
        self.host.close();
        if cleaned { Ok(()) } else { Err(failed()) }
    }
}
#[allow(clippy::too_many_arguments)] // Keep the owned stdio launch and its existing timeout inputs together.
fn call_blocking(
    launch: Launch,
    host_executable: std::path::PathBuf,
    runtime_root: std::path::PathBuf,
    run: String,
    name: String,
    args: Value,
    startup: Duration,
    tool: Duration,
) -> Result<Value, Error> {
    // The SDK probes a disposable sibling because old servers can exit on a
    // pre-initialize method. Reap that sibling before starting the actual one.
    let mut probe = Client::launch(&launch, &host_executable, &runtime_root, &run)?;
    let negotiated = (|| {
        probe.send(http::envelope("server/discover", Some(1), json!({}), true))?;
        probe.response(1, startup)
    })();
    probe.shutdown(true)?;
    let modern = match negotiated {
        Ok(reply) => reply["result"]["supportedVersions"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == "2026-07-28")),
        Err(Error::Runtime("mcp_result_too_large")) => {
            return Err(Error::Runtime("mcp_result_too_large"));
        }
        Err(_) => false,
    };
    let mut client = Client::launch(&launch, &host_executable, &runtime_root, &run)?;
    let result = (|| {
        if !modern {
            client.send(http::envelope("initialize",Some(2),json!({"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"rudder-managed-mcp","version":"1.0.0"}}),false))?;
            let initialized = client.response(2, startup)?;
            if initialized.get("error").is_some()
                || !initialized["result"]["protocolVersion"]
                    .as_str()
                    .is_some_and(|v| super::SUPPORTED.contains(&v))
            {
                return Err(failed());
            }
            client.send(http::envelope(
                "notifications/initialized",
                None,
                json!({}),
                false,
            ))?;
        }
        client.send(http::envelope(
            "tools/call",
            Some(3),
            json!({"name":name,"arguments":args}),
            modern,
        ))?;
        let result = client.response(3, tool).map_err(|error| match error {
            Error::Runtime("mcp_request_timeout") => Error::Runtime("mcp_tool_timeout"),
            other => other,
        })?;
        if result.get("error").is_some() {
            return Err(Error::Runtime("mcp_tool_failed"));
        }
        let result = result["result"].clone();
        if !result["content"].is_array() {
            return Err(Error::Runtime("mcp_result_invalid"));
        }
        Ok(result)
    })();
    let cleanup = client.shutdown(false);
    cleanup?;
    result.map_err(|error| match error {
        Error::Runtime("mcp_request_timeout") => Error::Runtime("mcp_startup_timeout"),
        other => other,
    })
}
pub(super) async fn call(
    launch: Launch,
    host: &Host,
    identity: &Identity,
    name: &str,
    args: &Value,
    startup: Duration,
    tool: Duration,
) -> Result<Value, Error> {
    let executable = host.process_host.clone();
    let runtime = host.runtime_root.clone();
    let run = identity.run_id.clone();
    let name = name.to_owned();
    let args = args.clone();
    tokio::task::spawn_blocking(move || {
        call_blocking(launch, executable, runtime, run, name, args, startup, tool)
    })
    .await
    .map_err(|_| failed())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires the prebuilt RUDDER_TEST_PROCESS_HOST; never builds a host inside a fixture"]
    async fn legacy_stdio_probe_uses_reaped_disposable_sibling() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("runtime")).unwrap();
        let marker = root.path().join("launched");
        let script = r#"printf '%s\n' "$$" >> "$MCP_FIXTURE_MARKER"
while IFS= read -r line; do
case "$line" in
*'"method":"server/discover"'*) exit 0 ;;
*'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"synthetic-legacy","version":"1"}}}' ;;
*'"method":"tools/call"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"synthetic stdio result"}]}}' ;;
esac
done
"#;
        let host = Host {
            deployment_mode: "local_trusted".into(),
            process_host: std::env::var_os("RUDDER_TEST_PROCESS_HOST")
                .map(std::path::PathBuf::from)
                .expect("prebuilt process host"),
            runtime_root: root.path().join("runtime"),
            environment: Default::default(),
            oauth_redirect_uri: "http://127.0.0.1:3100/api/mcp/oauth/callback".into(),
        };
        let launch = Launch {
            executable: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            cwd: root.path().into(),
            env: [(
                "MCP_FIXTURE_MARKER".into(),
                marker.to_string_lossy().into_owned(),
            )]
            .into_iter()
            .collect(),
        };
        let identity = Identity {
            organization_id: uuid::Uuid::new_v4().to_string(),
            agent_id: uuid::Uuid::new_v4().to_string(),
            run_id: uuid::Uuid::new_v4().to_string(),
        };
        let result = call(
            launch,
            &host,
            &identity,
            "fixture_read",
            &json!({}),
            Duration::from_secs(3),
            Duration::from_secs(3),
        )
        .await
        .unwrap();
        assert_eq!(result["content"][0]["text"], "synthetic stdio result");
        let pids = std::fs::read_to_string(marker).unwrap();
        assert_eq!(pids.lines().count(), 2);
        #[cfg(unix)]
        for pid in pids.lines() {
            assert_eq!(
                unsafe { libc::kill(pid.parse().unwrap(), 0) },
                -1,
                "MCP child must be reaped before return"
            );
        }
    }
}
