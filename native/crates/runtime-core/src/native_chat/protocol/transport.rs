//! Checkpoints for the existing process, HTTP and Gateway transports. A local
//! request correlation is never a provider session or a Codex Thread/Turn.
use super::*;

impl NativeChatProvider {
    pub const fn is_transport(self) -> bool {
        matches!(
            self,
            Self::Process | Self::Http | Self::HermesGateway | Self::OpenClawGateway
        )
    }

    pub fn matches_runtime(self, runtime: &str) -> bool {
        if self == Self::CursorLocal {
            return matches!(runtime, "cursor" | "cursor_local");
        }
        if self == Self::Process {
            !matches!(
                runtime,
                "http"
                    | "hermes_gateway"
                    | "openclaw_gateway"
                    | "codex_local"
                    | "pi_local"
                    | "hermes_local"
                    | "claude_local"
                    | "cursor"
                    | "cursor_local"
                    | "opencode_local"
            )
        } else {
            self.runtime_type() == runtime
        }
    }

    pub const fn runtime_type(self) -> &'static str {
        match self {
            Self::CodexLocal => "codex_local",
            Self::PiLocal => "pi_local",
            Self::HermesLocal => "hermes_local",
            Self::ClaudeLocal => "claude_local",
            Self::OpenCodeLocal => "opencode_local",
            Self::CursorLocal => "cursor",
            Self::Process => "process",
            Self::Http => "http",
            Self::HermesGateway => "hermes_gateway",
            Self::OpenClawGateway => "openclaw_gateway",
        }
    }
}

impl NativeChatProtocolCheckpoint {
    pub fn new_transport(
        provider: NativeChatProvider,
        session: Option<String>,
    ) -> Result<Self, RuntimeError> {
        if !provider.is_transport() {
            return Err(RuntimeError::invalid(
                "expected a request or process transport",
            ));
        }
        let mut state = Self::new(NativeChatProtocolStart::FreshThread)?;
        state.provider = Some(provider);
        state.phase = if session.is_some() {
            NativeChatProtocolPhase::ThreadKnown
        } else {
            NativeChatProtocolPhase::NoThreadRequest
        };
        state.transport_session = session;
        state.validate()?;
        Ok(state)
    }

    pub fn transport_session(&self) -> Option<&str> {
        self.transport_session.as_deref()
    }
    pub fn transport_request_id(&self) -> Option<&str> {
        self.transport_request_id.as_deref()
    }

    pub fn prepare_transport_input(
        &self,
        expected_revision: u64,
        request_id: String,
    ) -> Result<Self, RuntimeError> {
        self.validate()?;
        if !self.provider().is_transport()
            || self.revision != expected_revision
            || !matches!(
                self.phase,
                NativeChatProtocolPhase::NoThreadRequest | NativeChatProtocolPhase::ThreadKnown
            )
            || self.transport_request_id.is_some()
        {
            return Err(RuntimeError::fence("transport invocation is not fresh"));
        }
        validate_opaque_session(&request_id, "invalid transport request identity")?;
        let mut next = self.clone();
        next.phase = NativeChatProtocolPhase::InputIndeterminate;
        next.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::invalid("checkpoint revision exhausted"))?;
        next.transport_request_id = Some(request_id);
        next.validate()?;
        Ok(next)
    }

    pub fn record_transport_terminal(
        &self,
        expected_revision: u64,
        request_id: &str,
        session: Option<String>,
    ) -> Result<Self, RuntimeError> {
        self.validate()?;
        if !self.provider().is_transport()
            || self.revision != expected_revision
            || self.phase != NativeChatProtocolPhase::InputIndeterminate
            || self.transport_request_id() != Some(request_id)
        {
            return Err(RuntimeError::fence(
                "transport terminal belongs to another invocation",
            ));
        }
        let mut next = self.clone();
        next.phase = NativeChatProtocolPhase::ProviderTerminalObserved;
        next.revision = self
            .revision
            .checked_add(1)
            .ok_or_else(|| RuntimeError::invalid("checkpoint revision exhausted"))?;
        if let Some(session) = session {
            next.transport_session = Some(session);
        }
        next.validate()?;
        Ok(next)
    }

    pub(super) fn validate_transport(&self) -> Result<(), RuntimeError> {
        use NativeChatProtocolPhase::*;
        if self.thread_id.is_some()
            || self.turn_id.is_some()
            || self.pi_session.is_some()
            || self.pi_turn_entry_id.is_some()
            || self.hermes_session.is_some()
            || self.hermes_prompt_request_id.is_some()
            || self.claude_session.is_some()
            || self.claude_prompt_request_id.is_some()
            || self.claude_combined_input
            || self.cursor_session.is_some()
            || self.cursor_prompt_request_id.is_some()
            || self.opencode_session.is_some()
            || self.opencode_prompt_request_id.is_some()
            || self.observation_only
        {
            return Err(RuntimeError::invalid(
                "transport checkpoint contains foreign provider identity",
            ));
        }
        if let Some(id) = &self.transport_session {
            validate_opaque_session(id, "invalid transport session identity")?;
        }
        if let Some(id) = &self.transport_request_id {
            validate_opaque_session(id, "invalid transport request identity")?;
        }
        if !matches!(
            self.phase,
            NoThreadRequest
                | ThreadKnown
                | InputIndeterminate
                | ProviderTerminalObserved
                | ExecutionTerminalCommitted
        ) || (matches!(self.phase, InputIndeterminate | ProviderTerminalObserved)
            && self.transport_request_id.is_none())
            || (matches!(self.phase, NoThreadRequest | ThreadKnown)
                && self.transport_request_id.is_some())
            || (self.phase == NoThreadRequest && self.transport_session.is_some())
            || (self.phase == ThreadKnown && self.transport_session.is_none())
        {
            return Err(RuntimeError::invalid(
                "transport phase and invocation identity disagree",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn four_transports_keep_optional_real_sessions_and_no_replay_capability() {
        for provider in [
            NativeChatProvider::Process,
            NativeChatProvider::Http,
            NativeChatProvider::HermesGateway,
            NativeChatProvider::OpenClawGateway,
        ] {
            for session in [None, Some("actual-provider-session".to_owned())] {
                let initial =
                    NativeChatProtocolCheckpoint::new_transport(provider, session.clone()).unwrap();
                let active = initial
                    .prepare_transport_input(0, "local-request".into())
                    .unwrap();
                assert!(active.prepare_transport_input(1, "replay".into()).is_err());
                assert!(active.record_transport_terminal(1, "wrong", None).is_err());
                let done = active
                    .record_transport_terminal(1, "local-request", session)
                    .unwrap();
                assert!(done.thread_id().is_none());
                assert!(done.turn_id().is_none());
                let roundtrip: NativeChatProtocolCheckpoint =
                    serde_json::from_value(serde_json::to_value(done).unwrap()).unwrap();
                roundtrip.validate().unwrap();
                assert!(
                    roundtrip
                        .prepare_transport_input(2, "replay".into())
                        .is_err()
                );
            }
        }
    }
}
