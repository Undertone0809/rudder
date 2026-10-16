use super::super::{ChatGenerationStatus, FailureCategory, RuntimeError};
use super::{
    MAX_NATIVE_CHAT_REPLAY_EVENTS, NATIVE_CHAT_TURN_PROTOCOL_VERSION, NativeChatEventDisposition,
    NativeChatExecutionTerminal, NativeChatReconnectAction, NativeChatSubmissionPhase,
    NativeChatTurnCheckpoint, NativeChatTurnEvent, NativeChatTurnEventKind, NativeChatTurnIdentity,
    NativeChatTurnProjection, NativeChatTurnRequest, reconciliation_required, replay_conflict,
    stale_identity,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeChatTurnReducer {
    checkpoint: NativeChatTurnCheckpoint,
}

impl NativeChatTurnReducer {
    pub fn new(request: NativeChatTurnRequest) -> Result<Self, RuntimeError> {
        request.identity.validate()?;
        Ok(Self {
            checkpoint: NativeChatTurnCheckpoint {
                protocol_version: NATIVE_CHAT_TURN_PROTOCOL_VERSION,
                identity: request.identity,
                submission_phase: request.submission_phase,
                last_sequence: None,
                replay_floor: 0,
                retained_events: Vec::new(),
                provider_final_sequence: None,
                execution_terminal: None,
                cancellation_cutoff: None,
            },
        })
    }

    pub fn restore(
        expected_identity: &NativeChatTurnIdentity,
        checkpoint: NativeChatTurnCheckpoint,
    ) -> Result<Self, RuntimeError> {
        checkpoint.validate_for(expected_identity)?;
        Ok(Self { checkpoint })
    }

    pub fn checkpoint(&self) -> NativeChatTurnCheckpoint {
        self.checkpoint.clone()
    }

    pub fn projection(&self) -> NativeChatTurnProjection {
        NativeChatTurnProjection {
            checkpoint: self.checkpoint(),
            terminal_status: self.terminal_status(),
            reconnect_action: self.reconnect_action(),
        }
    }

    pub fn identity(&self) -> &NativeChatTurnIdentity {
        &self.checkpoint.identity
    }

    pub fn submission_phase(&self) -> NativeChatSubmissionPhase {
        self.checkpoint.submission_phase
    }

    pub fn reconnect_action(&self) -> NativeChatReconnectAction {
        if self.checkpoint.submission_phase == NativeChatSubmissionPhase::PreSubmission
            && self.checkpoint.provider_final_sequence.is_none()
            && self.checkpoint.execution_terminal.is_none()
            && self.checkpoint.cancellation_cutoff.is_none()
        {
            NativeChatReconnectAction::PrepareSubmission
        } else {
            NativeChatReconnectAction::ReattachEventsOnly
        }
    }

    /// Marks the submission boundary before any provider write and returns the
    /// checkpoint that the caller must durably commit before sending input.
    /// This only changes the in-memory projection; it does not claim a durable
    /// write occurred. If persistence fails, do not send input. A restored
    /// indeterminate checkpoint can only reattach to events and cannot call
    /// this method again to authorize another submission.
    pub fn prepare_provider_submission(
        &mut self,
    ) -> Result<NativeChatTurnCheckpoint, RuntimeError> {
        if self.terminal_status().is_some() || self.checkpoint.cancellation_cutoff.is_some() {
            return Err(RuntimeError::terminal());
        }
        if self.checkpoint.submission_phase != NativeChatSubmissionPhase::PreSubmission {
            return Err(RuntimeError::transition(
                "provider submission can only be prepared once from pre-submission state",
            ));
        }
        if self.checkpoint.execution_terminal.is_some()
            || self.checkpoint.provider_final_sequence.is_some()
        {
            return Err(RuntimeError::transition(
                "provider submission cannot be prepared after terminal provider evidence",
            ));
        }
        self.checkpoint.submission_phase = NativeChatSubmissionPhase::Indeterminate;
        Ok(self.checkpoint())
    }

    pub fn terminal_status(&self) -> Option<ChatGenerationStatus> {
        if self.checkpoint.cancellation_cutoff.is_some() {
            return Some(ChatGenerationStatus::Stopped);
        }
        let terminal = self.checkpoint.execution_terminal.as_ref()?;
        if terminal.status == ChatGenerationStatus::Completed {
            self.checkpoint
                .provider_final_sequence
                .map(|_| ChatGenerationStatus::Completed)
        } else {
            Some(terminal.status)
        }
    }

    pub fn apply(
        &mut self,
        event: NativeChatTurnEvent,
    ) -> Result<NativeChatEventDisposition, RuntimeError> {
        event.validate()?;
        if event.identity != self.checkpoint.identity {
            return Err(stale_identity());
        }
        if let Some(existing) = self
            .checkpoint
            .retained_events
            .iter()
            .find(|existing| existing.sequence == event.sequence)
        {
            if existing == &event {
                return Ok(NativeChatEventDisposition::Duplicate);
            }
            return Err(replay_conflict());
        }
        if self
            .checkpoint
            .execution_terminal
            .as_ref()
            .is_some_and(|terminal| terminal.sequence == event.sequence)
        {
            return Err(replay_conflict());
        }
        if event.sequence <= self.checkpoint.last_sequence.unwrap_or_default() {
            return Err(reconciliation_required());
        }
        if self.checkpoint.cancellation_cutoff.is_some() {
            return Err(RuntimeError::new(
                "native_event_after_cancellation",
                FailureCategory::Conflict,
                "native chat event arrived after the cancellation cutoff",
            ));
        }
        if self.terminal_status().is_some() {
            return Err(RuntimeError::terminal());
        }

        let mut next_submission_phase = self.checkpoint.submission_phase;
        let mut next_provider_final_sequence = self.checkpoint.provider_final_sequence;
        match &event.event {
            NativeChatTurnEventKind::Commentary { .. }
            | NativeChatTurnEventKind::ToolActivity { .. }
            | NativeChatTurnEventKind::ProviderFinal { .. } => {
                next_submission_phase = NativeChatSubmissionPhase::Accepted;
            }
            NativeChatTurnEventKind::SubmissionAccepted => {
                next_submission_phase = NativeChatSubmissionPhase::Accepted;
            }
            NativeChatTurnEventKind::SubmissionIndeterminate => {
                if next_submission_phase == NativeChatSubmissionPhase::Accepted {
                    return Err(RuntimeError::transition(
                        "accepted native chat submission cannot become indeterminate",
                    ));
                }
                next_submission_phase = NativeChatSubmissionPhase::Indeterminate;
            }
            NativeChatTurnEventKind::Unknown { .. } => {
                if matches!(
                    next_submission_phase,
                    NativeChatSubmissionPhase::PreSubmission | NativeChatSubmissionPhase::Unknown
                ) {
                    next_submission_phase = NativeChatSubmissionPhase::Indeterminate;
                }
            }
        }
        if matches!(&event.event, NativeChatTurnEventKind::ProviderFinal { .. }) {
            if next_provider_final_sequence.is_some() {
                return Err(RuntimeError::transition(
                    "native chat turn already has a provider final event",
                ));
            }
            next_provider_final_sequence = Some(event.sequence);
        }
        self.checkpoint.submission_phase = next_submission_phase;
        self.checkpoint.provider_final_sequence = next_provider_final_sequence;
        self.checkpoint.last_sequence = Some(event.sequence);
        self.checkpoint.retained_events.push(event);
        if self.checkpoint.retained_events.len() > MAX_NATIVE_CHAT_REPLAY_EVENTS {
            let evicted = self.checkpoint.retained_events.remove(0);
            self.checkpoint.replay_floor = evicted.sequence;
        }
        Ok(NativeChatEventDisposition::Applied)
    }

    /// Records terminal evidence projected from the fenced Attempt authority.
    /// This is a Rust integration hook, not a provider event: callers must
    /// read the terminal Attempt state under its current fence before invoking
    /// it. Do not expose this as an adapter or model-callable operation.
    pub fn record_attempt_terminal(
        &mut self,
        identity: &NativeChatTurnIdentity,
        sequence: u64,
        status: ChatGenerationStatus,
    ) -> Result<NativeChatEventDisposition, RuntimeError> {
        identity.validate()?;
        if identity != &self.checkpoint.identity {
            return Err(stale_identity());
        }
        if sequence == 0 || !status.is_terminal() {
            return Err(RuntimeError::invalid(
                "Attempt terminal evidence requires a positive sequence and terminal status",
            ));
        }
        if let Some(previous) = &self.checkpoint.execution_terminal {
            if previous.sequence == sequence && previous.status == status {
                return Ok(NativeChatEventDisposition::Duplicate);
            }
            return Err(RuntimeError::transition(
                "native chat turn already has Attempt terminal evidence",
            ));
        }
        if self
            .checkpoint
            .retained_events
            .iter()
            .any(|event| event.sequence == sequence)
        {
            return Err(replay_conflict());
        }
        if self.checkpoint.cancellation_cutoff.is_some() {
            return Err(RuntimeError::new(
                "native_event_after_cancellation",
                FailureCategory::Conflict,
                "Attempt terminal evidence arrived after the cancellation cutoff",
            ));
        }
        if self.terminal_status().is_some() {
            return Err(RuntimeError::terminal());
        }
        if sequence <= self.checkpoint.last_sequence.unwrap_or_default() {
            return Err(reconciliation_required());
        }
        self.checkpoint.execution_terminal = Some(NativeChatExecutionTerminal { status, sequence });
        self.checkpoint.last_sequence = Some(sequence);
        Ok(NativeChatEventDisposition::Applied)
    }

    /// Projects a cancellation cutoff only after the caller has validated the
    /// current Attempt fence. This reducer does not own or validate that fence.
    pub fn cancel(
        &mut self,
        identity: &NativeChatTurnIdentity,
        cutoff_sequence: u64,
    ) -> Result<(), RuntimeError> {
        identity.validate()?;
        if identity != &self.checkpoint.identity {
            return Err(stale_identity());
        }
        if self.checkpoint.cancellation_cutoff == Some(cutoff_sequence) {
            return Ok(());
        }
        if self.terminal_status().is_some() || self.checkpoint.execution_terminal.is_some() {
            return Err(RuntimeError::terminal());
        }
        if cutoff_sequence != self.checkpoint.last_sequence.unwrap_or_default() {
            return Err(RuntimeError::new(
                "native_chat_cancellation_cutoff_conflict",
                FailureCategory::Conflict,
                "cancellation cutoff must match the last accepted event sequence",
            ));
        }
        self.checkpoint.cancellation_cutoff = Some(cutoff_sequence);
        Ok(())
    }
}
