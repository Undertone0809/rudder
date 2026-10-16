//! Private, single-owner Codex turn execution. No public HTTP activation or Run
//! finalization authority lives here. Every exit retains the admission hold;
//! provider terminal data and host receipts require a separate finalizer.
mod profile;
mod wire;
pub use profile::provision_profile;

use crate::wire::ProviderTerminal;
use rudder_auth_core::VerifiedActor;
use rudder_codex_app_server::{
    CleanupReceipt, Message, OwnedTransport, ProcessLaunch, RequestId, SessionObservation,
    TransportError, TransportEvent, TurnReceipt,
};
use rudder_d1_persistence::{
    native_chat::{
        config::{LocalHostContext, ResolvedCodexConfig},
        execution::{
            self, CheckpointSnapshot, CheckpointTransition, EffectDispatch, ExecutionFence,
        },
    },
    runtime_bindings,
};
use rudder_runtime_core::native_chat::NativeChatProtocolPhase;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    collections::{BTreeMap, VecDeque},
    future::Future,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::runtime::Handle;

type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Native Chat blocking worker was interrupted")]
    WorkerInterrupted,
    #[error("Native Chat durable authority rejected execution")]
    Persistence(#[source] runtime_bindings::Error),
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error("Native Chat operation deadline expired; reconcile the held attempt")]
    Deadline,
    #[error("Native Chat execution was cancelled; reconcile the held attempt")]
    Cancelled,
    #[error("Native Chat runtime configuration has not been isolated")]
    UnsupportedConfiguration,
    #[error("Native Chat received an invalid or mismatched provider observation")]
    InvalidProviderObservation,
    #[error("Native Chat requires a governed provider decision")]
    ApprovalRequired,
    #[error("Native Chat provider rejected the request; input must not be retried")]
    ProviderRejected,
    #[error("Native Chat process exited before a matching provider terminal observation")]
    ProcessExited,
}

/// Installation paths, never accepted from an HTTP request. The isolated HOME
/// must be provisioned by the Rust host; this executor does not copy credentials
/// or use the operator's ambient environment.
pub struct HostPaths {
    pub process_host: PathBuf,
    pub runtime_root: PathBuf,
    pub isolated_home: PathBuf,
}

/// All IDs refer to an already admitted Run/Attempt. No prompt or client-selected
/// runtime configuration is accepted here.
pub struct ExecutionRequest<'a> {
    pub organization_id: &'a str,
    pub run_id: &'a str,
    pub attempt_id: &'a str,
    pub timeout: Duration,
    pub cancelled: &'a AtomicBool,
}

pub struct OwnedExecutionRequest {
    pub organization_id: String,
    pub run_id: String,
    pub attempt_id: String,
    pub timeout: Duration,
    pub cancelled: Arc<AtomicBool>,
}

struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// Own all worker inputs; dropping this future requests cancellation even while
/// the blocking worker is awaiting a database round trip. It still must reap
/// its own process and cannot release the held Run as a cancellation shortcut.
pub async fn execute(
    pool: PgPool,
    actor: VerifiedActor,
    host: LocalHostContext,
    paths: HostPaths,
    request: OwnedExecutionRequest,
) -> Result<ExecutionObservation> {
    let _cancel_on_drop = CancelOnDrop(Arc::clone(&request.cancelled));
    let handle = Handle::current();
    tokio::task::spawn_blocking(move || {
        run_on_blocking_thread(
            &handle,
            &pool,
            &actor,
            &host,
            &paths,
            ExecutionRequest {
                organization_id: &request.organization_id,
                run_id: &request.run_id,
                attempt_id: &request.attempt_id,
                timeout: request.timeout,
                cancelled: &request.cancelled,
            },
        )
    })
    .await
    .map_err(|_| Error::WorkerInterrupted)?
}

/// Observation only: even cleanup_proven=true does not release the durable hold
/// or finish the Run. The finalizer must validate/persist projection and billing.
pub struct ExecutionObservation {
    pub fence: ExecutionFence,
    pub turn_receipt: TurnReceipt,
    pub cleanup_receipt: Option<CleanupReceipt>,
    /// Compatibility observation only. Finalization must use the opaque receipt.
    pub cleanup_proven: bool,
}

