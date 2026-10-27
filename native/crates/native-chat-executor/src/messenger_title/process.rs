//! One bounded, owned, noninteractive CLI invocation through the native host.
use super::{Error, Request};
use rudder_native_process_transport::{HostConnection, HostError, HostEvent, OwnedHost};
use rudder_native_protocol::{Command, ProtocolVersion};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
pub(super) struct Capture {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}
#[allow(clippy::too_many_arguments)]
pub(super) fn run(
    request: &Request,
    executable: String,
    args: Vec<String>,
    cwd: &Path,
    env: BTreeMap<String, String>,
    stdin: Option<String>,
    timeout: Option<Duration>,
    grace: Duration,
) -> Result<Capture, Error> {
    let attempt = uuid::Uuid::new_v4().to_string();
    let token = uuid::Uuid::new_v4().to_string();
    let mut host = OwnedHost::launch_external(
        HostConnection {
            request_id: attempt.clone(),
            attempt_id: attempt.clone(),
            run_id: request.run_id.clone(),
            owner_token: token.clone(),
        },
        &request.process_host,
        None,
    )
    .map_err(|_| Error::Failed("Title process host is unavailable".into()))?;
    host.send(Command::StartProcess {
        protocol_version: Some(ProtocolVersion::default()),
        request_id: Some(attempt.clone()),
        executable,
        argv: args,
        cwd: cwd.to_string_lossy().into_owned(),
        env,
        owner_token: Some(token),
        runtime_root: Some(request.runtime_root.to_string_lossy().into_owned()),
        stdin,
        interactive_stdin: false,
        grace_ms: Some(grace.as_millis() as u64),
    })
    .map_err(|_| Error::Failed("Title process launch failed".into()))?;
    let started = Instant::now();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut successful = false;
    let mut stop = None;
    let mut stop_at = None;
    loop {
        if stop.is_none() {
            if request.cancelled.load(Ordering::Acquire) {
                stop = Some(Error::Cancelled);
            } else if timeout.is_some_and(|limit| started.elapsed() >= limit) {
                stop = Some(Error::Timeout);
            }
            if stop.is_some() {
                host.send(Command::Stop {
                    protocol_version: Some(ProtocolVersion::default()),
                    request_id: Some(attempt.clone()),
                    grace_ms: Some(grace.as_millis() as u64),
                })
                .map_err(|_| Error::Cleanup)?;
                stop_at = Some(Instant::now());
            }
        }
        if stop_at.is_some_and(|at| at.elapsed() > grace + Duration::from_secs(5)) {
            return Err(Error::Cleanup);
        }
        // StartProcess is the existing raw-output mode. Preserve each
        // stream's byte boundaries until proven terminal cleanup.
        let (target, bytes) = match host.receive(Duration::from_millis(100)) {
            Ok(HostEvent::Lifecycle(value)) => {
                match value["type"].as_str() {
                    Some("app-exit") => {
                        successful = value["code"] == 0 && value["signal"].is_null()
                    }
                    Some("terminal") => {
                        if host.take_cleanup_proof().is_none() {
                            return Err(Error::Cleanup);
                        }
                        host.close();
                        return if let Some(error) = stop {
                            Err(error)
                        } else {
                            Ok(Capture {
                                stdout: String::from_utf8_lossy(&stdout).into_owned(),
                                stderr: String::from_utf8_lossy(&stderr).into_owned(),
                                success: successful,
                            })
                        };
                    }
                    _ => (),
                }
                continue;
            }
            Ok(HostEvent::Stdout(bytes)) => (&mut stdout, bytes),
            Ok(HostEvent::Stderr(bytes)) => (&mut stderr, bytes),
            Ok(HostEvent::Failure) => return Err(Error::Cleanup),
            Err(HostError::Timeout) => continue,
            Err(_) => return Err(Error::Cleanup),
        };
        if target.len() + bytes.len() > 4 * 1024 * 1024 {
            stop = Some(Error::Failed("Title output exceeded its bound".into()));
            host.send(Command::Stop {
                protocol_version: Some(ProtocolVersion::default()),
                request_id: Some(attempt.clone()),
                grace_ms: Some(grace.as_millis() as u64),
            })
            .map_err(|_| Error::Cleanup)?;
            stop_at.get_or_insert_with(Instant::now);
        } else {
            target.extend_from_slice(&bytes);
        }
    }
}
