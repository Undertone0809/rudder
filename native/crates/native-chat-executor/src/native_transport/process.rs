use super::*;
use agent_run::AgentProcessLaunch;
use rudder_native_process_transport::{HostConnection, HostError, HostEvent, OwnedHost};
use rudder_native_protocol::{Command, ProtocolVersion};
use std::{sync::atomic::Ordering, time::Duration};

const CAPTURE_BYTES: usize = 4 * 1024 * 1024;
fn append(buffer: &mut Vec<u8>, bytes: &[u8]) {
    if bytes.len() >= CAPTURE_BYTES {
        buffer.clear();
        buffer.extend_from_slice(&bytes[bytes.len() - CAPTURE_BYTES..]);
    } else {
        let excess = (buffer.len() + bytes.len()).saturating_sub(CAPTURE_BYTES);
        buffer.drain(..excess);
        buffer.extend_from_slice(bytes);
    }
}

#[allow(clippy::too_many_arguments)] // Existing Native Chat ownership wraps the shared process-host protocol.
pub(super) fn execute(
    handle: &Handle,
    pool: &PgPool,
    principal: &NativeChatExecutionPrincipal,
    fence: &ExecutionFence,
    invocation: execution::TransportInvocation,
    request: &AgentRunRequest,
    launch: AgentProcessLaunch,
    external_cancelled: &AtomicBool,
    deadline: Instant,
) -> (
    AgentRunExecutionObservation,
    Option<TransportCleanupProof>,
    Option<execution::StopIntent>,
) {
    let (_, permit) = invocation.into_process();
    let id = fence.identity();
    let connection = HostConnection {
        request_id: id.attempt_id.into(),
        attempt_id: id.attempt_id.into(),
        run_id: id.run_id.into(),
        owner_token: fence.run_execution_owner_token().into(),
    };
    let mut host = match OwnedHost::launch_external(connection, &request.process_host, Some(permit))
    {
        Ok(host) => host,
        Err(_) => {
            return (
                failure(
                    AgentRunExecutionState::Unresolved,
                    "runtime_host_unavailable",
                    "Native Chat process host could not start",
                ),
                None,
                None,
            );
        }
    };
    if host
        .send(Command::StartProcess {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(id.attempt_id.into()),
            executable: launch.executable.clone(),
            argv: launch.args.clone(),
            cwd: launch.cwd.to_string_lossy().into_owned(),
            env: launch.env.clone(),
            owner_token: Some(fence.run_execution_owner_token().into()),
            runtime_root: Some(request.runtime_root.to_string_lossy().into_owned()),
            stdin: launch.stdin.clone(),
            interactive_stdin: false,
            grace_ms: Some(launch.grace.as_millis().min(u64::MAX as u128) as u64),
        })
        .is_err()
    {
        return (
            failure(
                AgentRunExecutionState::Unresolved,
                "runtime_launch_failed",
                "Native Chat process launch could not be acknowledged",
            ),
            None,
            None,
        );
    }
    let started = Instant::now();
    let mut last_poll = Instant::now();
    let mut last_renew = Instant::now();
    let mut stop = None;
    let mut stopping = None;
    let mut stop_started = None;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code = None;
    let mut signal = None;
    loop {
        if stopping.is_none()
            && (external_cancelled.load(Ordering::Acquire)
                || request.cancelled.load(Ordering::Acquire))
        {
            stopping = Some((
                AgentRunExecutionState::Cancelled,
                "cancelled",
                "Native Chat process cancelled",
            ));
        }
        if stopping.is_none()
            && (Instant::now() >= deadline
                || launch
                    .timeout
                    .is_some_and(|limit| started.elapsed() >= limit))
        {
            stopping = Some((
                AgentRunExecutionState::TimedOut,
                "timeout",
                "Native Chat process timed out",
            ));
        }
        if last_poll.elapsed() >= Duration::from_millis(500) {
            last_poll = Instant::now();
            let observed = handle.block_on(tokio::time::timeout(
                Duration::from_secs(5),
                execution::observe_stop(pool, principal, fence),
            ));
            match observed {
                Ok(Ok(Some(intent))) => {
                    stop = Some(intent);
                    stopping.get_or_insert((
                        AgentRunExecutionState::Cancelled,
                        "cancelled",
                        "Native Chat Stop requested",
                    ));
                }
                Ok(Ok(None)) => (),
                _ => {
                    stopping = Some((
                        AgentRunExecutionState::Unresolved,
                        "native_chat_ownership_lost",
                        "Native Chat process owner is unavailable",
                    ));
                }
            }
        }
        if last_renew.elapsed() >= Duration::from_secs(10) {
            last_renew = Instant::now();
            let renewed = handle.block_on(tokio::time::timeout(Duration::from_secs(5), async {
                if let Some(stop) = &stop {
                    execution::renew_stopping_lease(pool, principal, fence, stop).await
                } else {
                    execution::renew_lease(pool, principal, fence).await
                }
            }));
            if !matches!(renewed, Ok(Ok(_))) {
                stopping = Some((
                    AgentRunExecutionState::Unresolved,
                    "native_chat_ownership_lost",
                    "Native Chat process owner lease was lost",
                ));
            }
        }
        if stopping.is_some() && stop_started.is_none() {
            if host
                .send(Command::Stop {
                    protocol_version: Some(ProtocolVersion::default()),
                    request_id: Some(id.attempt_id.into()),
                    grace_ms: Some(launch.grace.as_millis().min(u64::MAX as u128) as u64),
                })
                .is_err()
            {
                return (
                    failure(
                        AgentRunExecutionState::Unresolved,
                        "runtime_cleanup_unknown",
                        "Native Chat process Stop could not be delivered",
                    ),
                    None,
                    stop,
                );
            }
            stop_started = Some(Instant::now());
        }
        if stop_started.is_some_and(|at| at.elapsed() > launch.grace + Duration::from_secs(5)) {
            return (
                failure(
                    AgentRunExecutionState::Unresolved,
                    "runtime_cleanup_unknown",
                    "Native Chat process cleanup deadline expired",
                ),
                None,
                stop,
            );
        }
        match host.receive(Duration::from_millis(100)) {
            Ok(HostEvent::Stdout(bytes)) => append(&mut stdout, &bytes),
            Ok(HostEvent::Stderr(bytes)) => append(&mut stderr, &bytes),
            Ok(HostEvent::Lifecycle(event)) => match event["type"].as_str() {
                Some("app-exit") => {
                    exit_code = event["code"].as_i64().and_then(|v| i32::try_from(v).ok());
                    signal = event["signal"].as_str().map(str::to_owned);
                }
                Some("terminal") => {
                    let proof = host.take_cleanup_proof();
                    host.close();
                    let mut observation = agent_run::project_transport_process(
                        fence.runtime_type(),
                        &request.config,
                        &launch,
                        String::from_utf8_lossy(&stdout).into_owned(),
                        String::from_utf8_lossy(&stderr).into_owned(),
                        exit_code,
                        signal,
                    );
                    if let Some((state, code, message)) = stopping {
                        observation.state = state;
                        observation.error_code = Some(code.into());
                        observation.error = Some(message.into());
                    }
                    if proof.is_none() {
                        observation.state = AgentRunExecutionState::Unresolved;
                    }
                    return (observation, proof.map(TransportCleanupProof::Process), stop);
                }
                _ => (),
            },
            Err(HostError::Timeout) => (),
            _ => {
                return (
                    failure(
                        AgentRunExecutionState::Unresolved,
                        "runtime_cleanup_unknown",
                        "Native Chat process host ended without cleanup proof",
                    ),
                    None,
                    stop,
                );
            }
        }
    }
}
