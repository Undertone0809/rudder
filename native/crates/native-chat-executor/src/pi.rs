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
    execution::{self, CheckpointSnapshot, CheckpointTransition, EffectDispatch, ExecutionFence},
};
use rudder_pi_rpc::{
    ConnectionLaunchPermit, PiCleanupReceipt, PiCommand, PiEvent, PiProfileMode, PiResponse,
    PiRpcMessage, PiRpcTransport, PiSessionTree, PiSessionTreeError, PiTransportError,
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
    let mut execution = match PiExecution::launch(
        launch,
        permit,
        remaining_timeout(deadline, RPC_TIMEOUT).unwrap_or_default(),
    ) {
        Ok(execution) => execution,
        Err(error) => {
            return Err(ExecutionFailure::after_claim_pi(
                Error::PiTransport(error),
                execution_principal,
                fence,
                None,
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
    // Cleanup must still receive its bounded receipt wait when the execution
    // deadline has elapsed. A zero remaining run timeout cannot prove cleanup.
    let _cleanup_phase = execution.cleanup_with_grace(
        cleanup_grace,
        cleanup_grace.saturating_add(Duration::from_secs(2)),
    );
    let observation = execution.into_observation();
    if let Err(error) = result {
        return Err(ExecutionFailure::after_claim_pi(
            error,
            execution_principal,
            fence,
            observation.cleanup_receipt,
        ));
    }
    if observation.turn_receipt.is_none() || observation.cleanup_receipt.is_none() {
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
) -> ExecResult<()> {
    if snapshot.phase == NativeChatProtocolPhase::NoThreadRequest {
        let mut prepared = db(
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
        )?;
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
        )?;
        let timeout = remaining_timeout(deadline, RPC_TIMEOUT)?;
        effect
            .dispatch(|payload| match payload {
                EffectDispatch::StartPiSession => execution
                    .new_session(timeout)
                    .map(|_| ())
                    .map_err(Error::PiTransport),
                _ => Err(Error::InvalidProviderObservation),
            })
            .map_err(Error::Persistence)??;
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
        )?;
        snapshot = recorded.snapshot().clone();
    } else {
        let stored = snapshot
            .pi_session
            .as_ref()
            .ok_or(Error::InvalidProviderObservation)?;
        execution
            .resume_session(
                Path::new(&stored.session_file),
                remaining_timeout(deadline, RPC_TIMEOUT)?,
            )
            .map_err(Error::PiTransport)?;
        let state = execution.state().ok_or(Error::InvalidProviderObservation)?;
        if state.session_id() != stored.session_id
            || state.session_file().to_string_lossy() != stored.session_file
        {
            return Err(Error::InvalidProviderObservation);
        }
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
    )?;
    snapshot = prepared.snapshot().clone();
    let input = db(
        handle,
        deadline,
        execution::load_submission(pool, actor, fence),
    )?;
    let input_body = input.body().to_owned();
    let mut marked = db(
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
    )?;
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
    )?;
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
    effect
        .dispatch(|payload| match payload {
            EffectDispatch::SubmitPiInput {
                session_id: expected,
                body,
                ..
            } if expected == session_id => execution
                .submit_input(body, timeout)
                .map(|_| ())
                .map_err(Error::PiTransport),
            _ => Err(Error::InvalidProviderObservation),
        })
        .map_err(Error::Persistence)??;
    if !execution
        .wait_until_settled(remaining_timeout(deadline, Duration::from_secs(3600))?)
        .map_err(Error::PiTransport)?
        .is_provider_terminal()
    {
        return Err(Error::InvalidProviderObservation);
    }
    execution
        .take_turn_receipt(prior_leaf_id.as_deref(), &input_body)
        .map_err(Error::PiTransport)?;
    let receipt = execution
        .turn_receipt()
        .ok_or(Error::InvalidProviderObservation)?;
    if receipt.session_id() != session_id || receipt.input_fingerprint().is_empty() {
        return Err(Error::InvalidProviderObservation);
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
    )?;
    snapshot = recorded.snapshot().clone();
    db(
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
    )?;
    Ok(())
}

fn remaining_timeout(deadline: Instant, max: Duration) -> ExecResult<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now()).min(max);
    if remaining.is_zero() {
        Err(Error::Deadline)
    } else {
        Ok(remaining)
    }
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
    #[error("Pi adapter is not ready for this operation")]
    InvalidPhase,
    #[error("Pi session path is outside the managed session directory")]
    InvalidSessionPath,
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
        let session_dir = canonical_session_dir(&launch.session_dir)?;
        let mut transport = PiRpcTransport::launch(launch, permit)?;
        transport.wait_spawned(timeout)?;
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

    /// Read and validate the exact native state. A rejected command is an
    /// explicit Unknown observation instead of a fabricated empty Session.
    pub fn get_state(&mut self, timeout: Duration) -> Result<PiExecutionPhase, PiAdapterError> {
        self.read_state(timeout, false)
    }

    fn read_state(
        &mut self,
        timeout: Duration,
        newly_created: bool,
    ) -> Result<PiExecutionPhase, PiAdapterError> {
        let response = self.command_response(PiCommand::GetState, timeout)?;
        if !response.success() {
            self.mark_unknown(PiUnknownReason::CommandRejected);
            return Ok(self.phase);
        }
        let state = match if newly_created {
            parse_new_session_state(response.data(), &self.session_dir)
        } else {
            parse_state(response.data(), &self.session_dir)
        } {
            Ok(state) => state,
            Err(reason) => {
                self.mark_unknown(reason);
                return Ok(self.phase);
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
        Ok(self.phase)
    }

    /// Switch to the exact persisted session file, then re-read state. The
    /// caller cannot point Pi at a different directory or a symlinked file.
    pub fn resume_session(
        &mut self,
        session_file: &Path,
        timeout: Duration,
    ) -> Result<PiExecutionPhase, PiAdapterError> {
        let session_file = validate_session_file(session_file, &self.session_dir)?;
        let response = self.command_response(
            PiCommand::SwitchSession(&session_file.to_string_lossy()),
            timeout,
        )?;
        if !response.success() {
            self.mark_unknown(PiUnknownReason::CommandRejected);
            return Ok(self.phase);
        }
        self.get_state(timeout)
    }

    /// Ask Pi to create a native Session and re-read its identity. This is
    /// intentionally separate from `launch`: a process may already have a
    /// provider-created Session that must be resumed instead.
    pub fn new_session(&mut self, timeout: Duration) -> Result<PiExecutionPhase, PiAdapterError> {
        let response = self.command_response(PiCommand::NewSession, timeout)?;
        if !response.success() {
            self.mark_unknown(PiUnknownReason::CommandRejected);
            return Ok(self.phase);
        }
        self.read_state(timeout, true)
    }

    /// Submit exactly one input. The returned request id only correlates the
    /// RPC response; it never serves as a durable deduplication key.
    pub fn submit_input(
        &mut self,
        input: &str,
        timeout: Duration,
    ) -> Result<PiExecutionPhase, PiAdapterError> {
        if input.is_empty() || !matches!(self.phase, PiExecutionPhase::SessionReady) {
            return Err(PiAdapterError::InvalidPhase);
        }
        let request_id = self.command_response(PiCommand::Prompt(input), timeout)?;
        if !request_id.success() {
            self.mark_unknown(PiUnknownReason::CommandRejected);
            return Ok(self.phase);
        }
        self.input_request_id = Some(request_id.id().to_owned());
        self.agent_started = false;
        self.agent_ended = false;
        self.agent_settled = false;
        self.phase = PiExecutionPhase::InputAccepted;
        Ok(self.phase)
    }

    /// Wait for provider settlement, preserving the distinction between
    /// low-level `agent_end` and the complete `agent_settled`/idle proof.
    pub fn wait_until_settled(
        &mut self,
        timeout: Duration,
    ) -> Result<PiExecutionPhase, PiAdapterError> {
        if !matches!(
            self.phase,
            PiExecutionPhase::InputAccepted
                | PiExecutionPhase::AgentRunning
                | PiExecutionPhase::AgentEnded
        ) {
            return Err(PiAdapterError::InvalidPhase);
        }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.agent_settled {
                if !self.agent_ended {
                    self.mark_unknown(PiUnknownReason::AgentSettledBeforeAgentEnd);
                    return Ok(self.phase);
                }
                // The pre-prompt state may name an unflushed session. Require
                // a new strict observation after terminal events, which also
                // binds the same native file as persisted in the transport.
                if self.get_state(remaining(deadline))? == PiExecutionPhase::Unknown {
                    return Ok(self.phase);
                }
                if self
                    .state
                    .as_ref()
                    .is_some_and(PiStateSnapshot::proves_idle_queue)
                    && self.phase != PiExecutionPhase::Unknown
                {
                    self.phase = PiExecutionPhase::Settled;
                    return Ok(self.phase);
                }
                self.mark_unknown(PiUnknownReason::MalformedState);
                return Ok(self.phase);
            }
            let message = match self.transport.receive(remaining(deadline)) {
                Ok(message) => message,
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
            if self.phase == PiExecutionPhase::AgentEnded && !self.agent_settled {
                // Older Pi versions have no agent_settled event. Their state
                // endpoint must prove that streaming, compaction and queued
                // follow-up input are all idle before we promote completion.
                let state_phase = self.get_state(remaining(deadline))?;
                if state_phase == PiExecutionPhase::Unknown {
                    return Ok(state_phase);
                }
                if state_phase == PiExecutionPhase::AgentEnded {
                    if self
                        .state
                        .as_ref()
                        .is_some_and(PiStateSnapshot::proves_idle_queue)
                    {
                        self.phase = PiExecutionPhase::Settled;
                        return Ok(self.phase);
                    }
                    if self.state.as_ref().is_some_and(|state| {
                        state.is_streaming.is_some()
                            && state.is_compacting.is_some()
                            && state.pending_message_count.is_some()
                    }) {
                        // A valid but still active state can continue to emit
                        // retries/compaction events. Keep waiting.
                        continue;
                    }
                    self.mark_unknown(PiUnknownReason::AgentEndedWithoutSettlement);
                    return Ok(self.phase);
                }
            }
        }
        self.mark_unknown(PiUnknownReason::AgentEndedWithoutSettlement);
        Ok(self.phase)
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
        self.transport.stop_with_grace(grace, timeout)?;
        let Some(receipt) = self.transport.take_cleanup_receipt() else {
            self.mark_unknown(PiUnknownReason::CleanupNotProven);
            return Ok(self.phase);
        };
        self.cleanup_receipt = Some(receipt);
        self.phase = PiExecutionPhase::Cleaned;
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
        let request_id = self.transport.request(command)?;
        let deadline = Instant::now() + timeout;
        loop {
            let message = self.transport.receive(remaining(deadline))?;
            match message {
                PiRpcMessage::Response(response) if response.id() == request_id => {
                    return Ok(response);
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
    use super::{PiExecutionPhase, PiUnknownReason, parse_new_session_state, parse_state};
    use serde_json::json;
    use std::fs;

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
