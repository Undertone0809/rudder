//! Rust-owned Pi RPC execution boundary.
//!
//! This module deliberately stops at provider observations. It owns the
//! launch/session/input/settlement/cleanup sequence for one Pi process, but it
//! does not admit a Run, mutate D1, or decide billing. A Foundation worker can
//! consume [`PiExecutionObservation`] and apply the shared fenced authority.
//!
//! `agent_end` is not treated as completion. Pi versions that emit
//! `agent_settled` are accepted only after an `agent_end`; older versions must
//! prove an idle, non-compacting state with an empty pending queue. If neither
//! proof is available the adapter returns an explicit `Unknown` phase.

use super::{Error, ExecutionFailure, HostPaths, PiNativeExecutionObservation, db};
use rudder_d1_persistence::native_chat::{
    NativeChatExecutionPrincipal,
    config::{LocalHostContext, ResolvedCodexConfig},
    execution::{
        self, CheckpointSnapshot, CheckpointTransition, EffectDispatch, ExecutionFence,
        NativeInterruptTarget, StopIntent,
    },
};
use rudder_d1_persistence::runtime_bindings;
use rudder_pi_rpc::{
    ConnectionLaunchPermit, ConnectionReceipt, PiCleanupReceipt, PiCommand, PiEvent, PiProfileMode,
    PiResponse, PiRpcMessage, PiRpcTransport, PiSessionTree, PiSessionTreeError, PiTransportError,
    PiTurnReceipt, ProcessLaunch,
};
use rudder_runtime_core::native_chat::{
    NativeChatProtocolPhase, NativeChatProvider, PiSessionSelector,
};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::runtime::Handle;

const MAX_SESSION_ID_BYTES: usize = 256;
const RPC_TIMEOUT: Duration = Duration::from_secs(10);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const SETTLEMENT_POLL_INTERVAL: Duration = Duration::from_millis(50);
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(200);
const LEASE_RENEW_INTERVAL: Duration = Duration::from_secs(5);
const INTERRUPT_TIMEOUT: Duration = Duration::from_secs(2);
const CLEANUP_AUTHORITY_POLL_INTERVAL: Duration = Duration::from_secs(1);
const CLEANUP_AUTHORITY_TIMEOUT: Duration = Duration::from_secs(1);
type ExecResult<T> = std::result::Result<T, Error>;

