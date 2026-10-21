//! Fenced session/input sequencing for providers with a native create-session
//! response. Prompt text is loaded only at InputPreSubmission and can leave
//! this boundary only through a fresh, single-use effect dispatch.
use rudder_d1_persistence::{
    native_chat::{
        NativeChatExecutionPrincipal,
        execution::{
            self, CheckpointSnapshot, CheckpointTransition, EffectDispatch, ExecutionFence,
            NativeInterruptPermit, NativeInterruptTarget, StopIntent,
        },
    },
    runtime_bindings,
};
use rudder_native_process_transport::ConnectionReceipt;
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
    connection: Option<ConnectionReceipt>,
    stop: Option<StopIntent>,
    connection_bound_to_stop: bool,
    renewed: Instant,
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
            connection: None,
            stop: None,
            connection_bound_to_stop: false,
            renewed: Instant::now(),
        })
    }

    /// Register the one owned process connection before provider effects.
    /// A Stop committed during spawn is latched and bound to this exact owner.
    pub(crate) fn register_connection(&mut self, connection: ConnectionReceipt) -> Result<()> {
        if self.connection.is_some() {
            return Err(conflict(
                "Native provider connection was already registered",
            ));
        }
        self.connection = Some(connection);
        self.refresh_stop(false)?;
        Ok(())
    }

    pub(crate) fn take_connection(&mut self) -> Result<ConnectionReceipt> {
        self.connection
            .take()
            .ok_or_else(|| conflict("Native provider connection receipt is missing"))
    }

    pub(crate) fn connection(&self) -> Option<&ConnectionReceipt> {
        self.connection.as_ref()
    }

    pub(crate) fn stop(&self) -> Option<&StopIntent> {
        self.stop.as_ref()
    }

    /// Observe durable Stop and, only for the exact currently-dispatched
    /// session/input, reserve one provider-native interrupt on the registered
    /// owned connection. The permit is consumed by the adapter's one write.
    pub(crate) fn poll_stop(&mut self) -> Result<Option<NativeInterruptPermit>> {
        self.refresh_stop(true)
    }

    /// Keep the exact execution fence alive while the owned process host is
    /// performing bounded terminal cleanup. This path only observes/binds a
    /// Stop and renews the matching lease; it never reserves an interrupt.
    /// Its DB-operation deadline is supplied by the cleanup wait and remains
    /// usable after the provider turn's input deadline has elapsed.
    pub(crate) fn cleanup_tick(&mut self, operation_deadline: Instant) -> Result<()> {
        let _ = self.refresh_stop_until(false, operation_deadline, true)?;
        Ok(())
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
        if !self.current_request_matches(request) {
            return Err(conflict("Native terminal request changed"));
        }
        // A terminal observed after Stop is evidence for the native Stop
        // finalizer, but must not advance the ordinary checkpoint. Keeping
        // InputIndeterminate preserves the one-use input fence until that
        // finalizer atomically validates provider terminal and host cleanup.
        self.refresh_stop(false)?;
        if self.stop.is_some() {
            return Ok(());
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
        if let Err(error) = self.advance(record) {
            // Stop can win the D1 lock between the read above and the first
            // terminal write. Re-read that exact fence before reporting a
            // persistence error; never advance the normal checkpoint under
            // Stop.
            self.refresh_stop(false)?;
            return if self.stop.is_some() {
                Ok(())
            } else {
                Err(error)
            };
        }
        if let Err(error) = self.advance(observe) {
            self.refresh_stop(false)?;
            return if self.stop.is_some() {
                Ok(())
            } else {
                Err(error)
            };
        }
        Ok(())
    }

    fn current_request_matches(&self, request: &str) -> bool {
        match self.snapshot.provider {
            NativeChatProvider::CursorLocal => {
                self.snapshot.cursor_prompt_request_id.as_deref() == Some(request)
            }
            NativeChatProvider::OpenCodeLocal => {
                self.snapshot.opencode_prompt_request_id.as_deref() == Some(request)
            }
            _ => false,
        }
    }

    fn refresh_stop(&mut self, reserve_interrupt: bool) -> Result<Option<NativeInterruptPermit>> {
        self.refresh_stop_until(reserve_interrupt, self.deadline, false)
    }

    fn refresh_stop_until(
        &mut self,
        reserve_interrupt: bool,
        operation_deadline: Instant,
        force_renewal: bool,
    ) -> Result<Option<NativeInterruptPermit>> {
        // Read the Stop fence before choosing the lease renewal path. If the
        // owner is already stopping, renewing the ordinary lease returns 409
        // and can strand a live provider before its interrupt is considered.
        self.observe_stop_until(operation_deadline)?;
        self.bind_stop_connection_until(operation_deadline)?;

        let now = Instant::now();
        if force_renewal || now.saturating_duration_since(self.renewed) >= Duration::from_secs(10) {
            if let Some(stop) = self.stop.clone() {
                self.wait_until(
                    operation_deadline,
                    execution::renew_stopping_lease(self.pool, self.actor, self.fence, &stop),
                )?;
                self.renewed = Instant::now();
            } else {
                match self.wait_until(
                    operation_deadline,
                    execution::renew_lease(self.pool, self.actor, self.fence),
                ) {
                    Ok(_) => self.renewed = Instant::now(),
                    Err(error) if matches!(&error, runtime_bindings::Error::Http(409, _)) => {
                        // Stop may win after the first read but before the
                        // normal renewal lock. Re-read that exact fence and
                        // switch to the stopping lease only when it exists.
                        self.observe_stop_until(operation_deadline)?;
                        if self.stop.is_none() {
                            return Err(error);
                        }
                        self.bind_stop_connection_until(operation_deadline)?;
                        let stop = self
                            .stop
                            .clone()
                            .ok_or_else(|| conflict("Native Stop fence is missing"))?;
                        self.wait_until(
                            operation_deadline,
                            execution::renew_stopping_lease(
                                self.pool, self.actor, self.fence, &stop,
                            ),
                        )?;
                        self.renewed = Instant::now();
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        let Some(stop) = self.stop.as_ref() else {
            return Ok(None);
        };
        let Some(connection) = self.connection.as_ref() else {
            return Ok(None);
        };
        if !reserve_interrupt || self.snapshot.phase != Phase::InputIndeterminate {
            return Ok(None);
        }
        let target = match self.snapshot.provider {
            NativeChatProvider::CursorLocal => NativeInterruptTarget::Cursor {
                session_id: self
                    .snapshot
                    .cursor_session
                    .as_ref()
                    .map(|session| session.as_str().to_owned())
                    .ok_or_else(|| conflict("Cursor Stop session is missing"))?,
                request_id: self
                    .snapshot
                    .cursor_prompt_request_id
                    .clone()
                    .ok_or_else(|| conflict("Cursor Stop request is missing"))?,
            },
            NativeChatProvider::OpenCodeLocal => NativeInterruptTarget::OpenCode {
                session_id: self
                    .snapshot
                    .opencode_session
                    .as_ref()
                    .map(|session| session.as_str().to_owned())
                    .ok_or_else(|| conflict("OpenCode Stop session is missing"))?,
                request_id: self
                    .snapshot
                    .opencode_prompt_request_id
                    .clone()
                    .ok_or_else(|| conflict("OpenCode Stop request is missing"))?,
            },
            _ => return Err(conflict("Unsupported native interrupt provider")),
        };
        self.wait_until(
            operation_deadline,
            execution::reserve_native_interrupt(
                self.pool, self.actor, self.fence, stop, connection, &target,
            ),
        )
    }

    fn observe_stop_until(&mut self, deadline: Instant) -> Result<()> {
        if let Some(stop) = self.wait_until(
            deadline,
            execution::observe_stop(self.pool, self.actor, self.fence),
        )? {
            self.stop = Some(stop);
        }
        Ok(())
    }

    fn bind_stop_connection_until(&mut self, deadline: Instant) -> Result<()> {
        let (Some(stop), Some(connection)) = (self.stop.as_ref(), self.connection.as_ref()) else {
            return Ok(());
        };
        if !self.connection_bound_to_stop {
            self.wait_until(
                deadline,
                execution::bind_stopping_connection(
                    self.pool, self.actor, self.fence, stop, connection,
                ),
            )?;
            self.connection_bound_to_stop = true;
        }
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
        self.wait_until(self.deadline, future)
    }

    fn wait_until<T>(
        &self,
        deadline: Instant,
        future: impl Future<Output = Result<T>>,
    ) -> Result<T> {
        wait(self.handle, deadline, future)
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
