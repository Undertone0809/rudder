use super::super::{ChatGenerationStatus, RuntimeError};
use super::{
    MAX_NATIVE_CHAT_REPLAY_EVENTS, NATIVE_CHAT_TURN_PROTOCOL_VERSION, NativeChatReconnectAction,
    NativeChatSubmissionPhase, NativeChatTurnEvent, NativeChatTurnEventKind,
    NativeChatTurnIdentity, stale_identity, validate_evidence_sequence,
};
use serde::{Deserialize, Serialize};

/// Serializable bounded checkpoint. Restore validates this state against an
/// expected full identity; it never starts a fresh deduplication window.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeChatTurnCheckpoint {
    pub protocol_version: u16,
    pub identity: NativeChatTurnIdentity,
    pub submission_phase: NativeChatSubmissionPhase,
    pub last_sequence: Option<u64>,
    /// Largest sequence evicted from `retained_events`; older replays require
    /// reconciliation instead of being accepted as new events.
    pub replay_floor: u64,
    pub retained_events: Vec<NativeChatTurnEvent>,
    pub provider_final_sequence: Option<u64>,
    pub execution_terminal: Option<NativeChatExecutionTerminal>,
    /// The accepted projection sequence when cancellation took effect (zero
    /// if cancellation occurred before the first event).
    pub cancellation_cutoff: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeChatExecutionTerminal {
    pub status: ChatGenerationStatus,
    /// Sequence in the shared native-chat projection order. This evidence is
    /// recorded only from the fenced Attempt authority, not provider events.
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeChatTurnProjection {
    pub checkpoint: NativeChatTurnCheckpoint,
    pub terminal_status: Option<ChatGenerationStatus>,
    pub reconnect_action: NativeChatReconnectAction,
}

impl NativeChatTurnCheckpoint {
    pub fn validate_for(
        &self,
        expected_identity: &NativeChatTurnIdentity,
    ) -> Result<(), RuntimeError> {
        expected_identity.validate()?;
        self.identity.validate()?;
        if &self.identity != expected_identity {
            return Err(stale_identity());
        }
        if self.protocol_version != NATIVE_CHAT_TURN_PROTOCOL_VERSION {
            return Err(RuntimeError::invalid(
                "unsupported native chat turn checkpoint version",
            ));
        }
        if self.retained_events.len() > MAX_NATIVE_CHAT_REPLAY_EVENTS {
            return Err(RuntimeError::invalid(
                "native chat checkpoint replay window exceeds its bound",
            ));
        }
        if self.replay_floor > self.last_sequence.unwrap_or_default() {
            return Err(RuntimeError::invalid(
                "native chat checkpoint replay floor exceeds its last sequence",
            ));
        }
        if self.retained_events.len() < MAX_NATIVE_CHAT_REPLAY_EVENTS && self.replay_floor != 0 {
            return Err(RuntimeError::invalid(
                "native chat checkpoint replay floor is nonzero before the bounded window filled",
            ));
        }

        let mut previous_sequence = None;
        for event in &self.retained_events {
            event.validate()?;
            if event.identity != self.identity {
                return Err(stale_identity());
            }
            if event.sequence <= self.replay_floor
                || previous_sequence.is_some_and(|previous| event.sequence <= previous)
            {
                return Err(RuntimeError::invalid(
                    "native chat checkpoint event history is not strictly ordered",
                ));
            }
            previous_sequence = Some(event.sequence);
        }
        let latest_sequence = previous_sequence.unwrap_or_default().max(
            self.execution_terminal
                .as_ref()
                .map_or(0, |terminal| terminal.sequence),
        );
        let expected_last_sequence = (latest_sequence > 0).then_some(latest_sequence);
        if self.last_sequence != expected_last_sequence {
            return Err(RuntimeError::invalid(
                "native chat checkpoint last sequence does not match retained evidence",
            ));
        }
        validate_evidence_sequence(
            self.provider_final_sequence,
            &self.retained_events,
            self.replay_floor,
            self.last_sequence,
            |event| matches!(event, NativeChatTurnEventKind::ProviderFinal { .. }),
            "provider final",
        )?;
        if let Some(terminal) = &self.execution_terminal {
            if !terminal.status.is_terminal() {
                return Err(RuntimeError::invalid(
                    "native chat checkpoint terminal status is not terminal",
                ));
            }
            if terminal.sequence == 0
                || terminal.sequence > self.last_sequence.unwrap_or_default()
                || self
                    .retained_events
                    .iter()
                    .any(|event| event.sequence == terminal.sequence)
            {
                return Err(RuntimeError::invalid(
                    "native chat checkpoint Attempt terminal evidence has an invalid sequence",
                ));
            }
            if terminal.status != ChatGenerationStatus::Completed
                && self
                    .provider_final_sequence
                    .is_some_and(|sequence| sequence > terminal.sequence)
            {
                return Err(RuntimeError::invalid(
                    "native provider final cannot follow a non-success execution terminal",
                ));
            }
        }
        if self
            .cancellation_cutoff
            .is_some_and(|cutoff| cutoff != self.last_sequence.unwrap_or_default())
        {
            return Err(RuntimeError::invalid(
                "native chat checkpoint cancellation cutoff does not match its event history",
            ));
        }
        if self.cancellation_cutoff.is_some() && self.execution_terminal.is_some() {
            return Err(RuntimeError::invalid(
                "native chat checkpoint cannot contain Attempt terminal evidence after cancellation",
            ));
        }
        if self.submission_phase == NativeChatSubmissionPhase::PreSubmission
            && !self.retained_events.is_empty()
        {
            return Err(RuntimeError::invalid(
                "native chat checkpoint cannot remain pre-submission after recording events",
            ));
        }
        let accepted_provider_evidence = self.retained_events.iter().any(|event| {
            matches!(
                event.event,
                NativeChatTurnEventKind::Commentary { .. }
                    | NativeChatTurnEventKind::ToolActivity { .. }
                    | NativeChatTurnEventKind::ProviderFinal { .. }
                    | NativeChatTurnEventKind::SubmissionAccepted
            )
        });
        if (accepted_provider_evidence || self.provider_final_sequence.is_some())
            && self.submission_phase != NativeChatSubmissionPhase::Accepted
        {
            return Err(RuntimeError::invalid(
                "native chat checkpoint has terminal provider evidence without accepted submission",
            ));
        }
        if self.submission_phase == NativeChatSubmissionPhase::Unknown
            && self.retained_events.iter().any(|event| {
                matches!(
                    event.event,
                    NativeChatTurnEventKind::SubmissionIndeterminate
                )
            })
        {
            return Err(RuntimeError::invalid(
                "native chat checkpoint lost indeterminate submission evidence",
            ));
        }
        Ok(())
    }
}