pub(super) fn validate_config(
    config: &ResolvedCodexConfig,
    host: &LocalHostContext,
    paths: &HostPaths,
) -> ExecResult<()> {
    let local = config.pi.as_ref().ok_or(Error::UnsupportedConfiguration)?;
    let Some((node, entry, _profiles_root)) = host.pi_runtime() else {
        return Err(Error::UnsupportedConfiguration);
    };
    if config.identity.runtime_type != "pi_local"
        || !host.has_trusted_executable_search_path()
        || local.node_executable != node
        || local.pi_cli_entry != entry
        || local.env_revision.is_empty()
        || !paths.process_host.is_file()
        || !paths.runtime_root.is_dir()
        || !paths.isolated_home.is_dir()
        || !local.home.is_dir()
        || !local.agent_dir.is_dir()
        || !local.session_dir.is_dir()
        || !config.cwd.is_dir()
        || !local.node_executable.is_file()
        || !local.pi_cli_entry.is_file()
        || local.home.canonicalize().as_ref().ok() != Some(&local.home)
        || local.agent_dir.canonicalize().as_ref().ok() != Some(&local.agent_dir)
        || local.session_dir.canonicalize().as_ref().ok() != Some(&local.session_dir)
        || config.cwd.canonicalize().as_ref().ok() != Some(&config.cwd)
    {
        return Err(Error::UnsupportedConfiguration);
    }
    Ok(())
}

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
) -> std::result::Result<PiNativeExecutionObservation, ExecutionFailure> {
    let deadline = config
        .pi
        .as_ref()
        .and_then(|local| local.timeout)
        .and_then(|timeout| Instant::now().checked_add(timeout))
        .map_or(deadline, |configured| configured.min(deadline));
    let cleanup_grace = config
        .pi
        .as_ref()
        .map_or(CLEANUP_TIMEOUT, |local| local.cleanup_grace);
    let prepared = (|| -> ExecResult<_> {
        if cancelled.load(Ordering::Acquire) {
            return Err(Error::Cancelled);
        }
        let local = config.pi.as_ref().ok_or(Error::UnsupportedConfiguration)?;
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
        if snapshot.provider != NativeChatProvider::PiLocal
            || !matches!(
                snapshot.phase,
                NativeChatProtocolPhase::NoThreadRequest | NativeChatProtocolPhase::ThreadKnown
            )
        {
            return Err(Error::ProviderRejected);
        }
        let resume_session_file = snapshot
            .pi_session
            .as_ref()
            .map(|session| PathBuf::from(&session.session_file));
        let system_prompt_file = config
            .instruction_source_path
            .as_ref()
            .map(|root| root.join(&config.instruction_entry_file));
        if config
            .instruction_content
            .as_ref()
            .is_some_and(|text| !text.is_empty())
            && system_prompt_file.is_none()
        {
            return Err(Error::UnsupportedConfiguration);
        }
        let launch = ProcessLaunch {
            node_executable: local.node_executable.clone(),
            pi_cli_entry: local.pi_cli_entry.clone(),
            process_host: paths.process_host.clone(),
            runtime_root: paths.runtime_root.clone(),
            isolated_home: local.home.clone(),
            session_dir: local.session_dir.clone(),
            profile_mode: if local.profile_id == "operator-default" {
                PiProfileMode::OperatorNative {
                    session_root: local.session_dir.clone(),
                    instruction_file: system_prompt_file.clone(),
                }
            } else if let Some(instruction_file) = system_prompt_file.as_ref() {
                PiProfileMode::ManagedWithInstructions {
                    instruction_file: instruction_file.clone(),
                }
            } else {
                PiProfileMode::Managed
            },
            resume_session_file,
            system_prompt_file,
            cwd: config.cwd.clone(),
            provider: local.provider.clone(),
            model: local.model.clone(),
            thinking: local.thinking.clone(),
            run_id: fence.identity().run_id.to_owned(),
            attempt_id: fence.identity().attempt_id.to_owned(),
            owner_token: fence.run_execution_owner_token().to_owned(),
            env: local.env.clone(),
        };
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
    let mut execution = match PiExecution::launch_with_cleanup(
        launch,
        permit,
        remaining_timeout(deadline, RPC_TIMEOUT).unwrap_or_default(),
    ) {
        Ok(execution) => execution,
        Err(failure) => {
            return Err(ExecutionFailure::after_claim_pi(
                Error::PiTransport(failure.error),
                execution_principal,
                fence,
                failure.cleanup_receipt,
            ));
        }
    };
    let result = execute_pi_turn(
        handle,
        pool,
        &execution_principal,
        &fence,
        &config,
        &mut execution,
        snapshot,
        cancelled,
        deadline,
    );
    // Host cleanup has its own bounded deadline. Continue observing Stop and
    // renewing the exact run/generation leases while waiting, even when the
    // provider execution deadline has elapsed. The cleanup hook never sends a
    // provider interrupt; all provider terminal evidence is already fixed.
    let mut cleanup_authority = PiStopPoll::new_for_cleanup(
        handle,
        pool,
        &execution_principal,
        &fence,
        execution.connection_receipt(),
    );
    if let Ok(Some(stop)) = &result {
        // A Stop returned by execute_pi_turn has already been durably observed
        // and bound to this exact connection.
        cleanup_authority.seed_bound_stop(stop.clone());
    }
    let mut cleanup_tick = || cleanup_authority.cleanup_tick(false);
    let _cleanup_phase = execution.cleanup_with_grace_and_hook(
        cleanup_grace,
        cleanup_grace.saturating_add(Duration::from_secs(2)),
        &mut cleanup_tick,
    );
    // Cover the narrow race where Stop is committed immediately as the host
    // emits its terminal cleanup event and the wait loop exits.
    cleanup_authority.cleanup_tick(true);
    let cleanup_stop = cleanup_authority.stop().cloned();
    let observation = execution.into_observation();
    let stop = match result {
        Ok(stop) => stop.or(cleanup_stop),
        Err(error) => {
            return Err(ExecutionFailure::after_claim_pi(
                error,
                execution_principal,
                fence,
                observation.cleanup_receipt,
            ));
        }
    };
    if (observation.turn_receipt.is_none() && stop.is_none())
        || observation.cleanup_receipt.is_none()
    {
        return Err(ExecutionFailure::after_claim_pi(
            Error::InvalidProviderObservation,
            execution_principal,
            fence,
            observation.cleanup_receipt,
        ));
    }
    Ok(PiNativeExecutionObservation {
        execution_principal,
        fence,
        observation,
        stop,
    })
}

#[allow(clippy::too_many_arguments)]
fn execute_pi_turn(
    handle: &Handle,
    pool: &PgPool,
    actor: &NativeChatExecutionPrincipal,
    fence: &ExecutionFence,
    _config: &ResolvedCodexConfig,
    execution: &mut PiExecution,
    mut snapshot: CheckpointSnapshot,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> ExecResult<Option<StopIntent>> {
    let connection = execution.connection_receipt();
    let mut stop_poll = PiStopPoll::new(handle, pool, actor, fence, connection);

    // A Stop observed before any input is dispatched remains a no-submit
    // finalization. The worker validates the empty frozen prefix and exact
    // cleanup receipt; this adapter does not fabricate a provider turn.
    let preflight_stopped = stop_poll.poll(deadline, true);
    stop_poll.take_poll_error()?;
    if preflight_stopped {
        return Ok(stop_poll.stop().cloned());
    }
    if snapshot.phase == NativeChatProtocolPhase::NoThreadRequest {
        let prepared = db(
            handle,
            deadline,
            execution::advance_checkpoint(
                pool,
                actor,
                fence,
                snapshot.phase,
                snapshot.revision,
                CheckpointTransition::PreparePiSessionStart,
            ),
        );
        let Some(mut prepared) = resolve_preinput_stop_race(prepared, &mut stop_poll, deadline)?
        else {
            return Ok(stop_poll.stop().cloned());
        };
        snapshot = prepared.snapshot().clone();
        let effect = db(
            handle,
            deadline,
            execution::authorize_effect(
                pool,
                actor,
                prepared
                    .take_effect_permit()
                    .ok_or(Error::InvalidProviderObservation)?,
                None,
            ),
        );
        let Some(effect) = resolve_preinput_stop_race(effect, &mut stop_poll, deadline)? else {
            return Ok(stop_poll.stop().cloned());
        };
        let timeout = remaining_timeout(deadline, RPC_TIMEOUT)?;
        effect
            .dispatch(|payload| match payload {
                EffectDispatch::StartPiSession => execution
                    .new_session_with_hook(timeout, &mut || stop_poll.poll(deadline, false))
                    .map(|_| ())
                    .map_err(Error::PiTransport),
                _ => Err(Error::InvalidProviderObservation),
            })
            .map_err(Error::Persistence)??;
        stop_poll.take_poll_error()?;
        // The session-start RPC may take long enough for Stop to arrive. It
        // has no user input, so retain the exact no-submit checkpoint and let
        // the stopped finalizer close the owned process without advancing it.
        if stop_poll.poll(deadline, true) {
            stop_poll.take_poll_error()?;
            return Ok(stop_poll.stop().cloned());
        }
        let state = execution.state().ok_or(Error::InvalidProviderObservation)?;
        let selector = PiSessionSelector {
            session_id: state.session_id().to_owned(),
            session_file: state.session_file().to_string_lossy().into_owned(),
            leaf_id: None,
        };
        let recorded = db(
            handle,
            deadline,
            execution::advance_checkpoint(
                pool,
                actor,
                fence,
                snapshot.phase,
                snapshot.revision,
                CheckpointTransition::RecordPiSession { selector },
            ),
        );
        let Some(recorded) = resolve_preinput_stop_race(recorded, &mut stop_poll, deadline)? else {
            return Ok(stop_poll.stop().cloned());
        };
        snapshot = recorded.snapshot().clone();
    } else {
        let stored = snapshot
            .pi_session
            .as_ref()
            .ok_or(Error::InvalidProviderObservation)?;
        execution
            .resume_session_with_hook(
                Path::new(&stored.session_file),
                remaining_timeout(deadline, RPC_TIMEOUT)?,
                &mut || stop_poll.poll(deadline, false),
            )
            .map_err(Error::PiTransport)?;
        stop_poll.take_poll_error()?;
        if stop_poll.poll(deadline, true) {
            stop_poll.take_poll_error()?;
            return Ok(stop_poll.stop().cloned());
        }
        let state = execution.state().ok_or(Error::InvalidProviderObservation)?;
        if state.session_id() != stored.session_id
            || state.session_file().to_string_lossy() != stored.session_file
        {
            return Err(Error::InvalidProviderObservation);
        }
    }
    let pre_input_stopped = stop_poll.poll(deadline, true);
    stop_poll.take_poll_error()?;
    if pre_input_stopped {
        return Ok(stop_poll.stop().cloned());
    }
    if cancelled.load(Ordering::Acquire) || Instant::now() >= deadline {
        return Err(if cancelled.load(Ordering::Acquire) {
            Error::Cancelled
        } else {
            Error::Deadline
        });
    }
    let prepared = db(
        handle,
        deadline,
        execution::advance_checkpoint(
            pool,
            actor,
            fence,
            snapshot.phase,
            snapshot.revision,
            CheckpointTransition::PrepareInput,
        ),
    );
    let Some(prepared) = resolve_preinput_stop_race(prepared, &mut stop_poll, deadline)? else {
        return Ok(stop_poll.stop().cloned());
    };
    snapshot = prepared.snapshot().clone();
    let input = db(
        handle,
        deadline,
        execution::load_submission(pool, actor, fence),
    );
    let Some(input) = resolve_preinput_stop_race(input, &mut stop_poll, deadline)? else {
        return Ok(stop_poll.stop().cloned());
    };
    let input_body = input.body().to_owned();
    let marked = db(
        handle,
        deadline,
        execution::advance_checkpoint(
            pool,
            actor,
            fence,
            snapshot.phase,
            snapshot.revision,
            CheckpointTransition::MarkPiInputIndeterminate,
        ),
    );
    let Some(mut marked) = resolve_preinput_stop_race(marked, &mut stop_poll, deadline)? else {
        return Ok(stop_poll.stop().cloned());
    };
    snapshot = marked.snapshot().clone();
    let effect = db(
        handle,
        deadline,
        execution::authorize_effect(
            pool,
            actor,
            marked
                .take_effect_permit()
                .ok_or(Error::InvalidProviderObservation)?,
            Some(input),
        ),
    );
    let Some(effect) = resolve_preinput_stop_race(effect, &mut stop_poll, deadline)? else {
        return Ok(stop_poll.stop().cloned());
    };
    let session_id = snapshot
        .pi_session
        .as_ref()
        .ok_or(Error::InvalidProviderObservation)?
        .session_id
        .clone();
    let prior_leaf_id = snapshot
        .pi_session
        .as_ref()
        .and_then(|session| session.leaf_id.clone());
    let timeout = remaining_timeout(deadline, RPC_TIMEOUT)?;
    {
        let mut poll_hook = || stop_poll.poll(deadline, false);
        effect
            .dispatch(|payload| match payload {
                EffectDispatch::SubmitPiInput {
                    session_id: expected,
                    body,
                    ..
                } if expected == session_id => execution
                    .submit_input_with_hook(body, timeout, &mut poll_hook)
                    .map(|_| ())
                    .map_err(Error::PiTransport),
                _ => Err(Error::InvalidProviderObservation),
            })
            .map_err(Error::Persistence)??;
    }
    stop_poll.take_poll_error()?;

    let target = NativeInterruptTarget::Pi {
        session_id: session_id.clone(),
    };
    let mut abort_reserved = false;
    loop {
        let (phase, _stop_observed) = {
            let mut poll_hook = || stop_poll.poll(deadline, false) && !abort_reserved;
            execution
                .wait_until_settled_with_hook(
                    remaining_timeout(deadline, Duration::from_secs(3600))?,
                    &mut poll_hook,
                )
                .map_err(Error::PiTransport)?
        };
        stop_poll.take_poll_error()?;
        if stop_poll.stop().is_some() && !abort_reserved && !execution.agent_ended() {
            let stop = stop_poll.stop().ok_or(Error::InvalidProviderObservation)?;
            let permit = db(
                handle,
                deadline,
                execution::reserve_native_interrupt(
                    pool,
                    actor,
                    fence,
                    stop,
                    &stop_poll.connection,
                    &target,
                ),
            )?;
            abort_reserved = true;
            if let Some(permit) = permit {
                let timeout = remaining_timeout(deadline, INTERRUPT_TIMEOUT)?;
                let abort = permit
                    .dispatch(&stop_poll.connection, &target, || execution.abort(timeout))
                    .map_err(Error::Persistence)?;
                match abort {
                    Ok(()) => (),
                    // Pi may have crossed its terminal edge after Stop was
                    // observed but before Abort reached the RPC loop. That is
                    // not an acknowledgment; continue waiting for the exact
                    // terminal tree and idle proof instead of retrying Abort.
                    Err(PiAdapterError::InvalidPhase)
                    | Err(PiAdapterError::Transport(PiTransportError::InvalidMessage)) => (),
                    // A negative provider response is likewise not terminal.
                    // Do not retry; the normal receive loop may still observe
                    // a naturally completed exact turn before its deadline.
                    Err(PiAdapterError::CommandRejected { command }) if command == "abort" => (),
                    Err(error) => return Err(Error::PiTransport(error)),
                }
            }
            continue;
        }
        if phase.is_provider_terminal() {
            break;
        }
        let reason = execution
            .unknown_reason()
            .ok_or(Error::InvalidProviderObservation)?;
        return Err(Error::PiTransport(PiAdapterError::UnknownObservation(
            reason,
        )));
    }
    // Re-read Stop before changing any normal checkpoint. A Stop owns its
    // stopping checkpoint and the Pi finalizer commits the terminal result.
    let _ = stop_poll.poll(deadline, true);
    stop_poll.take_poll_error()?;
    let stop = stop_poll.stop().cloned();
    execution
        .take_turn_receipt(prior_leaf_id.as_deref(), &input_body)
        .map_err(Error::PiTransport)?;
    let receipt = execution
        .turn_receipt()
        .ok_or(Error::InvalidProviderObservation)?;
    if receipt.session_id() != session_id || receipt.input_fingerprint().is_empty() {
        return Err(Error::InvalidProviderObservation);
    }
    if stop.is_some() {
        return Ok(stop);
    }
    let recorded = db(
        handle,
        deadline,
        execution::advance_checkpoint(
            pool,
            actor,
            fence,
            snapshot.phase,
            snapshot.revision,
            CheckpointTransition::RecordPiTurn {
                session_id: receipt.session_id().to_owned(),
                entry_id: receipt.input_entry_id().to_owned(),
            },
        ),
    );
    let Some(recorded) = resolve_terminal_stop_race(recorded, &mut stop_poll, deadline)? else {
        return Ok(stop_poll.stop().cloned());
    };
    snapshot = recorded.snapshot().clone();
    let terminal = db(
        handle,
        deadline,
        execution::advance_checkpoint(
            pool,
            actor,
            fence,
            snapshot.phase,
            snapshot.revision,
            CheckpointTransition::ObservePiProviderTerminal {
                session_id: receipt.session_id().to_owned(),
                entry_id: receipt.input_entry_id().to_owned(),
                next_leaf_id: receipt.leaf_id().to_owned(),
            },
        ),
    );
    let Some(_) = resolve_terminal_stop_race(terminal, &mut stop_poll, deadline)? else {
        return Ok(stop_poll.stop().cloned());
    };
    Ok(None)
}

/// A 409 during a pre-input transition can mean the operator committed Stop
/// between the previous poll and this database write. Resolve that race by
/// reading and binding the durable Stop; never infer it from an HTTP status
/// alone.
fn resolve_preinput_stop_race<T>(
    result: ExecResult<T>,
    stop_poll: &mut PiStopPoll<'_>,
    deadline: Instant,
) -> ExecResult<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if is_conflict(&error) => {
            if stop_poll.poll(deadline, true) {
                stop_poll.take_poll_error()?;
                if stop_poll.stop().is_some() {
                    return Ok(None);
                }
            }
            Err(error)
        }
        Err(error) => Err(error),
    }
}

/// Resolve Stop that races with a normal Pi terminal checkpoint. The exact
/// provider receipt already exists, so a proven Stop routes it through the Pi
/// stopped finalizer and skips any further normal checkpoint writes.
fn resolve_terminal_stop_race<T>(
    result: ExecResult<T>,
    stop_poll: &mut PiStopPoll<'_>,
    deadline: Instant,
) -> ExecResult<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if is_conflict(&error) => {
            if stop_poll.poll(deadline, true) {
                stop_poll.take_poll_error()?;
                if stop_poll.stop().is_some() {
                    return Ok(None);
                }
            }
            Err(error)
        }
        Err(error) => Err(error),
    }
}

