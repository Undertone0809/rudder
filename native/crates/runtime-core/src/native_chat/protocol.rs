//! Durable provider-effect ordering. This is validation, not permission to send:
//! the Rust persistence owner must commit each transition before its side effect.

use super::super::RuntimeError;
use serde::{Deserialize, Serialize};
use std::fmt;

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

/// Provider identity is explicit in newly written checkpoints. `None` is
/// retained as the legacy Codex representation so existing durable rows keep
/// their byte-compatible JSON shape.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeChatProvider {
    CodexLocal,
    PiLocal,
    HermesLocal,
}

/// Exact Hermes ACP session UUID. This is not a Codex Thread ID and is never
/// copied into the Codex provider identity columns.
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HermesSessionSelector(String);

impl HermesSessionSelector {
    pub fn from_persisted(value: &str) -> Result<Self, RuntimeError> {
        let valid = value.len() == 36
            && value.bytes().enumerate().all(|(index, byte)| match index {
                8 | 13 | 18 | 23 => byte == b'-',
                _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
            });
        if !valid {
            return Err(RuntimeError::invalid("invalid Hermes ACP session UUID"));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn validate(&self) -> Result<(), RuntimeError> {
        Self::from_persisted(&self.0).map(|_| ())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for HermesSessionSelector {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HermesSessionSelector")
            .field("present", &true)
            .finish()
    }
}

/// Exact Pi session-tree selector. These are Pi's own JSONL values, never
/// Codex Thread or Turn identifiers.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PiSessionSelector {
    pub session_id: String,
    pub session_file: String,
    pub leaf_id: Option<String>,
}

impl fmt::Debug for PiSessionSelector {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PiSessionSelector")
            .field("has_session_id", &true)
            .field("has_session_file", &true)
            .field("has_leaf_id", &self.leaf_id.is_some())
            .finish()
    }
}

impl PiSessionSelector {
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if self.session_id.trim().is_empty()
            || self.session_id.len() > 256
            || self.session_file.trim().is_empty()
            || self.session_file.len() > MAX_NATIVE_CHAT_PROVIDER_ID_BYTES
            || self
                .leaf_id
                .as_ref()
                .is_some_and(|leaf| !valid_pi_entry_id(leaf))
            || self.session_id.chars().any(char::is_control)
            || self.session_file.chars().any(char::is_control)
            || self
                .leaf_id
                .as_ref()
                .is_some_and(|leaf| leaf.chars().any(char::is_control))
        {
            return Err(RuntimeError::invalid("invalid Pi session selector"));
        }
        Ok(())
    }
}

