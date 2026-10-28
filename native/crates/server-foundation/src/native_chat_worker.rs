//! Process-owned execution of already admitted Native Chat attempts.
//!
//! This is an in-process Rust API, not an HTTP admission/Stop API. Jobs are not
//! reconstructed for ordinary requests on restart. The Automation producer
//! may rediscover only its never-claimed durable admissions. Claimed attempts
//! stay unresolved; durable admission exclusion still prevents a fresh turn.
//! Claimed attempts retain their hold until a separate authority resolves them.
use futures_util::FutureExt;
use rudder_auth_core::VerifiedActor;
use rudder_d1_persistence::native_chat::{
    BrowserPrincipal, NativeChatActor, config::LocalHostContext, execution,
};
use rudder_native_chat_executor::{ExecutionRequest, HostPaths};
use sqlx::PgPool;
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, oneshot, watch},
    task::JoinHandle,
    time::Instant,
};

const MAX_ACTIVE: usize = 2;
const MAX_RETAINED: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnresolvedReason {
    ExecutionUnresolved,
    MissingCleanupProof,
    FinalizationUnresolved,
    WorkerInterrupted,
    /// A provider produced a terminal-shaped observation, but the shared D1
    /// projection has no provider-native finalizer for it yet. This must stay
    /// visible as unresolved rather than being coerced into Codex IDs.
    ProviderTerminalUnsupported,
    /// The provider adapter could not prove cleanup or settlement. The held
    /// attempt requires reconciliation by its owning authority.
    ProviderCleanupUnknown,
}

/// An observation of this process only. Durable Run state remains authoritative.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Running,
    /// The finalizer committed its result; budget/projection holds may remain.
    FinalizationCommitted,
    Unresolved(UnresolvedReason),
}

#[derive(Debug, thiserror::Error, Eq, PartialEq)]
pub enum StartError {
    #[error("Native Chat worker is shutting down")]
    Closed,
    #[error("Native Chat worker cannot start this attempt")]
    Busy,
    #[error("Native Chat worker requires valid admitted attempt identifiers")]
    InvalidIdentity,
}

#[derive(Debug, thiserror::Error)]
#[error("Native Chat workers did not prove completion within shutdown grace")]
pub struct DrainIncomplete;

/// Trusted host data only. No prompt, serialized actor, or caller cancellation
/// flag crosses this boundary; the worker owns cancellation and execution.
pub struct Job {
    actor: RequestActor,
    host: LocalHostContext,
    paths: HostPaths,
    key: Key,
    timeout: Duration,
}

/// Request credentials are kept only until the executor completes its D1
/// claim. The executor consumes this actor and returns a different, move-only
/// execution principal for every continuation and finalizer.
enum RequestActor {
    Verified(VerifiedActor),
    Browser(BrowserPrincipal),
    Automation(rudder_d1_persistence::native_chat::AutomationChatActor),
}

impl RequestActor {
    fn organization_id(&self) -> &str {
        match self {
            Self::Verified(actor) => actor.organization_id(),
            Self::Browser(actor) => NativeChatActor::organization_id(actor),
            Self::Automation(actor) => NativeChatActor::organization_id(actor),
        }
    }
}

impl Job {
    /// Private producer capability from a persisted Automation/Chat identity;
    /// no request DTO can select this actor or construct the job source.
    pub(crate) fn new_automation(
        job: rudder_d1_persistence::native_chat::AutomationChatJob,
        host: LocalHostContext,
        paths: HostPaths,
        timeout: Duration,
    ) -> Result<Self, StartError> {
        let (actor, run, attempt) = job.into_parts();
        Self::with_actor(
            RequestActor::Automation(actor),
            host,
            paths,
            &run,
            &attempt,
            timeout,
        )
    }

    pub fn new(
        actor: VerifiedActor,
        host: LocalHostContext,
        paths: HostPaths,
        run_id: &str,
        attempt_id: &str,
        timeout: Duration,
    ) -> Result<Self, StartError> {
        Self::with_actor(
            RequestActor::Verified(actor),
            host,
            paths,
            run_id,
            attempt_id,
            timeout,
        )
    }

    /// Construct a process-owned job from Foundation's authenticated browser
    /// principal. D1 revalidates the credential in the claim transaction;
    /// this request actor is not retained for execution continuations.
    pub fn new_browser(
        actor: BrowserPrincipal,
        host: LocalHostContext,
        paths: HostPaths,
        run_id: &str,
        attempt_id: &str,
        timeout: Duration,
    ) -> Result<Self, StartError> {
        Self::with_actor(
            RequestActor::Browser(actor),
            host,
            paths,
            run_id,
            attempt_id,
            timeout,
        )
    }

    fn with_actor(
        actor: RequestActor,
        host: LocalHostContext,
        paths: HostPaths,
        run_id: &str,
        attempt_id: &str,
        timeout: Duration,
    ) -> Result<Self, StartError> {
        let run_id = uuid::Uuid::parse_str(run_id).map_err(|_| StartError::InvalidIdentity)?;
        let attempt_id =
            uuid::Uuid::parse_str(attempt_id).map_err(|_| StartError::InvalidIdentity)?;
        if timeout.is_zero() || timeout > Duration::from_secs(3600) {
            return Err(StartError::InvalidIdentity);
        }
        Ok(Self {
            key: Key {
                organization_id: actor.organization_id().to_owned(),
                run_id: run_id.to_string(),
                attempt_id: attempt_id.to_string(),
            },
            actor,
            host,
            paths,
            timeout,
        })
    }
}

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
struct Key {
    organization_id: String,
    run_id: String,
    attempt_id: String,
}