fn is_conflict(error: &Error) -> bool {
    matches!(
        error,
        Error::Persistence(runtime_bindings::Error::Http(409, _))
    )
}

struct PiStopPoll<'a> {
    handle: &'a Handle,
    pool: &'a PgPool,
    actor: &'a NativeChatExecutionPrincipal,
    fence: &'a ExecutionFence,
    connection: ConnectionReceipt,
    stop: Option<StopIntent>,
    stop_checked: Option<Instant>,
    lease_renewed: Instant,
    poll_error: Option<Error>,
}

impl<'a> PiStopPoll<'a> {
    fn new(
        handle: &'a Handle,
        pool: &'a PgPool,
        actor: &'a NativeChatExecutionPrincipal,
        fence: &'a ExecutionFence,
        connection: ConnectionReceipt,
    ) -> Self {
        Self {
            handle,
            pool,
            actor,
            fence,
            connection,
            stop: None,
            stop_checked: None,
            lease_renewed: Instant::now(),
            poll_error: None,
        }
    }

    fn new_for_cleanup(
        handle: &'a Handle,
        pool: &'a PgPool,
        actor: &'a NativeChatExecutionPrincipal,
        fence: &'a ExecutionFence,
        connection: ConnectionReceipt,
    ) -> Self {
        let mut poll = Self::new(handle, pool, actor, fence, connection);
        // Cleanup starts with a renewal due immediately: the provider turn may
        // have consumed most of either lease before host shutdown begins.
        poll.lease_renewed = Instant::now()
            .checked_sub(LEASE_RENEW_INTERVAL)
            .unwrap_or_else(Instant::now);
        poll
    }

    fn seed_bound_stop(&mut self, stop: StopIntent) {
        self.stop = Some(stop);
    }

    /// Maintain D1 authority during the process host's bounded cleanup wait.
    /// This path intentionally only observes/binds Stop and renews leases; it
    /// never dispatches Abort after provider-terminal evidence exists.
    fn cleanup_tick(&mut self, force: bool) {
        let operation_deadline = cleanup_operation_deadline();
        let now = Instant::now();
        let should_observe = force
            || self.stop_checked.is_none_or(|last| {
                now.saturating_duration_since(last) >= CLEANUP_AUTHORITY_POLL_INTERVAL
            });
        if should_observe && self.stop.is_none() {
            self.observe_cleanup_stop(operation_deadline);
        }

        let now = Instant::now();
        if force || now.saturating_duration_since(self.lease_renewed) >= LEASE_RENEW_INTERVAL {
            // Throttle failed lease renewals to the cleanup polling interval;
            // do not let a transient D1 error turn this into a request loop.
            let result = if let Some(stop) = &self.stop {
                db(
                    self.handle,
                    operation_deadline,
                    execution::renew_stopping_lease(self.pool, self.actor, self.fence, stop),
                )
            } else {
                db(
                    self.handle,
                    operation_deadline,
                    execution::renew_lease(self.pool, self.actor, self.fence),
                )
            };
            match result {
                Ok(_) => self.lease_renewed = Instant::now(),
                Err(error) if self.stop.is_none() && is_conflict(&error) => {
                    self.observe_cleanup_stop(operation_deadline);
                    if let Some(stop) = &self.stop {
                        match db(
                            self.handle,
                            operation_deadline,
                            execution::renew_stopping_lease(
                                self.pool, self.actor, self.fence, stop,
                            ),
                        ) {
                            Ok(_) => self.lease_renewed = Instant::now(),
                            Err(error) => {
                                self.remember_cleanup_error(error);
                                self.retry_cleanup_renewal_soon();
                            }
                        }
                    } else {
                        self.remember_cleanup_error(error);
                        self.retry_cleanup_renewal_soon();
                    }
                }
                Err(error) => {
                    self.remember_cleanup_error(error);
                    self.retry_cleanup_renewal_soon();
                }
            }
        }
    }

