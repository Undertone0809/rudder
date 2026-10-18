//! Hermes ACP execution over the shared owned-process transport.
//!
//! This adapter never uses Codex Thread/Turn fields. It resumes only the exact
//! ACP session persisted in the Segment and never retries a prompt after the
//! input-indeterminate checkpoint.

use super::{Error, ExecutionFailure, HermesExecutionObservation, HostPaths, Result, db};
use rudder_d1_persistence::native_chat::{
    NativeChatExecutionPrincipal,
    config::ResolvedCodexConfig,
    execution::{self, CheckpointSnapshot, CheckpointTransition, EffectDispatch, ExecutionFence},
};
use rudder_hermes_acp::{
    HermesAcpTransport, HermesCancellation, HermesLaunch, HermesStopReason, HermesTransportError,
    HermesTurnReceipt,
};
use rudder_runtime_core::native_chat::NativeChatProtocolPhase;
use sqlx::PgPool;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tokio::runtime::Handle;

const OWNER_POLL_INTERVAL: Duration = Duration::from_millis(250);
const LEASE_RENEW_INTERVAL: Duration = Duration::from_secs(5);
const RPC_TIMEOUT: Duration = Duration::from_secs(10);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) fn validate_config(
    config: &ResolvedCodexConfig,
    host: &rudder_d1_persistence::native_chat::config::LocalHostContext,
    paths: &HostPaths,
) -> Result<()> {
    let local = config
        .hermes
        .as_ref()
        .ok_or(Error::UnsupportedConfiguration)?;
    if config.identity.runtime_type != "hermes_local"
        || !host.has_trusted_executable_search_path()
        || local.executable_search_path != host.executable_search_path()
        || host
            .hermes_executable()
            .is_none_or(|path| path != config.executable)
        || !local.profile_revision_matches()
        || !local.instruction_adapter_matches(
            &config.executable,
            config
                .instruction_content
                .as_ref()
                .is_some_and(|text| !text.trim().is_empty()),
        )
        || !paths.process_host.is_file()
        || !paths.runtime_root.is_dir()
        || !paths.isolated_home.is_dir()
        || local.home.canonicalize().as_ref().ok() != Some(&local.home)
        || config.cwd.canonicalize().as_ref().ok() != Some(&config.cwd)
        || !local.home.is_dir()
        || !config.cwd.is_dir()
        || !config.executable.is_file()
    {
        return Err(Error::UnsupportedConfiguration);
    }
    Ok(())
}