fn valid_pi_entry_id(value: &str) -> bool {
    value.len() == 8 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<NativeChatProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pi_session: Option<PiSessionSelector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pi_turn_entry_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hermes_session: Option<HermesSessionSelector>,
    /// Locally allocated JSON-RPC correlation ID committed before the prompt
    /// write. It is not a provider session or turn identifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hermes_prompt_request_id: Option<u64>,
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
            provider: None,
            pi_session: None,
            pi_turn_entry_id: None,
            hermes_session: None,
            hermes_prompt_request_id: None,
        };
        state.validate()?;
        Ok(state)
    }

    pub fn new_pi_fresh_session() -> Result<Self, RuntimeError> {
        let mut state = Self::new(NativeChatProtocolStart::FreshThread)?;
        state.provider = Some(NativeChatProvider::PiLocal);
        state.validate()?;
        Ok(state)
    }

    pub fn new_pi_existing_session(selector: PiSessionSelector) -> Result<Self, RuntimeError> {
        selector.validate()?;
        if selector.leaf_id.is_none() {
            return Err(RuntimeError::invalid(
                "existing Pi session has no exact leaf",
            ));
        }
        let mut state = Self::new(NativeChatProtocolStart::FreshThread)?;
        state.phase = NativeChatProtocolPhase::ThreadKnown;
        state.provider = Some(NativeChatProvider::PiLocal);
        state.pi_session = Some(selector);
        state.validate()?;
        Ok(state)
    }

    pub fn new_hermes_fresh_session() -> Result<Self, RuntimeError> {
        let mut state = Self::new(NativeChatProtocolStart::FreshThread)?;
        state.provider = Some(NativeChatProvider::HermesLocal);
        state.validate()?;
        Ok(state)
    }

    pub fn new_hermes_existing_session(
        selector: HermesSessionSelector,
    ) -> Result<Self, RuntimeError> {
        selector.validate()?;
        let mut state = Self::new(NativeChatProtocolStart::FreshThread)?;
        state.phase = NativeChatProtocolPhase::ThreadKnown;
        state.provider = Some(NativeChatProvider::HermesLocal);
        state.hermes_session = Some(selector);
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

    pub fn provider(&self) -> NativeChatProvider {
        self.provider.unwrap_or(NativeChatProvider::CodexLocal)
    }

    pub fn pi_session(&self) -> Option<&PiSessionSelector> {
        self.pi_session.as_ref()
    }

    pub fn pi_turn_entry_id(&self) -> Option<&str> {
        self.pi_turn_entry_id.as_deref()
    }

    pub fn hermes_session(&self) -> Option<&HermesSessionSelector> {
        self.hermes_session.as_ref()
    }

    pub fn hermes_prompt_request_id(&self) -> Option<u64> {
        self.hermes_prompt_request_id
    }

    pub fn validate(&self) -> Result<(), RuntimeError> {
        for value in [&self.thread_id, &self.turn_id, &self.pi_turn_entry_id]
            .into_iter()
            .flatten()
        {
            // Provider IDs are opaque: validate bounds without normalizing.
            if value.trim().is_empty() || value.len() > MAX_NATIVE_CHAT_PROVIDER_ID_BYTES {
                return Err(RuntimeError::invalid("invalid opaque provider identity"));
            }
        }
        if let Some(selector) = &self.pi_session {
            selector.validate()?;
        }
        if let Some(selector) = &self.hermes_session {
            selector.validate()?;
        }
        if self.provider == Some(NativeChatProvider::HermesLocal) {
            use NativeChatProtocolPhase::*;
            let session_required =
                !matches!(self.phase, NoThreadRequest | ThreadStartIndeterminate);
            let request_required = matches!(
                self.phase,
                InputIndeterminate
                    | TurnKnown
                    | ProviderTerminalObserved
                    | ExecutionTerminalCommitted
            );
            if self.thread_id.is_some()
                || self.turn_id.is_some()
                || self.pi_session.is_some()
                || self.pi_turn_entry_id.is_some()
                || self.observation_only
                || self.hermes_session.is_some() != session_required
                || self.hermes_prompt_request_id.is_some() != request_required
            {
                return Err(RuntimeError::invalid(
                    "Hermes ACP checkpoint contains a mismatched provider identity",
                ));
            }
            return Ok(());
        }
        if self.provider == Some(NativeChatProvider::PiLocal) {
            if self.thread_id.is_some()
                || self.turn_id.is_some()
                || self.hermes_session.is_some()
                || self.hermes_prompt_request_id.is_some()
                || self.observation_only
                || matches!(self.phase, NoThreadRequest | ThreadStartIndeterminate)
                    != self.pi_session.is_none()
            {
                return Err(RuntimeError::invalid(
                    "Pi protocol checkpoint contains Codex or incomplete session identity",
                ));
            }
            let pi_turn_required = matches!(
                self.phase,
                TurnKnown | ProviderTerminalObserved | ExecutionTerminalCommitted
            );
            if self.pi_turn_entry_id.is_some() != pi_turn_required {
                return Err(RuntimeError::invalid(
                    "Pi protocol phase and session-tree turn identity disagree",
                ));
            }
            if self
                .pi_turn_entry_id
                .as_deref()
                .is_some_and(|entry| !valid_pi_entry_id(entry))
            {
                return Err(RuntimeError::invalid("invalid Pi session entry identity"));
            }
            return Ok(());
        }
        if self.pi_session.is_some()
            || self.pi_turn_entry_id.is_some()
            || self.hermes_session.is_some()
            || self.hermes_prompt_request_id.is_some()
        {
            return Err(RuntimeError::invalid(
                "Codex protocol checkpoint contains Pi session identity",
            ));
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

    pub fn record_pi_session(
        &self,
        expected_revision: u64,
        selector: PiSessionSelector,
    ) -> Result<Self, RuntimeError> {
        if self.provider != Some(NativeChatProvider::PiLocal)
            || self.pi_session.is_some()
            || !matches!(
                self.phase,
                NativeChatProtocolPhase::ThreadStartIndeterminate
            )
        {
            return Err(RuntimeError::fence(
                "Pi session does not match pending start",
            ));
        }
        selector.validate()?;
        self.advance_pi_session(expected_revision, selector)
    }

    pub fn record_hermes_session(
        &self,
        expected_revision: u64,
        selector: HermesSessionSelector,
    ) -> Result<Self, RuntimeError> {
        if self.provider != Some(NativeChatProvider::HermesLocal)
            || self.hermes_session.is_some()
            || self.phase != NativeChatProtocolPhase::ThreadStartIndeterminate
        {
            return Err(RuntimeError::fence(
                "Hermes ACP session does not match pending start",
            ));
        }
        selector.validate()?;
        self.validate()?;
        if self.revision != expected_revision
            || !self
                .phase
                .permits_transition(NativeChatProtocolPhase::ThreadKnown)
        {
            return Err(RuntimeError::fence("stale Hermes session checkpoint"));
        }
        // Hermes carries its session selector in a provider-specific field.
        // Populate it before validation of the ThreadKnown phase; routing it
        // through the generic Codex advance helper would validate an invalid
        // intermediate state with no thread locator.
        let mut next = self.clone();
        next.phase = NativeChatProtocolPhase::ThreadKnown;
        next.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::invalid("provider checkpoint revision exhausted"))?;
        next.hermes_session = Some(selector);
        next.validate()?;
        Ok(next)
    }

    pub fn mark_hermes_input_indeterminate(
        &self,
        expected_revision: u64,
        request_id: u64,
    ) -> Result<Self, RuntimeError> {
        if self.provider != Some(NativeChatProvider::HermesLocal)
            || self.hermes_session.is_none()
            || self.hermes_prompt_request_id.is_some()
        {
            return Err(RuntimeError::fence(
                "Hermes ACP prompt does not match the current session",
            ));
        }
        self.validate()?;
        if self.revision != expected_revision
            || !self
                .phase
                .permits_transition(NativeChatProtocolPhase::InputIndeterminate)
        {
            return Err(RuntimeError::fence("stale Hermes prompt checkpoint"));
        }
        // The request id is part of the valid InputIndeterminate identity, so
        // set it before the phase validator runs instead of validating an
        // impossible intermediate state with a missing prompt locator.
        let mut next = self.clone();
        next.phase = NativeChatProtocolPhase::InputIndeterminate;
        next.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::invalid("provider checkpoint revision exhausted"))?;
        next.hermes_prompt_request_id = Some(request_id);
        next.validate()?;
        Ok(next)
    }

    pub fn record_hermes_turn(&self, expected_revision: u64) -> Result<Self, RuntimeError> {
        if self.provider != Some(NativeChatProvider::HermesLocal)
            || self.hermes_session.is_none()
            || self.hermes_prompt_request_id.is_none()
        {
            return Err(RuntimeError::fence("Hermes ACP prompt receipt is missing"));
        }
        self.advance(
            expected_revision,
            NativeChatProtocolPhase::TurnKnown,
            None,
            None,
        )
    }

    pub fn record_hermes_provider_terminal(
        &self,
        expected_revision: u64,
        session_id: &str,
        request_id: u64,
    ) -> Result<Self, RuntimeError> {
        if self.provider != Some(NativeChatProvider::HermesLocal)
            || self
                .hermes_session
                .as_ref()
                .map(HermesSessionSelector::as_str)
                != Some(session_id)
            || self.hermes_prompt_request_id != Some(request_id)
        {
            return Err(RuntimeError::fence(
                "Hermes ACP terminal receipt belongs to another prompt",
            ));
        }
        self.advance(
            expected_revision,
            NativeChatProtocolPhase::ProviderTerminalObserved,
            None,
            None,
        )
    }

    /// The turn selector is Pi's exact persisted user-entry id observed in the
    /// newly extended session tree. `prompt` acceptance alone is insufficient.
    pub fn record_pi_turn_entry(
        &self,
        expected_revision: u64,
        session_id: &str,
        entry_id: String,
    ) -> Result<Self, RuntimeError> {
        if self.provider != Some(NativeChatProvider::PiLocal)
            || self.pi_session.as_ref().map(|s| s.session_id.as_str()) != Some(session_id)
        {
            return Err(RuntimeError::fence("Pi turn belongs to another session"));
        }
        let mut next = self.advance_pi_turn(expected_revision)?;
        next.pi_turn_entry_id = Some(entry_id);
        next.validate()?;
        Ok(next)
    }

    pub fn record_pi_provider_terminal(
        &self,
        expected_revision: u64,
        session_id: &str,
        entry_id: &str,
        next_leaf_id: String,
    ) -> Result<Self, RuntimeError> {
        if self.provider != Some(NativeChatProvider::PiLocal)
            || self.pi_session.as_ref().map(|s| s.session_id.as_str()) != Some(session_id)
            || self.pi_turn_entry_id.as_deref() != Some(entry_id)
        {
            return Err(RuntimeError::fence(
                "Pi terminal observation belongs to another session turn",
            ));
        }
        let mut next = self.advance(
            expected_revision,
            NativeChatProtocolPhase::ProviderTerminalObserved,
            None,
            None,
        )?;
        let selector = next.pi_session.as_mut().expect("validated Pi session");
        selector.leaf_id = Some(next_leaf_id);
        next.validate()?;
        Ok(next)
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

    fn advance_pi_turn(&self, expected_revision: u64) -> Result<Self, RuntimeError> {
        self.validate()?;
        if self.provider != Some(NativeChatProvider::PiLocal) || self.revision != expected_revision
        {
            return Err(RuntimeError::fence("stale Pi turn checkpoint"));
        }
        if !self
            .phase
            .permits_transition(NativeChatProtocolPhase::TurnKnown)
        {
            return Err(RuntimeError::transition("Pi turn cannot be recorded here"));
        }
        let mut next = self.clone();
        next.phase = NativeChatProtocolPhase::TurnKnown;
        next.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::invalid("provider checkpoint revision exhausted"))?;
        Ok(next)
    }

    fn advance_pi_session(
        &self,
        expected_revision: u64,
        selector: PiSessionSelector,
    ) -> Result<Self, RuntimeError> {
        self.validate()?;
        if self.provider != Some(NativeChatProvider::PiLocal)
            || self.revision != expected_revision
            || self.phase != NativeChatProtocolPhase::ThreadStartIndeterminate
            || self.pi_session.is_some()
        {
            return Err(RuntimeError::fence("stale Pi session checkpoint"));
        }
        selector.validate()?;
        let mut next = self.clone();
        next.phase = NativeChatProtocolPhase::ThreadKnown;
        next.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::invalid("provider checkpoint revision exhausted"))?;
        next.pi_session = Some(selector);
        next.validate()?;
        Ok(next)
    }
}