    fn observe_cleanup_stop(&mut self, deadline: Instant) {
        self.stop_checked = Some(Instant::now());
        match db(
            self.handle,
            deadline,
            execution::observe_stop(self.pool, self.actor, self.fence),
        ) {
            Ok(Some(stop)) => self.register_stop(stop, deadline),
            Ok(None) => (),
            Err(error) => self.remember_cleanup_error(error),
        }
    }

    fn remember_cleanup_error(&mut self, error: Error) {
        if self.poll_error.is_none() {
            self.poll_error = Some(error);
        }
    }

    fn retry_cleanup_renewal_soon(&mut self) {
        let backdate = LEASE_RENEW_INTERVAL.saturating_sub(CLEANUP_AUTHORITY_POLL_INTERVAL);
        self.lease_renewed = Instant::now()
            .checked_sub(backdate)
            .unwrap_or_else(Instant::now);
    }

    /// Called from the bounded Pi receive loop. `true` asks the provider wait
    /// to return control so the caller can reserve the one-use Abort permit.
    /// It is also true after a persistence error, which is surfaced once the
    /// in-flight RPC has been reconciled.
    fn poll(&mut self, deadline: Instant, force: bool) -> bool {
        if self.poll_error.is_some() {
            return true;
        }
        let now = Instant::now();
        if force
            || self
                .stop_checked
                .is_none_or(|last| now.saturating_duration_since(last) >= STOP_POLL_INTERVAL)
        {
            if self.stop.is_none() {
                match db(
                    self.handle,
                    deadline,
                    execution::observe_stop(self.pool, self.actor, self.fence),
                ) {
                    Ok(Some(stop)) => self.register_stop(stop, deadline),
                    Ok(None) => (),
                    Err(error) => self.poll_error = Some(error),
                }
            }
            self.stop_checked = Some(now);
        }
        if self.poll_error.is_none()
            && Instant::now().saturating_duration_since(self.lease_renewed) >= LEASE_RENEW_INTERVAL
        {
            let renewal = if let Some(stop) = &self.stop {
                db(
                    self.handle,
                    deadline,
                    execution::renew_stopping_lease(self.pool, self.actor, self.fence, stop),
                )
            } else {
                db(
                    self.handle,
                    deadline,
                    execution::renew_lease(self.pool, self.actor, self.fence),
                )
            };
            match renewal {
                Ok(_) => self.lease_renewed = Instant::now(),
                Err(error)
                    if self.stop.is_none()
                        && matches!(
                            &error,
                            Error::Persistence(runtime_bindings::Error::Http(409, _))
                        ) =>
                {
                    match db(
                        self.handle,
                        deadline,
                        execution::observe_stop(self.pool, self.actor, self.fence),
                    ) {
                        Ok(Some(stop)) => {
                            self.register_stop(stop, deadline);
                            if let Some(stop) = &self.stop {
                                match db(
                                    self.handle,
                                    deadline,
                                    execution::renew_stopping_lease(
                                        self.pool, self.actor, self.fence, stop,
                                    ),
                                ) {
                                    Ok(_) => self.lease_renewed = Instant::now(),
                                    Err(error) => self.poll_error = Some(error),
                                }
                            }
                        }
                        Ok(None) => self.poll_error = Some(error),
                        Err(observe_error) => self.poll_error = Some(observe_error),
                    }
                }
                Err(error) => self.poll_error = Some(error),
            }
        }
        self.stop.is_some() || self.poll_error.is_some()
    }

    fn register_stop(&mut self, stop: StopIntent, deadline: Instant) {
        match db(
            self.handle,
            deadline,
            execution::bind_stopping_connection(
                self.pool,
                self.actor,
                self.fence,
                &stop,
                &self.connection,
            ),
        ) {
            Ok(()) => self.stop = Some(stop),
            Err(error) => self.remember_cleanup_error(error),
        }
    }

    fn stop(&self) -> Option<&StopIntent> {
        self.stop.as_ref()
    }

    fn take_poll_error(&mut self) -> ExecResult<()> {
        match self.poll_error.take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn remaining_timeout(deadline: Instant, max: Duration) -> ExecResult<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now()).min(max);
    if remaining.is_zero() {
        Err(Error::Deadline)
    } else {
        Ok(remaining)
    }
}

fn cleanup_operation_deadline() -> Instant {
    Instant::now() + CLEANUP_AUTHORITY_TIMEOUT
}

/// Provider state that can be safely handed to the shared Native worker.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PiExecutionPhase {
    /// The owned process exists and passed the process-host spawn barrier.
    Spawned,
    /// Pi reported a native identity and exact managed file location. A new
    /// session may remain unflushed until its first assistant message.
    SessionReady,
    /// Pi accepted one input RPC. This is not a provider terminal result.
    InputAccepted,
    /// Pi emitted `agent_start` for the accepted input.
    AgentRunning,
    /// Pi emitted `agent_end`; settlement still needs a separate proof.
    AgentEnded,
    /// Pi emitted `agent_settled`, or the legacy idle/queue proof passed.
    Settled,
    /// The owned process-host cleanup receipt was observed.
    Cleaned,
    /// The provider state cannot safely be promoted to a terminal result.
    Unknown,
}

impl PiExecutionPhase {
    /// `Settled` is the only provider completion phase. `Cleaned` proves host
    /// quiescence, not that Pi produced a terminal turn.
    pub const fn is_provider_terminal(self) -> bool {
        matches!(self, Self::Settled)
    }

    pub const fn is_unknown(self) -> bool {
        matches!(self, Self::Unknown)
    }
}

/// Reasons the adapter refuses to promote a low-level Pi observation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PiUnknownReason {
    CommandRejected,
    MalformedState,
    SessionPathUnavailable,
    AgentSettledBeforeAgentEnd,
    AgentEndedWithoutSettlement,
    ExtensionError,
    CleanupNotProven,
}

impl PiUnknownReason {
    /// Bounded, payload-free classification for diagnostics.
    pub const fn diagnostic_code(self) -> &'static str {
        match self {
            Self::CommandRejected => "pi_command_rejected",
            Self::MalformedState => "pi_malformed_state",
            Self::SessionPathUnavailable => "pi_session_path_unavailable",
            Self::AgentSettledBeforeAgentEnd => "pi_agent_settled_before_agent_end",
            Self::AgentEndedWithoutSettlement => "pi_agent_ended_without_settlement",
            Self::ExtensionError => "pi_extension_error",
            Self::CleanupNotProven => "pi_cleanup_not_proven",
        }
    }
}

/// Bounded `get_state` data. The raw response is intentionally not retained.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PiStateSnapshot {
    session_id: String,
    session_file: PathBuf,
    session_file_persisted: bool,
    is_streaming: Option<bool>,
    is_compacting: Option<bool>,
    pending_message_count: Option<u64>,
    message_count: Option<u64>,
}

impl PiStateSnapshot {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn session_file(&self) -> &Path {
        &self.session_file
    }

    pub fn session_file_persisted(&self) -> bool {
        self.session_file_persisted
    }