// The executor boundary keeps the launch permit, fence, cancellation, deadline,
// and isolated host paths explicit so the provider cannot silently borrow a
// different session or workspace.
#[allow(clippy::too_many_arguments)]
pub(super) fn run_claimed(
    handle: &Handle,
    pool: &PgPool,
    execution_principal: NativeChatExecutionPrincipal,
    fence: ExecutionFence,
    config: ResolvedCodexConfig,
    permit: rudder_codex_app_server::ConnectionLaunchPermit,
    cancelled: &AtomicBool,
    deadline: Instant,
    paths: &HostPaths,
) -> std::result::Result<HermesExecutionObservation, ExecutionFailure> {
    let prepared = (|| -> Result<_> {
        if cancelled.load(Ordering::Acquire) {
            return Err(Error::Cancelled);
        }
        let local = config
            .hermes
            .as_ref()
            .ok_or(Error::UnsupportedConfiguration)?;
        if !local.profile_revision_matches() {
            return Err(Error::UnsupportedConfiguration);
        }
        if !local.instruction_adapter_matches(
            &config.executable,
            config
                .instruction_content
                .as_ref()
                .is_some_and(|text| !text.trim().is_empty()),
        ) {
            return Err(Error::UnsupportedConfiguration);
        }
        db(
            handle,
            deadline,
            execution::validate_submission_source(pool, &execution_principal, &fence),
        )?;
        let snapshot = db(
            handle,
            deadline,
            execution::current_checkpoint(pool, &execution_principal, &fence),
        )?;
        if snapshot.provider != rudder_runtime_core::native_chat::NativeChatProvider::HermesLocal
            || !matches!(
                snapshot.phase,
                NativeChatProtocolPhase::NoThreadRequest | NativeChatProtocolPhase::ThreadKnown
            )
        {
            return Err(Error::ProviderRejected);
        }
        let launch = hermes_launch(&config, &fence, paths)?;
        Ok((snapshot, launch))
    })();
    let (snapshot, launch) = match prepared {
        Ok(value) => value,
        Err(error) => {
            return Err(ExecutionFailure::before_launch(
                error,
                execution_principal,
                fence,
            ));
        }
    };
    let transport = match HermesAcpTransport::launch(launch, permit) {
        Ok(transport) => transport,
        Err(error) => {
            return Err(ExecutionFailure::after_claim_hermes(
                Error::HermesTransport(error),
                execution_principal,
                fence,
                None,
            ));
        }
    };
    let mut driver = Driver {
        handle,
        pool,
        execution_principal: &execution_principal,
        fence,
        config,
        transport,
        snapshot,
        cancelled,
        deadline,
        renewed: Instant::now(),
        stop_checked: Instant::now() - OWNER_POLL_INTERVAL,
        stop: None,
        connection_registered: false,
        poll_error: None,
    };
    let result = driver.execute();
    let cleanup_receipt = driver.stop_and_observe_cleanup();
    let fence = driver.fence.clone();
    let stop = driver.stop.take();
    drop(driver);
    match result {
        Ok(turn_receipt) => {
            if turn_receipt.stop_reason() == HermesStopReason::ApprovalRequired {
                return Err(ExecutionFailure::after_claim_hermes(
                    Error::ApprovalRequired,
                    execution_principal,
                    fence,
                    cleanup_receipt,
                ));
            }
            Ok(HermesExecutionObservation {
                execution_principal,
                fence,
                turn_receipt,
                cleanup_receipt,
                stop,
            })
        }
        Err(error) => Err(ExecutionFailure::after_claim_hermes(
            error,
            execution_principal,
            fence,
            cleanup_receipt,
        )),
    }
}

struct Driver<'a> {
    handle: &'a Handle,
    pool: &'a PgPool,
    execution_principal: &'a NativeChatExecutionPrincipal,
    fence: ExecutionFence,
    config: ResolvedCodexConfig,
    transport: HermesAcpTransport,
    snapshot: CheckpointSnapshot,
    cancelled: &'a AtomicBool,
    deadline: Instant,
    renewed: Instant,
    stop_checked: Instant,
    stop: Option<execution::StopIntent>,
    connection_registered: bool,
    poll_error: Option<Error>,
}

