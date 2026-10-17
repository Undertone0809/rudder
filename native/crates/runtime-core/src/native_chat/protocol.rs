//! Durable provider-effect ordering. This is validation, not permission to send:
//! the Rust persistence owner must commit each transition before its side effect.

use super::super::RuntimeError;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeChatProtocolPhase {
    NoThreadRequest,
    ThreadStartIndeterminate,
    ThreadKnown,
    InputPreSubmission,
    InputIndeterminate,
    TurnKnown,
    ProviderTerminalObserved,
    ExecutionTerminalCommitted,
}

impl NativeChatProtocolPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NoThreadRequest => "no_thread_request",
            Self::ThreadStartIndeterminate => "thread_start_indeterminate",
            Self::ThreadKnown => "thread_known",
            Self::InputPreSubmission => "input_pre_submission",
            Self::InputIndeterminate => "input_indeterminate",
            Self::TurnKnown => "turn_known",
            Self::ProviderTerminalObserved => "provider_terminal_observed",
            Self::ExecutionTerminalCommitted => "execution_terminal_committed",
        }
    }

    /// The terminal edge is reserved for the fenced execution authority, which
    /// must independently verify outcome/quiescence. A provider observation
    /// never invokes that edge. Failure/cancellation can terminate any phase.
    pub const fn permits_transition(self, next: Self) -> bool {
        if matches!(self, Self::ExecutionTerminalCommitted) {
            return false;
        }
        if matches!(next, Self::ExecutionTerminalCommitted) {
            return true;
        }
        matches!(
            (self, next),
            (Self::NoThreadRequest, Self::ThreadStartIndeterminate)
                | (Self::ThreadStartIndeterminate, Self::ThreadKnown)
                | (Self::ThreadKnown, Self::InputPreSubmission)
                | (Self::InputPreSubmission, Self::InputIndeterminate)
                | (Self::InputIndeterminate, Self::TurnKnown)
                | (Self::TurnKnown, Self::ProviderTerminalObserved)
        )
    }
}

/// An already selected exact Thread or Turn. Construction does not select a
/// session or authorize reattachment; those decisions belong to persistence.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeChatProtocolStart {
    FreshThread,
    ExistingThread { thread_id: String },
    ObserveExistingTurn { thread_id: String, turn_id: String },
}

pub const MAX_NATIVE_CHAT_PROVIDER_ID_BYTES: usize = 4096;

/// No prompt, transcript, credentials, owner token, or raw submission permit.
/// Restore must validate against the expected DB phase/revision and full turn
/// identity in the containing checkpoint; JSON alone is never authoritative.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeChatProtocolCheckpoint {
    phase: NativeChatProtocolPhase,
    revision: u64,
    observation_only: bool,
    thread_id: Option<String>,
    turn_id: Option<String>,
}

impl NativeChatProtocolCheckpoint {
    pub fn new(start: NativeChatProtocolStart) -> Result<Self, RuntimeError> {
        let (phase, observation_only, thread_id, turn_id) = match start {
            NativeChatProtocolStart::FreshThread => {
                (NativeChatProtocolPhase::NoThreadRequest, false, None, None)
            }
            NativeChatProtocolStart::ExistingThread { thread_id } => (
                NativeChatProtocolPhase::ThreadKnown,
                false,
                Some(thread_id),
                None,
            ),
            NativeChatProtocolStart::ObserveExistingTurn { thread_id, turn_id } => (
                NativeChatProtocolPhase::TurnKnown,
                true,
                Some(thread_id),
                Some(turn_id),
            ),
        };
        let state = Self {
            phase,
            revision: 0,
            observation_only,
            thread_id,
            turn_id,
        };
        state.validate()?;
        Ok(state)
    }