    pub fn is_streaming(&self) -> Option<bool> {
        self.is_streaming
    }

    pub fn is_compacting(&self) -> Option<bool> {
        self.is_compacting
    }

    pub fn pending_message_count(&self) -> Option<u64> {
        self.pending_message_count
    }

    pub fn message_count(&self) -> Option<u64> {
        self.message_count
    }

    fn proves_idle_queue(&self) -> bool {
        self.session_file_persisted
            && self.is_streaming == Some(false)
            && self.is_compacting == Some(false)
            && self.pending_message_count == Some(0)
    }
}

/// All provider observations collected by one owned Pi execution.
pub struct PiExecutionObservation {
    pub phase: PiExecutionPhase,
    pub unknown_reason: Option<PiUnknownReason>,
    pub state: Option<PiStateSnapshot>,
    pub input_request_id: Option<String>,
    pub turn_receipt: Option<PiTurnReceipt>,
    pub cleanup_receipt: Option<PiCleanupReceipt>,
}

impl std::fmt::Debug for PiExecutionObservation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PiExecutionObservation")
            .field("phase", &self.phase)
            .field("unknown_reason", &self.unknown_reason)
            .field("has_state", &self.state.is_some())
            .field("has_input_request_id", &self.input_request_id.is_some())
            .field("has_turn_receipt", &self.turn_receipt.is_some())
            .field("has_cleanup_receipt", &self.cleanup_receipt.is_some())
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PiAdapterError {
    #[error(transparent)]
    Transport(#[from] PiTransportError),
    #[error(transparent)]
    SessionTree(#[from] PiSessionTreeError),
    #[error("Pi RPC command {command} was rejected")]
    CommandRejected { command: String },
    #[error("Pi adapter operation deadline expired")]
    Deadline,
    #[error("Pi provider observation was inconclusive")]
    UnknownObservation(PiUnknownReason),
    #[error("Pi adapter is not ready for this operation")]
    InvalidPhase,
    #[error("Pi session path is outside the managed session directory")]
    InvalidSessionPath,
}

/// Launch failures can occur after the process host has already emitted its
/// correlated terminal receipt. Keep that opaque cleanup evidence attached to
/// the original launch error so the D1 worker can apply its normal fenced
/// pre-submission Stop path without inferring provider input acceptance.
struct PiLaunchFailure {
    error: PiAdapterError,
    cleanup_receipt: Option<PiCleanupReceipt>,
}

impl PiLaunchFailure {
    fn new(error: PiAdapterError, cleanup_receipt: Option<PiCleanupReceipt>) -> Self {
        Self {
            error,
            cleanup_receipt,
        }
    }
}

impl std::fmt::Debug for PiLaunchFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PiLaunchFailure")
            .field("diagnostic_code", &self.error.diagnostic_code())
            .field("has_cleanup_receipt", &self.cleanup_receipt.is_some())
            .finish()
    }
}

impl PiAdapterError {
    pub(crate) fn diagnostic_code(&self) -> &'static str {
        match self {
            Self::Transport(error) => error.diagnostic_code(),
            Self::SessionTree(_) => "pi_session_tree",
            Self::CommandRejected { .. } => "pi_command_rejected",
            Self::Deadline => "pi_deadline",
            Self::UnknownObservation(reason) => reason.diagnostic_code(),
            Self::InvalidPhase => "pi_invalid_phase",
            Self::InvalidSessionPath => "pi_invalid_session_path",
        }
    }
}

/// One owned Pi process and its provider-specific lifecycle reducer.
pub struct PiExecution {
    transport: PiRpcTransport,
    session_dir: PathBuf,
    phase: PiExecutionPhase,
    unknown_reason: Option<PiUnknownReason>,
    state: Option<PiStateSnapshot>,
    input_request_id: Option<String>,
    agent_started: bool,
    agent_ended: bool,
    agent_settled: bool,
    turn_receipt: Option<PiTurnReceipt>,
    cleanup_receipt: Option<PiCleanupReceipt>,
}

impl PiExecution {
    /// Launch Pi through the already-authorized one-use process-host permit.
    /// No database state is touched by this constructor.
    pub fn launch(
        launch: ProcessLaunch,
        permit: ConnectionLaunchPermit,
        timeout: Duration,
    ) -> Result<Self, PiAdapterError> {
        Self::launch_with_cleanup(launch, permit, timeout).map_err(|failure| failure.error)
    }

    fn launch_with_cleanup(
        launch: ProcessLaunch,
        permit: ConnectionLaunchPermit,
        timeout: Duration,
    ) -> Result<Self, PiLaunchFailure> {
        let session_dir = canonical_session_dir(&launch.session_dir)
            .map_err(|error| PiLaunchFailure::new(error, None))?;
        let mut transport = PiRpcTransport::launch(launch, permit)
            .map_err(PiAdapterError::from)
            .map_err(|error| PiLaunchFailure::new(error, None))?;
        if let Err(error) = transport.wait_spawned(timeout) {
            let cleanup_receipt = transport.take_cleanup_receipt();
            return Err(PiLaunchFailure::new(error.into(), cleanup_receipt));
        }
        Ok(Self {
            transport,
            session_dir,
            phase: PiExecutionPhase::Spawned,
            unknown_reason: None,
            state: None,
            input_request_id: None,
            agent_started: false,
            agent_ended: false,
            agent_settled: false,
            turn_receipt: None,
            cleanup_receipt: None,
        })
    }

    pub fn phase(&self) -> PiExecutionPhase {
        self.phase
    }

    pub fn unknown_reason(&self) -> Option<PiUnknownReason> {
        self.unknown_reason
    }

    pub fn state(&self) -> Option<&PiStateSnapshot> {
        self.state.as_ref()
    }

    pub fn input_request_id(&self) -> Option<&str> {
        self.input_request_id.as_deref()
    }

    pub fn turn_receipt(&self) -> Option<&PiTurnReceipt> {
        self.turn_receipt.as_ref()
    }

    fn connection_receipt(&self) -> ConnectionReceipt {
        self.transport.connection_receipt()
    }

    /// Read and validate the exact native state. A rejected command is an
    /// explicit Unknown observation instead of a fabricated empty Session.
    pub fn get_state(&mut self, timeout: Duration) -> Result<PiExecutionPhase, PiAdapterError> {
        self.read_state(timeout, false)
    }

    fn get_state_with_hook(
        &mut self,
        timeout: Duration,
        hook: &mut impl FnMut() -> bool,
    ) -> Result<(PiExecutionPhase, bool), PiAdapterError> {
        self.read_state_with_hook(timeout, false, hook)
    }

    fn read_state(
        &mut self,
        timeout: Duration,
        newly_created: bool,
    ) -> Result<PiExecutionPhase, PiAdapterError> {
        self.read_state_with_hook(timeout, newly_created, &mut || false)
            .map(|(phase, _)| phase)
    }

    fn read_state_with_hook(
        &mut self,
        timeout: Duration,
        newly_created: bool,
        hook: &mut impl FnMut() -> bool,
    ) -> Result<(PiExecutionPhase, bool), PiAdapterError> {
        let (response, stop_observed) =
            self.command_response_with_hook(PiCommand::GetState, timeout, hook)?;
        if !response.success() {
            self.mark_unknown(PiUnknownReason::CommandRejected);
            return Ok((self.phase, stop_observed));
        }
        let state = match if newly_created {
            parse_new_session_state(response.data(), &self.session_dir)
        } else {
            parse_state(response.data(), &self.session_dir)
        } {
            Ok(state) => state,
            Err(reason) => {
                self.mark_unknown(reason);
                return Ok((self.phase, stop_observed));
            }
        };
        self.transport.bind_session_state(
            state.session_id(),
            state.session_file(),
            state.session_file_persisted(),
        )?;
        self.state = Some(state);
        if !matches!(
            self.phase,
            PiExecutionPhase::InputAccepted
                | PiExecutionPhase::AgentRunning
                | PiExecutionPhase::AgentEnded
                | PiExecutionPhase::Settled
                | PiExecutionPhase::Cleaned
        ) {
            self.phase = PiExecutionPhase::SessionReady;
        }
        Ok((self.phase, stop_observed))
    }