impl Driver<'_> {
    fn execute(&mut self) -> Result<HermesTurnReceipt> {
        self.validate_configuration()?;
        self.transport
            .wait_spawned(self.remaining_timeout(RPC_TIMEOUT)?)?;
        self.transport
            .initialize(self.remaining_timeout(RPC_TIMEOUT)?)?;
        self.validate_configuration()?;

        if self.snapshot.phase == NativeChatProtocolPhase::NoThreadRequest {
            self.poll_owner(true)?;
            if self.stop.is_some() {
                return Err(Error::Cancelled);
            }
            self.start_fresh_session()?;
        } else {
            let stored_session = self
                .snapshot
                .hermes_session
                .as_ref()
                .ok_or(Error::InvalidProviderObservation)?;
            let session =
                rudder_hermes_acp::HermesSessionSelector::from_persisted(stored_session.as_str())
                    .map_err(Error::HermesTransport)?;
            self.transport.load_session(
                &session,
                &self.config.cwd,
                self.remaining_timeout(RPC_TIMEOUT)?,
            )?;
            if let Some(model) = self.config.model.as_deref() {
                // Hermes 0.21.0 restores the session transcript but resets
                // the active model to its profile default. Re-apply the
                // trusted Rust configuration before the resumed prompt so a
                // continuation cannot silently use a different provider.
                self.transport
                    .set_model(model, self.remaining_timeout(RPC_TIMEOUT)?)?;
            }
        }

        self.poll_owner(true)?;
        if self.stop.is_some() || self.cancelled.load(Ordering::Acquire) {
            return Err(Error::Cancelled);
        }

        let prepared = db(
            self.handle,
            self.deadline,
            execution::advance_checkpoint(
                self.pool,
                self.execution_principal,
                &self.fence,
                self.snapshot.phase,
                self.snapshot.revision,
                CheckpointTransition::PrepareInput,
            ),
        )?;
        self.snapshot = prepared.snapshot().clone();
        let input = db(
            self.handle,
            self.deadline,
            execution::load_submission(self.pool, self.execution_principal, &self.fence),
        )?;
        let expected_source_message_id = input.message_id().to_owned();
        let expected_input_fingerprint = input.fingerprint().to_owned();
        let expected_request_id = self.transport.next_request_id();
        let mut marked = db(
            self.handle,
            self.deadline,
            execution::advance_checkpoint(
                self.pool,
                self.execution_principal,
                &self.fence,
                self.snapshot.phase,
                self.snapshot.revision,
                CheckpointTransition::MarkHermesInputIndeterminate {
                    request_id: expected_request_id,
                },
            ),
        )?;
        self.snapshot = marked.snapshot().clone();
        let permit = marked
            .take_effect_permit()
            .ok_or(Error::InvalidProviderObservation)?;
        let effect = db(
            self.handle,
            self.deadline,
            execution::authorize_effect(self.pool, self.execution_principal, permit, Some(input)),
        )?;
        self.validate_configuration()?;
        let expected_session = self
            .snapshot
            .hermes_session
            .as_ref()
            .ok_or(Error::InvalidProviderObservation)?
            .as_str()
            .to_owned();
        let transport = &mut self.transport;
        let fence = &self.fence;
        let execution_principal = self.execution_principal;
        let handle = self.handle;
        let pool = self.pool;
        let cancelled = HermesCancellation::default();
        let request_cancelled = self.cancelled;
        let deadline = self.deadline;
        let stop = &mut self.stop;
        let stop_checked = &mut self.stop_checked;
        let renewed = &mut self.renewed;
        let poll_error = &mut self.poll_error;
        let request = effect
            .dispatch(|payload| match payload {
                EffectDispatch::SubmitHermesInput {
                    session_id,
                    source_message_id,
                    body,
                } => {
                    if session_id != expected_session {
                        return Err(Error::InvalidProviderObservation);
                    }
                    // The request id was reserved after session/load and the
                    // trusted model re-application above. The D1 binding fence
                    // rejects configuration drift before this point.
                    transport
                        .prompt_with_expected_request_id_and_poll(
                            body,
                            source_message_id,
                            expected_request_id,
                            &cancelled,
                            remaining_timeout_at(deadline, Duration::from_secs(3600))?,
                            |signal| {
                                let now = Instant::now();
                                if request_cancelled.load(Ordering::Acquire) {
                                    signal.cancel();
                                    return false;
                                }
                                if now.duration_since(*stop_checked) >= OWNER_POLL_INTERVAL {
                                    match db(
                                        handle,
                                        deadline,
                                        execution::observe_stop(pool, execution_principal, fence),
                                    ) {
                                        Ok(observed) => {
                                            if stop.is_none() {
                                                *stop = observed;
                                            }
                                        }
                                        Err(error) => {
                                            *poll_error = Some(error);
                                            signal.cancel();
                                            return false;
                                        }
                                    }
                                    *stop_checked = now;
                                }
                                if stop.is_some() || signal.is_cancelled() {
                                    signal.cancel();
                                    return false;
                                }
                                if now.duration_since(*renewed) >= LEASE_RENEW_INTERVAL {
                                    if let Err(error) = db(
                                        handle,
                                        deadline,
                                        execution::renew_lease(pool, execution_principal, fence),
                                    ) {
                                        *poll_error = Some(error);
                                        signal.cancel();
                                        return false;
                                    }
                                    *renewed = now;
                                }
                                now < deadline
                            },
                        )
                        .map_err(Error::HermesTransport)
                }
                _ => Err(Error::InvalidProviderObservation),
            })
            .map_err(Error::Persistence)?;
        let turn = request.map_err(|error| match error {
            Error::Persistence(_) => error,
            Error::HermesTransport(HermesTransportError::ApprovalRequired) => {
                Error::ApprovalRequired
            }
            other => other,
        })?;
        if let Some(error) = self.poll_error.take() {
            return Err(error);
        }
        if turn.session().as_str() != expected_session
            || turn.request_id() != expected_request_id
            || turn.user_message_id() != expected_source_message_id
            || turn.input_fingerprint() != expected_input_fingerprint
        {
            return Err(Error::InvalidProviderObservation);
        }
        self.poll_owner(true)?;
        if let Some(stop) = &self.stop {
            let recorded = db(
                self.handle,
                self.deadline,
                execution::advance_stopping_hermes_turn(
                    self.pool,
                    self.execution_principal,
                    &self.fence,
                    stop,
                    self.snapshot.phase,
                    self.snapshot.revision,
                    &turn,
                ),
            )?;
            self.snapshot = recorded.snapshot().clone();
            return Ok(turn);
        }
        let recorded = db(
            self.handle,
            self.deadline,
            execution::advance_checkpoint(
                self.pool,
                self.execution_principal,
                &self.fence,
                self.snapshot.phase,
                self.snapshot.revision,
                CheckpointTransition::RecordHermesTurn,
            ),
        )?;
        self.snapshot = recorded.snapshot().clone();
        self.poll_owner(true)?;
        if self.stop.is_some() {
            return Ok(turn);
        }
        let terminal = db(
            self.handle,
            self.deadline,
            execution::advance_checkpoint(
                self.pool,
                self.execution_principal,
                &self.fence,
                self.snapshot.phase,
                self.snapshot.revision,
                CheckpointTransition::ObserveHermesProviderTerminal {
                    session_id: expected_session,
                    request_id: expected_request_id,
                },
            ),
        )?;
        self.snapshot = terminal.snapshot().clone();
        Ok(turn)
    }

    fn start_fresh_session(&mut self) -> Result<()> {
        let mut prepared = db(
            self.handle,
            self.deadline,
            execution::advance_checkpoint(
                self.pool,
                self.execution_principal,
                &self.fence,
                self.snapshot.phase,
                self.snapshot.revision,
                CheckpointTransition::PrepareHermesSessionStart,
            ),
        )?;
        self.snapshot = prepared.snapshot().clone();
        let effect = db(
            self.handle,
            self.deadline,
            execution::authorize_effect(
                self.pool,
                self.execution_principal,
                prepared
                    .take_effect_permit()
                    .ok_or(Error::InvalidProviderObservation)?,
                None,
            ),
        )?;
        self.validate_configuration()?;
        let cwd = self.config.cwd.clone();
        let model = self.config.model.clone();
        let transport = &mut self.transport;
        let start_result = effect
            .dispatch(|payload| match payload {
                EffectDispatch::StartHermesSession => {
                    let receipt = transport.new_session_with_receipt(
                        &cwd,
                        remaining_timeout(self.deadline, RPC_TIMEOUT)?,
                    )?;
                    if let Some(model) = model.as_deref() {
                        transport
                            .set_model(model, remaining_timeout(self.deadline, RPC_TIMEOUT)?)?;
                    }
                    Ok(receipt)
                }
                _ => Err(Error::InvalidProviderObservation),
            })
            .map_err(Error::Persistence)?;
        let start = start_result?;
        self.poll_owner(true)?;
        if let Some(stop) = &self.stop {
            let recorded = db(
                self.handle,
                self.deadline,
                execution::advance_stopping_hermes_session(
                    self.pool,
                    self.execution_principal,
                    &self.fence,
                    stop,
                    self.snapshot.phase,
                    self.snapshot.revision,
                    &start,
                ),
            )?;
            self.snapshot = recorded.snapshot().clone();
            return Err(Error::Cancelled);
        }
        let recorded = db(
            self.handle,
            self.deadline,
            execution::advance_checkpoint(
                self.pool,
                self.execution_principal,
                &self.fence,
                self.snapshot.phase,
                self.snapshot.revision,
                CheckpointTransition::RecordHermesSession {
                    session_id: start.session().as_str().to_owned(),
                },
            ),
        );
        match recorded {
            Ok(receipt) => self.snapshot = receipt.snapshot().clone(),
            Err(error) => {
                if let Some(stop) = db(
                    self.handle,
                    self.deadline,
                    execution::observe_stop(self.pool, self.execution_principal, &self.fence),
                )? {
                    self.stop = Some(stop);
                    let recorded = db(
                        self.handle,
                        self.deadline,
                        execution::advance_stopping_hermes_session(
                            self.pool,
                            self.execution_principal,
                            &self.fence,
                            self.stop.as_ref().expect("set above"),
                            self.snapshot.phase,
                            self.snapshot.revision,
                            &start,
                        ),
                    )?;
                    self.snapshot = recorded.snapshot().clone();
                    return Err(Error::Cancelled);
                }
                return Err(error);
            }
        }
        Ok(())
    }

    fn validate_configuration(&self) -> Result<()> {
        let local = self
            .config
            .hermes
            .as_ref()
            .ok_or(Error::UnsupportedConfiguration)?;
        if !local.profile_revision_matches() {
            return Err(Error::UnsupportedConfiguration);
        }
        Ok(())
    }

    fn poll_owner(&mut self, force: bool) -> Result<()> {
        if self.cancelled.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            return Err(if self.cancelled.load(Ordering::Acquire) {
                Error::Cancelled
            } else {
                Error::Deadline
            });
        }
        let now = Instant::now();
        if force || now.duration_since(self.stop_checked) >= OWNER_POLL_INTERVAL {
            self.stop = db(
                self.handle,
                self.deadline,
                execution::observe_stop(self.pool, self.execution_principal, &self.fence),
            )?;
            self.stop_checked = now;
        }
        if let Some(stop) = &self.stop {
            if !self.connection_registered {
                let connection = self.transport.connection_receipt();
                db(
                    self.handle,
                    self.deadline,
                    execution::bind_stopping_connection(
                        self.pool,
                        self.execution_principal,
                        &self.fence,
                        stop,
                        &connection,
                    ),
                )?;
                self.connection_registered = true;
            }
            return Ok(());
        }
        if now.duration_since(self.renewed) >= LEASE_RENEW_INTERVAL {
            db(
                self.handle,
                self.deadline,
                execution::renew_lease(self.pool, self.execution_principal, &self.fence),
            )?;
            self.renewed = now;
        }
        Ok(())
    }

    fn stop_and_observe_cleanup(&mut self) -> Option<rudder_hermes_acp::HermesCleanupReceipt> {
        let cleanup = self
            .transport
            .stop(CLEANUP_TIMEOUT)
            .ok()
            .or_else(|| self.transport.take_cleanup_receipt());
        if cleanup.is_none() {
            self.transport.close();
        }
        cleanup
    }

    fn remaining_timeout(&self, max: Duration) -> Result<Duration> {
        remaining_timeout(self.deadline, max)
    }
}