fn db<T>(
    handle: &Handle,
    deadline: Instant,
    future: impl Future<Output = std::result::Result<T, runtime_bindings::Error>>,
) -> Result<T> {
    handle.block_on(async {
        tokio::time::timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(5)),
            future,
        )
        .await
        .map_err(|_| Error::Deadline)?
        .map_err(Error::Persistence)
    })
}

/// Process containment only; none of these facts establishes the durable Run
/// outcome, whether a claim committed, or permission to replay an attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessDisposition {
    NotLaunched,
    CleanupProven,
    Unresolved,
}

/// Opaque failure evidence, constructed only by the executor that owns launch
/// and observes cleanup. It cannot be used to finalize a provider turn.
#[derive(Debug)]
pub struct ExecutionFailure {
    error: Error,
    process: ProcessDisposition,
}

impl ExecutionFailure {
    pub fn process_disposition(&self) -> ProcessDisposition {
        self.process
    }
    pub fn into_error(self) -> Error {
        self.error
    }
}

impl ExecutionFailure {
    fn not_launched(error: Error) -> Self {
        Self {
            error,
            process: ProcessDisposition::NotLaunched,
        }
    }
}

/// Run only on a dedicated blocking worker (e.g. spawn_blocking), with the
/// caller's Tokio runtime kept alive. Transport polling and Drop are blocking.
/// Cancellation is explicit: abandoning a task handle alone is not a stop.
pub fn run_on_blocking_thread(
    handle: &Handle,
    pool: &PgPool,
    actor: &VerifiedActor,
    host: &LocalHostContext,
    paths: &HostPaths,
    request: ExecutionRequest<'_>,
) -> Result<ExecutionObservation> {
    run_observed_on_blocking_thread(handle, pool, actor, host, paths, request)
        .map_err(ExecutionFailure::into_error)
}