    /// Switch to the exact persisted session file, then re-read state. The
    /// caller cannot point Pi at a different directory or a symlinked file.
    pub fn resume_session(
        &mut self,
        session_file: &Path,
        timeout: Duration,
    ) -> Result<PiExecutionPhase, PiAdapterError> {
        self.resume_session_with_hook(session_file, timeout, &mut || false)
            .map(|(phase, _)| phase)
    }

    fn resume_session_with_hook(
        &mut self,
        session_file: &Path,
        timeout: Duration,
        hook: &mut impl FnMut() -> bool,
    ) -> Result<(PiExecutionPhase, bool), PiAdapterError> {
        let session_file = validate_session_file(session_file, &self.session_dir)?;
        let (response, stop_observed) = self.command_response_with_hook(
            PiCommand::SwitchSession(&session_file.to_string_lossy()),
            timeout,
            hook,
        )?;
        if !response.success() {
            self.mark_unknown(PiUnknownReason::CommandRejected);
            return Ok((self.phase, stop_observed));
        }
        let (phase, state_stop_observed) = self.get_state_with_hook(timeout, hook)?;
        Ok((phase, stop_observed || state_stop_observed))
    }

    /// Ask Pi to create a native Session and re-read its identity. This is
    /// intentionally separate from `launch`: a process may already have a
    /// provider-created Session that must be resumed instead.
    pub fn new_session(&mut self, timeout: Duration) -> Result<PiExecutionPhase, PiAdapterError> {
        self.new_session_with_hook(timeout, &mut || false)
            .map(|(phase, _)| phase)
    }

    fn new_session_with_hook(
        &mut self,
        timeout: Duration,
        hook: &mut impl FnMut() -> bool,
    ) -> Result<(PiExecutionPhase, bool), PiAdapterError> {
        let (response, stop_observed) =
            self.command_response_with_hook(PiCommand::NewSession, timeout, hook)?;
        if !response.success() {
            self.mark_unknown(PiUnknownReason::CommandRejected);
            return Ok((self.phase, stop_observed));
        }
        let (phase, state_stop_observed) = self.read_state_with_hook(timeout, true, hook)?;
        Ok((phase, stop_observed || state_stop_observed))
    }

    /// Submit exactly one input. The returned request id only correlates the
    /// RPC response; it never serves as a durable deduplication key.
    pub fn submit_input(
        &mut self,
        input: &str,
        timeout: Duration,
    ) -> Result<PiExecutionPhase, PiAdapterError> {
        self.submit_input_with_hook(input, timeout, &mut || false)
            .map(|(phase, _)| phase)
    }

    fn submit_input_with_hook(
        &mut self,
        input: &str,
        timeout: Duration,
        hook: &mut impl FnMut() -> bool,
    ) -> Result<(PiExecutionPhase, bool), PiAdapterError> {
        if input.is_empty() || !matches!(self.phase, PiExecutionPhase::SessionReady) {
            return Err(PiAdapterError::InvalidPhase);
        }
        // Bind lifecycle observations to the one prompt before waiting for its
        // preflight response. Pi may emit run events while that response is
        // pending; command_response consumes those events from the same RPC
        // stream, so initializing after it returns would lose valid evidence.
        let request_id = self.transport.request(PiCommand::Prompt(input))?;
        self.input_request_id = Some(request_id.clone());
        self.agent_started = false;
        self.agent_ended = false;
        self.agent_settled = false;
        self.phase = PiExecutionPhase::InputAccepted;

        let (response, stop_observed) =
            self.response_for_request_with_hook(&request_id, timeout, hook)?;
        if !response.success() {
            self.mark_unknown(PiUnknownReason::CommandRejected);
            return Ok((self.phase, stop_observed));
        }
        Ok((self.phase, stop_observed))
    }

    /// Send a single native abort for this accepted prompt. The transport
    /// consumes its attempt marker before writing, so ambiguous delivery is
    /// never retried on the same provider connection. The response is only an
    /// acknowledgement; callers must still wait for Pi's exact terminal tree.
    fn abort(&mut self, timeout: Duration) -> Result<(), PiAdapterError> {
        if self.input_request_id.is_none()
            || self.agent_ended
            || !matches!(
                self.phase,
                PiExecutionPhase::InputAccepted | PiExecutionPhase::AgentRunning
            )
        {
            return Err(PiAdapterError::InvalidPhase);
        }
        let response = self.command_response(PiCommand::Abort, timeout)?;
        if !response.success() {
            return Err(PiAdapterError::CommandRejected {
                command: "abort".to_owned(),
            });
        }
        Ok(())
    }

    fn agent_ended(&self) -> bool {
        self.agent_ended
    }

    /// Wait for provider settlement, preserving the distinction between
    /// low-level `agent_end` and the complete `agent_settled`/idle proof.
    pub fn wait_until_settled(
        &mut self,
        timeout: Duration,
    ) -> Result<PiExecutionPhase, PiAdapterError> {
        self.wait_until_settled_with_hook(timeout, &mut || false)
            .map(|(phase, _)| phase)
    }

    fn wait_until_settled_with_hook(
        &mut self,
        timeout: Duration,
        hook: &mut impl FnMut() -> bool,
    ) -> Result<(PiExecutionPhase, bool), PiAdapterError> {
        if !matches!(
            self.phase,
            PiExecutionPhase::InputAccepted
                | PiExecutionPhase::AgentRunning
                | PiExecutionPhase::AgentEnded
        ) {
            return Err(PiAdapterError::InvalidPhase);
        }
        let deadline = Instant::now() + timeout;
        let mut stop_observed = false;
        let mut next_hook = Instant::now();
        while Instant::now() < deadline {
            if Instant::now() >= next_hook {
                stop_observed |= hook();
                next_hook = Instant::now() + STOP_POLL_INTERVAL;
            }
            if stop_observed {
                // The prompt response may have been parsed in the same host
                // frame as lifecycle events. Reconcile the bounded in-memory
                // queue before deciding that the provider is still active;
                // otherwise a queued agent_end could trigger a needless Abort.
                self.drain_available_events()?;
            }
            if stop_observed && !self.agent_ended {
                // The caller owns the D1 permit and will issue one Abort on
                // this same connection. The Stop signal itself is not a
                // provider terminal observation.
                return Ok((self.phase, true));
            }
            if self.agent_settled {
                if !self.agent_ended {
                    self.mark_unknown(PiUnknownReason::AgentSettledBeforeAgentEnd);
                    return Ok((self.phase, stop_observed));
                }
                // The pre-prompt state may name an unflushed session. Require
                // a new strict observation after terminal events, which also
                // binds the same native file as persisted in the transport.
                let (state_phase, state_stop) =
                    self.get_state_with_hook(remaining(deadline), hook)?;
                stop_observed |= state_stop;
                if state_phase == PiExecutionPhase::Unknown {
                    return Ok((self.phase, stop_observed));
                }
                if self
                    .state
                    .as_ref()
                    .is_some_and(PiStateSnapshot::proves_idle_queue)
                    && self.phase != PiExecutionPhase::Unknown
                {
                    self.phase = PiExecutionPhase::Settled;
                    return Ok((self.phase, stop_observed));
                }
                self.mark_unknown(PiUnknownReason::MalformedState);
                return Ok((self.phase, stop_observed));
            }
            if self.agent_ended {
                // Pi 0.76 emits agent_end before its awaited lifecycle
                // listeners have settled, and documents agent_end as the last
                // event for a run. A single active get_state followed by a
                // wait for another event can therefore lose the wakeup. Poll
                // only the read-only state command until idle proof or the
                // existing execution deadline; never resubmit the prompt.
                let (state_phase, state_stop) =
                    self.get_state_with_hook(remaining(deadline).min(RPC_TIMEOUT), hook)?;
                stop_observed |= state_stop;
                if state_phase == PiExecutionPhase::Unknown {
                    return Ok((state_phase, stop_observed));
                }
                if self
                    .state
                    .as_ref()
                    .is_some_and(PiStateSnapshot::proves_idle_queue)
                {
                    self.phase = PiExecutionPhase::Settled;
                    return Ok((self.phase, stop_observed));
                }
                if self.agent_settled
                    || !self.state.as_ref().is_some_and(|state| {
                        state.is_streaming.is_some()
                            && state.is_compacting.is_some()
                            && state.pending_message_count.is_some()
                    })
                {
                    self.mark_unknown(PiUnknownReason::MalformedState);
                    return Ok((self.phase, stop_observed));
                }
                let pause = remaining(deadline).min(SETTLEMENT_POLL_INTERVAL);
                if pause.is_zero() {
                    break;
                }
                std::thread::sleep(pause);
                continue;
            }
            let until_hook = next_hook.saturating_duration_since(Instant::now());
            let receive_timeout = remaining(deadline).min(until_hook);
            let message = match self.transport.receive(receive_timeout) {
                Ok(message) => message,
                Err(PiTransportError::Timeout) if Instant::now() < deadline => continue,
                Err(PiTransportError::Timeout) => break,
                Err(error) => return Err(error.into()),
            };
            match message {
                PiRpcMessage::Response(_) => {
                    // A response for a command issued by this adapter is
                    // consumed by command_response. Seeing one here means the
                    // protocol ordering is no longer attributable.
                    return Err(PiAdapterError::Transport(
                        PiTransportError::MismatchedResponse,
                    ));
                }
                PiRpcMessage::Event(event) => self.observe_event(&event),
            }
        }
        self.mark_unknown(PiUnknownReason::AgentEndedWithoutSettlement);
        Ok((self.phase, stop_observed))
    }

