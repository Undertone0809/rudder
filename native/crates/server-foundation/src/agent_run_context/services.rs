//! Existing local runtime-service leases, migrated from workspace-runtime.
//! Service children, reuse membership and idle stop are owned by this process;
//! database rows are observations, never proof that an unknown PID stopped.
use super::realization::{RealizedWorkspace, resolve_path};
use super::{AgentRunContextHost, AgentWorkspacePreparation, ContextError, ContextLogSink, text};
use crate::goal_run_context::render_template;
use rudder_d1_persistence::{agent_execution::AgentRunClaim, agent_run_workspace};
use rudder_native_process_transport::{
    HostConnection, HostError, HostEvent, OwnedHost, read_unbound_cleanup_observation,
};
use rudder_native_protocol::{Command, ProtocolVersion};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{
    collections::{BTreeMap, BTreeSet},
    net::TcpListener,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

struct LocalService {
    reference: Value,
    process: ServiceProcess,
    leases: BTreeSet<String>,
    outputs: BTreeMap<String, ContextLogSink>,
    last_used: Instant,
}

#[derive(Default)]
struct ProcessObservation {
    pid: Option<u32>,
    exited: bool,
    cleanup: bool,
    failed: bool,
}
struct ServiceProcess {
    stop: Arc<AtomicBool>,
    observation: Arc<Mutex<ProcessObservation>>,
}
impl ServiceProcess {
    fn exited(&self) -> bool {
        self.observation.lock().map_or(true, |v| v.exited)
    }
    fn pid(&self) -> Option<u32> {
        self.observation.lock().ok().and_then(|v| v.pid)
    }
    fn result(&self) -> Option<bool> {
        self.observation
            .lock()
            .ok()
            .and_then(|v| (v.exited && v.cleanup).then_some(v.failed))
    }
}

#[derive(Default)]
struct LocalServices {
    by_id: BTreeMap<String, LocalService>,
    by_reuse: BTreeMap<(String, String), String>,
}
fn state() -> &'static Mutex<LocalServices> {
    static STATE: OnceLock<Mutex<LocalServices>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(LocalServices::default()))
}

pub(super) struct RuntimeServiceLease {
    pub references: Vec<Value>,
    org: String,
    run: String,
    ids: Vec<String>,
    released: bool,
}
impl RuntimeServiceLease {
    pub async fn release(&mut self, pool: &PgPool) -> Result<(), ContextError> {
        if self.released {
            return Ok(());
        }
        for id in &self.ids {
            release_one(pool, &self.org, &self.run, id).await?;
        }
        self.released = true;
        Ok(())
    }
}