/// Dropping a ticket does not cancel a job or release its admission hold.
pub struct Ticket(watch::Receiver<Status>);

impl Ticket {
    pub fn status(&self) -> Status {
        *self.0.borrow()
    }

    pub async fn wait(mut self) -> Status {
        loop {
            let status = self.status();
            if status != Status::Running {
                return status;
            }
            if self.0.changed().await.is_err() {
                return Status::Unresolved(UnresolvedReason::WorkerInterrupted);
            }
        }
    }
}

struct Entry {
    cancelled: Arc<AtomicBool>,
    status: watch::Sender<Status>,
    task: Option<JoinHandle<Completion>>,
    // Release only after joining a worker that proves no owned process remains.
    slot: Option<OwnedSemaphorePermit>,
}

#[derive(Default)]
struct State {
    closed: bool,
    reservations: usize,
    admission_failure: bool,
    admission_tasks: Vec<JoinHandle<()>>,
    jobs: BTreeMap<Key, Entry>,
}

struct Inner {
    pool: PgPool,
    slots: Arc<Semaphore>,
    state: Mutex<State>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        // Abnormal owner loss is only a cancellation request. It is not a
        // shutdown/cleanup receipt and cannot finalize any durable attempt.
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        for entry in state.jobs.values() {
            entry.cancelled.store(true, Ordering::Release);
        }
    }
}

#[derive(Clone)]
pub struct Supervisor(Arc<Inner>);

impl Supervisor {
    pub(crate) fn new(pool: PgPool) -> Self {
        Self(Arc::new(Inner {
            pool,
            slots: Arc::new(Semaphore::new(MAX_ACTIVE)),
            state: Mutex::new(State::default()),
        }))
    }

    /// Reserve bounded worker and retained-observation capacity before D1
    /// admission commits. The reservation owns no request identity and cannot
    /// start until the caller supplies the resulting admitted Run/Attempt.
    pub fn reserve_before_admission(&self) -> Result<AdmissionReservation, StartError> {
        let handle = tokio::runtime::Handle::current();
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.closed {
            return Err(StartError::Closed);
        }
        reap(&mut state);
        let slot = Arc::clone(&self.0.slots)
            .try_acquire_owned()
            .map_err(|_| StartError::Busy)?;
        if !make_retained_room(&mut state) {
            return Err(StartError::Busy);
        }
        state.reservations += 1;
        Ok(AdmissionReservation {
            inner: Arc::clone(&self.0),
            handle,
            slot: Some(slot),
            counted: true,
        })
    }

    /// Start an already-admitted job. New D1 admission flows should acquire
    /// reserve_before_admission before committing the admission transaction.
    /// A duplicate start never returns a cached observation capability. Both
    /// duplicates and capacity exhaustion have the same non-revealing failure.
    /// Claim authorization still happens in D1 for every newly started worker.
    pub fn try_start(&self, job: Job) -> Result<Ticket, StartError> {
        self.reserve_before_admission()?.start(job)
    }

    /// Run the short admission-to-dispatch section under supervisor ownership.
    /// The returned receiver may be dropped with the HTTP request; the bounded
    /// task continues, and shutdown waits for both its reservation and JoinHandle.
    pub(crate) fn spawn_reserved_admission<T, F, Fut>(
        &self,
        reservation: AdmissionReservation,
        work: F,
    ) -> Result<oneshot::Receiver<T>, StartError>
    where
        T: Send + 'static,
        F: FnOnce(AdmissionReservation) -> Fut + Send + 'static,
        Fut: Future<Output = T> + Send + 'static,
    {
        if !Arc::ptr_eq(&self.0, &reservation.inner) {
            return Err(StartError::Busy);
        }
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.closed {
            return Err(StartError::Closed);
        }
        let (sender, receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            let result = work(reservation).await;
            let _ = sender.send(result);
        });
        state.admission_tasks.push(task);
        Ok(receiver)
    }

    #[cfg(test)]
    fn start<F>(&self, key: Key, execute: F) -> Result<Ticket, StartError>
    where
        F: FnOnce(Arc<AtomicBool>) -> Completion + Send + 'static,
    {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.closed {
            return Err(StartError::Closed);
        }
        reap(&mut state);
        if state.jobs.contains_key(&key) {
            return Err(StartError::Busy);
        }
        let slot = Arc::clone(&self.0.slots)
            .try_acquire_owned()
            .map_err(|_| StartError::Busy)?;
        if !make_retained_room(&mut state) {
            return Err(StartError::Busy);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let (status, receiver) = watch::channel(Status::Running);
        let completion = CompletionGuard {
            status: status.clone(),
            completed: false,
        };
        let cancellation = Arc::clone(&cancelled);
        // This handle represents the real blocking executor, including finalizer
        // and transport destruction. There is no nested detached worker.
        let task = tokio::task::spawn_blocking(move || {
            let result = execute(cancellation);
            completion.complete(result.status);
            result
        });
        state.jobs.insert(
            key,
            Entry {
                cancelled,
                status,
                task: Some(task),
                slot: Some(slot),
            },
        );
        Ok(Ticket(receiver))
    }

    pub(crate) fn begin_shutdown(&self) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.closed = true;
        for entry in state.jobs.values() {
            entry.cancelled.store(true, Ordering::Release);
        }
    }

    pub(crate) async fn shutdown(&self, grace: Duration) -> Result<(), DrainIncomplete> {
        self.begin_shutdown();
        let deadline = Instant::now() + grace;
        loop {
            {
                let mut state = self
                    .0
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                reap(&mut state);
                if state.reservations == 0
                    && state.jobs.values().all(|entry| entry.slot.is_none())
                    && state.admission_tasks.is_empty()
                {
                    if state.admission_failure {
                        return Err(DrainIncomplete);
                    }
                    return Ok(());
                }
                // A joined but quarantined worker cannot establish clean drain.
                if state
                    .jobs
                    .values()
                    .any(|entry| entry.task.is_none() && entry.slot.is_some())
                {
                    return Err(DrainIncomplete);
                }
            }
            if Instant::now() >= deadline {
                return Err(DrainIncomplete);
            }
            // Handles always remain in State, even if this future is dropped or
            // concurrent shutdown callers time out. No cancellation can detach
            // a worker by dropping a locally extracted handle.
            tokio::time::sleep_until(deadline.min(Instant::now() + Duration::from_millis(10)))
                .await;
        }
    }
}