/// Dedicated blocking worker variant retaining process-containment evidence on
/// failure. A NotLaunched observation does not prove a database commit failed.
pub fn run_observed_on_blocking_thread(
    handle: &Handle,
    pool: &PgPool,
    actor: &VerifiedActor,
    host: &LocalHostContext,
    paths: &HostPaths,
    request: ExecutionRequest<'_>,
) -> std::result::Result<ExecutionObservation, ExecutionFailure> {
    if request.timeout.is_zero()
        || request.timeout > Duration::from_secs(3600)
        || request.cancelled.load(Ordering::Acquire)
    {
        return Err(ExecutionFailure::not_launched(Error::Cancelled));
    }
    let deadline = Instant::now() + request.timeout;
    let (claimed, launch, snapshot) = (|| -> Result<_> {
        validate_paths(paths)?;
        let claimed = db(
            handle,
            deadline,
            execution::claim_with_preflight(
                pool,
                actor,
                request.organization_id,
                request.run_id,
                request.attempt_id,
                host,
                |config| {
                    if request.cancelled.load(Ordering::Acquire) {
                        return Err(runtime_bindings::Error::Http(
                            409,
                            "Native Chat execution was cancelled".into(),
                        ));
                    }
                    profile::validate(config, paths).map_err(|_| {
                        runtime_bindings::Error::Http(
                            409,
                            "Native Chat profile configuration is unsupported".into(),
                        )
                    })
                },
            ),
        )?;
        if request.cancelled.load(Ordering::Acquire) {
            return Err(Error::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        db(
            handle,
            deadline,
            execution::validate_submission_source(pool, actor, &claimed.fence),
        )?;
        let launch = process_launch(&claimed.config, &claimed.fence, paths)?;
        let snapshot = db(
            handle,
            deadline,
            execution::current_checkpoint(pool, actor, &claimed.fence),
        )?;
        Ok((claimed, launch, snapshot))
    })()
    .map_err(ExecutionFailure::not_launched)?;
    // Finish all fallible prelaunch reads before creating the process owner.
    // A launch error may have created an external owner; do not infer cleanup.
    let transport =
        OwnedTransport::launch_external(launch, &paths.process_host).map_err(|error| {
            ExecutionFailure {
                error: error.into(),
                process: ProcessDisposition::Unresolved,
            }
        })?;
    let mut driver = Driver {
        handle,
        pool,
        actor,
        fence: claimed.fence,
        config: claimed.config,
        transport,
        snapshot,
        cancelled: request.cancelled,
        deadline,
        paths,
        renewed: Instant::now(),
        notifications: VecDeque::new(),
    };
    let result = driver.execute();
    // Stop even after permission, database, protocol, or provider failure. An
    // absent/unproven receipt stays unproven and never becomes success by Drop.
    let cleanup_receipt = driver.stop_and_observe_cleanup();
    let identity = driver.fence.identity();
    let process = if cleanup_receipt.as_ref().is_some_and(|cleanup| {
        cleanup.matches_execution(
            identity.run_id,
            identity.attempt_id,
            driver.fence.run_execution_owner_token(),
        )
    }) {
        ProcessDisposition::CleanupProven
    } else {
        ProcessDisposition::Unresolved
    };
    let failure = |error| ExecutionFailure { error, process };
    let provider_terminal = result.map_err(failure)?;
    let turn_receipt = driver
        .transport
        .take_turn_receipt()
        .ok_or_else(|| failure(Error::InvalidProviderObservation))?;
    if provider_terminal.thread_id != turn_receipt.thread_id()
        || provider_terminal.turn_id != turn_receipt.turn_id()
        || provider_terminal.status != turn_receipt.status()
    {
        return Err(failure(Error::InvalidProviderObservation));
    }
    let cleanup_proven = cleanup_receipt.is_some();
    Ok(ExecutionObservation {
        fence: driver.fence,
        turn_receipt,
        cleanup_receipt,
        cleanup_proven,
    })
}

fn validate_paths(paths: &HostPaths) -> Result<()> {
    for path in [
        &paths.process_host,
        &paths.runtime_root,
        &paths.isolated_home,
    ] {
        if !path.is_absolute() || path.canonicalize().as_ref().ok() != Some(path) {
            return Err(Error::UnsupportedConfiguration);
        }
    }
    if !paths.process_host.is_file()
        || !paths.runtime_root.is_dir()
        || !paths.isolated_home.is_dir()
    {
        return Err(Error::UnsupportedConfiguration);
    }
    Ok(())
}

fn process_launch(
    config: &ResolvedCodexConfig,
    fence: &ExecutionFence,
    paths: &HostPaths,
) -> Result<ProcessLaunch> {
    if config.plan_mode || config.search_enabled {
        return Err(Error::UnsupportedConfiguration);
    }
    profile::validate(config, paths)?;
    let utf8 = |path: &Path| {
        path.to_str()
            .map(str::to_owned)
            .ok_or(Error::UnsupportedConfiguration)
    };
    let mut env = BTreeMap::new();
    env.insert("HOME".into(), utf8(&paths.isolated_home)?);
    env.insert("USERPROFILE".into(), utf8(&paths.isolated_home)?);
    env.insert("CODEX_HOME".into(), utf8(&config.profile.home)?);
    env.insert("PATH".into(), "/usr/bin:/bin".into());
    Ok(ProcessLaunch {
        executable: utf8(&config.executable)?,
        argv: vec![
            "app-server".into(),
            "--strict-config".into(),
            "--disable".into(),
            "plugins".into(),
        ],
        cwd: utf8(&paths.isolated_home)?,
        env,
        request_id: fence.identity().attempt_id.into(),
        run_id: fence.identity().run_id.into(),
        attempt_id: fence.identity().attempt_id.into(),
        owner_token: fence.run_execution_owner_token().into(),
        runtime_root: utf8(&paths.runtime_root)?,
    })
}

struct Driver<'a> {
    handle: &'a Handle,
    pool: &'a PgPool,
    actor: &'a VerifiedActor,
    fence: ExecutionFence,
    config: ResolvedCodexConfig,
    paths: &'a HostPaths,
    transport: OwnedTransport,
    snapshot: CheckpointSnapshot,
    cancelled: &'a AtomicBool,
    deadline: Instant,
    renewed: Instant,
    notifications: VecDeque<(String, Value)>,
}

impl Driver<'_> {
    fn validate_configuration(&mut self) -> Result<()> {
        profile::validate(&self.config, self.paths)?;
        let observed = self.rpc(
            "config/read",
            json!({"cwd":self.config.cwd.to_string_lossy(),"includeLayers":true}),
        )?;
        profile::validate_layers(&observed, &self.config.profile.home)?;
        profile::validate(&self.config, self.paths)?;
        Ok(())
    }

    fn check_cancelled(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(Error::Cancelled);
        }
        if Instant::now() >= self.deadline {
            return Err(Error::Deadline);
        }
        Ok(())
    }

    fn next(&mut self) -> Result<TransportEvent> {
        loop {
            if self.cancelled.load(Ordering::Acquire) {
                return Err(Error::Cancelled);
            }
            if Instant::now() >= self.deadline {
                return Err(Error::Deadline);
            }
            if self.renewed.elapsed() >= Duration::from_secs(5) {
                db(
                    self.handle,
                    self.deadline,
                    execution::renew_lease(self.pool, self.actor, &self.fence),
                )?;
                self.renewed = Instant::now();
            }
            if let Some(event) = self.transport.poll(Duration::from_millis(100))? {
                match &event {
                    TransportEvent::Rpc(SessionObservation::Incoming(Message::Request {
                        ..
                    })) => return Err(Error::ApprovalRequired),
                    TransportEvent::Lifecycle(value)
                        if matches!(value["type"].as_str(), Some("app-exit" | "terminal")) =>
                    {
                        return Err(Error::ProcessExited);
                    }
                    _ => return Ok(event),
                }
            }
        }
    }

    fn remember(&mut self, event: TransportEvent) -> Result<()> {
        if let TransportEvent::Rpc(SessionObservation::Incoming(Message::Notification {
            method,
            params,
        })) = event
        {
            // Only the terminal event is needed by this private executor. Other
            // output belongs to the upcoming bounded projection owner.
            if method == "turn/completed" {
                if !matches!(
                    self.snapshot.phase,
                    NativeChatProtocolPhase::InputIndeterminate
                        | NativeChatProtocolPhase::TurnKnown
                ) {
                    return Err(Error::InvalidProviderObservation);
                }
                if self.notifications.len() >= 4 {
                    return Err(Error::InvalidProviderObservation);
                }
                self.notifications
                    .push_back((method, params.ok_or(Error::InvalidProviderObservation)?));
            }
        } else if matches!(event, TransportEvent::Rpc(_)) {
            return Err(Error::InvalidProviderObservation);
        }
        Ok(())
    }

    fn response(&mut self, id: RequestId, method: &str) -> Result<Value> {
        let mut written = false;
        let mut outcome = None;
        loop {
            match self.next()? {
                TransportEvent::FrameWritten { request_id } if request_id.as_ref() == Some(&id) => {
                    written = true
                }
                TransportEvent::Rpc(SessionObservation::Completed {
                    id: actual,
                    method: actual_method,
                    outcome: value,
                }) if actual == id && actual_method == method => {
                    if outcome.is_some() {
                        return Err(Error::InvalidProviderObservation);
                    }
                    outcome = Some(value.map_err(|_| Error::ProviderRejected)?);
                }
                event => self.remember(event)?,
            }
            if written && let Some(value) = outcome.take() {
                return Ok(value);
            }
        }
    }

    fn rpc(&mut self, method: &str, params: Value) -> Result<Value> {
        self.check_cancelled()?;
        let id = self.transport.request(method, params)?;
        self.response(id, method)
    }

    fn transition(
        &mut self,
        transition: CheckpointTransition,
    ) -> Result<execution::CheckpointReceipt> {
        let receipt = db(
            self.handle,
            self.deadline,
            execution::advance_checkpoint(
                self.pool,
                self.actor,
                &self.fence,
                self.snapshot.phase,
                self.snapshot.revision,
                transition,
            ),
        )?;
        self.snapshot = receipt.snapshot().clone();
        Ok(receipt)
    }

    fn execute(&mut self) -> Result<ProviderTerminal> {
        loop {
            if let TransportEvent::Lifecycle(value) = self.next()?
                && value["type"] == "spawned"
            {
                break;
            }
        }
        let initialized = self.rpc("initialize", json!({"clientInfo":{"name":"rudder-native-chat","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":false}}))?;
        if !initialized["userAgent"]
            .as_str()
            .is_some_and(|value| value.starts_with("rudder-native-chat/0.163.0-alpha.10.2 ("))
            || initialized["codexHome"].as_str() != self.config.profile.home.to_str()
        {
            return Err(Error::UnsupportedConfiguration);
        }
        self.transport.notify("initialized", json!({}))?;
        loop {
            match self.next()? {
                TransportEvent::FrameWritten { request_id: None } => break,
                event => self.remember(event)?,
            }
        }
        // Reject static provider configuration before marking any operation as
        // indeterminate. Recheck again immediately before each actual effect.
        self.validate_configuration()?;
        match self.snapshot.phase {
            NativeChatProtocolPhase::NoThreadRequest => {
                db(
                    self.handle,
                    self.deadline,
                    execution::validate_submission_source(self.pool, self.actor, &self.fence),
                )?;
                let mut receipt = self.transition(CheckpointTransition::PrepareThreadStart)?;
                let permit = receipt
                    .take_effect_permit()
                    .ok_or(Error::InvalidProviderObservation)?;
                let authorized = db(
                    self.handle,
                    self.deadline,
                    execution::authorize_effect(self.pool, self.actor, permit, None),
                )?;
                self.validate_configuration()?;
                let params = wire::thread_params(&self.config);
                self.check_cancelled()?;
                let id = authorized
                    .dispatch(|effect| match effect {
                        EffectDispatch::StartThread => {
                            self.transport.request("thread/start", params)
                        }
                        _ => Err(TransportError::InvalidLaunch),
                    })
                    .map_err(Error::Persistence)??;
                let response = self.response(id, "thread/start")?;
                if response["thread"]["ephemeral"] != false {
                    return Err(Error::InvalidProviderObservation);
                }
                let thread_id = wire::locator(&response["thread"]["id"])?;
                self.transition(CheckpointTransition::RecordThread { thread_id })?;
            }
            NativeChatProtocolPhase::ThreadKnown => {
                let thread = self
                    .snapshot
                    .thread_id
                    .clone()
                    .ok_or(Error::InvalidProviderObservation)?;
                let mut params = wire::thread_params(&self.config);
                params["threadId"] = json!(thread);
                params["excludeTurns"] = json!(true);
                db(
                    self.handle,
                    self.deadline,
                    execution::validate_submission_source(self.pool, self.actor, &self.fence),
                )?;
                self.validate_configuration()?;
                let response = self.rpc("thread/resume", params)?;
                if wire::locator(&response["thread"]["id"])? != thread {
                    return Err(Error::InvalidProviderObservation);
                }
            }
            _ => return Err(Error::InvalidProviderObservation),
        }
        self.transition(CheckpointTransition::PrepareInput)?;
        let input = db(
            self.handle,
            self.deadline,
            execution::load_submission(self.pool, self.actor, &self.fence),
        )?;
        let mut receipt = self.transition(CheckpointTransition::MarkInputIndeterminate)?;
        let permit = receipt
            .take_effect_permit()
            .ok_or(Error::InvalidProviderObservation)?;
        let authorized = db(
            self.handle,
            self.deadline,
            execution::authorize_effect(self.pool, self.actor, permit, Some(input)),
        )?;
        self.validate_configuration()?;
        self.check_cancelled()?;
        let id = authorized
            .dispatch(|effect| match effect {
                EffectDispatch::SubmitInput {
                    thread_id,
                    source_message_id,
                    body,
                } => {
                    self.transport.arm_turn_receipt()?;
                    self.transport.request(
                        "turn/start",
                        wire::turn_params(thread_id, source_message_id, body, &self.config),
                    )
                }
                _ => Err(TransportError::InvalidLaunch),
            })
            .map_err(Error::Persistence)??;
        let response = self.response(id, "turn/start")?;
        let turn_id = wire::locator(&response["turn"]["id"])?;
        let thread_id = self
            .snapshot
            .thread_id
            .clone()
            .ok_or(Error::InvalidProviderObservation)?;
        self.transition(CheckpointTransition::RecordTurn {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
        })?;
        self.transport
            .begin_turn_receipt(thread_id.clone(), turn_id.clone())?;
        loop {
            if let Some((_, value)) = self.notifications.pop_front() {
                let terminal = wire::terminal(value, &thread_id, &turn_id)?;
                self.transition(CheckpointTransition::ObserveProviderTerminal {
                    thread_id,
                    turn_id,
                })?;
                return Ok(terminal);
            }
            let event = self.next()?;
            self.remember(event)?;
        }
    }

    fn stop_and_observe_cleanup(&mut self) -> Option<CleanupReceipt> {
        if self.transport.stop().is_err() {
            return None;
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match self.transport.poll(Duration::from_millis(100)) {
                Ok(Some(TransportEvent::Lifecycle(value))) if value["type"] == "terminal" => {
                    return self.transport.take_cleanup_receipt();
                }
                Err(_) => return None,
                _ => (),
            }
        }
        None
    }
}