    fn drain_available_events(&mut self) -> Result<(), PiAdapterError> {
        for _ in 0..128 {
            match self.transport.receive(Duration::ZERO) {
                Ok(PiRpcMessage::Event(event)) => self.observe_event(&event),
                Ok(PiRpcMessage::Response(_)) => {
                    return Err(PiAdapterError::Transport(
                        PiTransportError::MismatchedResponse,
                    ));
                }
                Err(PiTransportError::Timeout) => return Ok(()),
                Err(error) => return Err(error.into()),
            }
        }
        match self.transport.receive(Duration::ZERO) {
            Err(PiTransportError::Timeout) => Ok(()),
            Ok(_) | Err(_) => Err(PiAdapterError::Transport(PiTransportError::OutputOverflow)),
        }
    }

    /// Read the exact persisted Session tree and mint the provider-native
    /// receipt. The adapter never turns Pi ids into Codex Thread/Turn ids.
    pub fn take_turn_receipt(
        &mut self,
        prior_leaf_id: Option<&str>,
        input_text: &str,
    ) -> Result<(), PiAdapterError> {
        if !self.phase.is_provider_terminal() {
            return Err(PiAdapterError::InvalidPhase);
        }
        let state = self.state.as_ref().ok_or(PiAdapterError::InvalidPhase)?;
        let tree = PiSessionTree::read(&state.session_file, &self.session_dir)?;
        let receipt = self
            .transport
            .take_turn_receipt(&tree, prior_leaf_id, input_text)?;
        self.turn_receipt = Some(receipt);
        Ok(())
    }

    /// Stop the exact owned process and retain cleanup only when the host
    /// emitted its matching terminal receipt.
    pub fn cleanup(&mut self, timeout: Duration) -> Result<PiExecutionPhase, PiAdapterError> {
        self.cleanup_with_grace(Duration::from_millis(500), timeout)
    }

    pub fn cleanup_with_grace(
        &mut self,
        grace: Duration,
        timeout: Duration,
    ) -> Result<PiExecutionPhase, PiAdapterError> {
        self.cleanup_with_grace_and_hook(grace, timeout, &mut || {})
    }

    pub fn cleanup_with_grace_and_hook(
        &mut self,
        grace: Duration,
        timeout: Duration,
        hook: &mut impl FnMut(),
    ) -> Result<PiExecutionPhase, PiAdapterError> {
        let stop_result = self
            .transport
            .stop_with_grace_and_hook(grace, timeout, hook);
        if let Some(receipt) = self.transport.take_cleanup_receipt() {
            self.cleanup_receipt = Some(receipt);
            self.phase = PiExecutionPhase::Cleaned;
            return Ok(self.phase);
        }
        self.mark_unknown(PiUnknownReason::CleanupNotProven);
        stop_result?;
        Ok(self.phase)
    }

    pub fn into_observation(self) -> PiExecutionObservation {
        PiExecutionObservation {
            phase: self.phase,
            unknown_reason: self.unknown_reason,
            state: self.state,
            input_request_id: self.input_request_id,
            turn_receipt: self.turn_receipt,
            cleanup_receipt: self.cleanup_receipt,
        }
    }

    fn command_response(
        &mut self,
        command: PiCommand<'_>,
        timeout: Duration,
    ) -> Result<PiResponse, PiAdapterError> {
        self.command_response_with_hook(command, timeout, &mut || false)
            .map(|(response, _)| response)
    }

    fn command_response_with_hook(
        &mut self,
        command: PiCommand<'_>,
        timeout: Duration,
        hook: &mut impl FnMut() -> bool,
    ) -> Result<(PiResponse, bool), PiAdapterError> {
        let request_id = self.transport.request(command)?;
        self.response_for_request_with_hook(&request_id, timeout, hook)
    }

    fn response_for_request_with_hook(
        &mut self,
        request_id: &str,
        timeout: Duration,
        hook: &mut impl FnMut() -> bool,
    ) -> Result<(PiResponse, bool), PiAdapterError> {
        let deadline = Instant::now() + timeout;
        let mut stop_observed = false;
        let mut next_hook = Instant::now();
        loop {
            if Instant::now() >= next_hook {
                stop_observed |= hook();
                next_hook = Instant::now() + STOP_POLL_INTERVAL;
            }
            let receive_timeout =
                remaining(deadline).min(next_hook.saturating_duration_since(Instant::now()));
            let message = match self.transport.receive(receive_timeout) {
                Ok(message) => message,
                Err(PiTransportError::Timeout) if Instant::now() < deadline => continue,
                Err(error) => return Err(error.into()),
            };
            match message {
                PiRpcMessage::Response(response) if response.id() == request_id => {
                    return Ok((response, stop_observed));
                }
                PiRpcMessage::Response(_) => {
                    return Err(PiAdapterError::Transport(
                        PiTransportError::MismatchedResponse,
                    ));
                }
                PiRpcMessage::Event(event) => self.observe_event(&event),
            }
        }
    }

    fn observe_event(&mut self, event: &PiEvent) {
        match event.kind() {
            "agent_start" if self.input_request_id.is_some() => {
                self.agent_started = true;
                self.phase = PiExecutionPhase::AgentRunning;
            }
            "agent_end" if self.agent_started => {
                self.agent_ended = true;
                self.phase = PiExecutionPhase::AgentEnded;
            }
            "agent_settled" if self.agent_ended => {
                self.agent_settled = true;
            }
            "agent_settled" => self.mark_unknown(PiUnknownReason::AgentSettledBeforeAgentEnd),
            "extension_error" => self.mark_unknown(PiUnknownReason::ExtensionError),
            _ => {}
        }
    }