/// Move-only process-local capacity reservation for an admission that has not
/// committed yet. Dropping it releases both the semaphore slot and reservation
/// count; shutdown waits for outstanding reservations and refuses late starts.
#[must_use = "hold this reservation until admission fails or it is converted into a job"]
pub struct AdmissionReservation {
    inner: Arc<Inner>,
    handle: tokio::runtime::Handle,
    slot: Option<OwnedSemaphorePermit>,
    counted: bool,
}

impl AdmissionReservation {
    pub fn start(self, job: Job) -> Result<Ticket, StartError> {
        let key = job.key.clone();
        let pool = self.inner.pool.clone();
        let handle = self.handle.clone();
        self.start_with(key, move |cancelled| run(&handle, pool, job, cancelled))
    }

    fn start_with<F>(mut self, key: Key, execute: F) -> Result<Ticket, StartError>
    where
        F: FnOnce(Arc<AtomicBool>) -> Completion + Send + 'static,
    {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if state.closed {
            return Err(StartError::Closed);
        }
        reap(&mut state);
        if state.jobs.contains_key(&key) {
            return Err(StartError::Busy);
        }
        if state.reservations == 0 {
            return Err(StartError::Busy);
        }

        let slot = self.slot.take().ok_or(StartError::Busy)?;
        state.reservations -= 1;
        self.counted = false;
        let cancelled = Arc::new(AtomicBool::new(false));
        let (status, receiver) = watch::channel(Status::Running);
        let completion = CompletionGuard {
            status: status.clone(),
            completed: false,
        };
        let cancellation = Arc::clone(&cancelled);
        let task = self.handle.spawn_blocking(move || {
            let result = execute(cancellation);
            completion.complete(result.status);
            result
        });
        state.jobs.insert(
            key,
            Entry {
                cancelled,
                status,
                task: Some(task),
                slot: Some(slot),
            },
        );
        Ok(Ticket(receiver))
    }
}

impl Drop for AdmissionReservation {
    fn drop(&mut self) {
        if !self.counted {
            return;
        }
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        debug_assert!(state.reservations > 0);
        state.reservations = state.reservations.saturating_sub(1);
    }
}

struct Completion {
    status: Status,
    quiescent: bool,
}

fn reap(state: &mut State) {
    let mut pending_admissions = Vec::new();
    for mut task in std::mem::take(&mut state.admission_tasks) {
        if task.is_finished() {
            match (&mut task).now_or_never() {
                Some(Ok(())) => {}
                Some(Err(_)) => state.admission_failure = true,
                None => pending_admissions.push(task),
            }
        } else {
            pending_admissions.push(task);
        }
    }
    state.admission_tasks = pending_admissions;
    for entry in state.jobs.values_mut() {
        let Some(task) = entry.task.as_mut().filter(|task| task.is_finished()) else {
            continue;
        };
        // Poll by reference so an unexpectedly pending handle remains owned.
        let Some(result) = task.now_or_never() else {
            continue;
        };
        entry.task = None;
        match result {
            Ok(completion) if completion.quiescent => {
                entry.slot = None;
            }
            Ok(_) => {} // Retain quarantined capacity and observation indefinitely.
            Err(_) => {
                entry
                    .status
                    .send_replace(Status::Unresolved(UnresolvedReason::WorkerInterrupted));
            }
        }
    }
}

fn make_retained_room(state: &mut State) -> bool {
    while state.jobs.len() + state.reservations >= MAX_RETAINED {
        let Some(finished) = state.jobs.iter().find_map(|(key, entry)| {
            (entry.task.is_none() && entry.slot.is_none()).then(|| key.clone())
        }) else {
            return false;
        };
        state.jobs.remove(&finished);
    }
    true
}

struct CompletionGuard {
    status: watch::Sender<Status>,
    completed: bool,
}

impl CompletionGuard {
    fn complete(mut self, result: Status) {
        self.status.send_replace(result);
        self.completed = true;
    }
}

impl Drop for CompletionGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.status
                .send_replace(Status::Unresolved(UnresolvedReason::WorkerInterrupted));
        }
    }
}