fn hermes_launch(
    config: &ResolvedCodexConfig,
    fence: &ExecutionFence,
    paths: &HostPaths,
) -> Result<HermesLaunch> {
    let local = config
        .hermes
        .as_ref()
        .ok_or(Error::UnsupportedConfiguration)?;
    Ok(HermesLaunch {
        hermes_executable: config.executable.clone(),
        python_executable: local.instruction_python_executable.clone(),
        python_source_root: local.instruction_python_source_root.clone(),
        ephemeral_system_prompt: local
            .instruction_adapter_revision
            .as_ref()
            .map(|_| config.instruction_content.clone().unwrap_or_default()),
        process_host: paths.process_host.clone(),
        runtime_root: paths.runtime_root.clone(),
        operator_home: config.operator_home.clone(),
        hermes_home: local.home.clone(),
        cwd: config.cwd.clone(),
        run_id: fence.identity().run_id.to_owned(),
        attempt_id: fence.identity().attempt_id.to_owned(),
        owner_token: fence.run_execution_owner_token().to_owned(),
        executable_search_path: local.executable_search_path.clone(),
        env: local.env.clone(),
    })
}

fn remaining_timeout(deadline: Instant, max: Duration) -> Result<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now()).min(max);
    if remaining.is_zero() {
        Err(Error::Deadline)
    } else {
        Ok(remaining)
    }
}

fn remaining_timeout_at(deadline: Instant, max: Duration) -> Result<Duration> {
    remaining_timeout(deadline, max)
}