impl Drop for RuntimeServiceLease {
    fn drop(&mut self) {
        // An unresolved provider keeps the service lease for recovery but must
        // not retain the finished driver's output channel.
        if let Ok(mut state) = state().lock() {
            for id in &self.ids {
                if let Some(record) = state.by_id.get_mut(id) {
                    record.outputs.remove(&self.run);
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn acquire(
    pool: &PgPool,
    claim: &AgentRunClaim,
    workspace: &AgentWorkspacePreparation,
    realized: &RealizedWorkspace,
    issue: &Value,
    config: &Value,
    host: &AgentRunContextHost,
    cancelled: &Arc<AtomicBool>,
    output: &ContextLogSink,
    secret_keys: &BTreeSet<String>,
) -> Result<RuntimeServiceLease, ContextError> {
    let mut lease = RuntimeServiceLease {
        references: Vec::new(),
        org: claim.organization_id.clone(),
        run: claim.run_id.clone(),
        ids: Vec::new(),
        released: false,
    };
    for service in &workspace.runtime_service_intents {
        if cancelled.load(Ordering::Acquire) {
            lease.release(pool).await?;
            return Err(ContextError::Cancelled);
        }
        let lifecycle = if text(service, "lifecycle") == Some("ephemeral") {
            "ephemeral"
        } else {
            "shared"
        };
        let scope = text(service, "reuseScope").unwrap_or(if lifecycle == "shared" {
            "project_workspace"
        } else {
            "run"
        });
        let scope = if matches!(scope, "project_workspace" | "execution_workspace" | "agent") {
            scope
        } else {
            "run"
        };
        let scope_id = match scope {
            "project_workspace" => workspace
                .workspace_id
                .as_deref()
                .or(workspace.project_id.as_deref())
                .map(str::to_owned),
            "execution_workspace" => Some(
                workspace
                    .execution_workspace_id
                    .clone()
                    .unwrap_or_else(|| workspace.cwd.to_string_lossy().into_owned()),
            ),
            "agent" => Some(claim.agent_id.clone()),
            _ => Some(claim.run_id.clone()),
        };
        let name = text(service, "name").unwrap_or("service");
        let env_fingerprint = Sha256::digest(
            service
                .get("env")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}))
                .to_string()
                .as_bytes(),
        )
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
        let reuse = if lifecycle == "shared" {
            Some(format!(
                "{scope}:{}:{name}:{env_fingerprint}",
                scope_id.as_deref().unwrap_or_default()
            ))
        } else {
            None
        };
        if let Some(reuse) = reuse.as_deref() {
            let unknown = {
                let state = state().lock().map_err(|_| {
                    ContextError::Invalid("Runtime service ownership is unavailable")
                })?;
                state
                    .by_reuse
                    .get(&(claim.organization_id.clone(), reuse.into()))
                    .and_then(|id| state.by_id.get(id))
                    .is_some_and(|r| r.process.exited() && r.process.result().is_none())
            };
            if unknown {
                lease.release(pool).await?;
                return Err(ContextError::Invalid(
                    "Prior runtime service cleanup is not yet proven",
                ));
            }
        }
        let existing = if let Some(reuse) = reuse.as_deref() {
            let mut state = state()
                .lock()
                .map_err(|_| ContextError::Invalid("Runtime service ownership is unavailable"))?;
            let id = state
                .by_reuse
                .get(&(claim.organization_id.clone(), reuse.into()))
                .cloned();
            id.and_then(|id| {
                state.by_id.get_mut(&id).and_then(|record| {
                    if record.process.exited() {
                        return None;
                    }
                    record.leases.insert(claim.run_id.clone());
                    record.outputs.insert(claim.run_id.clone(), output.clone());
                    record.last_used = Instant::now();
                    let mut reference = record.reference.clone();
                    reference["lastUsedAt"] = json!(
                        time::OffsetDateTime::now_utc()
                            .format(&time::format_description::well_known::Rfc3339)
                            .unwrap_or_default()
                    );
                    reference["reused"] = json!(true);
                    Some((id, reference))
                })
            })
        } else {
            None
        };
        if let Some((id, reference)) = existing {
            if let Err(error) = agent_run_workspace::persist_service(pool, claim, &reference).await
            {
                lease.release(pool).await?;
                return Err(error.into());
            }
            lease.ids.push(id);
            lease.references.push(reference);
            continue;
        }
        let started = start(
            pool,
            claim,
            workspace,
            realized,
            issue,
            service,
            config,
            host,
            cancelled,
            output,
            secret_keys,
            lifecycle,
            scope,
            scope_id.as_deref(),
            reuse.as_deref(),
        )
        .await;
        match started {
            Ok((id, reference)) => {
                lease.ids.push(id);
                lease.references.push(reference);
            }
            Err(error) => {
                lease.release(pool).await?;
                return Err(error);
            }
        }
    }
    Ok(lease)
}

#[allow(clippy::too_many_arguments)]
async fn start(
    pool: &PgPool,
    claim: &AgentRunClaim,
    workspace: &AgentWorkspacePreparation,
    realized: &RealizedWorkspace,
    issue: &Value,
    service: &Value,
    config: &Value,
    host: &AgentRunContextHost,
    cancelled: &Arc<AtomicBool>,
    output: &ContextLogSink,
    secret_keys: &BTreeSet<String>,
    lifecycle: &str,
    scope: &str,
    scope_id: Option<&str>,
    reuse: Option<&str>,
) -> Result<(String, Value), ContextError> {
    let name = text(service, "name").unwrap_or("service");
    let command = text(service, "command")
        .ok_or(ContextError::Invalid("Runtime service is missing command"))?;
    let port = if text(&service["port"], "type") == Some("auto") {
        let socket = TcpListener::bind(("127.0.0.1", 0))?;
        Some(socket.local_addr()?.port())
    } else {
        None
    };
    let data = json!({"workspace":{"cwd":workspace.cwd,"branchName":realized.branch_name,"worktreePath":realized.worktree_path,
        "repoUrl":workspace.repo_url,"repoRef":workspace.repo_ref,"env":config["env"]},"agent":{"id":claim.agent_id,"name":claim.agent_name},
        "issue":{"id":issue["id"],"identifier":issue["identifier"],"title":issue["title"]},"port":port});
    let cwd = resolve_path(
        &render_template(text(service, "cwd").unwrap_or("."), &data),
        &workspace.cwd,
        &host.operator_home,
    );
    let mut env = std::env::vars()
        .filter(|(key, _)| !key.starts_with("RUDDER_") && key != "DATABASE_URL")
        .collect::<BTreeMap<_, _>>();
    for (key, value) in config["env"].as_object().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            env.insert(key.clone(), value.into());
        }
    }
    for (key, value) in service["env"].as_object().into_iter().flatten() {
        if let Some(value) = value.as_str() {
            env.insert(key.clone(), render_template(value, &data));
        }
    }
    if let Some(port) = port {
        env.insert(
            text(&service["port"], "envKey").unwrap_or("PORT").into(),
            port.to_string(),
        );
    }
    let id = uuid::Uuid::new_v4().to_string();
    let startup_output = Arc::new(Mutex::new(Some(output.clone())));
    let secrets = secret_keys
        .iter()
        .filter_map(|key| config["env"][key].as_str())
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let process = launch_service(
        host,
        &id,
        name,
        command,
        &cwd,
        env,
        startup_output.clone(),
        secrets,
    )?;
    let started = Instant::now();
    while process.pid().is_none() && !process.exited() {
        if cancelled.load(Ordering::Acquire) || started.elapsed() > Duration::from_secs(10) {
            stop_process(process).await?;
            return Err(if cancelled.load(Ordering::Acquire) {
                ContextError::Cancelled
            } else {
                ContextError::Invalid("Runtime service did not start")
            });
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let Some(pid) = process.pid() else {
        stop_process(process).await?;
        return Err(ContextError::Invalid(
            "Runtime service exited before starting",
        ));
    };
    let url = text(&service["expose"], "urlTemplate")
        .or_else(|| text(&service["readiness"], "urlTemplate"))
        .map(|template| render_template(template, &data));
    let readiness = wait_ready(service, url.as_deref(), cancelled, &process).await;
    if let Err(error) = readiness {
        stop_process(process).await?;
        return Err(error);
    }
    let timestamp = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let reference = json!({"startedAt":timestamp,"lastUsedAt":timestamp,"stoppedAt":null,"id":id,"orgId":claim.organization_id,"projectId":workspace.project_id,"projectWorkspaceId":workspace.workspace_id,
        "executionWorkspaceId":workspace.execution_workspace_id,"issueId":claim.issue_id,"serviceName":name,"status":"running","lifecycle":lifecycle,
        "scopeType":scope,"scopeId":scope_id,"reuseKey":reuse,"command":command,"cwd":cwd,"port":port,"url":url,
        "provider":"local_process","providerRef":pid.to_string(),"ownerAgentId":claim.agent_id,"startedByRunId":claim.run_id,
        "stopPolicy":service.get("stopPolicy").cloned().unwrap_or_else(||json!({})),"healthStatus":"healthy","reused":false});
    if let Err(error) = agent_run_workspace::persist_service(pool, claim, &reference).await {
        stop_process(process).await?;
        return Err(error.into());
    }
    {
        let mut state = state()
            .lock()
            .map_err(|_| ContextError::Invalid("Runtime service ownership is unavailable"))?;
        let mut leases = BTreeSet::new();
        leases.insert(claim.run_id.clone());
        let mut outputs = BTreeMap::new();
        outputs.insert(claim.run_id.clone(), output.clone());
        state.by_id.insert(
            id.clone(),
            LocalService {
                reference: reference.clone(),
                process,
                leases,
                outputs,
                last_used: Instant::now(),
            },
        );
        if let Some(reuse) = reuse {
            state
                .by_reuse
                .insert((claim.organization_id.clone(), reuse.into()), id.clone());
        }
    }
    if let Ok(mut initial) = startup_output.lock() {
        initial.take();
    }
    monitor(pool.clone(), claim.organization_id.clone(), id.clone());
    Ok((id, reference))
}

fn launch_service(
    host: &AgentRunContextHost,
    id: &str,
    name: &str,
    command: &str,
    cwd: &std::path::Path,
    env: BTreeMap<String, String>,
    initial: Arc<Mutex<Option<ContextLogSink>>>,
    secrets: Vec<String>,
) -> Result<ServiceProcess, ContextError> {
    let runtime_root = host.runtime_root.join("runtime-services").join(id);
    std::fs::create_dir_all(&runtime_root)?;
    let mut owner = OwnedHost::launch_external(
        HostConnection {
            request_id: id.into(),
            attempt_id: id.into(),
            run_id: id.into(),
            owner_token: id.into(),
        },
        &host.process_host,
        None,
    )
    .map_err(|_| ContextError::Invalid("Runtime service host is unavailable"))?;
    owner
        .send(Command::StartProcess {
            protocol_version: Some(ProtocolVersion::default()),
            request_id: Some(id.into()),
            executable: std::env::var("SHELL")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "/bin/sh".into()),
            argv: vec!["-lc".into(), command.into()],
            cwd: cwd.to_string_lossy().into_owned(),
            env,
            owner_token: Some(id.into()),
            runtime_root: Some(runtime_root.to_string_lossy().into_owned()),
            stdin: None,
            interactive_stdin: false,
            grace_ms: Some(2000),
        })
        .map_err(|_| ContextError::Invalid("Runtime service launch failed"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let observation = Arc::new(Mutex::new(ProcessObservation::default()));
    let control = ServiceProcess {
        stop: stop.clone(),
        observation: observation.clone(),
    };
    let id = id.to_owned();
    let name = name.to_owned();
    thread::spawn(move || {
        let mut stopped = None;
        let mut exit_failed = false;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        loop {
            if stop.load(Ordering::Acquire) && stopped.is_none() {
                let _ = owner.send(Command::Stop {
                    protocol_version: Some(ProtocolVersion::default()),
                    request_id: Some(id.clone()),
                    grace_ms: Some(2000),
                });
                stopped = Some(Instant::now());
            }
            match owner.receive(Duration::from_millis(50)) {
                Ok(HostEvent::Stdout(bytes)) => buffer_output(
                    &id,
                    &name,
                    "stdout",
                    &mut stdout,
                    &bytes,
                    &initial,
                    &secrets,
                ),
                Ok(HostEvent::Stderr(bytes)) => buffer_output(
                    &id,
                    &name,
                    "stderr",
                    &mut stderr,
                    &bytes,
                    &initial,
                    &secrets,
                ),
                Ok(HostEvent::Lifecycle(value)) => match value["type"].as_str() {
                    Some("spawned") => {
                        if let Ok(mut v) = observation.lock() {
                            v.pid = value["pid"].as_u64().and_then(|v| u32::try_from(v).ok());
                        }
                    }
                    Some("app-exit") => {
                        exit_failed = value["code"].as_i64().is_some_and(|v| v != 0);
                    }
                    Some("terminal") => break,
                    _ => (),
                },
                Err(HostError::Timeout) => (),
                Ok(HostEvent::Failure) | Err(_) => break,
            }
            if stopped.is_some_and(|at| at.elapsed() > Duration::from_secs(7)) {
                break;
            }
        }
        emit_output(&id, &name, "stdout", &stdout, &initial, &secrets);
        emit_output(&id, &name, "stderr", &stderr, &initial, &secrets);
        // Owner drop closes stdin to the external host and joins its EOF cleanup.
        drop(owner);
        let receipt = read_unbound_cleanup_observation(&runtime_root, &id, &id)
            .ok()
            .flatten();
        if let Ok(mut v) = observation.lock() {
            v.exited = true;
            v.cleanup = receipt
                .as_ref()
                .is_some_and(|r| r.process_id.map(|p| p as u32) == v.pid);
            v.failed = exit_failed || receipt.as_ref().is_some_and(|r| r.host_status == "failed");
        }
    });
    Ok(control)
}
fn buffer_output(
    id: &str,
    name: &str,
    stream: &str,
    pending: &mut Vec<u8>,
    bytes: &[u8],
    initial: &Arc<Mutex<Option<ContextLogSink>>>,
    secrets: &[String],
) {
    pending.extend_from_slice(bytes);
    // Keep a full secret-width raw suffix even across newlines. A provider
    // token split between host chunks must never escape in an earlier log.
    let overlap = secrets.iter().map(String::len).max().unwrap_or(0);
    let mut safe = pending.len().saturating_sub(overlap);
    if let Some(newline) = pending[..safe].iter().rposition(|b| *b == b'\n') {
        safe = newline + 1;
    } else if pending.len() <= 65536 + overlap {
        return;
    }
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        for (index, window) in pending.windows(secret.len()).enumerate() {
            if window == secret.as_bytes() && index < safe && index + secret.len() > safe {
                safe = index;
                break;
            }
        }
    }
    let prefix = pending.drain(..safe).collect::<Vec<_>>();
    emit_output(id, name, stream, &prefix, initial, secrets);
}
fn emit_output(
    id: &str,
    name: &str,
    stream: &str,
    bytes: &[u8],
    initial: &Arc<Mutex<Option<ContextLogSink>>>,
    secrets: &[String],
) {
    if bytes.is_empty() {
        return;
    }
    let mut chunk = String::from_utf8_lossy(bytes).into_owned();
    for secret in secrets {
        chunk = chunk.replace(secret, "***REDACTED***");
    }
    let outputs = state()
        .lock()
        .ok()
        .and_then(|state| {
            state
                .by_id
                .get(id)
                .map(|r| r.outputs.values().cloned().collect::<Vec<_>>())
        })
        .unwrap_or_else(|| {
            initial
                .lock()
                .ok()
                .and_then(|v| v.clone())
                .into_iter()
                .collect()
        });
    for output in outputs {
        output.blocking_log(
            &format!("service:{name}"),
            stream,
            &format!("[service:{name}] {chunk}"),
        );
    }
}

async fn wait_ready(
    service: &Value,
    url: Option<&str>,
    cancelled: &Arc<AtomicBool>,
    process: &ServiceProcess,
) -> Result<(), ContextError> {
    if text(&service["readiness"], "type") != Some("http") || url.is_none() {
        return Ok(());
    }
    let url = url.unwrap();
    let timeout = service["readiness"]["timeoutSec"]
        .as_f64()
        .unwrap_or(30.0)
        .max(1.0);
    let interval = service["readiness"]["intervalMs"]
        .as_u64()
        .unwrap_or(500)
        .max(100);
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    let client = reqwest::Client::new();
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(ContextError::Cancelled);
        }
        if process.exited() {
            return Err(ContextError::Invalid(
                "Runtime service exited before becoming ready",
            ));
        }
        if Instant::now() >= deadline {
            return Err(ContextError::Invalid(
                "Runtime service readiness check failed",
            ));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let mut request = Box::pin(client.get(url).send());
        loop {
            match tokio::time::timeout(Duration::from_millis(100).min(remaining), request.as_mut())
                .await
            {
                Ok(Ok(response)) if response.status().is_success() => return Ok(()),
                Ok(_) => break,
                Err(_) => {
                    if cancelled.load(Ordering::Acquire) {
                        return Err(ContextError::Cancelled);
                    }
                    if Instant::now() >= deadline {
                        return Err(ContextError::Invalid(
                            "Runtime service readiness check failed",
                        ));
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(interval)).await;
    }
}

async fn stop_process(process: ServiceProcess) -> Result<bool, ContextError> {
    process.stop.store(true, Ordering::Release);
    let started = Instant::now();
    loop {
        if let Some(failed) = process.result() {
            return Ok(failed);
        }
        if process.exited() || started.elapsed() > Duration::from_secs(15) {
            return Err(ContextError::Invalid(
                "Runtime service cleanup receipt is unavailable",
            ));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn release_one(pool: &PgPool, org: &str, run: &str, id: &str) -> Result<(), ContextError> {
    let (stop, idle) = {
        let mut state = state()
            .lock()
            .map_err(|_| ContextError::Invalid("Runtime service ownership is unavailable"))?;
        let Some(record) = state.by_id.get_mut(id) else {
            return Ok(());
        };
        if text(&record.reference, "orgId") != Some(org) {
            return Err(ContextError::Invalid(
                "Runtime service organization mismatch",
            ));
        }
        record.leases.remove(run);
        record.outputs.remove(run);
        record.last_used = Instant::now();
        let policy = text(&record.reference["stopPolicy"], "type").unwrap_or(
            if record.reference["lifecycle"] == "ephemeral" {
                "on_run_finish"
            } else {
                "manual"
            },
        );
        (
            record.leases.is_empty()
                && (record.reference["lifecycle"] == "ephemeral" || policy == "on_run_finish"),
            if record.leases.is_empty() && policy == "idle_timeout" {
                Some(
                    record.reference["stopPolicy"]["idleSeconds"]
                        .as_u64()
                        .unwrap_or(1800)
                        .max(1),
                )
            } else {
                None
            },
        )
    };
    if stop {
        stop_record(pool, org, id).await?;
    }
    if let Some(seconds) = idle {
        let pool = pool.clone();
        let org = org.to_owned();
        let id = id.to_owned();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(seconds)).await;
            let idle = state()
                .lock()
                .ok()
                .and_then(|state| {
                    state.by_id.get(&id).map(|record| {
                        record.leases.is_empty()
                            && record.last_used.elapsed() >= Duration::from_secs(seconds)
                    })
                })
                .unwrap_or(false);
            if idle {
                let _ = stop_record(&pool, &org, &id).await;
            }
        });
    }
    Ok(())
}
async fn stop_record(pool: &PgPool, org: &str, id: &str) -> Result<(), ContextError> {
    let record = {
        let mut state = state()
            .lock()
            .map_err(|_| ContextError::Invalid("Runtime service ownership is unavailable"))?;
        let Some(record) = state.by_id.remove(id) else {
            return Ok(());
        };
        if let Some(reuse) = text(&record.reference, "reuseKey") {
            state.by_reuse.remove(&(org.into(), reuse.into()));
        }
        record
    };
    let process = record
        .process
        .pid()
        .ok_or(ContextError::Invalid(
            "Runtime service process identity is unavailable",
        ))?
        .to_string();
    let failed = stop_process(record.process).await?;
    agent_run_workspace::observe_service_process_exit(pool, org, id, &process, failed).await?;
    Ok(())
}
fn monitor(pool: PgPool, org: String, id: String) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let exited = {
                let mut state = match state().lock() {
                    Ok(state) => state,
                    Err(_) => return,
                };
                let Some(record) = state.by_id.get_mut(&id) else {
                    return;
                };
                record
                    .process
                    .result()
                    .and_then(|failed| record.process.pid().map(|pid| (pid.to_string(), failed)))
            };
            if let Some((process, failed)) = exited {
                if let Ok(mut state) = state().lock() {
                    if let Some(record) = state.by_id.remove(&id) {
                        if let Some(reuse) = text(&record.reference, "reuseKey") {
                            state.by_reuse.remove(&(org.clone(), reuse.into()));
                        }
                    }
                }
                let _ = agent_run_workspace::observe_service_process_exit(
                    &pool, &org, &id, &process, failed,
                )
                .await;
                return;
            }
        }
    });
}