fn run(
    handle: &tokio::runtime::Handle,
    pool: PgPool,
    job: Job,
    cancelled: Arc<AtomicBool>,
) -> Completion {
    let Job {
        actor,
        host,
        paths,
        key,
        timeout,
    } = job;
    let request = ExecutionRequest {
        organization_id: &key.organization_id,
        run_id: &key.run_id,
        attempt_id: &key.attempt_id,
        timeout,
        cancelled: &cancelled,
    };
    let observation = match actor {
        RequestActor::Verified(actor) => {
            rudder_native_chat_executor::run_observed_native_with_request_actor_on_blocking_thread(
                handle, &pool, actor, &host, &paths, request,
            )
        }
        RequestActor::Browser(actor) => {
            rudder_native_chat_executor::run_observed_native_with_request_actor_on_blocking_thread(
                handle, &pool, actor, &host, &paths, request,
            )
        }
        RequestActor::Automation(actor) => {
            rudder_native_chat_executor::run_observed_native_with_request_actor_on_blocking_thread(
                handle, &pool, actor, &host, &paths, request,
            )
        }
    };
    let observation = match observation {
        Ok(rudder_native_chat_executor::NativeExecutionObservation::Codex(observation)) => {
            observation
        }
        Ok(rudder_native_chat_executor::NativeExecutionObservation::Hermes(observation)) => {
            return finish_hermes_observation(handle, &pool, observation);
        }
        Ok(rudder_native_chat_executor::NativeExecutionObservation::Pi(observation)) => {
            return finish_pi_observation(handle, &pool, observation);
        }
        Ok(rudder_native_chat_executor::NativeExecutionObservation::Claude(observation)) => {
            return finish_claude_observation(handle, &pool, observation);
        }
        Ok(rudder_native_chat_executor::NativeExecutionObservation::Cursor(observation)) => {
            return finish_cursor_observation(handle, &pool, observation);
        }
        Ok(rudder_native_chat_executor::NativeExecutionObservation::OpenCode(observation)) => {
            return finish_opencode_observation(handle, &pool, observation);
        }
        Err(failure) => {
            tracing::warn!(
                run_id = %key.run_id,
                reason = failure.diagnostic_code(),
                process_quiescent = failure.process_quiescent(),
                "Native Chat execution did not produce a terminal receipt"
            );
            let Some(execution_actor) = failure.execution_principal() else {
                return Completion {
                    status: Status::Unresolved(UnresolvedReason::ExecutionUnresolved),
                    quiescent: failure.process_quiescent(),
                };
            };
            if let Some(fence) = failure.fence() {
                // Transport stderr is private and may be unavailable after
                // cleanup. Persist only the closed classification through the
                // same Rust execution fence; never release an ambiguous input.
                let _ = handle.block_on(tokio::time::timeout(
                    Duration::from_secs(5),
                    execution::record_execution_diagnostic(
                        &pool,
                        execution_actor,
                        fence,
                        failure.diagnostic_code(),
                        failure.process_quiescent(),
                    ),
                ));
            }
            if failure.process_disposition()
                == rudder_native_chat_executor::ProcessDisposition::CleanupProven
                && let Some(fence) = failure.fence()
                && (failure.host_cleanup_proof().is_some()
                    || failure.pi_cleanup_receipt().is_some())
            {
                let result = handle.block_on(tokio::time::timeout(Duration::from_secs(5), async {
                    let Some(stop) = execution::observe_stop(&pool, execution_actor, fence).await?
                    else {
                        return Ok::<_, rudder_d1_persistence::runtime_bindings::Error>(None);
                    };
                    if let Some(cleanup) = failure.host_cleanup_proof() {
                        execution::finalize_native_stopped_before_submission(
                            &pool,
                            execution_actor,
                            fence,
                            cleanup,
                            &stop,
                        )
                        .await
                        .map(Some)
                    } else if let Some(cleanup) = failure.pi_cleanup_receipt() {
                        execution::finalize_pi_stopped_before_submission(
                            &pool,
                            execution_actor,
                            fence,
                            cleanup,
                            &stop,
                        )
                        .await
                        .map(Some)
                    } else {
                        Ok(None)
                    }
                }));
                return Completion {
                    status: match result {
                        Ok(Ok(Some(_))) => Status::FinalizationCommitted,
                        Ok(Ok(None)) => Status::Unresolved(UnresolvedReason::ExecutionUnresolved),
                        _ => Status::Unresolved(UnresolvedReason::FinalizationUnresolved),
                    },
                    quiescent: true,
                };
            }
            if failure.process_disposition()
                == rudder_native_chat_executor::ProcessDisposition::CleanupProven
                && let (Some(fence), Some(cleanup)) =
                    (failure.fence(), failure.hermes_cleanup_receipt())
            {
                let status =
                    match handle.block_on(tokio::time::timeout(Duration::from_secs(5), async {
                        let stop = execution::observe_stop(&pool, execution_actor, fence).await?;
                        if let Some(stop) = stop {
                            let connection = cleanup.connection_receipt();
                            execution::bind_stopping_connection(
                                &pool,
                                execution_actor,
                                fence,
                                &stop,
                                &connection,
                            )
                            .await?;
                            if let Some(error) = failure.hermes_prompt_error_after_cancel_receipt()
                            {
                                return execution::finalize_hermes_prompt_error_stopped(
                                    &pool,
                                    execution_actor,
                                    fence,
                                    error,
                                    cleanup,
                                    &stop,
                                )
                                .await
                                .map(Some);
                            }
                            execution::finalize_hermes_stopped_before_submission(
                                &pool,
                                execution_actor,
                                fence,
                                cleanup,
                                &stop,
                            )
                            .await
                            .map(Some)
                        } else if cancelled.load(Ordering::Acquire)
                            || !failure.is_definitive_failure()
                        {
                            Ok(None)
                        } else {
                            execution::finalize_hermes_failed(
                                &pool,
                                execution_actor,
                                fence,
                                cleanup,
                            )
                            .await
                            .map(Some)
                        }
                    })) {
                        Ok(Ok(Some(_))) => Status::FinalizationCommitted,
                        Ok(Ok(None)) => Status::Unresolved(UnresolvedReason::ExecutionUnresolved),
                        _ => Status::Unresolved(UnresolvedReason::FinalizationUnresolved),
                    };
                return Completion {
                    status,
                    quiescent: failure.process_quiescent(),
                };
            }
            let cleanup = failure.cleanup_receipt();
            let status = if failure.process_disposition()
                == rudder_native_chat_executor::ProcessDisposition::CleanupProven
                && let (Some(fence), Some(cleanup)) = (failure.fence(), cleanup)
            {
                let finalization = if !cancelled.load(Ordering::Acquire)
                    && failure.can_finalize_output_limit_failure()
                {
                    // The output-cap finalizer observes Stop while it holds the
                    // exact execution fence. A separate Stop read here could
                    // race with a newly accepted Stop and incorrectly route a
                    // committed prefix through the empty-prefix pre-submission
                    // finalizer.
                    handle
                        .block_on(tokio::time::timeout(
                            Duration::from_secs(5),
                            execution::finalize_output_limit_failure(
                                &pool,
                                execution_actor,
                                fence,
                                cleanup,
                            ),
                        ))
                        .map(|result| result.map(Some))
                } else {
                    handle.block_on(tokio::time::timeout(Duration::from_secs(5), async {
                        let stop = execution::observe_stop(&pool, execution_actor, fence).await?;
                        let connection = cleanup.connection_receipt();
                        if let Some(stop) = stop {
                            execution::bind_stopping_connection(
                                &pool,
                                execution_actor,
                                fence,
                                &stop,
                                &connection,
                            )
                            .await?;
                            execution::finalize_stopped_before_submission(
                                &pool,
                                execution_actor,
                                fence,
                                cleanup,
                                &stop,
                            )
                            .await
                            .map(Some)
                        } else if cancelled.load(Ordering::Acquire)
                            || !failure.is_definitive_failure()
                        {
                            Ok(None)
                        } else {
                            execution::finalize_failed(&pool, execution_actor, fence, cleanup)
                                .await
                                .map(Some)
                        }
                    }))
                };
                match finalization {
                    Ok(Ok(Some(_))) => Status::FinalizationCommitted,
                    Ok(Ok(None)) => Status::Unresolved(UnresolvedReason::ExecutionUnresolved),
                    _ => Status::Unresolved(UnresolvedReason::FinalizationUnresolved),
                }
            } else {
                Status::Unresolved(UnresolvedReason::ExecutionUnresolved)
            };
            return Completion {
                status,
                quiescent: failure.process_quiescent(),
            };
        }
    };
    let Some(cleanup) = observation
        .cleanup_receipt
        .filter(|cleanup| cleanup.proves_quiescence_for(&observation.turn_receipt))
    else {
        return Completion {
            status: Status::Unresolved(UnresolvedReason::MissingCleanupProof),
            quiescent: false,
        };
    };
    // A timed-out commit has unknown outcome. Never retry or infer a released
    // or retained hold from it; durable readback/reconciliation stays separate.
    let status = handle.block_on(async {
        match tokio::time::timeout(Duration::from_secs(5), async {
            if let Some(stop) = &observation.stop {
                return execution::finalize_stopped(
                    &pool,
                    &observation.execution_principal,
                    &observation.fence,
                    &observation.turn_receipt,
                    &cleanup,
                    stop,
                )
                .await;
            }
            let result = execution::finalize(
                &pool,
                &observation.execution_principal,
                &observation.fence,
                &observation.turn_receipt,
                &cleanup,
            )
            .await;
            // Only a definite pre-commit conflict can select a now-visible
            // Stop. Database/timeout errors retain unknown commit outcome.
            if matches!(
                &result,
                Err(rudder_d1_persistence::runtime_bindings::Error::Http(409, _))
            ) && let Some(stop) =
                execution::observe_stop(&pool, &observation.execution_principal, &observation.fence)
                    .await?
            {
                return execution::finalize_stopped(
                    &pool,
                    &observation.execution_principal,
                    &observation.fence,
                    &observation.turn_receipt,
                    &cleanup,
                    &stop,
                )
                .await;
            }
            result
        })
        .await
        {
            Ok(Ok(_)) => Status::FinalizationCommitted,
            _ => Status::Unresolved(UnresolvedReason::FinalizationUnresolved),
        }
    });
    Completion {
        status,
        quiescent: true,
    }
}