    fn mark_unknown(&mut self, reason: PiUnknownReason) {
        self.phase = PiExecutionPhase::Unknown;
        self.unknown_reason = Some(reason);
    }
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

fn canonical_session_dir(path: &Path) -> Result<PathBuf, PiAdapterError> {
    let canonical = path
        .canonicalize()
        .map_err(|_| PiAdapterError::InvalidSessionPath)?;
    if !canonical.is_dir() {
        return Err(PiAdapterError::InvalidSessionPath);
    }
    Ok(canonical)
}

fn validate_session_file(path: &Path, session_dir: &Path) -> Result<PathBuf, PiAdapterError> {
    let canonical = path
        .canonicalize()
        .map_err(|_| PiAdapterError::InvalidSessionPath)?;
    if !canonical.is_file() || canonical.parent() != Some(session_dir) {
        return Err(PiAdapterError::InvalidSessionPath);
    }
    Ok(canonical)
}

fn parse_state(
    data: Option<&Value>,
    session_dir: &Path,
) -> Result<PiStateSnapshot, PiUnknownReason> {
    parse_state_with_new_file(data, session_dir, false)
}

fn parse_new_session_state(
    data: Option<&Value>,
    session_dir: &Path,
) -> Result<PiStateSnapshot, PiUnknownReason> {
    parse_state_with_new_file(data, session_dir, true)
}

fn parse_state_with_new_file(
    data: Option<&Value>,
    session_dir: &Path,
    newly_created: bool,
) -> Result<PiStateSnapshot, PiUnknownReason> {
    let object = data
        .and_then(Value::as_object)
        .ok_or(PiUnknownReason::MalformedState)?;
    let session_id = object
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= MAX_SESSION_ID_BYTES
                && !value.chars().any(char::is_control)
        })
        .ok_or(PiUnknownReason::MalformedState)?
        .to_owned();
    let session_file = object
        .get("sessionFile")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or(PiUnknownReason::SessionPathUnavailable)?;
    let session_file_persisted = match std::fs::symlink_metadata(&session_file) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => true,
        Err(error)
            if newly_created
                && error.kind() == std::io::ErrorKind::NotFound
                && session_file.is_absolute()
                && session_file.parent() == Some(session_dir)
                && !session_file
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
                && session_file
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.len() <= 512 && name.ends_with(&format!("_{session_id}.jsonl"))
                    })
                && object.get("isStreaming").and_then(Value::as_bool) == Some(false)
                && object.get("isCompacting").and_then(Value::as_bool) == Some(false)
                && object.get("pendingMessageCount").and_then(Value::as_u64) == Some(0)
                && object.get("messageCount").and_then(Value::as_u64) == Some(0) =>
        {
            false
        }
        _ => return Err(PiUnknownReason::SessionPathUnavailable),
    };
    let session_file = if session_file_persisted {
        let canonical = session_file
            .canonicalize()
            .map_err(|_| PiUnknownReason::SessionPathUnavailable)?;
        if canonical.parent() != Some(session_dir) {
            return Err(PiUnknownReason::SessionPathUnavailable);
        }
        canonical
    } else {
        // Pi allocated this path and identity; Rudder must not synthesize a
        // native header or treat it as resumable/persisted before Pi flushes.
        session_file
    };
    let optional_bool = |name: &str| {
        object
            .get(name)
            .map(|value| value.as_bool().ok_or(PiUnknownReason::MalformedState))
            .transpose()
    };
    let optional_u64 = |name: &str| {
        object
            .get(name)
            .map(|value| value.as_u64().ok_or(PiUnknownReason::MalformedState))
            .transpose()
    };
    Ok(PiStateSnapshot {
        session_id,
        session_file,
        session_file_persisted,
        is_streaming: optional_bool("isStreaming")?,
        is_compacting: optional_bool("isCompacting")?,
        pending_message_count: optional_u64("pendingMessageCount")?,
        message_count: optional_u64("messageCount")?,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        PiAdapterError, PiExecutionPhase, PiUnknownReason, parse_new_session_state, parse_state,
    };
    use serde_json::json;
    use std::fs;

    #[test]
    fn inconclusive_provider_diagnostics_preserve_only_safe_reason_code() {
        let error =
            PiAdapterError::UnknownObservation(PiUnknownReason::AgentEndedWithoutSettlement);
        assert_eq!(error.diagnostic_code(), "pi_agent_ended_without_settlement");
        assert_eq!(
            error.to_string(),
            "Pi provider observation was inconclusive"
        );
    }

    #[test]
    fn state_parser_requires_an_exact_managed_session_file() {
        let dir = tempfile::tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(&session_file, "{}\n").unwrap();
        let managed_dir = dir.path().canonicalize().unwrap();
        let state = parse_state(
            Some(&json!({
                "sessionId":"session-1",
                "sessionFile":session_file,
                "isStreaming":false,
                "isCompacting":false,
                "pendingMessageCount":0,
                "messageCount":0
            })),
            &managed_dir,
        )
        .unwrap();
        assert_eq!(state.session_id(), "session-1");
        assert!(state.proves_idle_queue());

        let outside = tempfile::NamedTempFile::new().unwrap();
        let error = parse_state(
            Some(&json!({
                "sessionId":"session-1",
                "sessionFile":outside.path()
            })),
            &managed_dir,
        )
        .unwrap_err();
        assert_eq!(error, PiUnknownReason::SessionPathUnavailable);
    }

    #[test]
    fn only_new_empty_native_session_can_reference_an_unflushed_file() {
        let dir = tempfile::tempdir().unwrap();
        let managed = dir.path().canonicalize().unwrap();
        let path = managed.join("2026-10-22T00-00-00-000Z_native-session.jsonl");
        let data = json!({"sessionId":"native-session", "sessionFile":path,
            "isStreaming":false, "isCompacting":false,
            "pendingMessageCount":0, "messageCount":0});
        assert_eq!(
            parse_state(Some(&data), &managed).unwrap_err(),
            PiUnknownReason::SessionPathUnavailable
        );
        let state = parse_new_session_state(Some(&data), &managed).unwrap();
        assert_eq!(state.session_file(), path);
        assert!(!state.session_file_persisted());
        assert!(
            !state.proves_idle_queue(),
            "an unflushed session cannot prove settlement"
        );
        assert!(
            !path.exists(),
            "reading native identity must not fabricate a session file"
        );
        for (key, value) in [
            ("sessionId", json!("different-session")),
            (
                "sessionFile",
                json!(managed.join("foreign/session_native-session.jsonl")),
            ),
            (
                "sessionFile",
                json!(managed.join("../outside_native-session.jsonl")),
            ),
            ("isStreaming", json!(true)),
            ("isCompacting", json!(true)),
            ("pendingMessageCount", json!(1)),
            ("messageCount", json!(1)),
        ] {
            let mut invalid = data.clone();
            invalid[key] = value;
            assert!(parse_new_session_state(Some(&invalid), &managed).is_err());
        }
        fs::write(&path, "{}\n").unwrap();
        assert!(
            parse_state(Some(&data), &managed)
                .unwrap()
                .session_file_persisted()
        );
    }

    #[cfg(unix)]
    #[test]
    fn new_session_cannot_use_a_dangling_or_existing_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let managed = dir.path().canonicalize().unwrap();
        let path = managed.join("timestamp_native-session.jsonl");
        let target = managed.join("target.jsonl");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let data = json!({"sessionId":"native-session", "sessionFile":path,
            "isStreaming":false, "isCompacting":false,
            "pendingMessageCount":0, "messageCount":0});
        assert!(parse_new_session_state(Some(&data), &managed).is_err());
        fs::write(target, "{}\n").unwrap();
        assert!(parse_new_session_state(Some(&data), &managed).is_err());
    }

    #[test]
    fn settlement_requires_idle_stream_compaction_and_queue_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let session_file = dir.path().join("session.jsonl");
        fs::write(&session_file, "{}\n").unwrap();
        let managed_dir = dir.path().canonicalize().unwrap();
        let active = parse_state(
            Some(&json!({
                "sessionId":"session-1",
                "sessionFile":session_file,
                "isStreaming":false,
                "isCompacting":true,
                "pendingMessageCount":0
            })),
            &managed_dir,
        )
        .unwrap();
        assert!(!active.proves_idle_queue());
        assert_eq!(PiExecutionPhase::AgentEnded, PiExecutionPhase::AgentEnded);
    }

    #[test]
    fn explicit_unknown_and_terminal_phases_are_distinct() {
        assert!(PiExecutionPhase::Unknown.is_unknown());
        assert!(!PiExecutionPhase::Unknown.is_provider_terminal());
        assert!(PiExecutionPhase::Settled.is_provider_terminal());
        assert!(!PiExecutionPhase::Cleaned.is_provider_terminal());
        assert_eq!(
            PiUnknownReason::AgentEndedWithoutSettlement,
            PiUnknownReason::AgentEndedWithoutSettlement
        );
    }
}
