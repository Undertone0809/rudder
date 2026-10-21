//! Fenced session/input sequencing for providers with a native create-session
//! response. Prompt text is loaded only at InputPreSubmission and can leave
//! this boundary only through a fresh, single-use effect dispatch.
use rudder_d1_persistence::{
    native_chat::{
        NativeChatExecutionPrincipal,
        execution::{
            self, CheckpointSnapshot, CheckpointTransition, EffectDispatch, ExecutionFence,
        },
    },
    runtime_bindings,
};
use rudder_runtime_core::native_chat::{NativeChatProtocolPhase as Phase, NativeChatProvider};
use sqlx::PgPool;
use std::{
    future::Future,
    time::{Duration, Instant},
};
use tokio::runtime::Handle;

type Result<T> = std::result::Result<T, runtime_bindings::Error>;

pub(crate) struct NativeTurnAuthority<'a> {
    handle: &'a Handle,
    pool: &'a PgPool,
    actor: &'a NativeChatExecutionPrincipal,
    fence: &'a ExecutionFence,
    deadline: Instant,
    snapshot: CheckpointSnapshot,
}

impl<'a> NativeTurnAuthority<'a> {
    pub(crate) fn new(
        handle: &'a Handle,
        pool: &'a PgPool,
        actor: &'a NativeChatExecutionPrincipal,
        fence: &'a ExecutionFence,
        deadline: Instant,
    ) -> Result<Self> {
        let snapshot = wait(
            handle,
            deadline,
            execution::current_checkpoint(pool, actor, fence),
        )?;
        if !matches!(snapshot.phase, Phase::NoThreadRequest | Phase::ThreadKnown)
            || !matches!(
                snapshot.provider,
                NativeChatProvider::CursorLocal | NativeChatProvider::OpenCodeLocal
            )
        {
            return Err(conflict(
                "Native turn cannot dispatch from a restored pending effect",
            ));
        }
        wait(
            handle,
            deadline,
            execution::validate_submission_source(pool, actor, fence),
        )?;
        Ok(Self {
            handle,
            pool,
            actor,
            fence,
            deadline,
            snapshot,
        })
    }

    pub(crate) fn existing_session(&self) -> Option<&str> {
        match self.snapshot.provider {
            NativeChatProvider::CursorLocal => {
                self.snapshot.cursor_session.as_ref().map(|s| s.as_str())
            }
            NativeChatProvider::OpenCodeLocal => {
                self.snapshot.opencode_session.as_ref().map(|s| s.as_str())
            }
            _ => None,
        }
    }

    pub(crate) fn start_session<T>(&mut self, dispatch: impl FnOnce() -> T) -> Result<T> {
        if self.snapshot.phase != Phase::NoThreadRequest {
            return Err(conflict("Native session start is not fresh"));
        }
        let transition = match self.snapshot.provider {
            NativeChatProvider::CursorLocal => CheckpointTransition::PrepareCursorSessionStart,
            NativeChatProvider::OpenCodeLocal => CheckpointTransition::PrepareOpenCodeSessionStart,
            _ => return Err(conflict("Unsupported native session provider")),
        };
        let mut prepared = self.advance(transition)?;
        let permit = prepared
            .take_effect_permit()
            .ok_or_else(|| conflict("Native session permit missing"))?;
        let effect = self.wait(execution::authorize_effect(
            self.pool, self.actor, permit, None,
        ))?;
        effect.dispatch(|payload| match (self.snapshot.provider, payload) {
            (NativeChatProvider::CursorLocal, EffectDispatch::StartCursorSession)
            | (NativeChatProvider::OpenCodeLocal, EffectDispatch::StartOpenCodeSession) => {
                Ok(dispatch())
            }
            _ => Err(conflict("Native session permit provider mismatch")),
        })?
    }