fn finish_claude_observation(
    handle: &tokio::runtime::Handle,
    pool: &PgPool,
    observation: rudder_native_chat_executor::ClaudeNativeExecutionObservation,
) -> Completion {
    let rudder_native_chat_executor::ClaudeNativeExecutionObservation {
        execution_principal,
        fence,
        observation: provider,
    } = observation;
    let Some(cleanup) = provider.cleanup.as_ref() else {
        return Completion {
            status: Status::Unresolved(UnresolvedReason::MissingCleanupProof),
            quiescent: false,
        };
    };
    if !fence.matches_host_cleanup_proof(cleanup)
        || provider.connection.connection_receipt_id() != cleanup.connection_receipt_id()
    {
        return Completion {
            status: Status::Unresolved(UnresolvedReason::ProviderCleanupUnknown),
            quiescent: false,
        };
    }
    let Some(request_id) = provider.turn.result_uuid() else {
        return Completion {
            status: Status::Unresolved(UnresolvedReason::ProviderTerminalUnsupported),
            quiescent: false,
        };
    };
    let turn = rudder_d1_persistence::native_chat::execution::NativeProviderTurnReceipt {
        provider: rudder_d1_persistence::native_chat::execution::NativeProviderKind::Claude,
        session_id: provider.turn.session_id().as_str().to_owned(),
        request_id: request_id.to_owned(),
        final_text: provider.turn.summary().map(str::to_owned),
        status: match provider.turn.status() {
            rudder_claude_code::ClaudeTurnStatus::Completed => {
                rudder_d1_persistence::native_chat::execution::NativeProviderStatus::Completed
            }
            rudder_claude_code::ClaudeTurnStatus::Failed => {
                rudder_d1_persistence::native_chat::execution::NativeProviderStatus::Failed
            }
        },
        usage: provider.turn.usage().cloned(),
        evidence: serde_json::json!({
            "provider": "claude_local",
            "sessionId": provider.turn.session_id().as_str(),
            "resultUuid": request_id,
            "subtype": provider.turn.subtype(),
            "isError": provider.turn.is_error(),
        }),
    };
    finalize_native_observation(
        handle,
        pool,
        execution_principal,
        fence,
        turn,
        cleanup,
        provider.stop.as_ref(),
    )
}