/// Recovery never kills an unowned PID from a stale row. Live Rust-owned
/// handles are released; an absent owner remains an explicit cleanup gap.
pub(super) async fn finish_persisted(
    pool: &PgPool,
    org: &str,
    run: &str,
    runtime_root: &std::path::Path,
) -> Result<(), ContextError> {
    let services = agent_run_workspace::persisted_run_services(pool, org, run).await?;
    for service in services {
        let Some(id) = text(&service, "id") else {
            continue;
        };
        let known = state()
            .lock()
            .is_ok_and(|state| state.by_id.contains_key(id));
        if known {
            release_one(pool, org, run, id).await?;
        } else {
            let receipt = read_unbound_cleanup_observation(
                &runtime_root.join("runtime-services").join(id),
                id,
                id,
            )
            .map_err(|_| ContextError::Invalid("Runtime service cleanup receipt is invalid"))?;
            if let Some(receipt) = receipt.filter(|r| {
                r.process_id.map(|p| p.to_string()).as_deref() == text(&service, "providerRef")
            }) {
                agent_run_workspace::observe_service_process_exit(
                    pool,
                    org,
                    id,
                    text(&service, "providerRef").unwrap(),
                    receipt.host_status == "failed",
                )
                .await?;
            } else {
                return Err(ContextError::Invalid(
                    "Runtime service process cleanup is not yet proven by its host receipt",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn service_logs_redact_credentials_split_across_chunks_and_newlines() {
        let (sender, mut receiver) = tokio::sync::mpsc::channel(16);
        let sink = ContextLogSink {
            censor_username: false,
            sender: Some(sender),
            ordinal: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let initial = Arc::new(Mutex::new(Some(sink)));
        let secrets = vec!["synthetic-token-one\nline-two".to_owned()];
        let mut pending = Vec::new();
        buffer_output(
            "fixture-no-state",
            "fixture",
            "stdout",
            &mut pending,
            b"prefix synthetic-token-one\n",
            &initial,
            &secrets,
        );
        buffer_output(
            "fixture-no-state",
            "fixture",
            "stdout",
            &mut pending,
            b"line-two\nnext message\n",
            &initial,
            &secrets,
        );
        emit_output(
            "fixture-no-state",
            "fixture",
            "stdout",
            &pending,
            &initial,
            &secrets,
        );
        let mut combined = String::new();
        while let Ok(rudder_native_chat_executor::agent_run::AgentRunOutput::Event {
            event, ..
        }) = receiver.try_recv()
        {
            combined.push_str(event["chunk"].as_str().unwrap());
        }
        assert!(combined.contains("***REDACTED***"));
        assert!(!combined.contains("synthetic-token-one"));
        assert!(!combined.contains("line-two"));
    }
}