    pub fn phase(&self) -> NativeChatProtocolPhase {
        self.phase
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn thread_id(&self) -> Option<&str> {
        self.thread_id.as_deref()
    }
    pub fn turn_id(&self) -> Option<&str> {
        self.turn_id.as_deref()
    }
    pub fn observation_only(&self) -> bool {
        self.observation_only
    }

    pub fn validate(&self) -> Result<(), RuntimeError> {
        for value in [&self.thread_id, &self.turn_id].into_iter().flatten() {
            // Provider IDs are opaque: validate bounds without normalizing.
            if value.trim().is_empty() || value.len() > MAX_NATIVE_CHAT_PROVIDER_ID_BYTES {
                return Err(RuntimeError::invalid("invalid opaque provider identity"));
            }
        }
        use NativeChatProtocolPhase::*;
        let terminal = self.phase == ExecutionTerminalCommitted;
        let thread_required = !matches!(self.phase, NoThreadRequest | ThreadStartIndeterminate);
        let turn_required = matches!(self.phase, TurnKnown | ProviderTerminalObserved);
        let mismatched_phase = !terminal
            && (self.thread_id.is_some() != thread_required
                || self.turn_id.is_some() != turn_required);
        if mismatched_phase
            || (self.turn_id.is_some() && self.thread_id.is_none())
            || (self.observation_only
                && (!matches!(
                    self.phase,
                    TurnKnown | ProviderTerminalObserved | ExecutionTerminalCommitted
                ) || self.turn_id.is_none()))
        {
            return Err(RuntimeError::invalid(
                "provider phase and exact identities disagree",
            ));
        }
        Ok(())
    }

    /// Return a proposed checkpoint. The caller must CAS and commit it before
    /// writing thread/start bytes; an ambiguous write can never reset this phase.
    pub fn prepare_thread_start(&self, expected_revision: u64) -> Result<Self, RuntimeError> {
        self.advance(
            expected_revision,
            NativeChatProtocolPhase::ThreadStartIndeterminate,
            None,
            None,
        )
    }

    pub fn record_thread(
        &self,
        expected_revision: u64,
        thread_id: String,
    ) -> Result<Self, RuntimeError> {
        self.advance(
            expected_revision,
            NativeChatProtocolPhase::ThreadKnown,
            Some(thread_id),
            None,
        )
    }

    pub fn prepare_input(&self, expected_revision: u64) -> Result<Self, RuntimeError> {
        self.advance(
            expected_revision,
            NativeChatProtocolPhase::InputPreSubmission,
            None,
            None,
        )
    }

    /// Commit this checkpoint together with the one-use permit digest before
    /// dispatch. This method does not issue or consume the persistence permit.
    pub fn mark_input_indeterminate(&self, expected_revision: u64) -> Result<Self, RuntimeError> {
        self.advance(
            expected_revision,
            NativeChatProtocolPhase::InputIndeterminate,
            None,
            None,
        )
    }

    pub fn record_turn(
        &self,
        expected_revision: u64,
        thread_id: &str,
        turn_id: String,
    ) -> Result<Self, RuntimeError> {
        if self.thread_id.as_deref() != Some(thread_id) {
            return Err(RuntimeError::fence(
                "provider Turn belongs to another Thread",
            ));
        }
        self.advance(
            expected_revision,
            NativeChatProtocolPhase::TurnKnown,
            None,
            Some(turn_id),
        )
    }

    pub fn record_provider_terminal(
        &self,
        expected_revision: u64,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<Self, RuntimeError> {
        if self.thread_id.as_deref() != Some(thread_id) || self.turn_id.as_deref() != Some(turn_id)
        {
            return Err(RuntimeError::fence(
                "provider terminal belongs to another Turn",
            ));
        }
        self.advance(
            expected_revision,
            NativeChatProtocolPhase::ProviderTerminalObserved,
            None,
            None,
        )
    }

    // Execution-terminal transition is deliberately absent from the provider
    // API. Persistence uses the phase graph only after its own terminal checks.
    fn advance(
        &self,
        expected_revision: u64,
        phase: NativeChatProtocolPhase,
        thread_id: Option<String>,
        turn_id: Option<String>,
    ) -> Result<Self, RuntimeError> {
        self.validate()?;
        if self.revision != expected_revision {
            return Err(RuntimeError::fence("stale provider checkpoint revision"));
        }
        if !self.phase.permits_transition(phase) {
            return Err(RuntimeError::transition(
                "provider effect cannot repeat, skip or move backwards",
            ));
        }
        let mut next = self.clone();
        next.phase = phase;
        next.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::invalid("provider checkpoint revision exhausted"))?;
        if let Some(thread_id) = thread_id {
            next.thread_id = Some(thread_id);
        }
        if let Some(turn_id) = turn_id {
            next.turn_id = Some(turn_id);
        }
        next.validate()?;
        Ok(next)
    }
}
