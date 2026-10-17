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

use rudder_pi_rpc::{
    ConnectionLaunchPermit, PiCleanupReceipt, PiCommand, PiEvent, PiResponse, PiRpcMessage,
    PiRpcTransport, PiSessionTree, PiSessionTreeError, PiTransportError, PiTurnReceipt,
    ProcessLaunch,
};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MAX_SESSION_ID_BYTES: usize = 256;

/// Provider state that can be safely handed to the shared Native worker.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PiExecutionPhase {
    /// The owned process exists and passed the process-host spawn barrier.
    Spawned,
    /// A native Pi session and its exact managed session file were observed.
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
        self.is_streaming == Some(false)
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

    /// Read and validate the exact native state. A rejected command is an
    /// explicit Unknown observation instead of a fabricated empty Session.
    pub fn get_state(&mut self, timeout: Duration) -> Result<PiExecutionPhase, PiAdapterError> {
        let response = self.command_response(PiCommand::GetState, timeout)?;
        if !response.success() {
            self.mark_unknown(PiUnknownReason::CommandRejected);
            return Ok(self.phase);
        }
        let state = match parse_state(response.data(), &self.session_dir) {
            Ok(state) => state,
            Err(reason) => {
                self.mark_unknown(reason);
                return Ok(self.phase);
            }
        };
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
        self.get_state(timeout)
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
                if self.state.is_none() {
                    self.get_state(remaining(deadline))?;
                }
                if self.state.is_some() {
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
        self.transport.stop(timeout)?;
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
    let session_file = session_file
        .canonicalize()
        .map_err(|_| PiUnknownReason::SessionPathUnavailable)?;
    if !session_file.is_file() || session_file.parent() != Some(session_dir) {
        return Err(PiUnknownReason::SessionPathUnavailable);
    }
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
        is_streaming: optional_bool("isStreaming")?,
        is_compacting: optional_bool("isCompacting")?,
        pending_message_count: optional_u64("pendingMessageCount")?,
        message_count: optional_u64("messageCount")?,
    })
}

#[cfg(test)]
mod tests {
    use super::{PiExecutionPhase, PiUnknownReason, parse_state};
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
