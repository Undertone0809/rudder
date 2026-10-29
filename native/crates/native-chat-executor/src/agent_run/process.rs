use super::{
    AgentProcessLaunch, AgentRunCleanupProof, AgentRunExecutionObservation, AgentRunExecutionState,
    AgentRunOutput, AgentRunRequest, AgentRunStream, projection,
};
use rudder_d1_persistence::{
    agent_execution::{AgentRunClaim, lifecycle},
    goal_runs::GoalRunError,
};
use rudder_native_process_transport::{HostConnection, HostError, HostEvent, OwnedHost};
use rudder_native_protocol::{Command, ProtocolVersion};
use sqlx::PgPool;
use std::{
    future::Future,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tokio::runtime::Handle;

const CAPTURE_BYTES: usize = 4 * 1024 * 1024;
fn database<T>(
    handle: &Handle,
    future: impl Future<Output = Result<T, GoalRunError>>,
) -> Result<T, String> {
    handle
        .block_on(tokio::time::timeout(Duration::from_secs(5), future))
        .map_err(|_| "Agent Run database operation timed out".to_owned())?
        .map_err(|e| e.to_string())
}
fn append(buffer: &mut Vec<u8>, bytes: &[u8]) {
    if bytes.len() >= CAPTURE_BYTES {
        buffer.clear();
        buffer.extend_from_slice(&bytes[bytes.len() - CAPTURE_BYTES..]);
    } else {
        let excess = (buffer.len() + bytes.len()).saturating_sub(CAPTURE_BYTES);
        if excess > 0 {
            buffer.drain(..excess);
        }
        buffer.extend_from_slice(bytes);
    }
}

pub(super) fn execute(
    handle: &Handle,
    pool: &PgPool,
    mut claim: AgentRunClaim,
    request: AgentRunRequest,
    launch: AgentProcessLaunch,
) -> (AgentRunClaim, AgentRunExecutionObservation) {
    let Some(permit) = claim.owned.take_connection_launch_permit() else {
        return (
            claim,
            AgentRunExecutionObservation::failure(
                AgentRunExecutionState::Unresolved,
                "agent_run_ownership_lost",
                "Agent Run launch capability was already consumed",
            ),
        );
    };
    let connection = HostConnection {
        request_id: claim.attempt_id.clone(),
        attempt_id: claim.attempt_id.clone(),
        run_id: claim.run_id.clone(),
        owner_token: claim.owner_token.clone(),
    };
    let mut host = match OwnedHost::launch_external(connection, &request.process_host, Some(permit))
    {
        Ok(host) => host,
        Err(error) => {
            return (
                claim,
                AgentRunExecutionObservation::failure(
                    AgentRunExecutionState::Unresolved,
                    "runtime_host_unavailable",
                    error.to_string(),
                ),
            );
        }
    };
    if let Err(error) = host.send(Command::StartProcess {
        protocol_version: Some(ProtocolVersion::default()),
        request_id: Some(claim.attempt_id.clone()),
        executable: launch.executable.clone(),
        argv: launch.args.clone(),
        cwd: launch.cwd.to_string_lossy().into_owned(),
        env: launch.env.clone(),
        owner_token: Some(claim.owner_token.clone()),
        runtime_root: Some(request.runtime_root.to_string_lossy().into_owned()),
        stdin: launch.stdin.clone(),
        interactive_stdin: false,
        grace_ms: Some(launch.grace.as_millis().min(u64::MAX as u128) as u64),
    }) {
        return (
            claim,
            AgentRunExecutionObservation::failure(
                AgentRunExecutionState::Unresolved,
                "runtime_launch_failed",
                error.to_string(),
            ),
        );
    }
    let started = Instant::now();
    let mut renewal = Instant::now();
    let mut cancel_poll = Instant::now();
    let mut cleanup_renewal = Instant::now();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut stdout_offset = 0_u64;
    let mut stderr_offset = 0_u64;
    let mut exit_code = None;
    let mut signal = None;
    let mut stop: Option<(AgentRunExecutionState, String, String)> = None;
    let mut stop_started = None;
    let mut stop_grace = launch.grace;
    loop {
        if stop.is_none() {
            if request.cancelled.load(Ordering::Acquire) {
                stop = Some((
                    AgentRunExecutionState::Cancelled,
                    "cancelled".into(),
                    "Agent Run cancelled".into(),
                ));
            } else if launch
                .timeout
                .is_some_and(|limit| started.elapsed() >= limit)
            {
                stop = Some((
                    AgentRunExecutionState::TimedOut,
                    "timeout".into(),
                    format!("Timed out after {}s", launch.timeout.unwrap().as_secs_f64()),
                ));
            } else if cancel_poll.elapsed() >= Duration::from_millis(500) {
                cancel_poll = Instant::now();
                match database(
                    handle,
                    lifecycle::cancellation_requested(pool, &claim.owned),
                ) {
                    Ok(true) => {
                        stop = Some((
                            AgentRunExecutionState::Cancelled,
                            "cancelled".into(),
                            "Agent Run cancellation requested".into(),
                        ))
                    }
                    Err(error) => {
                        stop = Some((
                            AgentRunExecutionState::Unresolved,
                            "agent_run_persistence".into(),
                            error,
                        ))
                    }
                    Ok(false) => (),
                }
            }
            if stop.is_none() && renewal.elapsed() >= Duration::from_secs(10) {
                renewal = Instant::now();
                match database(
                    handle,
                    lifecycle::renew_lease(pool, &claim.owned, Duration::from_secs(30)),
                ) {
                    Ok(true) => (),
                    result => {
                        stop = Some((
                            AgentRunExecutionState::Unresolved,
                            "agent_run_ownership_lost".into(),
                            result
                                .err()
                                .unwrap_or_else(|| "Agent Run execution lease was lost".into()),
                        ))
                    }
                }
            }
        }
        if stop.is_some() && stop_started.is_none() {
            if host
                .send(Command::Stop {
                    protocol_version: Some(ProtocolVersion::default()),
                    request_id: Some(claim.attempt_id.clone()),
                    grace_ms: Some(stop_grace.as_millis().min(u64::MAX as u128) as u64),
                })
                .is_err()
            {
                return (
                    claim,
                    AgentRunExecutionObservation::failure(
                        AgentRunExecutionState::Unresolved,
                        "runtime_cleanup_unknown",
                        "Runtime stop could not be delivered; cleanup is unproven",
                    ),
                );
            }
            stop_started = Some(Instant::now());
        }
        if stop_started.is_some() && cleanup_renewal.elapsed() >= Duration::from_secs(5) {
            cleanup_renewal = Instant::now();
            // Cancellation has a separate cleanup-only lease renewal; normal
            // ownership failures must not authorize further provider work.
            let _ = database(
                handle,
                lifecycle::renew_cleanup_lease(pool, &claim.owned, Duration::from_secs(30)),
            );
        }
        if stop_started.is_some_and(|at| at.elapsed() > stop_grace + Duration::from_secs(5)) {
            return (
                claim,
                AgentRunExecutionObservation::failure(
                    AgentRunExecutionState::Unresolved,
                    "runtime_cleanup_unknown",
                    "Runtime process cleanup deadline expired",
                ),
            );
        }
        match host.receive(Duration::from_millis(100)) {
            Ok(HostEvent::Stdout(bytes)) => {
                if stop.is_none()
                    && let Err(error) = emit_log(
                        handle,
                        &request,
                        AgentRunStream::Stdout,
                        stdout_offset,
                        &bytes,
                    )
                {
                    stop = Some((
                        AgentRunExecutionState::Unresolved,
                        "run_output_persistence_failed".into(),
                        error,
                    ));
                }
                stdout_offset = stdout_offset.saturating_add(bytes.len() as u64);
                append(&mut stdout, &bytes);
            }
            Ok(HostEvent::Stderr(bytes)) => {
                if stop.is_none()
                    && let Err(error) = emit_log(
                        handle,
                        &request,
                        AgentRunStream::Stderr,
                        stderr_offset,
                        &bytes,
                    )
                {
                    stop = Some((
                        AgentRunExecutionState::Unresolved,
                        "run_output_persistence_failed".into(),
                        error,
                    ));
                }
                stderr_offset = stderr_offset.saturating_add(bytes.len() as u64);
                append(&mut stderr, &bytes);
                if stop.is_none() && claim.runtime_type == "codex_local" {
                    let scan =
                        String::from_utf8_lossy(&stderr[stderr.len().saturating_sub(64 * 1024)..]);
                    if let Some(error) = super::codex_failure::provider_auth_failure(&scan) {
                        stop_grace = Duration::from_millis(2000);
                        stop = Some((
                            AgentRunExecutionState::Failed,
                            "codex_provider_auth_required".into(),
                            error,
                        ));
                    }
                }
            }
            Ok(HostEvent::Lifecycle(value)) => match value["type"].as_str() {
                Some("spawned") => {
                    let pid = value["pid"].as_i64().and_then(|v| i32::try_from(v).ok());
                    let recorded = pid.map(|pid| {
                        database(
                            handle,
                            lifecycle::record_process_started(pool, &claim.owned, pid),
                        )
                    });
                    if !matches!(recorded, Some(Ok(true))) {
                        stop.get_or_insert((
                            AgentRunExecutionState::Unresolved,
                            "agent_run_ownership_lost".into(),
                            "Runtime process identity could not be recorded for this owner".into(),
                        ));
                    }
                }
                Some("app-exit") => {
                    exit_code = value["code"].as_i64().and_then(|v| i32::try_from(v).ok());
                    signal = value["signal"].as_str().map(str::to_owned);
                }
                Some("terminal") => {
                    let proof = host.take_cleanup_proof();
                    host.close();
                    let mut observation = projection::parse(
                        &claim.runtime_type,
                        &request.config,
                        &launch,
                        String::from_utf8_lossy(&stdout).into_owned(),
                        String::from_utf8_lossy(&stderr).into_owned(),
                        exit_code,
                        signal,
                    );
                    if let Some((state, code, error)) = stop {
                        observation.state = state;
                        if code == "codex_provider_auth_required" {
                            observation.result["providerFailure"] = serde_json::json!({"classification":"authentication","retryable":false,"shortCircuited":true,"reason":code,"readinessState":"failed"});
                        }
                        observation.error_code = Some(code);
                        observation.error = Some(error);
                    }
                    if let Some(proof) = proof {
                        observation.cleanup_proof = Some(AgentRunCleanupProof::Process(proof));
                    } else {
                        observation.state = AgentRunExecutionState::Unresolved;
                        observation.error_code = Some("runtime_cleanup_unknown".into());
                        observation.error =
                            Some("Runtime returned no matching process cleanup receipt".into());
                    }
                    return (claim, observation);
                }
                _ => (),
            },
            Err(HostError::Timeout) => (),
            _ => {
                return (
                    claim,
                    AgentRunExecutionObservation::failure(
                        AgentRunExecutionState::Unresolved,
                        "runtime_cleanup_unknown",
                        "Runtime process host connection ended without cleanup proof",
                    ),
                );
            }
        }
    }
}

fn emit_log(
    handle: &Handle,
    request: &AgentRunRequest,
    stream: AgentRunStream,
    offset: u64,
    bytes: &[u8],
) -> Result<(), String> {
    let Some(output) = &request.output else {
        return Ok(());
    };
    handle
        .block_on(tokio::time::timeout(
            Duration::from_secs(5),
            output.send(AgentRunOutput::Log {
                stream,
                offset,
                chunk: bytes.to_vec(),
            }),
        ))
        .map_err(|_| "Run output persistence timed out".to_owned())?
        .map_err(|_| "Run output persistence channel closed".to_owned())
}