fn finish_cursor_observation(
    handle: &tokio::runtime::Handle,
    pool: &PgPool,
    observation: rudder_native_chat_executor::CursorNativeExecutionObservation,
) -> Completion {
    let rudder_native_chat_executor::CursorNativeExecutionObservation {
        execution_principal,
        fence,
        observation: provider,
    } = observation;
    let cleanup = &provider.cleanup;
    if !fence.matches_host_cleanup_proof(cleanup)
        || provider.connection.connection_receipt_id() != cleanup.connection_receipt_id()
    {
        return Completion {
            status: Status::Unresolved(UnresolvedReason::ProviderCleanupUnknown),
            quiescent: false,
        };
    }
    if provider.request_id.trim().is_empty() {
        return Completion {
            status: Status::Unresolved(UnresolvedReason::ProviderTerminalUnsupported),
            quiescent: false,
        };
    }
    let final_text = provider.final_text.or_else(|| {
        provider
            .response
            .get("text")
            .or_else(|| provider.response.get("output"))
            .or_else(|| provider.response.get("message"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    });
    let turn = rudder_d1_persistence::native_chat::execution::NativeProviderTurnReceipt {
        provider: rudder_d1_persistence::native_chat::execution::NativeProviderKind::Cursor,
        session_id: provider.session.as_str().to_owned(),
        request_id: provider.request_id.clone(),
        final_text,
        status: if provider.stop_reason == "cancelled" {
            execution::NativeProviderStatus::Interrupted
        } else {
            execution::NativeProviderStatus::Completed
        },
        usage: None,
        evidence: serde_json::json!({
            "provider": "cursor_local",
            "sessionId": provider.session.as_str(),
            "requestId": provider.request_id,
            "updateCount": provider.update_count,
            "response": provider.response,
        }),
    };
    finalize_native_observation(
        handle,
        pool,
        execution_principal,
        fence,
        turn,
        cleanup,
        provider.stop.as_ref(),
    )
}

fn finish_opencode_observation(
    handle: &tokio::runtime::Handle,
    pool: &PgPool,
    observation: rudder_native_chat_executor::OpenCodeNativeExecutionObservation,
) -> Completion {
    let rudder_native_chat_executor::OpenCodeNativeExecutionObservation {
        execution_principal,
        fence,
        observation: provider,
    } = observation;
    if !fence.matches_host_cleanup_proof(&provider.cleanup)
        || provider.connection.connection_receipt_id() != provider.cleanup.connection_receipt_id()
    {
        return Completion {
            status: Status::Unresolved(UnresolvedReason::ProviderCleanupUnknown),
            quiescent: false,
        };
    }
    use rudder_opencode_native::OpenCodeInputTerminal;
    let turn = match &provider.terminal {
        OpenCodeInputTerminal::Completed(receipt) => execution::NativeProviderTurnReceipt {
            provider: execution::NativeProviderKind::OpenCode,
            session_id: receipt.session_id.clone(),
            request_id: provider.request_id.clone(),
            final_text: (!receipt.final_text.trim().is_empty())
                .then_some(receipt.final_text.clone()),
            status: execution::NativeProviderStatus::Completed,
            usage: receipt
                .tokens
                .as_ref()
                .and_then(|tokens| serde_json::to_value(tokens).ok()),
            evidence: serde_json::json!({"provider":"opencode_local","sessionId":receipt.session_id,
                "userMessageId":receipt.user_message_id,"assistantMessageId":receipt.assistant_message_id,
                "cost":receipt.cost,"cancelAcknowledged":provider.cancel_acknowledged}),
        },
        OpenCodeInputTerminal::Failed(receipt) => execution::NativeProviderTurnReceipt {
            provider: execution::NativeProviderKind::OpenCode,
            session_id: receipt.session_id.clone(),
            request_id: provider.request_id.clone(),
            final_text: None,
            status: execution::NativeProviderStatus::Failed,
            usage: None,
            evidence: serde_json::json!({"provider":"opencode_local","sessionId":receipt.session_id,
                "userMessageId":receipt.user_message_id,"assistantMessageId":receipt.assistant_message_id,
                "providerErrorObserved":true,"cancelAcknowledged":provider.cancel_acknowledged}),
        },
    };
    finalize_native_observation(
        handle,
        pool,
        execution_principal,
        fence,
        turn,
        &provider.cleanup,
        provider.stop.as_ref(),
    )
}

fn finalization_error_code(error: &rudder_d1_persistence::runtime_bindings::Error) -> &'static str {
    use rudder_d1_persistence::runtime_bindings::Error;
    match error {
        Error::Http(401 | 403, _) => "native_finalize_authorization",
        Error::Http(404, _) => "native_finalize_missing_scope",
        Error::Http(409, message) => {
            // Classify only into a closed vocabulary. Never persist the
            // message, which may include private provider or owner details.
            let message = message.to_ascii_lowercase();
            if message.contains("lease") {
                "native_finalize_lease_conflict"
            } else if message.contains("segment") {
                "native_finalize_segment_conflict"
            } else if message.contains("binding") {
                "native_finalize_binding_conflict"
            } else if message.contains("checkpoint") {
                "native_finalize_checkpoint_conflict"
            } else if message.contains("cleanup") {
                "native_finalize_cleanup_conflict"
            } else if message.contains("provider") || message.contains("receipt") {
                "native_finalize_provider_conflict"
            } else if message.contains("owner") || message.contains("epoch") {
                "native_finalize_owner_conflict"
            } else {
                "native_finalize_conflict"
            }
        }
        Error::Http(_, _) => "native_finalize_rejected",
        Error::Database(sqlx::Error::Database(error)) => match error.code().as_deref() {
            Some("22P02") => "native_finalize_database_identity",
            Some("23514") => "native_finalize_database_constraint",
            Some("23503") => "native_finalize_database_reference",
            Some("42501") => "native_finalize_database_permission",
            Some("40001" | "40P01") => "native_finalize_database_contention",
            _ => "native_finalize_database",
        },
        Error::Database(sqlx::Error::PoolTimedOut) => "native_finalize_database_timeout",
        Error::Database(_) => "native_finalize_database",
    }
}

async fn record_finalization_failure(
    pool: &PgPool,
    actor: &rudder_d1_persistence::native_chat::NativeChatExecutionPrincipal,
    fence: &execution::ExecutionFence,
    code: &'static str,
) {
    // The finalizer and this evidence write each reauthorize the same fence.
    // A diagnostic must neither release an ambiguous input nor extend the
    // finalization attempt indefinitely when its database is unavailable.
    let _ = tokio::time::timeout(
        Duration::from_secs(1),
        execution::record_execution_diagnostic(pool, actor, fence, code, true),
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
fn finalize_native_observation(
    handle: &tokio::runtime::Handle,
    pool: &PgPool,
    execution_principal: rudder_d1_persistence::native_chat::NativeChatExecutionPrincipal,
    fence: execution::ExecutionFence,
    turn: execution::NativeProviderTurnReceipt,
    cleanup: &rudder_native_process_transport::HostCleanupProof,
    stop: Option<&execution::StopIntent>,
) -> Completion {
    let status = handle.block_on(async {
        match tokio::time::timeout(Duration::from_secs(5), async {
            if let Some(stop) = stop {
                return execution::finalize_native_stopped(
                    pool,
                    &execution_principal,
                    &fence,
                    &turn,
                    cleanup,
                    stop,
                )
                .await;
            }
            let result =
                execution::finalize_native(pool, &execution_principal, &fence, &turn, cleanup)
                    .await;
            if matches!(
                &result,
                Err(rudder_d1_persistence::runtime_bindings::Error::Http(409, _))
            ) && let Some(stop) =
                execution::observe_stop(pool, &execution_principal, &fence).await?
            {
                return execution::finalize_native_stopped(
                    pool,
                    &execution_principal,
                    &fence,
                    &turn,
                    cleanup,
                    &stop,
                )
                .await;
            }
            result
        })
        .await
        {
            Ok(Ok(_)) => Status::FinalizationCommitted,
            Ok(Err(error)) => {
                record_finalization_failure(
                    pool,
                    &execution_principal,
                    &fence,
                    finalization_error_code(&error),
                )
                .await;
                Status::Unresolved(UnresolvedReason::FinalizationUnresolved)
            }
            Err(_) => {
                record_finalization_failure(
                    pool,
                    &execution_principal,
                    &fence,
                    "native_finalize_timeout",
                )
                .await;
                Status::Unresolved(UnresolvedReason::FinalizationUnresolved)
            }
        }
    });
    Completion {
        status,
        quiescent: true,
    }
}

/// Pi has provider-native session/leaf receipts. A settled receipt with an
/// owned cleanup proof is handed to the D1 Pi finalizer; missing terminal or
/// cleanup evidence remains unresolved. Neither path fabricates Codex
/// Thread/Turn identifiers.
fn finish_pi_observation(
    handle: &tokio::runtime::Handle,
    pool: &PgPool,
    observation: rudder_native_chat_executor::PiNativeExecutionObservation,
) -> Completion {
    let rudder_native_chat_executor::PiNativeExecutionObservation {
        execution_principal,
        fence,
        observation: provider,
        stop,
    } = observation;
    let Some(cleanup) = provider
        .cleanup_receipt
        .as_ref()
        .filter(|cleanup| fence.matches_pi_cleanup_receipt(cleanup))
    else {
        return Completion {
            status: Status::Unresolved(UnresolvedReason::MissingCleanupProof),
            quiescent: false,
        };
    };
    let result = handle.block_on(tokio::time::timeout(Duration::from_secs(5), async {
        let stop = match stop {
            Some(stop) => Some(stop),
            None => execution::observe_stop(pool, &execution_principal, &fence).await?,
        };
        let Some(turn) = provider.turn_receipt.as_ref() else {
            if let Some(stop) = stop {
                return execution::finalize_pi_stopped_before_submission(
                    pool,
                    &execution_principal,
                    &fence,
                    cleanup,
                    &stop,
                )
                .await;
            }
            return Err(rudder_d1_persistence::runtime_bindings::Error::Http(
                409,
                "Pi terminal receipt is missing".into(),
            ));
        };
        if !cleanup.proves_quiescence_for(turn)
            || !matches!(
                provider.phase,
                rudder_native_chat_executor::PiExecutionPhase::Cleaned
            )
        {
            return Err(rudder_d1_persistence::runtime_bindings::Error::Http(
                409,
                "Pi terminal cleanup is not proven".into(),
            ));
        }
        if let Some(stop) = stop {
            return execution::finalize_pi_stopped(
                pool,
                &execution_principal,
                &fence,
                turn,
                cleanup,
                &stop,
            )
            .await;
        }
        let result =
            execution::finalize_pi(pool, &execution_principal, &fence, turn, cleanup).await;
        if matches!(
            &result,
            Err(rudder_d1_persistence::runtime_bindings::Error::Http(409, _))
        ) && let Some(stop) = execution::observe_stop(pool, &execution_principal, &fence).await?
        {
            return execution::finalize_pi_stopped(
                pool,
                &execution_principal,
                &fence,
                turn,
                cleanup,
                &stop,
            )
            .await;
        }
        result
    }));
    Completion {
        status: match result {
            Ok(Ok(_)) => Status::FinalizationCommitted,
            Ok(Err(error)) => {
                handle.block_on(record_finalization_failure(
                    pool,
                    &execution_principal,
                    &fence,
                    finalization_error_code(&error),
                ));
                Status::Unresolved(UnresolvedReason::FinalizationUnresolved)
            }
            Err(_) => {
                handle.block_on(record_finalization_failure(
                    pool,
                    &execution_principal,
                    &fence,
                    "native_finalize_timeout",
                ));
                Status::Unresolved(UnresolvedReason::FinalizationUnresolved)
            }
        },
        quiescent: true,
    }
}

#[cfg(test)]
fn classify_pi_observation(
    provider_terminal: bool,
    turn_receipt: bool,
    cleanup_proven: bool,
) -> UnresolvedReason {
    if provider_terminal && turn_receipt && cleanup_proven {
        UnresolvedReason::ProviderTerminalUnsupported
    } else {
        UnresolvedReason::ProviderCleanupUnknown
    }
}

fn finish_hermes_observation(
    handle: &tokio::runtime::Handle,
    pool: &PgPool,
    observation: rudder_native_chat_executor::HermesExecutionObservation,
) -> Completion {
    let Some(cleanup) = observation
        .cleanup_receipt
        .filter(|cleanup| cleanup.proves_quiescence_for(&observation.turn_receipt))
    else {
        return Completion {
            status: Status::Unresolved(UnresolvedReason::MissingCleanupProof),
            quiescent: false,
        };
    };
    let status = handle.block_on(async {
        match tokio::time::timeout(Duration::from_secs(5), async {
            if let Some(stop) = &observation.stop {
                return execution::finalize_hermes_stopped(
                    pool,
                    &observation.execution_principal,
                    &observation.fence,
                    &observation.turn_receipt,
                    &cleanup,
                    stop,
                )
                .await;
            }
            let result = execution::finalize_hermes(
                pool,
                &observation.execution_principal,
                &observation.fence,
                &observation.turn_receipt,
                &cleanup,
            )
            .await;
            if matches!(
                &result,
                Err(rudder_d1_persistence::runtime_bindings::Error::Http(409, _))
            ) && let Some(stop) =
                execution::observe_stop(pool, &observation.execution_principal, &observation.fence)
                    .await?
            {
                return execution::finalize_hermes_stopped(
                    pool,
                    &observation.execution_principal,
                    &observation.fence,
                    &observation.turn_receipt,
                    &cleanup,
                    &stop,
                )
                .await;
            }
            result
        })
        .await
        {
            Ok(Ok(_)) => Status::FinalizationCommitted,
            _ => Status::Unresolved(UnresolvedReason::FinalizationUnresolved),
        }
    });
    Completion {
        status,
        quiescent: true,
    }
}

#[cfg(test)]
#[path = "native_chat_worker_tests.rs"]
mod tests;