    pub(crate) fn record_session(&mut self, session: &str) -> Result<()> {
        if self.snapshot.phase == Phase::ThreadKnown {
            return if self.existing_session() == Some(session) {
                Ok(())
            } else {
                Err(conflict("Native resumed session changed"))
            };
        }
        let transition = match self.snapshot.provider {
            NativeChatProvider::CursorLocal => CheckpointTransition::RecordCursorSession {
                session_id: session.into(),
            },
            NativeChatProvider::OpenCodeLocal => CheckpointTransition::RecordOpenCodeSession {
                session_id: session.into(),
            },
            _ => return Err(conflict("Unsupported native session provider")),
        };
        self.advance(transition)?;
        Ok(())
    }

    pub(crate) fn submit<T>(
        &mut self,
        request_id: &str,
        dispatch: impl FnOnce(&str) -> T,
    ) -> Result<T> {
        self.advance(CheckpointTransition::PrepareInput)?;
        let input = self.wait(execution::load_submission(
            self.pool, self.actor, self.fence,
        ))?;
        let transition = match self.snapshot.provider {
            NativeChatProvider::CursorLocal => CheckpointTransition::MarkCursorInputIndeterminate {
                request_id: request_id.into(),
            },
            NativeChatProvider::OpenCodeLocal => {
                CheckpointTransition::MarkOpenCodeInputIndeterminate {
                    request_id: request_id.into(),
                }
            }
            _ => return Err(conflict("Unsupported native input provider")),
        };
        let mut marked = self.advance(transition)?;
        let permit = marked
            .take_effect_permit()
            .ok_or_else(|| conflict("Native input permit missing"))?;
        let effect = self.wait(execution::authorize_effect(
            self.pool,
            self.actor,
            permit,
            Some(input),
        ))?;
        let session = self
            .existing_session()
            .ok_or_else(|| conflict("Native input session missing"))?;
        effect.dispatch(|payload| match (self.snapshot.provider, payload) {
            (
                NativeChatProvider::CursorLocal,
                EffectDispatch::SubmitCursorInput {
                    session_id, body, ..
                },
            )
            | (
                NativeChatProvider::OpenCodeLocal,
                EffectDispatch::SubmitOpenCodeInput {
                    session_id, body, ..
                },
            ) if session_id == session => Ok(dispatch(body)),
            _ => Err(conflict("Native input permit provider or session mismatch")),
        })?
    }

    pub(crate) fn terminal(&mut self, session: &str, request: &str) -> Result<()> {
        if self.existing_session() != Some(session) {
            return Err(conflict("Native terminal session changed"));
        }
        let (record, observe) = match self.snapshot.provider {
            NativeChatProvider::CursorLocal => (
                CheckpointTransition::RecordCursorTurn,
                CheckpointTransition::ObserveCursorProviderTerminal {
                    session_id: session.into(),
                    request_id: request.into(),
                },
            ),
            NativeChatProvider::OpenCodeLocal => (
                CheckpointTransition::RecordOpenCodeTurn,
                CheckpointTransition::ObserveOpenCodeProviderTerminal {
                    session_id: session.into(),
                    request_id: request.into(),
                },
            ),
            _ => return Err(conflict("Unsupported native terminal provider")),
        };
        self.advance(record)?;
        self.advance(observe)?;
        Ok(())
    }

    fn advance(
        &mut self,
        transition: CheckpointTransition,
    ) -> Result<execution::CheckpointReceipt> {
        let receipt = self.wait(execution::advance_checkpoint(
            self.pool,
            self.actor,
            self.fence,
            self.snapshot.phase,
            self.snapshot.revision,
            transition,
        ))?;
        self.snapshot = receipt.snapshot().clone();
        Ok(receipt)
    }

    fn wait<T>(&self, future: impl Future<Output = Result<T>>) -> Result<T> {
        wait(self.handle, self.deadline, future)
    }
}

fn wait<T>(
    handle: &Handle,
    deadline: Instant,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    handle.block_on(async {
        tokio::time::timeout(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_secs(5)),
            future,
        )
        .await
        .map_err(|_| conflict("Native turn authority deadline expired"))?
    })
}

fn conflict(message: &str) -> runtime_bindings::Error {
    runtime_bindings::Error::Http(409, message.into())
}
